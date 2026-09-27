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
  // ms timestamp (decimal string, same overflow reason as maxChatId) of the newest
  // history message actually delivered to Telegram so far. Lets a resumed backfill
  // (crash, redeploy, or a fresh reconnect mid-flood-wait) skip everything already
  // sent instead of replaying the whole chat and duplicating messages.
  historyBackfillCursor?: string;
  // Set by /ban: incoming MAX messages for this chat are dropped (not mirrored) and
  // its Telegram topic is deleted. The mapping is KEPT (banned=true) so the ban
  // survives restarts; /unban flips this back and the next message recreates the
  // topic (via the thread-not-found auto-recreate path in bridge/sync.ts).
  banned?: boolean;
  // Set while this mapping is a PENDING 1:1 dialog: the panel's "Начать чат" created a topic for a
  // fresh contact, but MAX has no dialog yet (a 1:1 is only created by the first message). Holds the
  // contact's userId; the first outbound message opens the real dialog (client.sendToNewDialog) and
  // rewrites this into a real maxChatId. Until then maxChatId is a "pending:<userId>" sentinel so the
  // store's maxChatId keying still works.
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
 * entries that name the same chat collapse into ONE. Files written before the string
 * normalization can hold a legacy raw-number entry, and the old upsert (strict === against the
 * normalized string) never matched it — it appended a string twin instead. Lookups found the
 * legacy copy first while every write (cursor, /ban) landed in the twin nobody read, so the
 * cursor never moved and bans didn't stick (review 2026-09-26). The later entry is the newer
 * write (upsert appends), so its fields win; the cursor keeps the more advanced of the two.
 * The merged entry stays at the first twin's position.
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
    // Files written before the string-normalization fix can still contain raw-number
    // entries; a strict === against those would silently miss and re-create a duplicate
    // topic (hit live in prod 2026-08-08). load() now normalizes every id to its string
    // and merges legacy twins (normalizeChatMappings), so the strict compare is safe.
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
   * rename awaits editForumTopic first, and writing back the whole entry read before that call
   * dragged the cursor back, dropped a /ban set meanwhile or restored a mapping a topic recreate had
   * just replaced (review 2026-09-26, catchup-r1#4). No-op when the chat is gone or now lives in a
   * different topic than the one renamed.
   */
  async setTitle(maxChatId: unknown, telegramTopicId: number, title: string): Promise<void> {
    const current = await this.getByMaxChatId(maxChatId);
    if (!current || current.telegramTopicId !== telegramTopicId || current.title === title) return;
    await this.upsert({ ...current, title });
  }

  /** Drops a mapping entirely — used only to force a fresh topic when the current one was deleted in Telegram (see the recreate path in bridge/sync.ts). */
  async remove(maxChatId: unknown): Promise<void> {
    const key = String(maxChatId);
    const all = await this.load();
    const filtered = all.filter((m) => m.maxChatId !== key);
    if (filtered.length === all.length) return;
    this.cache = filtered;
    await this.persist(filtered);
  }

  /**
   * Moves the chat's history cursor FORWARD to `time` (MAX server ms). Never backwards: a
   * backfill replays a history snapshot oldest-first while live messages for the same chat
   * keep arriving, and an unconditional write let the replay drag the cursor back behind
   * messages already delivered live — the next catch-up then re-sent them (review 2026-09-26).
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

  // Memoizes the in-flight first read. Without this, concurrent first accesses
  // (a live-push upsert racing the startup sync) each read the file independently
  // and each installed their OWN array as the cache — forking it, so concurrent
  // upserts landed in different arrays and all but the last writer's entries were
  // silently dropped from disk. Caught by the concurrent-upsert test 2026-08-14.
  private pendingLoad: Promise<ChatMapping[]> | null = null;

  private load(): Promise<ChatMapping[]> {
    if (this.cache) return Promise.resolve(this.cache);
    this.pendingLoad ??= (async () => {
      try {
        const raw = await readFile(this.filePath, 'utf8');
        this.cache = normalizeChatMappings(JSON.parse(raw));
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code === 'ENOENT') this.cache = [];
        else throw err;
      }
      return this.cache;
    })().finally(() => {
      // On success the cache short-circuits future calls; on failure this
      // allows a retry instead of caching the rejection forever.
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

  private async writeToDisk(mappings: ChatMapping[]): Promise<void> {
    await mkdir(path.dirname(this.filePath), { recursive: true });
    // write-then-rename so a crash mid-write can't leave a truncated/corrupt map file
    const tmpPath = `${this.filePath}.tmp`;
    await writeFile(tmpPath, JSON.stringify(mappings, null, 2), 'utf8');
    await rename(tmpPath, this.filePath);
  }
}
