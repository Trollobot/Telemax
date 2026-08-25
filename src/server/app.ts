import dns from 'node:dns';
import { Telegraf } from 'telegraf';
import path from 'node:path';
import { readFile, unlink, writeFile } from 'node:fs/promises';
import { MaxClient, type MaxMessageEvent, type MaxContactInfo } from '../max/client.js';
import { OPCODES } from '../max/opcodes.js';
import { extractMyAccountId, resolveChatName, type ContactProfile } from '../max/names.js';
import { SessionStore, type MaxSession } from '../store/sessionStore.js';
import { ChatMapStore } from '../store/chatMapStore.js';
import { wireBridge, syncAllChatsToTelegram, MessageLinkStore } from '../bridge/sync.js';
import { configureErrorReporter, reportBridgeError, resetErrorKey } from '../bridge/errorReporter.js';
import { getAppVersion } from '../bridge/version.js';
import { createLogger } from '../logger.js';
import { config } from './config.js';
import { getTelegramProxyAgent, initTelegramProxy } from '../telegram/proxy.js';

const logger = createLogger('server');

// Prefer IPv4 when a host resolves to both. On dual-stack servers where IPv6 has no
// working route to Telegram (common in RU — Telegram is blocked over v6 while v4
// stays reachable), Node's default order would try the dead v6 address first and the
// bot would hang connecting to api.telegram.org — messages silently stop flowing
// (reported live 2026-08-16, user had to pin v4 in /etc/hosts). Still falls back to
// v6 when there's no A record, so v6-only hosts keep working.
dns.setDefaultResultOrder('ipv4first');

// One bad handler shouldn't take down MAX auth, the Telegram bot, and every other
// in-flight session — log and keep running instead of letting Node's default
// "crash the process" behavior undo all the reconnect/retry work elsewhere. The
// operator also gets a throttled heads-up in Telegram — deliberately generic (no raw
// error text) so a token/URL in the message can't leak into the group; details stay
// in the container logs.
process.on('unhandledRejection', (reason) => {
  logger.error('Unhandled rejection:', reason);
  reportBridgeError('unhandled-rejection', '⚠️ Внутренняя ошибка моста — подробности в логах контейнера (docker compose logs).');
});
process.on('uncaughtException', (err) => {
  logger.error('Uncaught exception:', err);
  reportBridgeError('uncaught-exception', '⚠️ Внутренняя ошибка моста — подробности в логах контейнера (docker compose logs).');
});

const sessionStore = new SessionStore();
const chatMapStore = new ChatMapStore();
const max = new MaxClient({ host: config.maxHost, sni: config.maxSni });

let bot: Telegraf | null = null;
let messageLinks: MessageLinkStore | null = null;
let tgActive = false;
let maxConnected = false;
let activePhone = '';
let pendingPhone = '';
// The phone we last authenticated with. Unlike currentSession/activePhone (wiped on a session
// rejection), this SURVIVES so the Telegram /login flow can offer "re-auth with +7•••1587?" after a
// reconnect failure — two taps instead of retyping the number. Cleared only by /kill or change-number.
let lastKnownPhone = '';
let pendingAuthToken: string | null = null;
/** Set when verifyCode() comes back password_required — cleared only on a successful login, since the trackId survives a wrong password and can be retried (confirmed live 2026-08-14). */
let pendingPasswordTrackId: string | null = null;
let currentSession: MaxSession | null = null;
// LOGIN's embedded chat list is capped at chatsCount (<=50) and, live, has also
// been observed to just omit chats a later resumed-session LOGIN included —
// cachedChats gets replaced with the real, fully-paginated CHATS_LIST result
// right after login (see refreshChatsAndNames), so this is only the seed value.
let cachedChats: unknown[] = [];
let myAccountId: number | null = null;
// Populated from CONTACT_INFO per DIALOG participant — not from LOGIN's contacts[],
// which only has a single `name` per type (no firstName/lastName/phone).
let contactProfiles: Map<number, ContactProfile> = new Map();

