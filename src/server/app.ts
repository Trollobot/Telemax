import dns from 'node:dns';
import { Telegraf } from 'telegraf';
import path from 'node:path';
import { readFile, unlink, writeFile } from 'node:fs/promises';
import { MaxClient, type MaxMessageEvent, type MaxContactInfo } from '../max/client.js';
import { DIR, OPCODES } from '../max/opcodes.js';
import { dialogParticipantIds, extractMyAccountId, resolveChatName, type ContactProfile } from '../max/names.js';
import { SessionStore } from '../store/sessionStore.js';
import { ChatMapStore } from '../store/chatMapStore.js';
import { wireBridge, syncAllChatsToTelegram, type ChatCatchUp } from '../bridge/sync.js';
import { RetryBackoff } from '../bridge/catchUp.js';
import { isTransientTelegramError } from '../bridge/transient.js';
import { configureErrorReporter, reportBridgeError } from '../bridge/errorReporter.js';
import { getAppVersion } from '../bridge/version.js';
import { noteBoot, reportError } from '../bridge/telemetry.js';
import { createLogger } from '../logger.js';
import { config } from './config.js';
import { MaxSessionController } from './maxSession.js';
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
// in the container logs. The maintainer gets the scrubbed first line as an anonymous report.
process.on('unhandledRejection', (reason) => {
  logger.error('Unhandled rejection:', reason);
  reportBridgeError('unhandled-rejection', '⚠️ Внутренняя ошибка моста — подробности в логах контейнера (docker compose logs).');
  void reportError({ kind: 'internal', step: 'unhandledRejection', error: reason });
});
process.on('uncaughtException', (err) => {
  logger.error('Uncaught exception:', err);
  reportBridgeError('uncaught-exception', '⚠️ Внутренняя ошибка моста — подробности в логах контейнера (docker compose logs).');
  void reportError({ kind: 'internal', step: 'uncaughtException', error: err });
});

const sessionStore = new SessionStore();
const chatMapStore = new ChatMapStore();
const max = new MaxClient({ host: config.maxHost, sni: config.maxSni });

let bot: Telegraf | null = null;
let chatSync: ChatCatchUp | null = null;
let tgActive = false;
// LOGIN's embedded chat list is capped at chatsCount (<=50) and, live, has also
// been observed to just omit chats a later resumed-session LOGIN included —
// cachedChats gets replaced with the real, fully-paginated CHATS_LIST result
// right after login (see refreshChatsAndNames), so this is only the seed value.
let cachedChats: unknown[] = [];
let myAccountId: number | null = null;
// Populated from CONTACT_INFO per DIALOG participant — not from LOGIN's contacts[],
// which only has a single `name` per type (no firstName/lastName/phone).
let contactProfiles: Map<number, ContactProfile> = new Map();

// The MAX leg's state (socket, session, /login chain, resume retries, pause, outage notice) lives in
// the controller; this file only feeds it the client's events and reacts to a login or /kill.
const maxSession = new MaxSessionController({
  client: max,
  store: sessionStore,
  onLogin: async (payload) => {
    applyLoginPayload(payload);
    await refreshChatsAndNames();
    void syncChatsIfPossible();
  },
  postReauthNotice: (text) => (bot ? bot.telegram.sendMessage(config.targetTelegramGroup, text, maxLoginKeyboard()) : Promise.resolve()),
  reportError,
});

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

