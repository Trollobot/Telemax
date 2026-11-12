import http, { type IncomingMessage, type ServerResponse } from 'node:http';
import { randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { redactProxyUrl } from '../telegram/proxy.js';
import { readEnvValues, setEnvValues } from './envFile.js';
import { isAllowedRequest, proxyProblem, resolveForm, type FormInput, type Settings } from './form.js';
import { buildHealth, explainTelegramError } from './health.js';
import { PAGE_HTML } from './page.js';
import { LogSink, Supervisor } from './supervisor.js';
import { checkGroup, findGroups, getBot } from './telegramApi.js';

/**
 * The portable build's entry (Windows: started by app/tray.ps1). Plays the parts Docker, setup.sh
 * and the update watcher play on a server: keeps the bridge process running, and serves one local
 * page — connection state, settings, the log. The bridge itself stays what it is everywhere else.
 *
 * Run from the portable folder: .env, .data, certs and VERSION are looked up in the working directory.
 */
const ROOT = process.cwd();
const ENV_FILE = path.join(ROOT, '.env');
const DATA_DIR = path.join(ROOT, '.data');
const STATUS_FILE = path.join(DATA_DIR, 'status.json');
const LOG_FILE = path.join(DATA_DIR, 'logs', 'telemax.log');
/** The port actually taken, for the tray script. */
const PORT_FILE = path.join(DATA_DIR, 'panel-port');
const DEFAULT_PORT = 8377;
const HERE = path.dirname(fileURLToPath(import.meta.url));

const version = ((): string => {
  try {
    return readFileSync(path.join(ROOT, 'VERSION'), 'utf8').trim();
  } catch {
    return 'unknown';
  }
})();

mkdirSync(DATA_DIR, { recursive: true });
const log = new LogSink(LOG_FILE);
const supervisor = new Supervisor({ entry: path.join(HERE, 'server.mjs'), cwd: ROOT, statusFile: STATUS_FILE, log });

// --- settings (.env) -----------------------------------------------------------------------------

function readEnvText(): string {
  return existsSync(ENV_FILE) ? readFileSync(ENV_FILE, 'utf8') : '';
}

function readSettings(): Settings {
  const env = readEnvValues(readEnvText());
  return { token: env.TELEGRAM_BOT_TOKEN ?? '', group: env.TARGET_TELEGRAM_GROUP ?? '', proxy: env.TELEGRAM_PROXY ?? '', sessionKey: env.MAX_SESSION_KEY ?? '' };
}

const isConfigured = (s: Settings): boolean => Boolean(s.token && s.group && s.sessionKey);

/** First start: a .env with the session key the bridge refuses to run without. Never replaces a key that is there — the saved MAX session is encrypted with it. */
function ensureSessionKey(): void {
  if (readSettings().sessionKey) return;
  const head = existsSync(ENV_FILE) ? readEnvText() : '# Настройки Telemax. Токен бота, группу и прокси удобнее менять на странице программы.\n';
  writeFileSync(ENV_FILE, setEnvValues(head, { MAX_SESSION_KEY: randomBytes(32).toString('hex') }), 'utf8');
  log.note('created the session key in .env');
}

// The bot's @username for the page's hints — asked once per token, not on every status poll.
let knownBot: { token: string; username: string; id: number } | null = null;

// --- what the page sends ---------------------------------------------------------------------------

type Reply = Record<string, unknown> & { ok: boolean };
const fail = (error: string): Reply => ({ ok: false, error });
const telegramFailure = (err: unknown): Reply => fail(`Не получилось: ${explainTelegramError(err instanceof Error ? err.message : String(err))}`);

async function apiCheck(input: FormInput): Promise<Reply> {
  const form = resolveForm(input, readSettings());
  if (!form.token) return fail('Сначала вставьте токен бота.');
  const problem = proxyProblem(form.proxy);
  if (problem) return fail(problem);
  const started = Date.now();
  try {
    const bot = await getBot(form.token, form.proxy);
    return { ok: true, bot, viaProxy: Boolean(form.proxy), ms: Date.now() - started };
  } catch (err) {
    return telegramFailure(err);
  }
}

async function apiFindGroup(input: FormInput): Promise<Reply> {
  const form = resolveForm(input, readSettings());
  if (!form.token) return fail('Сначала вставьте токен бота.');
  const problem = proxyProblem(form.proxy);
  if (problem) return fail(problem);
  // One reader per bot: with the bridge polling, a second getUpdates would knock it off.
  const wasRunning = supervisor.running;
  if (wasRunning) await supervisor.stop();
  try {
    return { ok: true, groups: await findGroups(form.token, form.proxy) };
  } catch (err) {
    return telegramFailure(err);
  } finally {
    if (wasRunning) supervisor.start();
  }
}

async function apiCheckGroup(input: FormInput): Promise<Reply> {
  const form = resolveForm(input, readSettings());
  if (!form.token) return fail('Сначала вставьте токен бота.');
  if (!/^-\d+$/.test(form.group)) return fail('Номер группы выглядит так: -1001234567890. Проще нажать «Найти группу».');
  const problem = proxyProblem(form.proxy);
  if (problem) return fail(problem);
  try {
    const bot = await getBot(form.token, form.proxy);
    const check = await checkGroup(form.token, form.proxy, form.group, bot.id);
    return { ...check };
  } catch (err) {
    const text = err instanceof Error ? err.message : String(err);
    if (/chat not found/i.test(text)) return fail('Telegram не знает такую группу для этого бота: проверьте номер и что бот добавлен в группу.');
    return telegramFailure(err);
  }
}

async function apiSaveSettings(input: FormInput): Promise<Reply> {
  const saved = readSettings();
  const form = resolveForm(input, saved);
  if (!/^\d+:[\w-]{30,}$/.test(form.token)) return fail('Токен бота выглядит так: 123456789:AAE… — скопируйте его целиком из @BotFather.');
  if (!/^-\d+$/.test(form.group)) return fail('Укажите группу: нажмите «Найти группу» или вставьте её номер (-100…).');
  const problem = proxyProblem(form.proxy);
  if (problem) return fail(problem);
  try {
    writeFileSync(ENV_FILE, setEnvValues(readEnvText(), { TELEGRAM_BOT_TOKEN: form.token, TARGET_TELEGRAM_GROUP: form.group, TELEGRAM_PROXY: form.proxy || null }), 'utf8');
  } catch (err) {
    return fail(err instanceof Error ? err.message : String(err));
  }
  log.note('settings saved from the page — restarting the bridge');
  knownBot = null;
  ensureSessionKey();
  await supervisor.restart();
  return { ok: true, note: saved.token ? '' : 'Дальше — вход в MAX: напишите боту в личку /login.' };
}

async function apiStatus(): Promise<Reply> {
  const settings = readSettings();
  const configured = isConfigured(settings);
  const status = supervisor.readStatus();
  if (configured && knownBot?.token !== settings.token && status?.telegram.ok) {
    const token = settings.token;
    // Best effort and off the request's path: the page shows the name once it is known.
    void getBot(token, settings.proxy)
      .then((bot) => {
        knownBot = { token, username: bot.username, id: bot.id };
      })
      .catch(() => {});
  }
  const health = buildHealth(supervisor.processState(configured), status, Date.now());
  return {
    ok: true,
    version,
    configured,
    needsLogin: supervisor.running && status?.max.state === 'ready',
    health,
    logFile: LOG_FILE,
    settings: {
      tokenSet: Boolean(settings.token),
      bot: knownBot?.token === settings.token ? knownBot.username : '',
      group: settings.group,
      proxy: settings.proxy ? redactProxyUrl(settings.proxy) : '',
    },
  };
}

// --- the local page ----------------------------------------------------------------------------------

function send(res: ServerResponse, code: number, body: string, type: string): void {
  res.writeHead(code, { 'content-type': `${type}; charset=utf-8`, 'cache-control': 'no-store', 'x-content-type-options': 'nosniff' });
  res.end(body);
}
const sendJson = (res: ServerResponse, code: number, body: unknown): void => send(res, code, JSON.stringify(body), 'application/json');

async function readBody(req: IncomingMessage): Promise<FormInput> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    size += (chunk as Buffer).length;
    if (size > 64 * 1024) throw new Error('too big');
    chunks.push(chunk as Buffer);
  }
  const parsed: unknown = chunks.length ? JSON.parse(Buffer.concat(chunks).toString('utf8')) : {};
  return parsed && typeof parsed === 'object' ? (parsed as FormInput) : {};
}