function extractChats(loginPayload: unknown): unknown[] {
  if (loginPayload && typeof loginPayload === 'object' && Array.isArray((loginPayload as { chats?: unknown }).chats)) {
    return (loginPayload as { chats: unknown[] }).chats;
  }
  return [];
}

function applyLoginPayload(payload: unknown): void {
  cachedChats = extractChats(payload);
  myAccountId = extractMyAccountId(payload);
}

/** Replaces the LOGIN chat snapshot with the account's real full list, and fetches display-name profiles for every DIALOG participant. Safe to call on every login (fresh auth or resumed session) — both round trips are idempotent reads. */
async function refreshChatsAndNames(): Promise<void> {
  try {
    const allChats = await max.getAllChats();
    if (allChats.length > 0) cachedChats = allChats;
  } catch (err) {
    logger.error('Failed to fetch full chat list via CHATS_LIST, using LOGIN snapshot:', err);
  }

  const participantIds = new Set<number>();
  for (const chat of cachedChats) {
    const participants = (chat as { type?: string; participants?: Record<string, unknown> } | null)?.participants;
    if (!participants) continue;
    for (const key of Object.keys(participants)) {
      const id = Number(key);
      if (!Number.isNaN(id) && id !== myAccountId) participantIds.add(id);
    }
  }
  if (participantIds.size === 0) return;
  try {
    const contacts: MaxContactInfo[] = await max.getContactInfo([...participantIds]);
    const profiles = new Map<number, ContactProfile>();
    for (const c of contacts) {
      const id = Number(c.id);
      if (!Number.isNaN(id)) profiles.set(id, c);
    }
    contactProfiles = profiles;
  } catch (err) {
    logger.error('Failed to fetch contact profiles via CONTACT_INFO:', err);
  }
}

/** Shared tail end of both auth paths (plain SMS, and SMS + password) — exchanges a login token for a session and persists it. */
async function completeMaxLogin(loginToken: string): Promise<void> {
  const { sessionToken, payload } = await max.login(loginToken);
  applyLoginPayload(payload);
  await refreshChatsAndNames();
  void syncChatsIfPossible();
  const session: MaxSession = {
    sessionToken,
    phone: pendingPhone,
    deviceId: max.deviceId,
    savedAt: new Date().toISOString(),
  };
  await sessionStore.save(session);
  currentSession = session;
  activePhone = session.phone;
  lastKnownPhone = session.phone;
  notifyMaxSessionRestored();
  refreshBotDescription();
}

// --- Shared MAX auth steps: used by BOTH the web panel (/api/auth/*) and the Telegram /login flow ---

async function maxAuthRequestSms(rawPhone: string): Promise<void> {
  const phone = rawPhone.replace(/[^\d+]/g, '');
  if (!phone) throw new Error('Пустой номер телефона');
  // No active session (first login / re-auth after loss / change-number): bring up a FRESH socket
  // first — a socket left over from a rejected session refuses START_AUTH (hit live 2026-08-18).
  if (!currentSession) await freshConnectForAuth();
  else if (!maxConnected) throw new Error('MAX is disconnected');
  pendingAuthToken = await max.requestSms(phone);
  pendingPhone = phone;
}

async function maxAuthVerifyCode(code: string): Promise<{ ok: true } | { passwordRequired: true; hint: string | null }> {
  if (!pendingAuthToken) throw new Error('no pending auth — request an SMS first');
  const verified = await max.verifyCode(pendingAuthToken, code);
  if (verified.status === 'password_required') {
    pendingPasswordTrackId = verified.challenge.trackId;
    return { passwordRequired: true, hint: verified.challenge.hint ?? null };
  }
  pendingAuthToken = null;
  await completeMaxLogin(verified.loginToken);
  return { ok: true };
}

