import dns from 'node:dns';
import { Telegraf } from 'telegraf';
import path from 'node:path';
import { readFile, unlink, writeFile } from 'node:fs/promises';
import { MaxClient, isMaxServerError, type MaxMessageEvent, type MaxContactInfo } from '../max/client.js';
import { DIR, OPCODES } from '../max/opcodes.js';
import { dialogParticipantIds, extractMyAccountId, resolveChatName, type ContactProfile } from '../max/names.js';
import { SessionStore, type MaxSession } from '../store/sessionStore.js';
import { ChatMapStore } from '../store/chatMapStore.js';
import { wireBridge, syncAllChatsToTelegram, MessageLinkStore } from '../bridge/sync.js';
import { RetryBackoff, type CatchUpTracker } from '../bridge/catchUp.js';
import { isTransientTelegramError } from '../bridge/transient.js';
import { clearPause, isMaxPaused } from '../bridge/panel.js';
import { MaxAuthUnavailableError } from '../bridge/maxAuthFlow.js';
import { configureErrorReporter, reportBridgeError, resetErrorKey } from '../bridge/errorReporter.js';
import { getAppVersion } from '../bridge/version.js';
import { maskPhone } from '../bridge/status.js';
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
let catchUp: CatchUpTracker | null = null;
let tgActive = false;
let maxConnected = false;
let lastLoginAt: number | null = null; // set on every successful LOGIN (fresh or resumed) — shown in the panel's status
let activePhone = '';
let pendingPhone = '';
// The phone we last authenticated with. Unlike currentSession/activePhone (wiped on a session
// rejection), this SURVIVES so the Telegram /login flow can offer "re-auth with +7999***9999?" after a
// reconnect failure — two taps instead of retyping the number. Cleared only by /kill or change-number.
let lastKnownPhone = '';
let pendingAuthToken: string | null = null;
/** Set when verifyCode() comes back password_required — cleared only on a successful login, since the trackId survives a wrong password and can be retried (confirmed live 2026-08-14). */
let pendingPasswordTrackId: string | null = null;
// When the /login auth chain (START_AUTH -> CHECK_CODE -> LOGIN) started on the current socket; null
// when none runs. A pending resume retry defers itself while it is fresh (scheduleResumeReconnect).
// Bounded by AUTH_CHAIN_TTL_MS, the /login flow's own lifetime: an abandoned flow never ends it.
let authChainStartedAt: number | null = null;
const AUTH_CHAIN_TTL_MS = 10 * 60_000;
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
  // the resync named «MAX ID <n>» (review 2026-09-26, C5/b5-delivery). A failed batch keeps what
  // the others fetched, merged into the profiles we already had.
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

/** Shared tail end of both auth paths (plain SMS, and SMS + password) — exchanges a login token for a session and persists it. */
async function completeMaxLogin(loginToken: string): Promise<void> {
  let login: Awaited<ReturnType<typeof max.login>>;
  try {
    login = await max.login(loginToken);
  } catch (err) {
    // The SMS code (or password) is spent by now: «пришлите ещё раз» only hit «no pending auth».
    // The chain is over, so a pending resume retry no longer defers to it (review 2026-09-27, client-r3.1#2).
    authChainStartedAt = null;
    // The raw client error is English or carries log-only diagnostics — logged, not shown (client-r3.2#1).
    logger.error('LOGIN after a successful auth chain failed', err);
    throw new MaxAuthUnavailableError(`Не удалось завершить вход в MAX: ${isMaxServerError(err) ? 'MAX отклонил вход' : 'MAX не ответил'}. Начните заново: /login`);
  }
  const session: MaxSession = {
    sessionToken: login.sessionToken,
    phone: pendingPhone,
    deviceId: max.deviceId,
    savedAt: new Date().toISOString(),
  };
  // In memory at once, like a resumed LOGIN: set only after the refresh and the save, a failed write
  // or a reconnect meanwhile left a relaying bridge that /status called unauthorized and that never
  // logged in again (review 2026-09-27, client-r3.1#1).
  currentSession = session;
  activePhone = session.phone;
  lastKnownPhone = session.phone;
  // No group notice from here: the /login flow (maxAuthFlow.announceAuthed) already posts
  // «✅ MAX-авторизация восстановлена.» to the group, and this used to post it a second time
  // (review 2026-09-26, client-r1#5). A resumed LOGIN keeps its own group notice.
  maxSessionLostReported = false;
  // A pending resume retry must not reconnect over this socket (review 2026-09-26, b3-liveness).
  noteLoginSucceeded();
  applyLoginPayload(login.payload);
  try {
    await sessionStore.save(session);
  } catch (err) {
    logger.error('MAX login succeeded but the session could not be saved to disk — running on the in-memory copy:', err);
    reportBridgeError('session-save-failed', SESSION_SAVE_FAILED_TEXT);
  }
  await refreshChatsAndNames();
  void syncChatsIfPossible();
}

