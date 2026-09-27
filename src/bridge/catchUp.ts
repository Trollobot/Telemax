/**
 * Per-session "caught up" bookkeeping for the per-chat history cursor
 * (ChatMapping.historyBackfillCursor).
 *
 * INVARIANT: the cursor never passes a message that was not delivered.
 *
 * The cursor is the lower bound of every reconnect catch-up (fetchFullHistory: `time > cursor`),
 * so anything older than it is never fetched again. Two writers move it:
 *  - the history backfill, oldest-first through a snapshot, after each message — safe on its
 *    own because it walks the gap in order;
 *  - the live paths (an incoming push delivered to Telegram, our own send to MAX), which jump it
 *    to the newest message. That jump is only safe once everything older in that chat is already
 *    in Telegram. Right after a (re)connect it is not: messages that arrived in MAX while the
 *    bridge was offline are still waiting for syncAllChatsToTelegram to reach the chat, and a
 *    live message landing first used to move the cursor past them — lost for good (review
 *    2026-09-26, C3).
 *
 * So a live path advances the cursor ONLY for chats in this set. A chat joins it when:
 *  - syncAllChatsToTelegram finished its history fetch + backfill for it (even an empty one);
 *  - restoreDeletedTopic finished refilling its recreated topic;
 *  - its mapping was created fresh this session by a live path: a group we just created or the
 *    first send opening a pending 1:1 (markCaughtUp — there is truly no older history), or a new
 *    contact's first push (markBornLive). The latter only once a full catch-up pass has completed
 *    since the last reset, and never while the chat has an undelivered live message pending
 *    (markDirty): until then its first messages may have arrived while the bridge was offline, or
 *    failed on the way, and moving the cursor to the live message lost them for good (review
 *    2026-09-26, b2a-cursor/b2b-errors). Left out, the chat is picked up by the running (or retry)
 *    sync — it walks mapped chats missing from its snapshot too — which backfills its short history
 *    from a null cursor and skips what the live path already delivered by its link. A chat refused
 *    after the running pass already listed its mappings is not visited by that pass, so the pass
 *    asks for a retry run when it completes with such a chat still not caught up — before, it stayed
 *    out all session, its cursor frozen, and the next restart re-sent everything it relayed (review
 *    2026-09-26, catchup-r2#0).
 * The set is emptied (reset) on every new MAX socket and on /reboot: whatever arrived in the
 * gap has to be caught up again first. Live messages delivered for a not-yet-caught-up chat are
 * still relayed; they just leave the cursor alone, and the backfill skips them by their
 * message link instead of sending them twice — pinned, so a long replay cannot evict it first
 * (MessageLinkStore.pin; review 2026-09-27, catchup-r3.2#0).
 *
 * A chat also leaves the set (markDirty) when a live message for it could not be delivered for a
 * transient reason, or while its deleted topic is being restored: the undelivered message sits
 * above the cursor only as long as nothing moves the cursor past it (review 2026-09-26,
 * RECOVERY5/RECOVERY8). Such a failure also asks for a catch-up run (requestRetry), since no
 * reconnect may come along to trigger one.
 *
 * The generation guards a sync that straddles a reconnect: a chat whose history was fetched
 * under the previous socket must not be marked caught up after the reset — that fetch could
 * not see the new gap. The same holds per chat for markDirty: a fetch captured before a live
 * failure could not see the message that failed, so it must not mark the chat either.
 *
 * Live messages delivered while a chat is not caught up are noted (noteLiveDelivered): a message
 * that arrived after the backfill fetched its snapshot is not in it, so the backfill never moved the
 * cursor up to it, and the next restart (links are in memory only) re-sent it. Whoever marks the
 * chat caught up with a generation takes the note (takeLiveCursor) and moves the cursor there — safe,
 * because everything older was just delivered and a failure since would have blocked the mark
 * (review 2026-09-26, catchup-r1#1). reset() and markDirty() drop the notes.
 */
export class CatchUpTracker {
  private readonly caughtUp = new Set<string>();
  // Monotonic: bumped by every reset() and markDirty(). A generation is just a reading of it.
  private seq = 0;
  private resetSeq = 0;
  private readonly dirtySeq = new Map<string, number>();
  // A full catch-up pass (syncAllChatsToTelegram, snapshot + mapped chats) completed since the last reset.
  private syncPassed = false;
  // Chat -> newest MAX time of a live message delivered while the chat was not caught up.
  private readonly liveDelivered = new Map<string, number>();
  // Chats markBornLive refused since the last reset / completed pass (see markSyncPassComplete).
  private readonly bornLiveRefused = new Set<string>();
  private retryHandler: ((reason: string) => void) | null = null;

