import express from 'express';
import { createServer } from 'node:http';
import { WebSocketServer, type WebSocket } from 'ws';
import { Telegraf } from 'telegraf';
import path from 'node:path';
import { createServer as createViteServer } from 'vite';
import { MaxClient, type MaxMessageEvent, type MaxContactInfo } from '../max/client.js';
import { OPCODES, formatOpcode } from '../max/opcodes.js';
import { extractMyAccountId, resolveChatName, type ContactProfile } from '../max/names.js';
import { SessionStore, type MaxSession } from '../store/sessionStore.js';
import { ChatMapStore } from '../store/chatMapStore.js';
import { wireBridge, syncAllChatsToTelegram, MessageLinkStore } from '../bridge/sync.js';
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
}

/** Keeps the LOGIN-derived chat snapshot from going stale as messages flow in either direction. */
function patchCachedChatLastMessage(chatId: number, lastMessage: unknown): void {
  const chat = cachedChats.find((c) => c && typeof c === 'object' && (c as { id?: unknown }).id === chatId);
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
  const httpServer = createServer(app);
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
      const loginToken = await max.verifyCode(pendingAuthToken, String(code));
      const { sessionToken, payload } = await max.login(loginToken);
      applyLoginPayload(payload);
      await refreshChatsAndNames();
      void syncChatsIfPossible();
      pendingAuthToken = null;
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
      res.json({ success: true });
    } catch (err) {
      res.status(502).json({ error: (err as Error).message });
    }
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

  // One-shot poll-creation probe — sends a real POLL attach to a chat (default 0,
  // Избранное) to confirm MSG_SEND accepts the shape. Pass ?chatId= for a real
  // two-party chat (e.g. the user's own approved test contact "Svv") to also
  // exercise the live push-echo -> Telegram relay path, which self-chat sends don't trigger.
  api.post('/debug/test-poll', async (req, res) => {
    try {
      const chatId = req.query.chatId ?? 0;
      const pollAttach = {
        _type: 'POLL',
        title: '🍕 Тест опроса',
        answers: [
          { text: 'Вариант A', answerId: null },
          { text: 'Вариант B', answerId: null },
        ],
        settings: 0,
      };
      const result = await max.sendMessage(chatId, null, [pollAttach]);
      res.type('application/json').send(jsonStringify({ success: true, result }));
    } catch (err) {
      res.status(502).json({ error: (err as Error).message });
    }
  });

  // One-shot outgoing vCard-CONTACT probe — confirms the self-contained shape (no
  // contactId, just phone/name/vcfBody) works as an outgoing MSG_SEND before trusting
  // it in the real Telegram->MAX contact-share flow.
  api.post('/debug/test-contact', async (req, res) => {
    try {
      const chatId = req.query.chatId ?? 0;
      const firstName = String(req.query.firstName ?? 'Тест');
      const lastName = String(req.query.lastName ?? '');
      const phone = String(req.query.phone ?? '79990001122');
      const contactAttach = {
        _type: 'CONTACT',
        firstName,
        lastName,
        phone,
        vcfBody: `BEGIN:VCARD\r\nVERSION:2.1\r\nN:${lastName};${firstName};;;\r\nFN:${[firstName, lastName].filter(Boolean).join(' ')}\r\nTEL;CELL:${phone}\r\nEND:VCARD\r\n`,
        name: firstName,
      };
      const result = await max.sendMessage(chatId, null, [contactAttach]);
      res.type('application/json').send(jsonStringify({ success: true, result }));
    } catch (err) {
      res.status(502).json({ error: (err as Error).message });
    }
  });

  // One-shot group-creation probe — the first MSG_SEND in this codebase with no
  // chatId, so worth confirming live before wiring real Telegram commands to it.
  api.post('/debug/test-group', async (req, res) => {
    try {
      const userIds = req.query.invite ? String(req.query.invite).split(',').map(Number) : [];
      const result = await max.createGroup('🧪 Тест группы (бот)', userIds, 'CHAT');
      res.type('application/json').send(jsonStringify({ success: true, result }));
    } catch (err) {
      res.status(502).json({ error: (err as Error).message });
    }
  });

  // One-shot probes for the rest of group management — CHAT_SET_INFO / CHAT_MEMBERS /
  // CHAT_LEAVE / CHAT_DELETE — all first-time-tested opcodes, same reasoning as test-group.
  api.post('/debug/test-group-rename', async (req, res) => {
    try {
      const chatId = String(req.query.chatId);
      await max.updateChatInfo(chatId, { title: String(req.query.title ?? 'renamed'), description: req.query.description ? String(req.query.description) : undefined });
      res.json({ success: true });
    } catch (err) {
      res.status(502).json({ error: (err as Error).message });
    }
  });

  api.post('/debug/test-group-members', async (req, res) => {
    try {
      const chatId = String(req.query.chatId);
      const userIds = String(req.query.userIds).split(',').map(Number);
      const operation = req.query.operation === 'remove' ? 'remove' : 'add';
      await max.updateChatMembers(chatId, userIds, operation);
      res.json({ success: true });
    } catch (err) {
      res.status(502).json({ error: (err as Error).message });
    }
  });

  api.post('/debug/test-group-delete', async (req, res) => {
    try {
      const chatId = String(req.query.chatId);
      const lastEventTime = Number(req.query.lastEventTime);
      const forAll = req.query.forAll === 'true';
      await max.deleteChat(chatId, lastEventTime, forAll);
      res.json({ success: true });
    } catch (err) {
      res.status(502).json({ error: (err as Error).message });
    }
  });

  // One-shot MSG_DELETE / FORWARD probes.
  api.post('/debug/test-delete', async (req, res) => {
    try {
      const chatId = String(req.query.chatId);
      const messageId = BigInt(String(req.query.messageId));
      const forMe = req.query.forMe === 'true';
      await max.deleteMessages(chatId, [messageId], forMe);
      res.json({ success: true });
    } catch (err) {
      res.status(502).json({ error: (err as Error).message });
    }
  });

  // One-shot CHATS_LIST probe — single page, not the pagination loop — used to
  // sanity-check the response shape before trusting getAllChats() with the real sync.
  api.get('/debug/chats-list', async (_req, res) => {
    try {
      const page = await max.getChatsList(Date.now());
      res.type('application/json').send(jsonStringify({ success: true, count: page.chats.length, nextMarker: page.marker, chats: page.chats }));
    } catch (err) {
      res.status(502).json({ error: (err as Error).message });
    }
  });

  // One-shot CONTACT_INFO probe — used to confirm the response wrapper key and
  // field shapes before wiring phone-number fallback into name resolution.
  api.get('/debug/contact-info/:id', async (req, res) => {
    try {
      const contacts = await max.getContactInfo([Number(req.params.id)]);
      res.type('application/json').send(jsonStringify({ success: true, contacts }));
    } catch (err) {
      res.status(502).json({ error: (err as Error).message });
    }
  });

  // One-shot CHAT_HISTORY probe — single MAX request (not the pagination loop), used
  // to sanity-check the response shape live before trusting the full history backfill.
  api.get('/debug/chat-history/:id', async (req, res) => {
    try {
      const count = Number(req.query.count) || 5;
      const messages = await max.getChatHistory(req.params.id, Date.now(), count);
      res.type('application/json').send(jsonStringify({ success: true, count: messages.length, messages }));
    } catch (err) {
      res.status(502).json({ error: (err as Error).message });
    }
  });

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
    const vite = await createViteServer({ server: { middlewareMode: true }, appType: 'spa' });
    app.use(vite.middlewares);
  }

  httpServer.listen(config.port, '0.0.0.0', () => {
    logger.info(`Server listening on port ${config.port}`);
  });
}