const SESSION_SAVE_FAILED_TEXT =
  '⚠️ Не удалось сохранить MAX-сессию на диск (нет места или нет прав на папку data?). Мост работает, но после перезапуска может понадобиться повторный вход. Подробности в логах контейнера (docker compose logs).';

/** Bookkeeping shared by both successful LOGIN paths (fresh auth and a resumed session). */
function noteLoginSucceeded(): void {
  clearResumeRetryTimer();
  authChainStartedAt = null;
  resumeFailures = 0;
  resumeBackoff.reset();
  lastLoginAt = Date.now();
  // With a session, "MAX is up" means a LOGIN went through, not just INIT (client-r2#1).
  noteMaxUp();
}

// --- MAX auth steps: driven by the Telegram /login flow (maxAuthFlow.ts) — the only way to log in ---

async function maxAuthRequestSms(rawPhone: string): Promise<void> {
  const phone = rawPhone.replace(/[^\d+]/g, '');
  if (!phone) throw new Error('Пустой номер телефона');
  // No active session (first login / re-auth after loss / change-number): bring up a FRESH socket
  // first — a socket left over from a rejected session refuses START_AUTH (hit live 2026-08-18).
  // A panel pause (max.disconnect()) emits no 'disconnected', so maxConnected alone kept reading true:
  // /login then failed on a raw «MaxClient.send called while not connected», or — without a session —
  // connect() quietly lifted the pause while the panel still showed it, and the pause timer's own
  // connect() later tore down the socket the SMS auth chain ran on (review 2026-09-26, client-r1#2).
  if (!currentSession) {
    clearPause(); // this login needs the connection: the pause ends here, timer included
    await freshConnectForAuth();
  } else if (isMaxPaused()) {
    // Typed: the /login flow shows these alone and ends, no «Проверьте номер…» (client-r2#2).
    throw new MaxAuthUnavailableError('MAX на паузе — снимите паузу в /panel (▶️ Возобновить MAX) и повторите /login.');
  } else if (!maxConnected || max.stoppedByUser) {
    throw new MaxAuthUnavailableError('Нет связи с MAX — подождите минуту и повторите /login.');
  }
  // An auth chain (START_AUTH -> CHECK_CODE -> LOGIN) now runs on this socket: a pending resume
  // retry defers itself meanwhile instead of tearing the socket down under the user typing the SMS
  // code (b3-liveness). It is NOT cleared: it is the only thing that reconnects after a rejected or
  // timed-out resume LOGIN, and clearing it here left the bridge on that dead socket for good when
  // START_AUTH then failed («Недопустимое состояние сессии») or the user abandoned the flow (review
  // 2026-09-26, client-r2#0).
  authChainStartedAt = Date.now();
  try {
    pendingAuthToken = await max.requestSms(phone);
  } catch (err) {
    authChainStartedAt = null;
    throw err;
  }
  pendingPhone = phone;
}