  /** Current generation — capture it BEFORE fetching a chat's history, pass it to markCaughtUp after. */
  get generation(): number {
    return this.seq;
  }

  /** Forgets every chat (new MAX session / full resync): all of them must be caught up again. */
  reset(): void {
    this.caughtUp.clear();
    this.dirtySeq.clear();
    this.liveDelivered.clear();
    this.bornLiveRefused.clear();
    this.seq += 1;
    this.resetSeq = this.seq;
    this.syncPassed = false;
  }

  /**
   * Marks the chat caught up. With `generation`, only if no reset (and no markDirty of this chat)
   * happened since it was captured; returns whether the chat was marked.
   */
  markCaughtUp(chatId: unknown, generation?: number): boolean {
    const key = String(chatId);
    if (generation != null && (generation < this.resetSeq || generation < (this.dirtySeq.get(key) ?? 0))) return false;
    this.caughtUp.add(key);
    return true;
  }

  /**
   * A mapping born live (a new contact's first push): marks the chat caught up only when that is
   * safe — a catch-up pass has completed since the last reset (so nothing that arrived while the
   * bridge was offline is still waiting for it) and the chat has no undelivered live message
   * pending (markDirty with no markCaughtUp since). Returns whether the chat was marked.
   */
  markBornLive(chatId: unknown): boolean {
    const key = String(chatId);
    if (this.caughtUp.has(key)) return true;
    if (!this.syncPassed || this.dirtySeq.has(key)) {
      this.bornLiveRefused.add(key);
      // Dirty after the pass completed: no pass may be coming to reach it (a permanent failure asks
      // for no retry, a retry pass may have run before it was mapped) — ask for one (catchup-r3.3#0).
      if (this.syncPassed) this.requestRetry(`MAX chat ${key} opened live while not caught up`);
      return false;
    }
    this.caughtUp.add(key);
    return true;
  }

  /**
   * A catch-up pass that captured `generation` at its start went through every chat — unless a reset
   * came since. A chat markBornLive refused meanwhile that is still not caught up was born after the
   * pass listed its mappings (or failed in it): that pass never reaches it, so another run is
   * requested (catchup-r2#0).
   */
  markSyncPassComplete(generation: number): void {
    if (generation < this.resetSeq) return;
    this.syncPassed = true;
    const missed = [...this.bornLiveRefused].filter((key) => !this.caughtUp.has(key));
    this.bornLiveRefused.clear();
    if (missed.length > 0) this.requestRetry(`MAX chat(s) ${missed.join(', ')} opened live during the catch-up pass`);
  }

  /** Takes the chat out again (e.g. a message for it could not be delivered): its cursor stays put until the next catch-up. */
  markDirty(chatId: unknown): void {
    const key = String(chatId);
    this.caughtUp.delete(key);
    this.liveDelivered.delete(key);
    this.seq += 1;
    this.dirtySeq.set(key, this.seq);
  }

  /** A live message (MAX server time `time`) was delivered while the chat was not caught up — see the class note. */
  noteLiveDelivered(chatId: unknown, time: number): void {
    if (!Number.isFinite(time)) return;
    const key = String(chatId);
    this.liveDelivered.set(key, Math.max(this.liveDelivered.get(key) ?? -Infinity, time));
  }

  /** Returns and forgets the chat's noted live time — call right after a successful markCaughtUp(chatId, generation). */
  takeLiveCursor(chatId: unknown): number | undefined {
    const key = String(chatId);
    const time = this.liveDelivered.get(key);
    this.liveDelivered.delete(key);
    return time;
  }

  /** Who runs the catch-up retries (server/app.ts's scheduler — it owns the sync runs). */
  setRetryHandler(handler: ((reason: string) => void) | null): void {
    this.retryHandler = handler;
  }

  /** Something could not be caught up for a transient reason — ask for another catch-up run later. */
  requestRetry(reason: string): void {
    this.retryHandler?.(reason);
  }

  isCaughtUp(chatId: unknown): boolean {
    return this.caughtUp.has(String(chatId));
  }
}

