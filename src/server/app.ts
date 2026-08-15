import express from 'express';
import { createServer } from 'node:http';
import { createServer as createTlsServer } from 'node:https';
import net from 'node:net';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { WebSocketServer, type WebSocket } from 'ws';
import { Telegraf } from 'telegraf';
import path from 'node:path';
import { chmod, mkdir, readFile, unlink } from 'node:fs/promises';
import { MaxClient, type MaxMessageEvent, type MaxContactInfo } from '../max/client.js';
import { OPCODES, formatOpcode } from '../max/opcodes.js';
import { extractMyAccountId, resolveChatName, type ContactProfile } from '../max/names.js';
import { SessionStore, type MaxSession } from '../store/sessionStore.js';
import { ChatMapStore } from '../store/chatMapStore.js';
import { wireBridge, syncAllChatsToTelegram, MessageLinkStore } from '../bridge/sync.js';
import { shortSha } from '../bridge/version.js';
import { createLogger, jsonStringify, redactSecrets } from '../logger.js';
import { config } from './config.js';
import { isValidApiKey, requireApiKey } from './authMiddleware.js';

const logger = createLogger('server');
const startedAt = Date.now();

// One bad handler shouldn't take down MAX auth, the Telegram bot, and every other
// in-flight session — log and keep running instead of letting Node's default
// "crash the process" behavior undo all the reconnect/retry work elsewhere.
process.on('unhandledRejection', (reason) => logger.error('Unhandled rejection:', reason));
process.on('uncaughtException', (err) => logger.error('Uncaught exception:', err));

const sessionStore = new SessionStore();
const chatMapStore = new ChatMapStore();
const max = new MaxClient();

let bot: Telegraf | null = null;
let messageLinks: MessageLinkStore | null = null;
let tgActive = false;
let maxConnected = false;
let activePhone = '';
let pendingPhone = '';
let pendingAuthToken: string | null = null;
/** Set when verifyCode() comes back password_required — cleared only on a successful login, since the trackId survives a wrong password and can be retried (confirmed live 2026-08-14). */
let pendingPasswordTrackId: string | null = null;
let currentSession: MaxSession | null = null;
let latestLatencyMs: number | null = null;
let packetsSent = 0;
let packetsReceived = 0;
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
  broadcastStatus();
  refreshBotDescription();
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
  pendingAuthToken = null;
  cachedChats = [];
  myAccountId = null;
  contactProfiles = new Map();
  maxConnected = false;
  broadcastStatus();
  refreshBotDescription();
}

/** Keeps the LOGIN-derived chat snapshot from going stale as messages flow in either direction. Ids compare via String() — cached ids can be number OR BigInt (channels), and a strict === across those types silently never matches. */
function patchCachedChatLastMessage(chatId: unknown, lastMessage: unknown): void {
  const key = String(chatId);
  const chat = cachedChats.find((c) => c && typeof c === 'object' && String((c as { id?: unknown }).id) === key);
  if (chat) (chat as { lastMessage: unknown }).lastMessage = lastMessage;
}

interface UiLogEntry {
  time: string;
  opcode: string;
  dir: string;
  size: string;
  payload: string;
}

const packetLogs: UiLogEntry[] = [];
const uiClients = new Set<WebSocket>();

function broadcast(message: unknown): void {
  const data = JSON.stringify(message);
  for (const client of uiClients) {
    if (client.readyState === client.OPEN) client.send(data);
  }
}

function broadcastStatus(): void {
  broadcast({
    type: 'status',
    data: {
      max: maxConnected,
      tg: tgActive,
      deviceId: max.deviceId,
      phone: activePhone,
      latencyMs: latestLatencyMs,
    },
  });
}

function pushLog(dir: string, opcode: number, length: number, payload: unknown): void {
  const entry: UiLogEntry = {
    time: new Date().toISOString().substring(11, 23),
    opcode: formatOpcode(opcode),
    dir,
    size: `${length} B`,
    payload: jsonStringify(redactSecrets(payload)),
  };
  packetLogs.push(entry);
  if (packetLogs.length > 50) packetLogs.shift();
  broadcast({ type: 'log', data: entry });
}