async function maxAuthCheckPassword(password: string): Promise<void> {
  if (!pendingPasswordTrackId) throw new Error('no pending password challenge');
  // NOT cleared on a throw: the trackId survives a wrong password on MAX's side, so the user can
  // retry the password without a fresh SMS (confirmed live 2026-08-14). Only success clears it.
  const loginToken = await max.checkPassword(pendingPasswordTrackId, password);
  pendingPasswordTrackId = null;
  await completeMaxLogin(loginToken);
}

/**
 * Idempotent — safe to call after every LOGIN (fresh auth or a reconnect's
 * resumed session). Rapid reconnects can fire this several times in quick
 * succession; a `null` chatSyncInFlight guard collapses those into one run
 * instead of racing overlapping full-history backfills against each other
 * (a stacked race here corrupted chat-map.json writes live, 2026-08-08).
 */
let chatSyncInFlight: Promise<void> | null = null;
function syncChatsIfPossible(): Promise<void> {
  if (!bot || !messageLinks) return Promise.resolve();
  if (chatSyncInFlight) return chatSyncInFlight;
  const bot_ = bot;
  const messageLinks_ = messageLinks;
  chatSyncInFlight = syncAllChatsToTelegram(
    bot_,
    chatMapStore,
    config.targetTelegramGroup,
    cachedChats,
    (chat) => resolveChatName(chat, myAccountId, contactProfiles),
    max,
    messageLinks_,
    myAccountId,
    contactProfiles,
  )
    .catch((err) => logger.error('Chat sync to Telegram failed:', err))
    .finally(() => {
      chatSyncInFlight = null;
    });
  return chatSyncInFlight;
}

/**
 * /kill's full teardown: disconnects the live MAX connection (closedByUser — no
 * auto-reconnect) and deletes the encrypted session so nothing short of a fresh
 * SMS login via the web UI can bring the bridge back. Also resets every
 * in-memory cache derived from the old account so nothing lingers after a
 * different number logs in later. The server process itself keeps running —
 * only the MAX-side identity is torn down, not the whole service.
 */
async function killMaxSession(): Promise<void> {
  max.disconnect();
  await sessionStore.clear();
  currentSession = null;
  activePhone = '';
  pendingPhone = '';
  lastKnownPhone = '';
  pendingAuthToken = null;
  cachedChats = [];
  myAccountId = null;
  contactProfiles = new Map();
  maxConnected = false;
  refreshBotDescription();
}

/** Keeps the LOGIN-derived chat snapshot from going stale as messages flow in either direction. Ids compare via String() — cached ids can be number OR BigInt (channels), and a strict === across those types silently never matches. */
function patchCachedChatLastMessage(chatId: unknown, lastMessage: unknown): void {
  const key = String(chatId);
  const chat = cachedChats.find((c) => c && typeof c === 'object' && String((c as { id?: unknown }).id) === key);
  if (chat) (chat as { lastMessage: unknown }).lastMessage = lastMessage;
}

/** Adds or replaces a chat in the cached snapshot from a live full CHAT_UPDATE — so a
 * freshly-created group/dialog (not in the last CHATS_LIST) is immediately nameable and
 * visible in /info, instead of falling back to "MAX chat <id>". */
function upsertCachedChat(chat: unknown): void {
  if (!chat || typeof chat !== 'object') return;
  const id = (chat as { id?: unknown }).id;
  if (id == null) return;
  const key = String(id);
  const idx = cachedChats.findIndex((c) => c && typeof c === 'object' && String((c as { id?: unknown }).id) === key);
  if (idx >= 0) cachedChats[idx] = chat;
  else cachedChats.push(chat);
}

// Set once we've told the group the MAX session was lost, so a "restored" notice only
// fires after an actual loss — and only once.
let maxSessionLostReported = false;

// A resume LOGIN can fail transiently (a blip mid-handshake, a momentary server hiccup),
// so we don't nuke the saved session on the first miss — we reconnect a fresh socket and let
// 'ready' retry, only demanding a fresh SMS after several genuine failures in a row. resumeInFlight
// collapses overlapping resumes (two 'ready' events racing) into one.
let resumeFailures = 0;
let resumeInFlight = false;
const MAX_RESUME_RETRIES = 3;
const RESUME_RETRY_DELAY_MS = 5_000;