async function maxAuthVerifyCode(code: string): Promise<{ ok: true } | { passwordRequired: true; hint: string | null }> {
  if (!pendingAuthToken) throw new MaxAuthUnavailableError('Код уже использован или устарел — начните заново: /login');
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
  if (!pendingPasswordTrackId) throw new MaxAuthUnavailableError('Проверка пароля уже завершена или устарела — начните заново: /login');
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
 * A call that lands while a run is in flight is not just dropped, though: it
 * queues ONE more run for when the current one ends. A reconnect mid-run resets
 * the bridge's caught-up set (bridge/catchUp.ts), so the chats this run already
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
  if (!bot || !messageLinks) return Promise.resolve();
  // /reboot or /kill is wiping the group — it starts its own run afterwards (or none, for /kill).
  if (chatSyncHolds > 0) {
    chatSyncDroppedWhileHeld = true;
    return Promise.resolve();
  }
  if (chatSyncInFlight) {
    chatSyncRerun = true;
    return chatSyncInFlight;
  }
  const bot_ = bot;
  const messageLinks_ = messageLinks;
  const generation = chatSyncGeneration;
  catchUpRetryRequestedDuringRun = false;
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
    catchUp ?? undefined,
    () => generation !== chatSyncGeneration,
  )
    .catch((err) => {
      catchUpRetryRequestedDuringRun = true; // not a clean run — keep the backoff where it is
      logger.error('Chat sync to Telegram failed:', err);
    })
    .finally(() => {
      chatSyncInFlight = null;
      // A run that needed no retry means the trouble is over: the next one starts at the base delay
      // again. Without this the backoff only started over after a quiet HOUR, so isolated blips
      // (each fixed by one retry) climbed to the 15-minute cap and stayed there (review 2026-09-26,
      // b2b-errors).
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
 * is called. Before, the old run went on over its stale chat snapshot while the wipe deleted
 * topics — refilling them, recreating them after /kill, and swallowing /reboot's own resync
 * (review 2026-09-26, C7).
 * Whatever the hold swallowed — a pending retry timer, a retry request, a LOGIN's sync — is made
 * up for on release with a scheduled catch-up retry. A successful /reboot starts its own resync
 * anyway, but a failed wipe (or /kill, which leaves MAX down — the retry then stands down) did
 * nothing, and the swallowed catch-up waited for the next reconnect, possibly days on a stable
 * socket (review 2026-09-26, catchup-r1#3).
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
 * Telegram/proxy outage, a failed topic restore — reported through catchUp.requestRetry). Before,
 * only a MAX LOGIN ever ran a catch-up, and a Telegram outage doesn't cause one, so the chats it
 * hit stayed behind (review 2026-09-26, RECOVERY5). One timer at a time, backing off
 * (RetryBackoff); each firing first checks that Telegram answers (getMe) and waits again if not,
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
  // Paused from the panel (or /kill): MAX is down on purpose — the LOGIN after the resume syncs.
  // max.stoppedByUser, not maxConnected alone: a pause drops the socket without a 'disconnected'
  // event, and every retry then failed each chat on "not connected" and re-armed itself for as
  // long as the pause lasted (review 2026-09-26, cross). max.loggedIn too: maxConnected is TLS-level
  // only, and on a socket whose LOGIN failed or timed out every chat failed on "not connected" the
  // same way — the LOGIN that succeeds syncs (review 2026-09-27, client-r3.2#0).
  if (!bot_ || !maxConnected || max.stoppedByUser || !max.loggedIn) return;
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
  void syncChatsIfPossible();
}

/**
 * /kill's full teardown: disconnects the live MAX connection (closedByUser — no
 * auto-reconnect) and deletes the encrypted session so nothing short of a fresh
 * SMS login via /login in the bot's DM can bring the bridge back. Also resets every
 * in-memory cache derived from the old account so nothing lingers after a
 * different number logs in later. The server process itself keeps running —
 * only the MAX-side identity is torn down, not the whole service.
 */
async function killMaxSession(): Promise<void> {
  max.disconnect();
  clearResumeRetryTimer(); // a pending resume retry would max.connect() right back
  clearPause(); // ...and so would a panel pause's timer (review 2026-09-26, client-r1#2)
  await sessionStore.clear();
  currentSession = null;
  activePhone = '';
  pendingPhone = '';
  lastKnownPhone = '';
  pendingAuthToken = null;
  authChainStartedAt = null;
  cachedChats = [];
  myAccountId = null;
  contactProfiles = new Map();
  maxConnected = false;
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
// Only a server REJECTION (an ERR answer to LOGIN, MaxServerError) counts toward resumeFailures.
// A timeout, a socket error or a bad frame says nothing about the token: those just reconnect
// with backoff (resumeBackoff) and never wipe the session — before, three network blips in a row
// deleted a valid session and demanded a fresh SMS (review 2026-09-26, RECOVERY4).
let resumeFailures = 0;
let resumeInFlight = false;
const MAX_RESUME_RETRIES = 3;
const RESUME_RETRY_DELAY_MS = 5_000;
const resumeBackoff = new RetryBackoff(5_000, 60_000);
let resumeRetryTimer: ReturnType<typeof setTimeout> | null = null;

/**
 * Reconnects a fresh socket after `delayMs` so 'ready' retries the resume LOGIN. One timer at a time;
 * every successful LOGIN clears it (noteLoginSucceeded). connect() tears down whatever socket there
 * is and clears the client's own "stopped" flag, so the timer stands down when a LOGIN is running,
 * when MAX was stopped on purpose (a stale timer used to quietly lift a pause or undo /kill), and
 * when the socket is down — the client is then already reconnecting and its 'ready' retries the
 * LOGIN, which a connect() here would only cut short (review 2026-09-26, M14).
 */
function scheduleResumeReconnect(delayMs: number): void {
  clearResumeRetryTimer();
  resumeRetryTimer = setTimeout(() => {
    resumeRetryTimer = null;
    if (resumeInFlight || max.stoppedByUser || !maxConnected) return;
    // A /login auth chain runs on this socket: look again later instead of tearing it down under
    // the user typing the SMS code — kept pending, not dropped (client-r2#0).
    if (authChainStartedAt != null && Date.now() - authChainStartedAt < AUTH_CHAIN_TTL_MS) {
      scheduleResumeReconnect(delayMs);
      return;
    }
    max.connect();
  }, delayMs);
}

function clearResumeRetryTimer(): void {
  if (resumeRetryTimer) {
    clearTimeout(resumeRetryTimer);
    resumeRetryTimer = null;
  }
}

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
      reject(new MaxAuthUnavailableError('MAX не ответил при переподключении для авторизации — подождите минуту и повторите /login.'));
    }, timeoutMs);
    max.once('ready', onReady);
    max.connect(); // tears down any stale socket and starts a fresh INIT
  });
}