const execFileAsync = promisify(execFile);
const TLS_DIR = path.join(process.cwd(), '.data', 'tls');

/** What /apikey should build its login link with — flips to 'https' once the panel actually boots with a certificate (not just intends to), so the link never points at a scheme the server isn't serving. */
let panelScheme: 'http' | 'https' = 'http';

/**
 * Self-signed TLS for the web panel. Installs are typically bare-IP VPSes, so a
 * publicly-trusted certificate isn't attainable by default — self-signed still
 * closes the real gap: the API key, the SMS code and the MAX 2FA password used
 * to cross the open internet as plain HTTP. The browser warns once about the
 * unknown issuer (expected; /apikey's link says so). Generated with the openssl
 * CLI (present in the Docker image) and persisted in .data/tls — the ./data
 * volume — so the browser exception survives container rebuilds.
 */
async function loadOrCreatePanelCert(): Promise<{ key: Buffer; cert: Buffer } | null> {
  const keyPath = path.join(TLS_DIR, 'key.pem');
  const certPath = path.join(TLS_DIR, 'cert.pem');
  try {
    return { key: await readFile(keyPath), cert: await readFile(certPath) };
  } catch {
    // not generated yet — fall through
  }
  try {
    await mkdir(TLS_DIR, { recursive: true });
    await execFileAsync('openssl', [
      'req', '-x509', '-newkey', 'rsa:2048', '-keyout', keyPath, '-out', certPath,
      '-days', '3650', '-nodes', '-subj', '/CN=telemax',
    ]);
    await chmod(keyPath, 0o600).catch(() => {});
    logger.info('Generated a self-signed TLS certificate for the web panel (.data/tls)');
    return { key: await readFile(keyPath), cert: await readFile(certPath) };
  } catch (err) {
    logger.error('Failed to generate a self-signed TLS certificate — the panel stays on plain HTTP', err);
    return null;
  }
}

async function loginWithSession(session: MaxSession): Promise<void> {
  try {
    const { payload } = await max.login(session.sessionToken);
    applyLoginPayload(payload);
    activePhone = session.phone;
    currentSession = session;
    logger.info(`Resumed session for ${session.phone}`);
    await refreshChatsAndNames();
    void syncChatsIfPossible();
  } catch (err) {
    logger.warn('Saved session was rejected, clearing it:', (err as Error).message);
    currentSession = null;
    activePhone = '';
    await sessionStore.clear();
  }
  broadcastStatus();
  refreshBotDescription();
}