let shuttingDown = false;
async function shutdown(): Promise<void> {
  if (shuttingDown) return;
  shuttingDown = true;
  log.note('stopping');
  await supervisor.stop();
  process.exit(0);
}

function createServer(port: number): http.Server {
  const posts: Record<string, (input: FormInput) => Promise<Reply>> = {
    '/api/check': apiCheck,
    '/api/find-group': apiFindGroup,
    '/api/check-group': apiCheckGroup,
    '/api/settings': apiSaveSettings,
    '/api/restart': async () => {
      if (!isConfigured(readSettings())) return fail('Сначала заполните настройки.');
      log.note('restart asked from the page or the tray');
      // Not awaited: a clean stop takes seconds, and the tray icon asks from its one UI thread.
      void supervisor.restart();
      return { ok: true };
    },
    '/api/shutdown': async () => {
      setTimeout(() => void shutdown(), 100);
      return { ok: true };
    },
  };
  return http.createServer((req, res) => {
    void (async () => {
      const url = (req.url ?? '/').split('?')[0] as string;
      const method = req.method ?? 'GET';
      if (!isAllowedRequest(method, req.headers, port)) return sendJson(res, 403, fail('forbidden'));
      if (method === 'GET') {
        if (url === '/') return send(res, 200, PAGE_HTML, 'text/html');
        if (url === '/api/ping') return sendJson(res, 200, { ok: true, telemax: true, version });
        if (url === '/api/status') return sendJson(res, 200, await apiStatus());
        if (url === '/api/log') return sendJson(res, 200, { ok: true, lines: log.tail() });
        return sendJson(res, 404, fail('not found'));
      }
      const handler = posts[url];
      if (!handler) return sendJson(res, 404, fail('not found'));
      sendJson(res, 200, await handler(await readBody(req)));
    })().catch((err) => {
      log.note(`page request failed: ${err instanceof Error ? err.message : String(err)}`);
      if (!res.headersSent) sendJson(res, 500, fail('внутренняя ошибка — подробности в журнале'));
    });
  });
}