/** Replaces the LOGIN chat snapshot with the account's real full list, and fetches display-name profiles for the other side of every 1:1 dialog. Safe to call on every login (fresh auth or resumed session) — both round trips are idempotent reads. */
async function refreshChatsAndNames(): Promise<void> {
  try {
    const allChats = await max.getAllChats();
    if (allChats.length > 0) cachedChats = allChats;
  } catch (err) {
    if (/Недопустимое состояние сессии|while not connected/.test((err as Error).message ?? '')) {
      // MAX's wording for "this connection has no authenticated session" (or the client's own refusal
      // before LOGIN OK) — expected before the first /login on a fresh install (e.g. someone pressed
      // «Пересинхронизация» early); no stack needed.
      logger.warn('CHATS_LIST rejected: no MAX session on this connection (not logged in yet) — using the LOGIN snapshot');
    } else {
      logger.error('Failed to fetch full chat list via CHATS_LIST, using LOGIN snapshot:', err);
    }
  }

  // Only 1:1 dialogs (their topics are named after the other side), in batches: one request with
  // every group member's id grew to thousands and a single failure left every new dialog topic of
  // the resync named «MAX ID <n>». A failed batch keeps what the others fetched.
  const participantIds = dialogParticipantIds(cachedChats, myAccountId);
  if (participantIds.length === 0) return;
  const profiles = new Map(contactProfiles);
  let failed = 0;
  for (let i = 0; i < participantIds.length; i += CONTACT_INFO_BATCH) {
    const batch = participantIds.slice(i, i + CONTACT_INFO_BATCH);
    try {
      const contacts: MaxContactInfo[] = await max.getContactInfo(batch);
      for (const c of contacts) {
        const id = Number(c.id);
        if (!Number.isNaN(id)) profiles.set(id, c);
      }
    } catch (err) {
      failed += batch.length;
      logger.error(`Failed to fetch ${batch.length} contact profile(s) via CONTACT_INFO:`, err);
    }
  }
  contactProfiles = profiles;
  if (failed > 0) logger.warn(`CONTACT_INFO: ${failed} of ${participantIds.length} dialog profile(s) not fetched — those topics may carry a «MAX ID» name until the next refresh`);
}
const CONTACT_INFO_BATCH = 100;

/**
 * Idempotent — safe to call after every LOGIN (fresh auth or a reconnect's
 * resumed session). Rapid reconnects can fire this several times in quick
 * succession; a `null` chatSyncInFlight guard collapses those into one run
 * instead of racing overlapping full-history backfills against each other
 * (a stacked race here corrupted chat-map.json writes live, 2026-08-08).
 * A call that lands while a run is in flight is not just dropped, though: it
 * queues ONE more run for when the current one ends. A reconnect mid-run resets
 * the bridge's caught-up set (ChatCatchUp, bridge/sync.ts), so the chats this run already
 * passed need another pass to catch up on the new gap — until then their
 * cursors stay frozen.
 * /reboot and /kill cancel a run (suspendChatSync) instead of collapsing into it:
 * the run checks its generation before every chat and message and stops.
 */
let chatSyncInFlight: Promise<void> | null = null;
let chatSyncRerun = false;
let chatSyncGeneration = 0;
let chatSyncHolds = 0;
// Set by every catch-up retry request (scheduleCatchUpRetry): a sync run that ends with it still
// false got everything through, and the retry backoff starts over.
let catchUpRetryRequestedDuringRun = false;
// A sync or catch-up retry was dropped (or a pending retry timer cleared) while a hold was active —
// the release makes up for it (see suspendChatSync).
let chatSyncDroppedWhileHeld = false;
function syncChatsIfPossible(): Promise<void> {
  if (!bot || !chatSync) return Promise.resolve();
  // /reboot or /kill is wiping the group — it starts its own run afterwards (or none, for /kill).
  if (chatSyncHolds > 0) {
    chatSyncDroppedWhileHeld = true;
    return Promise.resolve();
  }
  if (chatSyncInFlight) {
    chatSyncRerun = true;
    return chatSyncInFlight;
  }
  const generation = chatSyncGeneration;
  catchUpRetryRequestedDuringRun = false;
  chatSyncInFlight = syncAllChatsToTelegram(
    chatSync,
    cachedChats,
    (chat) => resolveChatName(chat, myAccountId, contactProfiles),
    () => generation !== chatSyncGeneration,
  )
    .catch((err) => {
      catchUpRetryRequestedDuringRun = true; // not a clean run — keep the backoff where it is
      logger.error('Chat sync to Telegram failed:', err);
    })
    .finally(() => {
      chatSyncInFlight = null;
      // A run that needed no retry means the trouble is over: the next one starts at the base delay
      // again (otherwise isolated blips climbed the backoff to the 15-minute cap and stayed there).
      if (!catchUpRetryRequestedDuringRun && generation === chatSyncGeneration) catchUpBackoff.reset();
      if (chatSyncRerun) {
        chatSyncRerun = false;
        void syncChatsIfPossible();
      }
    });
  return chatSyncInFlight;
}