/** Inline keyboard: a deep link into the bot's DM that kicks off the /login flow. undefined until the bot knows its own @username (Telegraf sets botInfo during launch). */
function maxLoginKeyboard(): { reply_markup: { inline_keyboard: { text: string; url: string }[][] } } | undefined {
  const username = bot?.botInfo?.username;
  if (!username) return undefined;
  return { reply_markup: { inline_keyboard: [[{ text: '🔐 Войти в MAX', url: `https://t.me/${username}?start=login` }]] } };
}

/** Tells the group the MAX session was rejected and offers the in-bot re-auth flow (button + /login). Fires once per loss — guarded by maxSessionLostReported, reset by notifyMaxSessionRestored. */
function notifyReauthNeeded(): void {
  if (maxSessionLostReported) return;
  maxSessionLostReported = true;
  const text =
    '❌ MAX-сессия отклонена — нужна повторная авторизация (номер + код из SMS). ' +
    'Нажмите «🔐 Войти в MAX» и авторизуйтесь в личке бота (или напишите боту в личку /login). Пока переписка не пересылается.';
  bot?.telegram
    .sendMessage(config.targetTelegramGroup, text, maxLoginKeyboard())
    .catch((err) => logger.error('Failed to send re-auth notice', err));
}

/** After a reported session loss, tells the group it's back — on resume or re-auth. */
function notifyMaxSessionRestored(): void {
  if (!maxSessionLostReported) return;
  maxSessionLostReported = false;
  resetErrorKey('max-session-lost');
  reportBridgeError('max-session-ok', '✅ MAX-авторизация восстановлена.');
}

/** Forces a clean MAX socket and resolves once it has finished INIT (the 'ready' event).
 * Used before (re)authentication: a socket left over from a rejected session refuses
 * START_AUTH with "Недопустимое состояние сессии", so instead of requiring a manual
 * container restart (hit live 2026-08-18), we reconnect a fresh socket first. */
function freshConnectForAuth(timeoutMs = 15000): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    const onReady = (): void => {
      clearTimeout(timer);
      resolve();
    };
    const timer = setTimeout(() => {
      max.off('ready', onReady);
      reject(new Error('MAX не ответил при переподключении для авторизации'));
    }, timeoutMs);
    max.once('ready', onReady);
    max.connect(); // tears down any stale socket and starts a fresh INIT
  });
}

async function loginWithSession(session: MaxSession): Promise<void> {
  if (resumeInFlight) return; // two 'ready' events (e.g. a racy reconnect) must not double-LOGIN
  resumeInFlight = true;
  try {
    const { sessionToken, payload } = await max.login(session.sessionToken);
    applyLoginPayload(payload);
    activePhone = session.phone;
    lastKnownPhone = session.phone;
    // MAX rotates the session token on every LOGIN and eventually invalidates the previous
    // one. The fresh-auth path (completeMaxLogin) already persists the new token; a resumed
    // login must do the same — otherwise every reconnect keeps presenting the ORIGINAL token
    // and, once its lifetime lapses, MAX rejects it. The "rotated"/"unchanged" tag confirms
    // whether re-LOGIN actually hands back a NEW token (it must, for the proactive refresh
    // below to keep the session alive on a rock-stable connection).
    const refreshed: MaxSession = { ...session, sessionToken, savedAt: new Date().toISOString() };
    await sessionStore.save(refreshed);
    currentSession = refreshed;
    resumeFailures = 0;
    logger.info(`Resumed session for ${session.phone} (token ${sessionToken === session.sessionToken ? 'unchanged' : 'rotated'})`);
    notifyMaxSessionRestored();
    await refreshChatsAndNames();
    void syncChatsIfPossible();
  } catch (err) {
    const msg = (err as Error).message;
    resumeFailures += 1;
    if (resumeFailures < MAX_RESUME_RETRIES) {
      // The socket stays up after a rejected LOGIN (no 'disconnected' fires). Reconnect a fresh
      // socket and let 'ready' retry rather than nuking a possibly-still-valid session on one
      // transient miss — a single failure used to brick the bridge until a manual SMS re-auth.
      logger.warn(`Resume login failed (attempt ${resumeFailures}/${MAX_RESUME_RETRIES}), reconnecting to retry: ${msg}`);
      setTimeout(() => max.connect(), RESUME_RETRY_DELAY_MS);
    } else {
      resumeFailures = 0;
      logger.warn('Saved session was rejected after retries, clearing it:', msg);
      currentSession = null;
      activePhone = '';
      // lastKnownPhone deliberately kept — the re-auth flow offers a one-tap "войти с +7•••…?".
      await sessionStore.clear();
      // The bridge is functionally dead until someone re-authenticates. Prompt the in-bot flow.
      notifyReauthNeeded();
    }
  } finally {
    resumeInFlight = false;
  }
  refreshBotDescription();
}