async function loginWithSession(session: MaxSession): Promise<void> {
  if (resumeInFlight) return; // two 'ready' events (e.g. a racy reconnect) must not double-LOGIN
  resumeInFlight = true;
  try {
    let login: Awaited<ReturnType<MaxClient['login']>>;
    try {
      login = await max.login(session.sessionToken);
    } catch (err) {
      await onResumeLoginFailed(err);
      return;
    }
    const { sessionToken, payload } = login;
    noteLoginSucceeded();
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
    currentSession = refreshed;
    // A failed write (disk full, EACCES) is not a session failure: LOGIN succeeded and the token in
    // memory is valid, so keep running on it. Counting it as one used to reconnect with the OLD
    // token and, on the third try, delete a valid session (review 2026-09-26, C9).
    try {
      await sessionStore.save(refreshed);
    } catch (err) {
      logger.error('MAX login succeeded but the refreshed session could not be saved to disk — running on the in-memory copy:', err);
      reportBridgeError('session-save-failed', SESSION_SAVE_FAILED_TEXT);
    }
    logger.info(`Resumed session for ${maskPhone(session.phone)} (token ${sessionToken === session.sessionToken ? 'unchanged' : 'rotated'})`);
    notifyMaxSessionRestored();
    await refreshChatsAndNames();
    void syncChatsIfPossible();
  } finally {
    resumeInFlight = false;
  }
}