// getUpdates only allows one active poller per bot token (a second instance — even a
// throwaway debug script — gets a 409 and knocks the first one off), so a launch
// failure here is often transient. Retry with backoff instead of leaving tgActive
// stuck false until someone notices and restarts the process by hand.
const TELEGRAM_RETRY_DELAYS_MS = [2_000, 5_000, 15_000, 30_000, 60_000];

// Shown in the bot's Telegram profile (Bot API 512-char limit on setMyDescription).
// The two caveats are platform-level, not bugs — worth surfacing here since neither
// is discoverable from the UI itself.
const BOT_DESCRIPTION = `Мост MAX (+7XXXXXXXXXX) ↔ Telegram: сообщения, файлы, голосовые, стикеры, опросы, пересылка. Звонки — только уведомления, без аудио.

Ограничения:
• Свайп-удаление в Telegram бот не видит (нет такого события в Bot API) — удаляй командой /delete (или /delete me) ответом на сообщение.
• Голоса за опрос из MAX не появляются в виджете Telegram сами — счёт через /poll ответом на сообщение опроса.

Команды: /help /donate /info /poll /delete /newgroup /invite /kick /leavegroup /deletegroup /reboot /kill`;

// Populates Telegram's "/" command menu with one-line descriptions. /help (bridge/sync.ts)
// has the full reference — these are just enough to jog the memory from the menu.
const BOT_COMMANDS = [
  { command: 'help', description: 'Полный список команд и ограничений' },
  { command: 'donate', description: 'Поддержать проект (рубли / TON)' },
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
  bot.telegram.setMyDescription(BOT_DESCRIPTION).catch((err) => logger.error('Failed to set bot description', err));
  bot.telegram.setMyCommands(BOT_COMMANDS).catch((err) => logger.error('Failed to set bot commands', err));

  // message_reaction and poll_answer are opt-in — Telegram omits them from the default update set unless requested.
  bot
    .launch({ allowedUpdates: ['message', 'edited_message', 'message_reaction', 'poll_answer'] })
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