async function startServer(): Promise<void> {
  currentSession = await sessionStore.load();
  if (currentSession) lastKnownPhone = currentSession.phone;

  // --- MAX client wiring ---
  // A brief MAX drop during a reconnect is normal and shouldn't ping the group — only
  // a sustained outage (still down 60s later) earns an operator notice, paired with a
  // "recovered" once it's back.
  let maxDownTimer: ReturnType<typeof setTimeout> | null = null;
  let maxDownReported = false;

  max.on('connected', () => {
    maxConnected = true;
    if (maxDownTimer) {
      clearTimeout(maxDownTimer);
      maxDownTimer = null;
    }
    if (maxDownReported) {
      maxDownReported = false;
      resetErrorKey('max-down');
      reportBridgeError('max-up', '✅ Связь с MAX восстановлена.');
    }
  });

  max.on('ready', () => {
    if (currentSession) void loginWithSession(currentSession);
  });

  max.on('disconnected', () => {
    maxConnected = false;
    if (maxDownTimer == null && !maxDownReported) {
      maxDownTimer = setTimeout(() => {
        maxDownTimer = null;
        maxDownReported = true;
        reportBridgeError('max-down', '❌ Потеряна связь с MAX. Пытаюсь переподключиться…');
      }, 60_000);
    }
  });

  max.on('error', (err: Error) => logger.error('MAX client error:', err.message));

  max.on('message', (event: MaxMessageEvent) => {
    if (event.opcode === OPCODES.PUSH_MESSAGE || (event.opcode === OPCODES.MSG_SEND && event.dir === 0x01)) {
      const p = event.payload as { chatId?: number; message?: unknown } | null;
      if (p?.chatId != null && p.message) patchCachedChatLastMessage(p.chatId, p.message);
    } else if (event.opcode === OPCODES.CHAT_UPDATE) {
      // A full chat snapshot (creation/rename/members) carries participants; a
      // reaction-only CHAT_UPDATE doesn't. Upsert only the full ones — so a freshly
      // created chat lands in the cache (nameable + visible in /info) without a resync,
      // and a reaction update doesn't clobber a full cached chat with a partial one.
      const chat = (event.payload as { chat?: { participants?: unknown } } | null)?.chat;
      if (chat && chat.participants != null) upsertCachedChat(chat);
    }
  });

  max.connect();

  // Build the Telegram proxy agent (TELEGRAM_PROXY from .env) before the bot is
  // built — Telegraf binds its agent at construction time, so this has to run
  // first. No-op when no proxy is configured.
  initTelegramProxy();

  // --- Telegram bot (optional — bridge stays dormant without credentials) ---
  if (config.telegramEnabled) {
    bot = createBotSafely(config.telegramBotToken);
    if (bot) {
      ({ messageLinks } = wireBridge({
        max,
        bot,
        chatMapStore,
        targetGroupId: config.targetTelegramGroup,
        getChats: () => cachedChats,
        getMyAccountId: () => myAccountId,
        getContactProfiles: () => contactProfiles,
        getActivePhone: () => activePhone,
        triggerFullResync: () => refreshChatsAndNames().then(() => syncChatsIfPossible()),
        killEverything: killMaxSession,
        auth: {
          getLastKnownPhone: () => lastKnownPhone,
          requestSms: maxAuthRequestSms,
          verifyCode: maxAuthVerifyCode,
          checkPassword: maxAuthCheckPassword,
        },
      }));
      launchTelegramBotWithRetry(bot);
      // Route throttled operator error notices (MAX down, delivery failures, internal
      // errors) to the target group. Captured in a const so the closure keeps the
      // non-null bot even though the module-level `bot` is nullable.
      const notifyBot = bot;
      configureErrorReporter((text) => notifyBot.telegram.sendMessage(config.targetTelegramGroup, text));
    }
  } else {
    logger.warn('TELEGRAM_BOT_TOKEN / TARGET_TELEGRAM_GROUP not set — Telegram bridge stays disabled');
  }

  // No inbound server: the bridge is headless (v0.4). Auth, status and control all live in
  // the Telegram bot now (see /login, the /panel menu). MAX runs over an outbound TCP socket
  // and Telegram over long-polling, so nothing needs to listen on a port.

  // docker stop / systemd send SIGTERM (node runs as PID 1 — exec-form CMD, so it actually
  // receives it). Stop polling Telegram and close the MAX socket cleanly instead of letting the
  // runtime kill mid-write; the backfill cursor is persisted per message, so an in-flight
  // backfill resumes where it left off either way.
  const shutdown = (signal: string): void => {
    logger.info(`Received ${signal}, shutting down`);
    try {
      bot?.stop(signal);
    } catch {
      // bot may not have launched (bad token, mid-retry) — nothing to stop
    }
    max.disconnect();
    // Let in-flight work (a mid-write store persist, the polling loop's teardown)
    // drain naturally; the timer is the failsafe so a lingering keep-alive socket
    // or maintenance interval can't hold the process past docker's stop timeout.
    // (An immediate exit(0) here used to make the "graceful" part a no-op.)
    setTimeout(() => process.exit(0), 5_000).unref();
  };
  process.once('SIGTERM', () => shutdown('SIGTERM'));
  process.once('SIGINT', () => shutdown('SIGINT'));
}