/** Whether a Telemax launcher already answers on this port (a second start of the same folder, or another copy). */
async function isOurs(port: number): Promise<boolean> {
  try {
    const res = await fetch(`http://127.0.0.1:${port}/api/ping`, { signal: AbortSignal.timeout(1500) });
    return ((await res.json()) as { telemax?: boolean }).telemax === true;
  } catch {
    return false;
  }
}

function listen(port: number): Promise<http.Server | null> {
  return new Promise((resolve, reject) => {
    const server = createServer(port);
    server.once('error', (err: NodeJS.ErrnoException) => (err.code === 'EADDRINUSE' ? resolve(null) : reject(err)));
    server.listen(port, '127.0.0.1', () => resolve(server));
  });
}

async function main(): Promise<void> {
  const first = Number(process.env.TELEMAX_PANEL_PORT) || DEFAULT_PORT;
  let port = first;
  let server: http.Server | null = null;
  // The port may be taken by something else on this PC; a few next ones are tried. A second
  // Telemax folder running at the same time simply gets the next port.
  for (; port < first + 10; port += 1) {
    server = await listen(port);
    if (server) break;
    if (await isOurs(port)) log.note(`port ${port} is taken by another Telemax — trying the next one`);
  }
  if (!server) throw new Error(`не удалось занять порт для страницы (пробовал ${first}–${first + 9})`);
  writeFileSync(PORT_FILE, String(port), 'utf8');
  log.note(`Telemax ${version} — page at http://127.0.0.1:${port}/`);

  ensureSessionKey();
  if (isConfigured(readSettings())) supervisor.start();
  else log.note('not configured yet — waiting for the settings from the page');
  setInterval(() => supervisor.tick(), 10_000);

  process.once('SIGINT', () => void shutdown());
  process.once('SIGTERM', () => void shutdown());
}

main().catch((err) => {
  log.note(`fatal: ${err instanceof Error ? err.message : String(err)}`);
  process.exit(1);
});
