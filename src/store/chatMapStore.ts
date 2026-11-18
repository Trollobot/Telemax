import { copyFile, mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { reportBridgeError } from '../bridge/errorReporter.js';
import { createLogger } from '../logger.js';

const logger = createLogger('chat-map');
/** A known-good copy for a corrupt file to fall back to; refreshed at most this often. */
const BACKUP_EVERY_MS = 60 * 60_000;

export interface ChatMapping {
  // MAX chat ids arrive as a plain number or a BigInt (large/negative ids, seen live on channels);
  // JSON can't serialize a BigInt, so this is always the decimal string form, in memory and on
  // disk. Compare via String(), convert back via BigInt(...) for a MAX request.
  maxChatId: string;
  telegramTopicId: number;
  title?: string;
  createdAt: string;
  // MAX server ms timestamp (decimal string) of the newest history message delivered to Telegram
  // so far — the lower bound of every catch-up (see ChatCatchUp in bridge/sync.ts).
  historyBackfillCursor?: string;
  // Set by /ban: incoming messages are dropped and the topic deleted. The mapping is KEPT so the
  // ban survives restarts; /unban flips it back and the next message recreates the topic.
  banned?: boolean;
  // A PENDING 1:1: the panel's "Начать чат" created a topic for a fresh contact, but MAX has no
  // dialog yet (a 1:1 is only created by the first message). Holds the contact's userId; the first
  // outbound message opens the real dialog (client.sendToNewDialog) and rewrites this into a real
  // maxChatId. Until then maxChatId is a "pending:<userId>" sentinel.
  pendingUserId?: string;
}

/**
 * A stored history cursor as a plain ms number, or null when absent/unparseable. The field is
 * written as a decimal string, but hand-edited or pre-normalization files can hold a raw number
 * (and a BigInt can reach upsert straight from a MAX payload) — accept all three.
 */
export function cursorToMs(cursor: unknown): number | null {
  if (cursor == null || cursor === '') return null;
  if (typeof cursor !== 'number' && typeof cursor !== 'string' && typeof cursor !== 'bigint') return null;
  const n = Number(cursor);
  return Number.isFinite(n) ? n : null;
}

/**
 * Normalizes a freshly parsed chat-map.json: every maxChatId becomes its decimal string, and
 * entries that name the same chat collapse into ONE (files written before the string
 * normalization can hold a raw-number entry next to its string twin — lookups then found one
 * while writes landed in the other, so the cursor never moved and bans didn't stick). The later
 * entry's fields win; the cursor keeps the more advanced of the two.
 */
export function normalizeChatMappings(raw: unknown): ChatMapping[] {
  if (!Array.isArray(raw)) return [];
  const out: ChatMapping[] = [];
  const indexById = new Map<string, number>();
  for (const entry of raw) {
    if (!entry || typeof entry !== 'object') continue;
    const m = entry as Omit<ChatMapping, 'maxChatId' | 'historyBackfillCursor'> & { maxChatId?: unknown; historyBackfillCursor?: unknown };
    if (m.maxChatId == null) continue;
    const maxChatId = String(m.maxChatId);
    const cursorMs = cursorToMs(m.historyBackfillCursor);
    const { historyBackfillCursor: _rawCursor, ...rest } = m;
    const normalized: ChatMapping = { ...rest, maxChatId };
    if (cursorMs != null) normalized.historyBackfillCursor = String(cursorMs);
    const idx = indexById.get(maxChatId);
    if (idx == null) {
      indexById.set(maxChatId, out.length);
      out.push(normalized);
      continue;
    }
    const prev = out[idx] as ChatMapping;
    const prevCursor = cursorToMs(prev.historyBackfillCursor);
    const merged: ChatMapping = { ...prev, ...normalized };
    const best = prevCursor == null ? cursorMs : cursorMs == null ? prevCursor : Math.max(prevCursor, cursorMs);
    if (best != null) merged.historyBackfillCursor = String(best);
    out[idx] = merged;
  }
  return out;
}

/** Persistent MAX chatId <-> Telegram forum topicId mapping (ТЗ.md §1.4). Not secret — plain JSON is fine. */
export class ChatMapStore {
  private cache: ChatMapping[] | null = null;
  // Concurrent upserts each write-then-rename the same tmp path; interleaved, the second rename
  // hits ENOENT (hit live 2026-08-08). Every write is chained onto this queue.
  private writeQueue: Promise<void> = Promise.resolve();

  constructor(private readonly filePath: string = path.join(process.cwd(), '.data', 'chat-map.json')) {}

  async list(): Promise<ChatMapping[]> {
    return [...(await this.load())];
  }

  async getByMaxChatId(maxChatId: unknown): Promise<ChatMapping | undefined> {
    const key = String(maxChatId);
    // Strict compare is safe: load() normalizes every id to its string (normalizeChatMappings).
    return (await this.load()).find((m) => m.maxChatId === key);
  }

  async getByTopicId(telegramTopicId: number): Promise<ChatMapping | undefined> {
    return (await this.load()).find((m) => m.telegramTopicId === telegramTopicId);
  }

  async upsert(mapping: {
    maxChatId: unknown;
    telegramTopicId: number;
    title?: string;
    createdAt: string;
    historyBackfillCursor?: string;
    banned?: boolean;
    pendingUserId?: string;
  }): Promise<void> {
    const normalized: ChatMapping = { ...mapping, maxChatId: String(mapping.maxChatId) };
    const all = await this.load();
    const idx = all.findIndex((m) => m.maxChatId === normalized.maxChatId); // stored ids normalized in load()
    if (idx >= 0) all[idx] = normalized;
    else all.push(normalized);
    this.cache = all;
    await this.persist(all);
  }

  /** Flags/unflags a chat as banned (/ban, /unban). No-op if the chat has no mapping. */
  async setBanned(maxChatId: unknown, banned: boolean): Promise<void> {
    const existing = await this.getByMaxChatId(maxChatId);
    if (!existing) return;
    await this.upsert({ ...existing, banned });
  }

  /**
   * Records a topic's new title after a rename. Re-reads the entry and merges only `title`: every
   * rename awaits editForumTopic first, and writing back a whole entry read before that call
   * dragged the cursor back or dropped a /ban set meanwhile. No-op when the chat is gone or now
   * lives in a different topic than the one renamed.
   */
  async setTitle(maxChatId: unknown, telegramTopicId: number, title: string): Promise<void> {
    const current = await this.getByMaxChatId(maxChatId);
    if (!current || current.telegramTopicId !== telegramTopicId || current.title === title) return;
    await this.upsert({ ...current, title });
  }

  /** Drops a mapping entirely — a topic recreate, a chat closed in MAX, a pending dialog rewritten. */
  async remove(maxChatId: unknown): Promise<void> {
    const key = String(maxChatId);
    const all = await this.load();
    const filtered = all.filter((m) => m.maxChatId !== key);
    if (filtered.length === all.length) return;
    this.cache = filtered;
    await this.persist(filtered);
  }

  /**
   * Moves the chat's history cursor FORWARD to `time` (MAX server ms). Never backwards: a backfill
   * replays a snapshot oldest-first while live messages keep arriving, and an unconditional write
   * dragged the cursor back behind messages already delivered live.
   */
  async advanceHistoryCursor(maxChatId: unknown, time: number): Promise<void> {
    if (!Number.isFinite(time)) return;
    const existing = await this.getByMaxChatId(maxChatId);
    if (!existing) return;
    const current = cursorToMs(existing.historyBackfillCursor);
    if (current != null && time <= current) return;
    await this.upsert({ ...existing, historyBackfillCursor: String(time) });
  }

  /** Wipes every mapping — used by /reboot to force a full from-scratch resync. */
  async clear(): Promise<void> {
    this.cache = [];
    await this.persist([]);
  }

  // Memoizes the in-flight first read: concurrent first accesses would each install their OWN
  // array as the cache, and all but the last writer's entries were dropped from disk (caught 2026-08-14).
  private pendingLoad: Promise<ChatMapping[]> | null = null;

  private load(): Promise<ChatMapping[]> {
    if (this.cache) return Promise.resolve(this.cache);
    this.pendingLoad ??= (async () => {
      try {
        const raw = await readFile(this.filePath, 'utf8');
        this.cache = normalizeChatMappings(JSON.parse(raw));
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code === 'ENOENT') this.cache = [];
        else if (err instanceof SyntaxError) this.cache = await this.recoverFromCorruptFile(err);
        else throw err;
      }
      return this.cache;
    })().finally(() => {
      // On failure this allows a retry instead of caching the rejection forever.
      this.pendingLoad = null;
    });
    return this.pendingLoad;
  }

  private persist(mappings: ChatMapping[]): Promise<void> {
    const run = this.writeQueue.then(() => this.writeToDisk(mappings));
    // Keep the queue moving even if this write failed, so one bad write doesn't wedge every later one.
    this.writeQueue = run.catch(() => undefined);
    return run;
  }

  private lastBackupAt = 0;

  private async writeToDisk(mappings: ChatMapping[]): Promise<void> {
    try {
      await mkdir(path.dirname(this.filePath), { recursive: true });
      // write-then-rename so a crash mid-write can't leave a truncated/corrupt map file
      const tmpPath = `${this.filePath}.tmp`;
      await writeFile(tmpPath, JSON.stringify(mappings, null, 2), { encoding: 'utf8', mode: 0o600 });
      await rename(tmpPath, this.filePath);
      if (Date.now() - this.lastBackupAt > BACKUP_EVERY_MS) {
        this.lastBackupAt = Date.now();
        await copyFile(this.filePath, `${this.filePath}.bak`).catch((err) => logger.warn('Could not refresh chat-map.json.bak', err));
      }
    } catch (err) {
      // Memory is already ahead of disk: after a restart everything since the last good write would be
      // sent again. Every later write rewrites the whole file, so freeing the disk heals it — but the
      // owner has to know (a full disk is the usual cause).
      logger.error('Saving chat-map.json failed', err);
      reportBridgeError(
        'chat-map-save-failed',
        `⚠️ Не удалось сохранить привязку чатов к темам (${(err as NodeJS.ErrnoException).code ?? (err as Error).message}). Скорее всего, кончилось место на диске. Мост работает, но после перезапуска часть сообщений придёт повторно — освободите место.`,
      );
      throw err;
    }
  }

  /**
   * A chat-map.json that is not JSON (a truncated write from an old version, a disk error) used to make
   * every lookup throw — the bridge looked alive and relayed nothing. Now it is parked as .broken (never
   * deleted) and the hourly .bak, if readable, takes its place; failing that the bridge starts with no
   * mappings (topics are created afresh — duplicates, but it relays). Either way the owner is told.
   */
  private async recoverFromCorruptFile(err: SyntaxError): Promise<ChatMapping[]> {
    await rename(this.filePath, `${this.filePath}.broken`).catch(() => {});
    let restored: ChatMapping[] | null = null;
    try {
      restored = normalizeChatMappings(JSON.parse(await readFile(`${this.filePath}.bak`, 'utf8')));
      await copyFile(`${this.filePath}.bak`, this.filePath);
    } catch {
      restored = null;
    }
    logger.error(`chat-map.json was unreadable (${err.message}) — parked as .broken, ${restored ? `restored ${restored.length} chats from .bak` : 'starting with no mappings'}`);
    reportBridgeError(
      'chat-map-corrupt',
      restored
        ? `⚠️ Файл привязки чатов к темам был повреждён — восстановлен из резервной копии (до часа назад). Сообщения за это время могут прийти повторно.`
        : `⚠️ Файл привязки чатов к темам был повреждён, резервной копии нет — темы будут созданы заново. Старый файл сохранён как chat-map.json.broken.`,
    );
    return restored ?? [];
  }
}