// getUpdates only allows one active poller per bot token (a second instance — even a
// throwaway debug script — gets a 409 and knocks the first one off), so a launch
// failure here is often transient. Retry with backoff instead of leaving tgActive
// stuck false until someone notices and restarts the process by hand.
const TELEGRAM_RETRY_DELAYS_MS = [2_000, 5_000, 15_000, 30_000, 60_000];

// Shown in the bot's Telegram profile (Bot API 512-char limit on setMyDescription).
// MUST NOT contain the MAX phone number or anything account-specific: setMyDescription
// is PUBLIC — visible to anyone who opens the bot's profile or DMs it (shown in the
// empty chat before /start), including anyone who adds the bot to their own group.
// It used to embed the active phone number here, which leaked it to any such viewer
// (confirmed 2026-08-15). The owner already sees their number via /help inside the group.
function buildBotDescription(): string {
  return `Мост MAX ↔ Telegram: сообщения, файлы, голосовые, стикеры, опросы, пересылка. Звонки — только уведомления, без аудио.

Удаление: свайпом своего сообщения (подхватится сам), реакцией 👎 на своё, или /delete ответом (/delete me — только у себя).

Ограничения:
• Голоса за опрос из MAX сами не появляются в Telegram — счёт через /poll ответом на опрос.

Команды: /help /donate /login /version /info /poll /delete /newgroup /invite /kick /leavegroup /deletegroup /ban /unban /reboot /kill`;
}

