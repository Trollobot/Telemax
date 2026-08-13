import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';

export interface ChatMapping {
  // MAX chat ids arrive as either a plain number or a BigInt depending on the
  // wire type the server happened to use for that chat (large/negative ids —
  // seen live on channels — come through as BigInt; JSON can't serialize those
  // directly, so this is always normalized to its decimal string form both
  // in-memory and on disk. Compare via String(), convert back via BigInt(...)
  // whenever this needs to go back out in a MAX request.
  maxChatId: string;
  telegramTopicId: number;
  title?: string;
  createdAt: string;
  // Separate from topic existence: a topic can exist (created:true once) while its
  // history backfill failed and was never retried, since `created` only fires the
  // first time. Absent/false on any entry written before this field existed —
  // read as "needs a (re)backfill attempt" (hit live in prod 2026-08-09, first
  // batch of topics predates the CHAT_HISTORY BigInt fix and stayed empty forever).
  historySynced?: boolean;
  // ms timestamp (decimal string, same overflow reason as maxChatId) of the newest
  // history message actually delivered to Telegram so far. Lets a resumed backfill
  // (crash, redeploy, or a fresh reconnect mid-flood-wait) skip everything already
  // sent instead of replaying the whole chat and duplicating messages.
  historyBackfillCursor?: string;
}

/** Persistent MAX chatId <-> Telegram forum topicId mapping (ТЗ.md §1.4). Not secret — plain JSON is fine. */
export class ChatMapStore {
  private cache: ChatMapping[] | null = null;
  // Concurrent upserts (e.g. a reconnect re-triggering a full chat sync while a
  // previous one is still in flight) each write-then-rename the same tmp path;
  // interleaved, the second rename hits ENOENT because the first already moved
  // it away. Chaining every write onto this queue serializes them (hit live in
  // production 2026-08-08).
  private writeQueue: Promise<void> = Promise.resolve();

  constructor(private readonly filePath: string = path.join(process.cwd(), '.data', 'chat-map.json')) {}

  async list(): Promise<ChatMapping[]> {
    return [...(await this.load())];
  }

  async getByMaxChatId(maxChatId: unknown): Promise<ChatMapping | undefined> {
    const key = String(maxChatId);
    // String() the stored side too — files written before the string-normalization
    // fix can still contain raw-number entries; a strict === against those would
    // silently miss and re-create a duplicate topic (hit live in prod 2026-08-08).
    return (await this.load()).find((m) => String(m.maxChatId) === key);
  }

  async getByTopicId(telegramTopicId: number): Promise<ChatMapping | undefined> {
    return (await this.load()).find((m) => m.telegramTopicId === telegramTopicId);
  }

  async upsert(mapping: {
    maxChatId: unknown;
    telegramTopicId: number;
    title?: string;
    createdAt: string;
    historySynced?: boolean;
    historyBackfillCursor?: string;
  }): Promise<void> {
    const normalized: ChatMapping = { ...mapping, maxChatId: String(mapping.maxChatId) };
    const all = await this.load();
    const idx = all.findIndex((m) => m.maxChatId === normalized.maxChatId);
    if (idx >= 0) all[idx] = normalized;
    else all.push(normalized);
    this.cache = all;
    await this.persist(all);
  }

  async markHistorySynced(maxChatId: unknown): Promise<void> {
    const existing = await this.getByMaxChatId(maxChatId);
    if (!existing) return;
    await this.upsert({ ...existing, historySynced: true });
  }

  async advanceHistoryCursor(maxChatId: unknown, time: number): Promise<void> {
    const existing = await this.getByMaxChatId(maxChatId);
    if (!existing) return;
    await this.upsert({ ...existing, historyBackfillCursor: String(time) });
  }

  /** Wipes every mapping — used by /reboot to force a full from-scratch resync. */
  async clear(): Promise<void> {
    this.cache = [];
    await this.persist([]);
  }

  private async load(): Promise<ChatMapping[]> {
    if (this.cache) return this.cache;
    try {
      const raw = await readFile(this.filePath, 'utf8');
      this.cache = JSON.parse(raw) as ChatMapping[];
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') this.cache = [];
      else throw err;
    }
    return this.cache;
  }

  private persist(mappings: ChatMapping[]): Promise<void> {
    const run = this.writeQueue.then(() => this.writeToDisk(mappings));
    // Keep the queue moving even if this write failed, so one bad write doesn't wedge every later one.
    this.writeQueue = run.catch(() => undefined);
    return run;
  }

  private async writeToDisk(mappings: ChatMapping[]): Promise<void> {
    await mkdir(path.dirname(this.filePath), { recursive: true });
    // write-then-rename so a crash mid-write can't leave a truncated/corrupt map file
    const tmpPath = `${this.filePath}.tmp`;
    await writeFile(tmpPath, JSON.stringify(mappings, null, 2), 'utf8');
    await rename(tmpPath, this.filePath);
  }
}
