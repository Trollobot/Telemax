/**
 * Big files through links — what the Bot API can't carry. A bot may DOWNLOAD from Telegram only
 * ≤20 MB (getFile) and SEND only ≤50 MB, while MAX takes up to 4 GB. So:
 *   - Telegram → MAX over 20 MB: the topic gets a one-time UPLOAD link; the file arrives through a
 *     browser, then goes to MAX as a normal file (≤4 GB) or as a download link (bigger);
 *   - MAX → Telegram over 50 MB: the bridge saves the file and the topic gets a DOWNLOAD link.
 *
 * The links are served by ONE shared service per host (files-service/: Caddy + a small Node app),
 * which the host's update dispatcher starts only while some bridge has a live link and stops when
 * none is left — so ports 80/443 are open only then. The bridge (non-root, no Docker access) talks
 * to it through files on the shared `.data/files` volume:
 *   active          — exists while this bridge has a live link (the host reads it every minute);
 *   service.json    — written by the host: {state, url, at, detail};
 *   tokens/<t>.json — what a link may do (download a stored file / receive one upload);
 *   items/<id>/…    — stored files, deleted when their link expires;
 *   incoming/<t>/…  — uploads written by the service (`done.json` once complete).
 */
import path from 'node:path';
import { createWriteStream } from 'node:fs';
import { mkdir, readFile, readdir, rename, rm, stat, statfs, unlink, writeFile } from 'node:fs/promises';
import { randomBytes } from 'node:crypto';
import { pipeline } from 'node:stream/promises';
import { Readable, Transform } from 'node:stream';
import { createLogger } from '../logger.js';
import { parseEnvBool } from '../env.js';

const logger = createLogger('files');

/** Bot API getFile refuses bigger files with "400: Bad Request: file is too big". */
export const TELEGRAM_BOT_DOWNLOAD_LIMIT = 20 * 1024 * 1024;
/** MAX's own limit for one file (the user's number, 2026-10-09); bigger goes to MAX as a link. */
export const MAX_FILE_LIMIT = 4_000_000_000;

export interface StoredFile {
  id: string;
  name: string;
  size: number;
  /** max2tg: saved from MAX for the topic; tg2max: uploaded for MAX (over MAX's limit). */
  direction: 'max2tg' | 'tg2max';
  token: string;
  createdAt: number;
  expiresAt: number;
}

export interface UploadTicket {
  token: string;
  maxChatId: string;
  topicId: number;
  /** The Telegram message with the too-big file — the MAX copy gets linked to it. */
  telegramMessageId: number;
  /** The bot's «загрузите по ссылке» message, edited as the upload progresses. */
  promptMessageId?: number;
  caption?: string;
  name: string;
  expectedSize: number;
  createdAt: number;
  expiresAt: number;
}

interface Index {
  files: StoredFile[];
  tickets: UploadTicket[];
}

export type ServiceResult = { ok: true; url: string } | { ok: false; reason: string };

/** What the host writes into service.json. */
interface ServiceState {
  state?: string;
  url?: string;
  /** Unix seconds. */
  at?: number;
  detail?: string;
}

export interface FileShareOptions {
  enabled: boolean;
  ttlMs: number;
  /** Kept free on top of any file: an update needs ~1.5 GB, a full disk would block it. */
  reserveBytes: number;
}

export function fileShareOptionsFromEnv(env: NodeJS.ProcessEnv = process.env): FileShareOptions {
  const ttlHours = Number(env.FILES_TTL_HOURS);
  const reserveMb = Number(env.FILES_RESERVE_MB);
  return {
    enabled: parseEnvBool(env.FILES) !== false,
    ttlMs: (Number.isFinite(ttlHours) && ttlHours > 0 ? ttlHours : 72) * 3600_000,
    reserveBytes: (Number.isFinite(reserveMb) && reserveMb >= 0 ? reserveMb : 1536) * 1024 * 1024,
  };
}

/**
 * A file name safe for a path segment and a Content-Disposition: no separators, no control
 * characters, no leading dots, at most 180 UTF-16 units (extension kept). Pure + exported for tests.
 */