async function startServer(): Promise<void> {
  currentSession = await sessionStore.load();

  // --- MAX client wiring ---
  max.on('connected', () => {
    maxConnected = true;
    broadcastStatus();
  });

  max.on('ready', () => {
    if (currentSession) void loginWithSession(currentSession);
  });

  max.on('disconnected', () => {
    maxConnected = false;
    broadcastStatus();
  });

  max.on('error', (err: Error) => logger.error('MAX client error:', err.message));

  max.on('latency', (ms: number) => {
    latestLatencyMs = ms;
    broadcastStatus();
  });

  max.on('sent', ({ opcode, payload, length }: { opcode: number; payload: unknown; length: number }) => {
    packetsSent += 1;
    pushLog('TX', opcode, length, payload);
  });

  max.on('message', (event: MaxMessageEvent) => {
    packetsReceived += 1;
    const dirLabel = event.dir === 0x03 ? 'ERR' : event.dir === 0x01 ? 'RX' : 'PUSH';
    pushLog(dirLabel, event.opcode, event.length, event.payload);

    if (event.opcode === OPCODES.PUSH_MESSAGE || (event.opcode === OPCODES.MSG_SEND && event.dir === 0x01)) {
      const p = event.payload as { chatId?: number; message?: unknown } | null;
      if (p?.chatId != null && p.message) patchCachedChatLastMessage(p.chatId, p.message);
    }
  });

  max.connect();

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
        getPanelScheme: () => panelScheme,
        triggerFullResync: () => refreshChatsAndNames().then(() => syncChatsIfPossible()),
        killEverything: killMaxSession,
      }));
      launchTelegramBotWithRetry(bot);
    }
  } else {
    logger.warn('TELEGRAM_BOT_TOKEN / TARGET_TELEGRAM_GROUP not set — Telegram bridge stays disabled');
  }

  // --- HTTP + WS server ---
  const app = express();
  app.use(express.json());

  // TLS on by default in production (self-signed — see loadOrCreatePanelCert).
  // PANEL_TLS=off opts out for setups with their own TLS-terminating reverse
  // proxy in front. Dev mode stays plain HTTP on localhost.
  const wantTls = process.env.NODE_ENV === 'production' && process.env.PANEL_TLS !== 'off';
  const tlsMaterial = wantTls ? await loadOrCreatePanelCert() : null;
  panelScheme = tlsMaterial ? 'https' : 'http';
  const httpServer = tlsMaterial ? createTlsServer({ key: tlsMaterial.key, cert: tlsMaterial.cert }, app) : createServer(app);
  const wss = new WebSocketServer({ noServer: true });

  httpServer.on('upgrade', (req, socket, head) => {
    if (req.url?.startsWith('/ws')) {
      const key = new URL(req.url, 'http://localhost').searchParams.get('apiKey');
      if (!isValidApiKey(config.apiKey, key)) {
        socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n');
        socket.destroy();
        return;
      }
      wss.handleUpgrade(req, socket, head, (ws) => wss.emit('connection', ws, req));
    } else {
      socket.destroy();
    }
  });

  wss.on('connection', (ws) => {
    uiClients.add(ws);
    ws.send(JSON.stringify({ type: 'init_logs', data: packetLogs }));
    ws.send(
      JSON.stringify({
        type: 'status',
        data: { max: maxConnected, tg: tgActive, deviceId: max.deviceId, phone: activePhone, latencyMs: latestLatencyMs },
      }),
    );
    ws.on('close', () => uiClients.delete(ws));
  });

  app.get('/api/health', (_req, res) => res.json({ ok: true }));

  const api = express.Router();
  api.use(requireApiKey(config.apiKey));

  api.get('/status', (_req, res) => {
    res.json({
      maxOnline: maxConnected,
      tgActive,
      deviceId: max.deviceId,
      phone: activePhone,
      latencyMs: latestLatencyMs,
      uptimeSeconds: Math.floor((Date.now() - startedAt) / 1000),
      packetsSent,
      packetsReceived,
    });
  });

  api.post('/system/stop', (_req, res) => {
    max.disconnect();
    res.json({ success: true });
  });

  api.post('/system/start', (_req, res) => {
    max.connect();
    res.json({ success: true });
  });

  api.post('/auth/phone', async (req, res) => {
    const rawPhone = req.body?.phone;
    if (!rawPhone) {
      res.status(400).json({ error: 'phone missing' });
      return;
    }
    const phone = String(rawPhone).replace(/[^\d+]/g, '');
    if (!maxConnected) {
      res.status(503).json({ error: 'MAX is disconnected' });
      return;
    }
    try {
      pendingAuthToken = await max.requestSms(phone);
      pendingPhone = phone;
      res.json({ success: true });
    } catch (err) {
      logger.error(`Failed to request SMS for ${phone}`, err);
      res.status(502).json({ error: (err as Error).message });
    }
  });

  api.post('/auth/verify', async (req, res) => {
    const code = req.body?.code;
    if (!code) {
      res.status(400).json({ error: 'code missing' });
      return;
    }
    if (!pendingAuthToken) {
      res.status(400).json({ error: 'no pending auth — call /api/auth/phone first' });
      return;
    }
    try {
      const verified = await max.verifyCode(pendingAuthToken, String(code));
      if (verified.status === 'password_required') {
        pendingPasswordTrackId = verified.challenge.trackId;
        res.json({ success: true, passwordRequired: true, hint: verified.challenge.hint ?? null });
        return;
      }
      pendingAuthToken = null;
      await completeMaxLogin(verified.loginToken);
      res.json({ success: true });
    } catch (err) {
      logger.error('Failed to verify SMS code', err);
      res.status(502).json({ error: (err as Error).message });
    }
  });

  // Only reached for password-protected accounts — verifyCode() above set
  // pendingPasswordTrackId instead of completing the login directly.
  api.post('/auth/password', async (req, res) => {
    const password = req.body?.password;
    if (!password) {
      res.status(400).json({ error: 'password missing' });
      return;
    }
    if (!pendingPasswordTrackId) {
      res.status(400).json({ error: 'no pending password challenge — call /api/auth/verify first' });
      return;
    }
    try {
      const loginToken = await max.checkPassword(pendingPasswordTrackId, String(password));
      pendingPasswordTrackId = null;
      await completeMaxLogin(loginToken);
      res.json({ success: true });
    } catch (err) {
      // Deliberately NOT clearing pendingPasswordTrackId here — it survives a
      // wrong password on MAX's side, so the user can just retry the password
      // without needing a fresh SMS code (confirmed live 2026-08-14).
      logger.error('Failed to verify MAX password', err);
      res.status(502).json({ error: (err as Error).message });
    }
  });

  // Same MAX-side teardown /kill's bot command uses (disconnect + delete the
  // encrypted session) — but scoped to just that, unlike /kill, which also
  // wipes every Telegram topic. Lets the web panel offer "log out / change
  // number" without touching chat history.
  api.post('/auth/logout', async (_req, res) => {
    await killMaxSession();
    res.json({ success: true });
  });

  api.get('/chats', (_req, res) => {
    const chats = cachedChats.map((chat) => ({
      ...(chat as object),
      displayName: resolveChatName(chat, myAccountId, contactProfiles),
    }));
    res.type('application/json').send(jsonStringify({ success: true, data: { chats } }));
  });

  api.get('/chat-mappings', async (_req, res) => {
    res.json({ success: true, data: await chatMapStore.list() });
  });

  // The /api/debug/* one-shot probes that used to live here (test-poll, test-contact,
  // test-group*, test-delete, chats-list, contact-info, chat-history) were removed
  // 2026-08-14 after every probed opcode got wired into real bot commands — they were
  // API-key-gated but still let a caller send messages and manage groups on the MAX
  // account, which is needless surface on a production install. Recover from git
  // history if a new opcode ever needs live probing again.

  api.post('/chats/:id/messages', async (req, res) => {
    if (!maxConnected) {
      res.status(503).json({ error: 'MAX is disconnected' });
      return;
    }
    const text = req.body?.text;
    if (!text) {
      res.status(400).json({ error: 'text missing' });
      return;
    }
    try {
      const { cid } = await max.sendMessage(req.params.id, String(text));
      res.json({ success: true, cid });
    } catch (err) {
      res.status(502).json({ error: (err as Error).message });
    }
  });

  app.use('/api', api);

  // --- Frontend ---
  if (process.env.NODE_ENV === 'production') {
    const distPath = path.join(process.cwd(), 'dist');
    app.use(express.static(distPath));
    app.get('*', (_req, res) => res.sendFile(path.join(distPath, 'index.html')));
  } else {
    // Dynamic import, NOT a static top-level one: vite is a devDependency, so it
    // doesn't exist in the production image at all. A static import crashed the
    // container on boot (ERR_MODULE_NOT_FOUND) the moment @tailwindcss/vite left
    // "dependencies" — it had been pulling vite into the runtime image as its
    // peer dependency this whole time, masking the problem. Hit live 2026-08-14.
    const { createServer: createViteServer } = await import('vite');
    const vite = await createViteServer({ server: { middlewareMode: true }, appType: 'spa' });
    app.use(vite.middlewares);
  }

  let listener: net.Server = httpServer;
  if (tlsMaterial) {
    // Single-port polyglot: a TLS ClientHello always starts with byte 0x16, so
    // anything else on the socket is a plain-HTTP client — an old bookmark or a
    // pre-TLS /apikey link — and gets a 301 to the same URL over https instead
    // of a cryptic protocol error.
    const redirectServer = createServer((req, res) => {
      res.writeHead(301, { Location: `https://${req.headers.host ?? `localhost:${config.port}`}${req.url ?? '/'}` });
      res.end();
    });
    listener = net.createServer((socket) => {
      socket.on('error', () => socket.destroy());
      socket.once('data', (firstChunk) => {
        socket.pause();
        socket.unshift(firstChunk);
        (firstChunk[0] === 0x16 ? httpServer : redirectServer).emit('connection', socket);
        // NOT a synchronous resume: the TLS wrap set up by the 'connection'
        // listener needs this tick, or the handshake never sees the ClientHello
        // and hangs forever (caught by a local smoke test before shipping).
        process.nextTick(() => socket.resume());
      });
    });
  }
  listener.listen(config.port, '0.0.0.0', () => {
    logger.info(`Server listening on port ${config.port}${tlsMaterial ? ' (HTTPS, self-signed)' : ''}`);
  });

  // docker stop / systemd send SIGTERM (node runs as PID 1 — exec-form CMD, so it
  // actually receives it). Stop polling Telegram and close the MAX socket cleanly
  // instead of letting the runtime kill mid-write; the backfill cursor is persisted
  // per message, so an in-flight backfill resumes where it left off either way.
  const shutdown = (signal: string): void => {
    logger.info(`Received ${signal}, shutting down`);
    try {
      bot?.stop(signal);
    } catch {
      // bot may not have launched (bad token, mid-retry) — nothing to stop
    }
    max.disconnect();
    if (listener !== httpServer) httpServer.close();
    listener.close(() => process.exit(0));
    // Failsafe: don't let a lingering keep-alive socket hold the process past
    // docker's own stop timeout.
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

Команды: /help /donate /apikey /version /info /poll /delete /newgroup /invite /kick /leavegroup /deletegroup /reboot /kill`;
}

/** Best-effort refresh once the phone number becomes known (or changes) — the initial setMyDescription at Telegram launch may well have fired before MAX auth finished. */
function refreshBotDescription(): void {
  if (!bot || !tgActive) return;
  bot.telegram.setMyDescription(buildBotDescription()).catch((err) => logger.error('Failed to refresh bot description', err));
}

// Populates Telegram's "/" command menu with one-line descriptions. /help (bridge/sync.ts)
// has the full reference — these are just enough to jog the memory from the menu.
const BOT_COMMANDS = [
  { command: 'help', description: 'Полный список команд и ограничений' },
  { command: 'donate', description: 'Поддержать проект (рубли / TON)' },
  { command: 'apikey', description: 'Показать ключ для веб-панели' },
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
  await bot.telegram.sendMessage(config.targetTelegramGroup, `✅ Обновлено до ${shortSha(commit)}.`).catch((err) => logger.error('Failed to send post-update notice', err));
}

function retryTelegramLaunch(bot: Telegraf, attempt: number, reason: unknown): void {
  tgActive = false;
  broadcastStatus();
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
  broadcastStatus();

  // Best-effort: keeps the bot's Telegram profile description in sync with its
  // actual command surface and the two platform-level gaps a user could otherwise
  // spend time re-discovering (Bot API has no delete-notification event at all, and
  // Telegram's poll widget has no way to receive a vote cast on the MAX side).
  bot.telegram.setMyDescription(buildBotDescription()).catch((err) => logger.error('Failed to set bot description', err));
  bot.telegram.setMyCommands(BOT_COMMANDS).catch((err) => logger.error('Failed to set bot commands', err));
  void reportIfJustUpdated(bot);

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
    return new Telegraf(token);
  } catch (err) {
    logger.error('Failed to create Telegram bot:', err);
    return null;
  }
}

startServer().catch((err) => {
  logger.error('Fatal startup error:', err);
  process.exitCode = 1;
});