/** Best-effort refresh once the phone number becomes known (or changes) — the initial setMyDescription at Telegram launch may well have fired before MAX auth finished. */
function refreshBotDescription(): void {
  if (!bot || !tgActive) return;
  bot.telegram.setMyDescription(buildBotDescription()).catch((err) => logger.error('Failed to refresh bot description', err));
}

// Populates Telegram's "/" command menu with one-line descriptions. /help (bridge/sync.ts)
// has the full reference — these are just enough to jog the memory from the menu.
const BOT_COMMANDS = [
  { command: 'panel', description: '🎛 Пульт управления (меню с кнопками)' },
  { command: 'help', description: 'Полный список команд и ограничений' },
  { command: 'donate', description: 'Поддержать проект (рубли / TON)' },
  { command: 'login', description: 'Войти в MAX (номер + SMS, в личке бота)' },
  { command: 'version', description: 'Версия бота, обновление по кнопке' },
  { command: 'info', description: 'Карточка контакта/чата (просто в теме)' },
  { command: 'poll', description: 'Актуальный счёт опроса (ответом на сообщение)' },
  { command: 'delete', description: 'Удалить сообщение с обеих сторон (ответом)' },
  { command: 'newgroup', description: 'Создать группу в MAX: /newgroup <название>' },
  { command: 'invite', description: 'Пригласить в группу: /invite <MAX ID>' },
  { command: 'kick', description: 'Удалить из группы: /kick <MAX ID>' },
  { command: 'rename', description: 'Переименовать группу: /rename <название>' },
  { command: 'setdesc', description: 'Изменить описание группы: /setdesc <текст>' },
  { command: 'leavegroup', description: 'Выйти из группы (требует подтверждения)' },
  { command: 'deletegroup', description: 'Удалить группу (требует подтверждения)' },
  { command: 'ban', description: 'Заглушить чат (выбор кнопкой из списка)' },
  { command: 'unban', description: 'Вернуть заглушённый чат' },
  { command: 'reboot', description: 'Пересоздать все темы с нуля (требует подтверждения)' },
  { command: 'kill', description: 'Разлогинить MAX и стереть все данные (необратимо)' },
];

const UPDATE_COMPLETED_MARKER = path.join(process.cwd(), '.data', 'update-completed');

/** update.sh (run by the host-side update-watcher, see setup.sh) writes this with the new commit right before restarting the container — read once on startup so the update isn't silent. */
async function reportIfJustUpdated(bot: Telegraf): Promise<void> {
  let commit: string;
  try {
    commit = (await readFile(UPDATE_COMPLETED_MARKER, 'utf8')).trim();
  } catch {
    return;
  }
  await unlink(UPDATE_COMPLETED_MARKER).catch(() => {});
  if (!commit) return;
  await bot.telegram.sendMessage(config.targetTelegramGroup, `✅ Обновлено до v${getAppVersion()}.`).catch((err) => logger.error('Failed to send post-update notice', err));
}

const WELCOME_SENT_MARKER = path.join(process.cwd(), '.data', 'welcome-sent');

/**
 * On launch, verify the bot can actually reach the configured group and give the
 * user the "it's connected" signal they otherwise lack — the #1 confusion for new
 * installs (a correctly-set-up bridge is silent until MAX messages start flowing).
 * If the group is unreachable (bot not added, wrong id), there's no Telegram channel
 * to warn the owner — Telegram bots can't DM someone who hasn't messaged them first —
 * so the best we can do is a loud log line, which the README troubleshooting points at.
 * The welcome itself is posted once ever (marker in .data) so restarts/updates don't spam.
 */