/** The resume LOGIN threw — see the note above resumeFailures for which failures count. */
async function onResumeLoginFailed(err: unknown): Promise<void> {
  const msg = err instanceof Error ? err.message : String(err);
  if (!isMaxServerError(err)) {
    // Timeout (an undecodable answer ends up here too) or a lost socket: nothing is known about
    // the token. Reconnect with backoff; the session stays as it is. After a lost socket the
    // client is already reconnecting and the timer stands down (scheduleResumeReconnect).
    const delay = resumeBackoff.next();
    logger.warn(`Resume login did not complete (not a rejection), reconnecting in ${Math.round(delay / 1000)}s: ${msg}`);
    scheduleResumeReconnect(delay);
    // This loop (reconnect, INIT OK, LOGIN times out) never emits 'disconnected': without arming
    // the outage notice here a LOGIN that never completes went on silently forever (client-r2#1).
    armMaxDownNotice();
    return;
  }
  resumeFailures += 1;
  if (resumeFailures < MAX_RESUME_RETRIES) {
    // The socket stays up after a rejected LOGIN (no 'disconnected' fires). Reconnect a fresh
    // socket and let 'ready' retry rather than nuking a possibly-still-valid session on one
    // transient miss — a single failure used to brick the bridge until a manual SMS re-auth.
    logger.warn(`Resume login rejected (attempt ${resumeFailures}/${MAX_RESUME_RETRIES}), reconnecting to retry: ${msg}`);
    scheduleResumeReconnect(RESUME_RETRY_DELAY_MS);
  } else {
    resumeFailures = 0;
    logger.warn('Saved session was rejected after retries, clearing it:', msg);
    currentSession = null;
    activePhone = '';
    // lastKnownPhone deliberately kept — the re-auth flow offers a one-tap "войти с +7999***9999?".
    await sessionStore.clear().catch((clearErr) => logger.error('Failed to delete the rejected session file', clearErr));
    // The connection itself is up (the server answered): without a session that is all "MAX is up"
    // means, and the re-auth notice below replaces an outage notice (client-r2#1).
    noteMaxUp();
    // The bridge is functionally dead until someone re-authenticates. Prompt the in-bot flow.
    notifyReauthNeeded();
  }
}

// --- MAX outage notice ---
// A brief MAX drop during a reconnect is normal and shouldn't ping the group — only a sustained
// outage (still down 60s later) earns an operator notice, paired with a "recovered" once it's back.
// "Back" means a LOGIN went through when there is a session (noteLoginSucceeded), and INIT OK
// ('ready') only without one. Clearing it on INIT alone let a LOGIN that never completes — timing
// out on every retry, or the socket reset right after INIT — go on without any notice while /status
// read «подключён» (review 2026-09-26, client-r2#1). Not on the TLS handshake ('connected') either:
// a server that accepts TLS and drops the socket right away restarted the 60 s window on every
// attempt (review 2026-09-26, M4).
let maxDownTimer: ReturnType<typeof setTimeout> | null = null;
let maxDownReported = false;

/** Starts the 60 s outage window unless one runs or an outage is already reported. */
function armMaxDownNotice(): void {
  if (maxDownTimer != null || maxDownReported) return;
  maxDownTimer = setTimeout(() => {
    maxDownTimer = null;
    // Stopped on purpose meanwhile (panel pause, /kill — max.disconnect() emits nothing): no
    // reconnect is coming, so «пытаюсь переподключиться» would be false (review 2026-09-26,
    // client-r1#4).
    if (max.stoppedByUser) return;
    maxDownReported = true;
    // Every reported loss gets its «✅» — 'max-up' has its own cooldown, which used to swallow
    // the recovery of a second outage within 10 minutes while its «❌» went out.
    resetErrorKey('max-up');
    reportBridgeError('max-down', '❌ Потеряна связь с MAX. Пытаюсь переподключиться…');
  }, 60_000);
}