export function safeFileName(raw: string | undefined): string {
  let name = (raw ?? '').replace(/[\u0000-\u001f\u007f/\\:*?"<>|]/g, '_').trim();
  name = name.replace(/^\.+/, '').trim();
  if (!name) return 'file';
  if (name.length > 180) {
    const dot = name.lastIndexOf('.');
    const ext = dot > 0 && name.length - dot <= 16 ? name.slice(dot) : '';
    name = name.slice(0, 180 - ext.length) + ext;
  }
  return name;
}

const newToken = (): string => randomBytes(18).toString('base64url');
const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/** How long service.json stays believable: the host rewrites it every minute while it matters. */
const SERVICE_STATE_FRESH_MS = 150_000;
const SERVICE_WAIT_MS = 150_000;
const HEARTBEAT_STALE_MS = 5 * 60_000;

export class FileShare {
  readonly dir: string;
  private readonly indexPath: string;
  private index: Index = { files: [], tickets: [] };
  private chain: Promise<unknown> = Promise.resolve();
  private uploadHandler: ((t: UploadTicket, filePath: string, size: number, name: string) => Promise<void>) | null = null;
  private busyTokens = new Set<string>();

  constructor(
    dataDir: string,
    readonly opts: FileShareOptions,
  ) {
    this.dir = path.join(dataDir, 'files');
    this.indexPath = path.join(this.dir, 'index.json');
  }

  get enabled(): boolean {
    return this.opts.enabled;
  }

  async init(): Promise<void> {
    await mkdir(path.join(this.dir, 'items'), { recursive: true });
    await mkdir(path.join(this.dir, 'tokens'), { recursive: true });
    await mkdir(path.join(this.dir, 'incoming'), { recursive: true });
    try {
      const parsed = JSON.parse(await readFile(this.indexPath, 'utf8')) as Partial<Index>;
      this.index = { files: Array.isArray(parsed.files) ? parsed.files : [], tickets: Array.isArray(parsed.tickets) ? parsed.tickets : [] };
    } catch {
      this.index = { files: [], tickets: [] };
    }
    await this.sweep();
  }

  /** Serialized: index writes and the token files they imply never interleave. */
  private locked<T>(fn: () => Promise<T>): Promise<T> {
    const run = this.chain.then(fn, fn);
    this.chain = run.catch(() => {});
    return run;
  }

  private async save(): Promise<void> {
    const tmp = `${this.indexPath}.tmp`;
    await writeFile(tmp, JSON.stringify(this.index, null, 2), 'utf8');
    await rename(tmp, this.indexPath);
    await this.syncActiveMarker();
  }

  /** `active` exists exactly while a link is alive — the host opens ports 80/443 only then. */
  private async syncActiveMarker(): Promise<void> {
    const marker = path.join(this.dir, 'active');
    if (this.index.files.length + this.index.tickets.length > 0) {
      await writeFile(marker, new Date().toISOString(), 'utf8');
    } else {
      await unlink(marker).catch(() => {});
    }
  }

  private async writeToken(token: string, body: Record<string, unknown>): Promise<void> {
    const file = path.join(this.dir, 'tokens', `${token}.json`);
    await writeFile(`${file}.tmp`, JSON.stringify({ v: 1, ...body }), 'utf8');
    await rename(`${file}.tmp`, file);
  }

  private async dropToken(token: string): Promise<void> {
    await unlink(path.join(this.dir, 'tokens', `${token}.json`)).catch(() => {});
  }

  list(): StoredFile[] {
    return [...this.index.files].sort((a, b) => b.createdAt - a.createdAt);
  }

  get(id: string): StoredFile | undefined {
    return this.index.files.find((f) => f.id === id);
  }

  pendingUploads(): number {
    return this.index.tickets.length;
  }

  /** Free bytes left for a file of `size` after the reserve; negative when it won't fit. */
  async roomFor(size: number): Promise<{ fits: boolean; freeBytes: number }> {
    const s = await statfs(this.dir);
    const freeBytes = Number(s.bavail) * Number(s.bsize);
    return { fits: freeBytes - this.opts.reserveBytes >= size, freeBytes };
  }

  // --- Telegram → MAX ---------------------------------------------------------------------

  async createUploadTicket(t: Omit<UploadTicket, 'token' | 'createdAt' | 'expiresAt'>): Promise<UploadTicket> {
    return this.locked(async () => {
      const now = Date.now();
      const ticket: UploadTicket = { ...t, token: newToken(), createdAt: now, expiresAt: now + this.opts.ttlMs };
      await this.writeToken(ticket.token, {
        kind: 'upload',
        name: ticket.name,
        expectedSize: ticket.expectedSize,
        expiresAt: ticket.expiresAt,
        reserveBytes: this.opts.reserveBytes,
      });
      this.index.tickets.push(ticket);
      await this.save();
      return ticket;
    });
  }

  async setPromptMessage(token: string, messageId: number): Promise<void> {
    await this.locked(async () => {
      const t = this.index.tickets.find((x) => x.token === token);
      if (!t) return;
      t.promptMessageId = messageId;
      await this.save();
    });
  }

  async dropTicket(token: string): Promise<void> {
    await this.locked(async () => {
      this.index.tickets = this.index.tickets.filter((t) => t.token !== token);
      await this.dropToken(token);
      await rm(path.join(this.dir, 'incoming', token), { recursive: true, force: true });
      await this.save();
    });
  }

  /** Moves a finished upload into storage (a file over MAX's limit lives on as a download link). */
  async adoptUpload(ticket: UploadTicket, filePath: string, size: number, name: string): Promise<StoredFile> {
    const file = await this.locked(async () => {
      const id = newToken();
      await mkdir(path.join(this.dir, 'items', id), { recursive: true });
      const target = path.join(this.dir, 'items', id, safeFileName(name));
      await rename(filePath, target);
      return this.addFile(id, safeFileName(name), size, 'tg2max');
    });
    await this.dropTicket(ticket.token);
    return file;
  }

  /** Called with each finished upload; the bridge sends it to MAX. */
  onUpload(handler: (t: UploadTicket, filePath: string, size: number, name: string) => Promise<void>): void {
    this.uploadHandler = handler;
  }

  // --- MAX → Telegram ---------------------------------------------------------------------

  /**
   * Streams `body` into storage and opens a download link for it. Throws when the stream fails or
   * runs past `size` + the free space (the partial file is removed either way).
   */
  async storeStream(body: Readable, name: string, size: number): Promise<StoredFile> {
    const id = newToken();
    const safe = safeFileName(name);
    const dir = path.join(this.dir, 'items', id);
    await mkdir(dir, { recursive: true });
    const part = path.join(dir, `${safe}.part`);
    let written = 0;
    const limit = Math.max(size, 0) + 1024 * 1024; // the declared size, a little slack
    const guard = new Transform({
      transform(chunk: Buffer, _enc, cb) {
        written += chunk.length;
        if (written > limit) cb(new Error(`file grew past its declared ${size} bytes`));
        else cb(null, chunk);
      },
    });
    try {
      await pipeline(body, guard, createWriteStream(part));
      await rename(part, path.join(dir, safe));
    } catch (err) {
      await rm(dir, { recursive: true, force: true });
      throw err;
    }
    return this.locked(() => this.addFile(id, safe, written, 'max2tg'));
  }

  private async addFile(id: string, name: string, size: number, direction: StoredFile['direction']): Promise<StoredFile> {
    const now = Date.now();
    const file: StoredFile = { id, name, size, direction, token: newToken(), createdAt: now, expiresAt: now + this.opts.ttlMs };
    await this.writeToken(file.token, { kind: 'download', name, size, path: `items/${id}/${name}`, expiresAt: file.expiresAt });
    this.index.files.push(file);
    await this.save();
    return file;
  }

  // --- the panel ----------------------------------------------------------------------------

  /** A fresh link (the old one stops working) and a fresh TTL. */
  async renew(id: string): Promise<StoredFile | undefined> {
    return this.locked(async () => {
      const file = this.index.files.find((f) => f.id === id);
      if (!file) return undefined;
      await this.dropToken(file.token);
      file.token = newToken();
      file.expiresAt = Date.now() + this.opts.ttlMs;
      await this.writeToken(file.token, { kind: 'download', name: file.name, size: file.size, path: `items/${id}/${file.name}`, expiresAt: file.expiresAt });
      await this.save();
      return file;
    });
  }

  async remove(id: string): Promise<boolean> {
    return this.locked(async () => {
      const file = this.index.files.find((f) => f.id === id);
      if (!file) return false;
      this.index.files = this.index.files.filter((f) => f.id !== id);
      await this.dropToken(file.token);
      await rm(path.join(this.dir, 'items', id), { recursive: true, force: true });
      await this.save();
      return true;
    });
  }

  // --- the host service -----------------------------------------------------------------------

  /**
   * Waits (≤2.5 min: the host checks once a minute, then Caddy may need a certificate) until the
   * shared files service answers for this bridge. Call AFTER creating the link — its `active`
   * marker is what makes the host start the service.
   */
  async ensureService(waitMs = SERVICE_WAIT_MS): Promise<ServiceResult> {
    if (!this.opts.enabled) return { ok: false, reason: 'пересылка больших файлов отключена в настройках (FILES=off)' };
    await this.syncActiveMarker();
    const deadline = Date.now() + waitMs;
    let heartbeatChecked = false;
    for (;;) {
      const st = await this.readServiceState();
      const fresh = st?.at != null && Date.now() - st.at * 1000 < SERVICE_STATE_FRESH_MS;
      if (fresh && st?.state === 'up' && st.url) return { ok: true, url: st.url.replace(/\/+$/, '') };
      if (fresh && st?.state && st.state !== 'up' && st.state !== 'starting' && st.state !== 'down') {
        return { ok: false, reason: describeServiceProblem(st) };
      }
      if (!heartbeatChecked) {
        heartbeatChecked = true;
        if (!(await this.watcherAlive())) {
          return {
            ok: false,
            reason: 'службу файлов запускает автообновление, а оно на этом сервере не работает (setup.sh запускали не от root?)',
          };
        }
      }
      if (Date.now() >= deadline) return { ok: false, reason: 'служба файлов не запустилась за 2,5 минуты — подробности в /var/lib/telemax-files на сервере' };
      await sleep(3000);
    }
  }

  private async readServiceState(): Promise<ServiceState | null> {
    try {
      return JSON.parse(await readFile(path.join(this.dir, 'service.json'), 'utf8')) as ServiceState;
    } catch {
      return null;
    }
  }

  private async watcherAlive(): Promise<boolean> {
    try {
      const s = await stat(path.join(this.dir, '..', 'watcher-heartbeat'));
      return Date.now() - s.mtimeMs < HEARTBEAT_STALE_MS;
    } catch {
      return false;
    }
  }

  // --- housekeeping ---------------------------------------------------------------------------

  /** Drops expired links with their files, and anything on disk the index no longer knows. */
  async sweep(): Promise<void> {
    await this.locked(async () => {
      const now = Date.now();
      const expiredFiles = this.index.files.filter((f) => f.expiresAt <= now);
      const expiredTickets = this.index.tickets.filter((t) => t.expiresAt <= now && !this.busyTokens.has(t.token));
      this.index.files = this.index.files.filter((f) => f.expiresAt > now);
      this.index.tickets = this.index.tickets.filter((t) => !expiredTickets.includes(t));
      for (const f of expiredFiles) logger.info(`File «${f.name}» expired — deleted`);
      const liveTokens = new Set([...this.index.files.map((f) => f.token), ...this.index.tickets.map((t) => t.token)]);
      const liveItems = new Set(this.index.files.map((f) => f.id));
      for (const name of await readdir(path.join(this.dir, 'tokens')).catch(() => [] as string[])) {
        if (!liveTokens.has(name.replace(/\.json(\.tmp)?$/, ''))) await unlink(path.join(this.dir, 'tokens', name)).catch(() => {});
      }
      for (const name of await readdir(path.join(this.dir, 'items')).catch(() => [] as string[])) {
        if (!liveItems.has(name)) await rm(path.join(this.dir, 'items', name), { recursive: true, force: true });
      }
      for (const name of await readdir(path.join(this.dir, 'incoming')).catch(() => [] as string[])) {
        if (!liveTokens.has(name)) await rm(path.join(this.dir, 'incoming', name), { recursive: true, force: true });
      }
      await this.save();
    });
  }

  /** Hands every finished upload to the handler, one at a time. */
  async pollUploads(): Promise<void> {
    if (!this.uploadHandler) return;
    for (const ticket of [...this.index.tickets]) {
      if (this.busyTokens.has(ticket.token)) continue;
      const dir = path.join(this.dir, 'incoming', ticket.token);
      let done: { name?: string; size?: number; file?: string } | null;
      try {
        done = JSON.parse(await readFile(path.join(dir, 'done.json'), 'utf8')) as typeof done;
      } catch {
        continue;
      }
      const name = safeFileName(done?.name ?? ticket.name);
      const filePath = path.join(dir, done?.file ?? name);
      this.busyTokens.add(ticket.token);
      try {
        const size = (await stat(filePath)).size;
        logger.info(`Upload for «${name}» (${size} bytes) arrived — sending it on`);
        await this.uploadHandler(ticket, filePath, size, name);
      } catch (err) {
        logger.error(`Processing the upload «${name}» failed`, err);
      } finally {
        this.busyTokens.delete(ticket.token);
      }
    }
  }

  /** Upload polling every 5 s, sweeping every 10 min. Timers are unref'd. */
  startBackground(): void {
    const poll = setInterval(() => void this.pollUploads().catch((err) => logger.error('pollUploads failed', err)), 5000);
    poll.unref();
    const sweep = setInterval(() => void this.sweep().catch((err) => logger.error('sweep failed', err)), 10 * 60_000);
    sweep.unref();
  }
}

function describeServiceProblem(st: ServiceState): string {
  switch (st.state) {
    case 'ports-busy':
      return 'порты 80/443 на сервере заняты другим веб-сервером — файлы можно пустить через него (FILES_PUBLIC_URL и FILES_LISTEN в .env, см. README)';
    case 'no-ip':
      return 'не удалось определить внешний IPv4-адрес сервера (можно указать свой домен: FILES_DOMAIN в .env)';
    default:
      return `служба файлов не запустилась${st.detail ? `: ${st.detail}` : ''}`;
  }
}

/** Readable from a WHATWG stream (undici's Response.body). */
export function nodeReadable(body: ReadableStream<Uint8Array>): Readable {
  return Readable.fromWeb(body as Parameters<typeof Readable.fromWeb>[0]);
}