async function announceGroupReadyOnce(bot: Telegraf): Promise<void> {
  const groupId = config.targetTelegramGroup;
  try {
    await bot.telegram.getChat(groupId);
  } catch (err) {
    logger.error(
      `Не удаётся получить доступ к Telegram-группе ${groupId}. Проверьте, что бот добавлен в неё администратором с правом «Управление темами». Пока это не исправлено, мост не сможет пересылать сообщения.`,
      err instanceof Error ? err.message : err,
    );
    return;
  }
  try {
    await readFile(WELCOME_SENT_MARKER);
    return; // already welcomed this install
  } catch {
    // first successful launch into the group — send the one-time welcome
  }
  try {
    await bot.telegram.sendMessage(
      groupId,
      '✅ Telemax подключён к этой группе.\n\nЕсли ещё не вошли в MAX — нажмите «🔐 Войти в MAX» и авторизуйтесь в личке бота (номер + код из SMS), или напишите боту в личку /login. Полный список команд — /help.',
      maxLoginKeyboard(),
    );
    await writeFile(WELCOME_SENT_MARKER, new Date().toISOString(), 'utf8').catch(() => {});
  } catch (err) {
    logger.error('Failed to send group welcome message', err);
  }
}

function retryTelegramLaunch(bot: Telegraf, attempt: number, reason: unknown): void {
  tgActive = false;
  const idx = Math.min(attempt, TELEGRAM_RETRY_DELAYS_MS.length - 1);
  const delay = TELEGRAM_RETRY_DELAYS_MS[idx] as number;
  logger.error(`Telegram bot stopped, retrying in ${delay}ms:`, reason instanceof Error ? reason.message : reason);
  setTimeout(() => launchTelegramBotWithRetry(bot, attempt + 1), delay);
}

/**
 * `bot.launch()` does NOT resolve once the bot is up — it awaits the polling loop
 * internally and only settles when the bot stops or hits an unrecoverable error.
 * Treating `.then()` as "now active" (as both prototype versions did) means
 * `tgActive` can never become true during normal operation. `getMe()` resolves
 * as soon as the token/connection are good, so that's the actual readiness signal;
 * `launch()` is fired after and only awaited for its rejection/stop outcome.
 */
async function launchTelegramBotWithRetry(bot: Telegraf, attempt = 0): Promise<void> {
  try {
    await bot.telegram.getMe();
  } catch (err) {
    retryTelegramLaunch(bot, attempt, err);
    return;
  }

  tgActive = true;
  logger.info('Telegram bot active');

  // Best-effort: keeps the bot's Telegram profile description in sync with its
  // actual command surface and the two platform-level gaps a user could otherwise
  // spend time re-discovering (Bot API has no delete-notification event at all, and
  // Telegram's poll widget has no way to receive a vote cast on the MAX side).
  bot.telegram.setMyDescription(buildBotDescription()).catch((err) => logger.error('Failed to set bot description', err));
  bot.telegram.setMyCommands(BOT_COMMANDS).catch((err) => logger.error('Failed to set bot commands', err));
  void reportIfJustUpdated(bot);
  void announceGroupReadyOnce(bot);

  // message_reaction and poll_answer are opt-in — Telegram omits them from the default update set unless
  // requested. callback_query has to be listed explicitly too once you restrict allowedUpdates at all —
  // it's normally on by default, but an explicit list overrides that default rather than adding to it, so
  // leaving it out here silently dropped every inline-keyboard button press (/version's Обновить/Позже)
  // with no error anywhere: Telegram just never delivered the update. /donate's buttons never surfaced
  // this because they're url buttons, which the client opens directly without involving the bot at all.
  bot
    .launch({ allowedUpdates: ['message', 'edited_message', 'message_reaction', 'poll_answer', 'callback_query'] })
    .catch((err) => retryTelegramLaunch(bot, attempt, err));
}

function createBotSafely(token: string): Telegraf | null {
  try {
    const agent = getTelegramProxyAgent();
    return new Telegraf(token, agent ? { telegram: { agent } } : undefined);
  } catch (err) {
    logger.error('Failed to create Telegram bot:', err);
    return null;
  }
}

startServer().catch((err) => {
  logger.error('Fatal startup error:', err);
  process.exitCode = 1;
});