/**
 * /reboot and /kill: cancels the in-flight sync run, waits until it has stopped, and keeps new
 * runs (LOGIN, a scheduled catch-up retry, the panel) from starting until the returned release
 * is called — otherwise the old run goes on over its stale chat snapshot while the wipe deletes
 * topics, refilling them. Whatever the hold swallowed — a pending retry timer, a retry request, a
 * LOGIN's sync — is made up for on release with a scheduled catch-up retry (a failed wipe, or
 * /kill, starts no resync of its own, and the next reconnect may be days away on a stable socket).
 */
async function suspendChatSync(): Promise<() => void> {
  chatSyncHolds += 1;
  chatSyncGeneration += 1;
  chatSyncRerun = false;
  if (catchUpRetryTimer) {
    clearTimeout(catchUpRetryTimer);
    catchUpRetryTimer = null;
    chatSyncDroppedWhileHeld = true;
  }
  if (chatSyncInFlight) await chatSyncInFlight; // never rejects — the run's .catch() logs
  let released = false;
  return () => {
    if (released) return;
    released = true;
    chatSyncHolds -= 1;
    if (chatSyncHolds === 0 && chatSyncDroppedWhileHeld) {
      chatSyncDroppedWhileHeld = false;
      scheduleCatchUpRetry('a catch-up was held off during /reboot or /kill');
    }
  };
}

/**
 * Catch-up retries after a transient failure (a live delivery or a backfill that hit a
 * Telegram/proxy outage, a failed topic restore — reported through chatSync.requestRetry): a
 * Telegram outage causes no MAX LOGIN, so the chats it hit would otherwise stay behind. One timer
 * at a time, backing off (RetryBackoff); each firing first checks that Telegram answers (getMe) and waits again if not,
 * so an outage is polled, not spun on. MAX being down is left to the LOGIN on reconnect, which
 * syncs anyway.
 */
const catchUpBackoff = new RetryBackoff();
let catchUpRetryTimer: ReturnType<typeof setTimeout> | null = null;
function scheduleCatchUpRetry(reason: string): void {
  catchUpRetryRequestedDuringRun = true;
  if (catchUpRetryTimer) return;
  if (chatSyncHolds > 0) {
    chatSyncDroppedWhileHeld = true;
    return;
  }
  const delay = catchUpBackoff.next();
  logger.info(`Catch-up sync scheduled in ${Math.round(delay / 1000)}s: ${reason}`);
  catchUpRetryTimer = setTimeout(() => {
    catchUpRetryTimer = null;
    void runCatchUpRetry();
  }, delay);
  catchUpRetryTimer.unref?.();
}

async function runCatchUpRetry(): Promise<void> {
  const bot_ = bot;
  // Only over an accepted LOGIN: paused (or /kill), or on a socket whose LOGIN failed, every retry
  // would fail each chat on "not connected" and re-arm itself — the LOGIN that succeeds syncs.
  if (!bot_ || maxSession.state !== 'loggedIn') return;
  try {
    await bot_.telegram.getMe();
  } catch (err) {
    if (isTransientTelegramError(err)) {
      scheduleCatchUpRetry('Telegram still unreachable');
    } else {
      logger.error('Catch-up retry: Telegram refused getMe — not retrying', err);
    }
    return;
  }
  // A chat born during the outage (its topic never got created, so no mapping either) is in
  // neither the LOGIN snapshot nor the mappings — refresh the snapshot so the sync sees it.
  await refreshChatsAndNames().catch((err) => logger.error('Catch-up retry: refreshing the chat list failed', err));
  void syncChatsIfPossible();
}