/**
 * The cursor value for a message relayed live: its MAX server time (a push's message.time, the
 * MSG_SEND response's message.time), so the cursor stays in the same clock fetchFullHistory
 * compares against. Local receipt time is only the fallback when the server gave none — a
 * skewed VPS clock otherwise cut off (fast clock) or re-sent (slow clock) messages at the next
 * catch-up (review 2026-09-26, RECOVERY9).
 */
export function liveCursorTime(serverTime: unknown, now: number = Date.now()): number {
  if (typeof serverTime === 'number' || typeof serverTime === 'bigint' || (typeof serverTime === 'string' && serverTime.trim() !== '')) {
    const n = Number(serverTime);
    if (Number.isFinite(n) && n > 0) return n;
  }
  return now;
}

/**
 * Thrown out of a chat's backfill or topic restore when the chat was banned (/ban) meanwhile. /ban
 * deletes the topic, and the recreate-on-thread-not-found healing used to bring it straight back:
 * a fresh mapping without the `banned` flag, the history replayed into it (review 2026-09-26, cross).
 * Stops that one chat only; nothing is retried.
 */
export class ChatBannedError extends Error {
  constructor(readonly chatId: string) {
    super(`MAX chat ${chatId} was banned — not refilling its topic`);
    this.name = 'ChatBannedError';
  }
}

/** Thrown out of the history sync when /reboot or /kill cancelled it (review 2026-09-26, C7). */
export class SyncCancelledError extends Error {
  constructor() {
    super('Chat sync cancelled');
    this.name = 'SyncCancelledError';
  }
}

/**
 * Backoff for catch-up retries after a transient failure: 30s, 1m, 2m, … capped at 15m, so an
 * outage is retried without spinning. Only an explicit reset() starts it over — the owner calls it
 * once the retried thing succeeded (a clean catch-up run, a successful LOGIN).
 */
export class RetryBackoff {
  private attempt = 0;

  constructor(
    private readonly baseMs = 30_000,
    private readonly maxMs = 15 * 60_000,
  ) {}

  /** Delay before the next retry; each call counts as one more attempt. */
  next(): number {
    const delay = Math.min(this.maxMs, this.baseMs * 2 ** Math.min(this.attempt, 30));
    this.attempt += 1;
    return delay;
  }

  /** Starts over from baseMs — after the thing being retried succeeded. */
  reset(): void {
    this.attempt = 0;
  }
}

/**
 * Counts transient failures per key (one MAX message) across catch-up runs. The backfill stops on a
 * transient error and retries later — but a failure that only LOOKS transient and repeats every
 * time (a proxy that always drops one oversized upload, a CDN file that always times out) would
 * park the chat's cursor on that message forever. After `limit` strikes spread over at least
 * `minSpanMs` the backfill degrades it to placeholders on its last try. The span keeps a plain outage
 * from counting as "this message is broken": retry runs come minutes apart, and five of them used
 * to drop a message after ~7.5 minutes of Telegram trouble (review 2026-09-26, b2b-errors).
 * Only failures pinned on the message itself are recorded (the caller's choice: a download, an
 * attachment upload — never a text send). Bounded (FIFO, `cap`). `now` is injectable for tests.
 */
export class StrikeCounter {
  private readonly strikes = new Map<string, { n: number; firstAt: number }>();

  constructor(
    readonly limit = 5,
    private readonly cap = 500,
    private readonly minSpanMs = 0,
  ) {}

  count(key: string): number {
    return this.strikes.get(key)?.n ?? 0;
  }

  /** True when this is the last allowed try — the message now degrades to placeholders. */
  isLastTry(key: string, now: number = Date.now()): boolean {
    const entry = this.strikes.get(key);
    if (!entry) return this.limit <= 1;
    return entry.n >= this.limit - 1 && now - entry.firstAt >= this.minSpanMs;
  }

  /** Records one more transient failure; returns the new count. */
  hit(key: string, now: number = Date.now()): number {
    const prev = this.strikes.get(key);
    const n = (prev?.n ?? 0) + 1;
    this.strikes.delete(key);
    this.strikes.set(key, { n, firstAt: prev?.firstAt ?? now });
    while (this.strikes.size > this.cap) {
      const oldest = this.strikes.keys().next().value;
      if (oldest === undefined) break;
      this.strikes.delete(oldest);
    }
    return n;
  }

  clear(key: string): void {
    this.strikes.delete(key);
  }

  clearAll(): void {
    this.strikes.clear();
  }
}