/** MAX is up again: cancels a running outage window, and reports the recovery of a reported outage. */
function noteMaxUp(): void {
  if (maxDownTimer) {
    clearTimeout(maxDownTimer);
    maxDownTimer = null;
  }
  if (maxDownReported) {
    maxDownReported = false;
    resetErrorKey('max-down');
    reportBridgeError('max-up', '✅ Связь с MAX восстановлена.');
  }
}

async function startServer(): Promise<void> {
  currentSession = await sessionStore.load();
  if (currentSession) lastKnownPhone = currentSession.phone;

  // --- MAX client wiring ---
  max.on('connected', () => {
    maxConnected = true;
  });

  max.on('ready', () => {
    if (currentSession) void loginWithSession(currentSession);
    else noteMaxUp();
  });

  max.on('disconnected', () => {
    maxConnected = false;
    // An auth chain dies with its socket.
    authChainStartedAt = null;
    // The client reconnects on its own and 'ready' retries the LOGIN; a pending resume retry
    // would only cut that attempt short (review 2026-09-26, M14).
    clearResumeRetryTimer();
    armMaxDownNotice();
  });

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

  max.connect();

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
      // an SMS code or the 2FA password (review 2026-09-26, C2). Log the update TYPE only.
      bot.catch((err, ctx) => {
        // The 90 s handlerTimeout only stops waiting: the handler (a big upload, a /login step's
        // chat refresh) keeps running and usually succeeds — no false error notice (client-r3.3#3).
        if ((err as Error)?.name === 'TimeoutError') {
          logger.warn(`Telegram handler still running past telegraf's 90 s limit (update type: ${ctx.updateType})`);
          return;
        }
        logger.error(`Telegram handler failed (update type: ${ctx.updateType}):`, err);
        reportBridgeError(
          'telegram-handler-error',
          '⚠️ Ошибка при обработке сообщения или команды из Telegram — подробности в логах контейнера (docker compose logs).',
        );
      });
      ({ messageLinks, catchUp } = wireBridge({
        max,
        bot,
        chatMapStore,
        targetGroupId: config.targetTelegramGroup,
        getChats: () => cachedChats,
        getMyAccountId: () => myAccountId,
        getContactProfiles: () => contactProfiles,
        getActivePhone: () => activePhone,
        // Connected = LOGIN accepted while a session exists: a socket whose LOGIN keeps failing read
        // «🟢 подключён» next to «❌ Потеряна связь с MAX» (review 2026-09-27, client-r3.2#0).
        getMaxState: () => ({ connected: maxConnected && (max.loggedIn || !currentSession), lastLoginAt }),
        triggerFullResync: () => refreshChatsAndNames().then(() => syncChatsIfPossible()),
        killEverything: killMaxSession,
        suspendChatSync,
        auth: {
          getLastKnownPhone: () => lastKnownPhone,
          requestSms: maxAuthRequestSms,
          verifyCode: maxAuthVerifyCode,
          checkPassword: maxAuthCheckPassword,
        },
      }));
      catchUp?.setRetryHandler(scheduleCatchUpRetry);
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
  // socket stops that backfill before the cursor passes it (TransientDownloadError), instead
  // of leaving a text placeholder behind for good (review 2026-09-26, RECOVERY3).
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
// (confirmed 2026-08-15). /help and /status inside the group show it only masked (+7999***9999).
// A constant, so it's set once at Telegram launch. The command list comes from BOT_COMMANDS, so
// the profile never drifts from the "/" menu (it used to miss /panel, /rename and /setdesc) —
// mind the 512 limit when adding commands (the text is ~500 chars with today's 19).
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
  if (sessionStore.corruptedOnLoad) notifyReauthNeeded();
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
startServer().catch((err) => {
  logger.error('Fatal startup error:', err);
  try {
    max.disconnect();
  } catch {
    // exiting anyway
  }
  setTimeout(() => process.exit(1), 500);
});