/** /kill: the controller closes the connection and deletes the session; every in-memory cache derived from the old account goes with it so nothing lingers after a different number logs in later. */
async function killMaxSession(): Promise<void> {
  await maxSession.kill();
  cachedChats = [];
  myAccountId = null;
  contactProfiles = new Map();
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

/** Inline keyboard: a deep link into the bot's DM that kicks off the /login flow. undefined until the bot knows its own @username (Telegraf sets botInfo during launch). */
function maxLoginKeyboard(): { reply_markup: { inline_keyboard: { text: string; url: string }[][] } } | undefined {
  const username = bot?.botInfo?.username;
  if (!username) return undefined;
  return { reply_markup: { inline_keyboard: [[{ text: '🔐 Войти в MAX', url: `https://t.me/${username}?start=login` }]] } };
}

async function startServer(): Promise<void> {
  // Production only: `npm run dev` restarts on every save and would look like a restart loop.
  if (process.env.NODE_ENV === 'production') void noteBoot();
  // --- MAX client wiring: the lifecycle events go to the controller, the rest is cache upkeep ---
  max.on('error', (err: Error) => logger.error('MAX client error:', err.message));
  // An undecodable frame on a live socket: diagnostic only, nothing waiting on the socket fails.
  max.on('decode-error', (err: Error) => logger.warn('MAX frame could not be decoded, skipped:', err.message));

  max.on('message', (event: MaxMessageEvent) => {
    if (event.opcode === OPCODES.PUSH_MESSAGE || (event.opcode === OPCODES.MSG_SEND && event.dir === DIR.OK)) {
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

  maxSession.start(await sessionStore.load());

  // Build the Telegram proxy agent (TELEGRAM_PROXY from .env) before the bot is
  // built — Telegraf binds its agent at construction time, so this has to run
  // first. No-op when no proxy is configured.
  initTelegramProxy();

  // --- Telegram bot (optional — bridge stays dormant without credentials) ---
  if (config.telegramEnabled) {
    bot = createBotSafely(config.telegramBotToken);
    if (bot) {
      // Without this, telegraf's default handler rethrows a handler error (or its 90 s
      // handlerTimeout), which stops the polling loop until retryTelegramLaunch restarts it, sets
      // process.exitCode = 1 and console.error()s the raw update — with a /login DM step in it,
      // an SMS code or the 2FA password. Log the update TYPE only.
      bot.catch((err, ctx) => {
        // The 90 s handlerTimeout only stops waiting: the handler (a big upload, a /login step's
        // chat refresh) keeps running and usually succeeds — no false error notice.
        if ((err as Error)?.name === 'TimeoutError') {
          logger.warn(`Telegram handler still running past telegraf's 90 s limit (update type: ${ctx.updateType})`);
          return;
        }
        logger.error(`Telegram handler failed (update type: ${ctx.updateType}):`, err);
        reportBridgeError(
          'telegram-handler-error',
          '⚠️ Ошибка при обработке сообщения или команды из Telegram — подробности в логах контейнера (docker compose logs).',
        );
        void reportError({ kind: 'internal', step: 'telegram-handler', error: err });
      });
      ({ chatSync } = wireBridge({
        max,
        bot,
        chatMapStore,
        targetGroupId: config.targetTelegramGroup,
        getChats: () => cachedChats,
        getMyAccountId: () => myAccountId,
        getContactProfiles: () => contactProfiles,
        getActivePhone: () => maxSession.activePhone,
        getMaxState: () => maxSession.status(),
        triggerFullResync: () => refreshChatsAndNames().then(() => syncChatsIfPossible()),
        killEverything: killMaxSession,
        suspendChatSync,
        auth: {
          getLastKnownPhone: () => maxSession.lastKnownPhone,
          requestSms: (phone) => maxSession.requestSms(phone),
          verifyCode: (code) => maxSession.verifyCode(code),
          checkPassword: (password) => maxSession.checkPassword(password),
        },
        pause: {
          start: (seconds) => maxSession.pause(seconds),
          stop: () => maxSession.unpause(),
          until: () => maxSession.pausedUntil,
        },
      }));
      chatSync.setRetryHandler(scheduleCatchUpRetry);
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
  // backfill resumes where it left off either way. A FILE/VIDEO whose download dies with the
  // socket stops that backfill before the cursor passes it (TransientDownloadError).
  const shutdown = (signal: string): void => {
    logger.info(`Received ${signal}, shutting down`);
    try {
      bot?.stop(signal);
    } catch {
      // bot may not have launched (bad token, mid-retry) — nothing to stop
    }
    maxSession.shutdown();
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
// (confirmed 2026-08-15). /help and /status inside the group show it only masked (+7999***9999).
// A constant, so it's set once at Telegram launch. The command list comes from BOT_COMMANDS, so
// the profile never drifts from the "/" menu (it used to miss /panel, /rename and /setdesc) —
// mind the 512 limit when adding commands (503 chars with today's 20 — /file was the last that fit).
function buildBotDescription(): string {
  return `Мост MAX ↔ Telegram: сообщения, файлы, голосовые, стикеры, опросы, пересылка. Звонки — только уведомления, без аудио.

Удаление: свайпом своего (подхватится сам), реакцией 👎 на своё или /delete ответом (/delete me — только у себя).

Ограничения:
• Голоса за опрос из MAX сами не появляются в Telegram — счёт через /poll ответом на опрос.

Команды: ${BOT_COMMANDS.map((c) => `/${c.command}`).join(' ')}`;
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
  { command: 'file', description: 'Большой файл в MAX по ссылке (в теме, до 4 ГБ)' },
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

/**
 * update.sh (run by the host-side update-watcher, see setup.sh) writes this with the new commit's
 * SHA right before restarting the container — read once on startup so the update isn't silent.
 * Only its presence counts (the notice names the version, not the commit); an empty or truncated
 * marker is ignored rather than announced.
 */
async function reportIfJustUpdated(bot: Telegraf): Promise<void> {
  let marker: string;
  try {
    marker = (await readFile(UPDATE_COMPLETED_MARKER, 'utf8')).trim();
  } catch {
    return;
  }
  await unlink(UPDATE_COMPLETED_MARKER).catch(() => {});
  if (!marker) return;
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

// Polling that ran at least this long before it stopped counts as a fresh failure: the retry
// delay starts over instead of staying at the 60 s cap accumulated over the process's life.
const TELEGRAM_STABLE_POLLING_MS = 10 * 60_000;

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

  // Best-effort, once per launch: the profile description (a constant — see buildBotDescription)
  // lists the command surface, how deletion works and the platform-level gap a user could
  // otherwise spend time re-discovering (Telegram's poll widget can't receive a MAX-side vote).
  bot.telegram.setMyDescription(buildBotDescription()).catch((err) => logger.error('Failed to set bot description', err));
  bot.telegram.setMyCommands(BOT_COMMANDS).catch((err) => logger.error('Failed to set bot commands', err));
  void reportIfJustUpdated(bot);
  // SessionStore parked an unreadable session file (corrupt, or encrypted with a different
  // MAX_SESSION_KEY — the usual cause is restoring ./data without carrying .env across). The bridge
  // is up but unauthenticated, so say so in the group with the same re-auth prompt a rejected
  // session gets; otherwise it just sits there silently doing nothing.
  if (sessionStore.corruptedOnLoad) maxSession.notifyReauthNeeded();
  void announceGroupReadyOnce(bot);

  // message_reaction and poll_answer are opt-in — Telegram omits them from the default update set unless
  // requested. callback_query has to be listed explicitly too once you restrict allowedUpdates at all —
  // it's normally on by default, but an explicit list overrides that default rather than adding to it, so
  // leaving it out here silently dropped every inline-keyboard button press (/version's Обновить/Позже)
  // with no error anywhere: Telegram just never delivered the update. /donate's buttons never surfaced
  // this because they're url buttons, which the client opens directly without involving the bot at all.
  const launchedAt = Date.now();
  bot
    .launch({ allowedUpdates: ['message', 'edited_message', 'message_reaction', 'poll_answer', 'callback_query'] })
    .catch((err) => retryTelegramLaunch(bot, Date.now() - launchedAt >= TELEGRAM_STABLE_POLLING_MS ? 0 : attempt, err));
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

// A startup failure must end the process so Docker (restart: unless-stopped) restarts it. Only
// setting exitCode left it running whenever max.connect() had already opened its socket — e.g. a
// bad TELEGRAM_PROXY: MAX connected, no Telegram bot, a live but useless container (review
// 2026-09-26, A13). The short delay lets the log line reach stdout first.
startServer().catch(async (err) => {
  logger.error('Fatal startup error:', err);
  try {
    maxSession.shutdown();
  } catch {
    // exiting anyway
  }
  // Bounded: an unreachable report endpoint must not hold the restart back.
  await Promise.race([reportError({ kind: 'fatal', error: err }), new Promise((resolve) => setTimeout(resolve, 3_000))]);
  setTimeout(() => process.exit(1), 500);
});
