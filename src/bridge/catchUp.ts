/**
 * Helpers of the per-chat history catch-up. The bookkeeping itself — one writer per chat, catch-up
 * on first touch, the cursor gate — is ChatCatchUp in sync.ts.
 */

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
 * Counts transient failures per key (one MAX message) across catch-up runs. The backfill stops on a
 * transient error and is retried later — but a failure that only LOOKS transient and repeats every
 * time (a proxy that always drops one oversized upload, a CDN file that always times out) would
 * park the chat's cursor on that message forever. After `limit` strikes spread over at least
 * `minSpanMs` the next try degrades it to placeholders (isLastTry). The span keeps a plain outage
 * from counting as "this message is broken": a catch-up now runs on every push of the chat, so
 * three strikes can land within seconds of a short Telegram hiccup (review 2026-09-26, b2b-errors).
 * Bounded (FIFO, `cap`). `now` is injectable for tests.
 */
export class StrikeCounter {
  private readonly strikes = new Map<string, { n: number; firstAt: number }>();

  constructor(
    readonly limit = 3,
    private readonly cap = 500,
    private readonly minSpanMs = 60 * 60_000,
  ) {}

  /** True when the message has struck out — its next try degrades to placeholders. */
  isLastTry(key: string, now: number = Date.now()): boolean {
    const entry = this.strikes.get(key);
    return entry != null && entry.n >= this.limit && now - entry.firstAt >= this.minSpanMs;
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
