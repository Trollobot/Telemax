import { describe, expect, it } from 'vitest';
import { CatchUpTracker, RetryBackoff, StrikeCounter, liveCursorTime } from '../src/bridge/catchUp.js';

describe('CatchUpTracker', () => {
  it('starts with no chat caught up and marks by normalized id', () => {
    const t = new CatchUpTracker();
    expect(t.isCaughtUp(1)).toBe(false);
    expect(t.markCaughtUp(123n)).toBe(true);
    expect(t.isCaughtUp('123')).toBe(true);
    expect(t.isCaughtUp(123)).toBe(true);
  });

  it('reset() forgets every chat (new MAX session)', () => {
    const t = new CatchUpTracker();
    t.markCaughtUp(1);
    t.markCaughtUp(2);
    t.reset();
    expect(t.isCaughtUp(1)).toBe(false);
    expect(t.isCaughtUp(2)).toBe(false);
  });

  it('markDirty() takes a single chat out', () => {
    const t = new CatchUpTracker();
    t.markCaughtUp(1);
    t.markCaughtUp(2);
    t.markDirty('1');
    expect(t.isCaughtUp(1)).toBe(false);
    expect(t.isCaughtUp(2)).toBe(true);
  });

  it('ignores a mark whose generation predates a reset (fetch under the old socket)', () => {
    const t = new CatchUpTracker();
    const gen = t.generation;
    t.reset(); // reconnect while the chat's history was being fetched/backfilled
    expect(t.markCaughtUp(5, gen)).toBe(false);
    expect(t.isCaughtUp(5)).toBe(false);
    // A fetch started after the reset counts.
    expect(t.markCaughtUp(5, t.generation)).toBe(true);
    expect(t.isCaughtUp(5)).toBe(true);
  });
});

describe('liveCursorTime', () => {
  const NOW = 1_700_000_000_000;

  it('prefers the MAX server time in any wire form', () => {
    expect(liveCursorTime(1_723_600_000_000, NOW)).toBe(1_723_600_000_000);
    expect(liveCursorTime(1_723_600_000_000n, NOW)).toBe(1_723_600_000_000);
    expect(liveCursorTime('1723600000000', NOW)).toBe(1_723_600_000_000);
  });

  it('falls back to local time only when the server gave none', () => {
    expect(liveCursorTime(undefined, NOW)).toBe(NOW);
    expect(liveCursorTime(null, NOW)).toBe(NOW);
    expect(liveCursorTime('', NOW)).toBe(NOW);
    expect(liveCursorTime('abc', NOW)).toBe(NOW);
    expect(liveCursorTime(0, NOW)).toBe(NOW);
    expect(liveCursorTime({}, NOW)).toBe(NOW);
  });
});

describe('CatchUpTracker — per-chat dirty generation and retries', () => {
  it('ignores a mark whose generation predates a markDirty of that chat (fetch missed the failed message)', () => {
    const t = new CatchUpTracker();
    const gen = t.generation; // sync captured it before fetching chat 7's history
    t.markDirty(7); // a live delivery for chat 7 failed after that fetch
    expect(t.markCaughtUp(7, gen)).toBe(false);
    expect(t.isCaughtUp(7)).toBe(false);
    // Other chats are unaffected by chat 7's dirt.
    expect(t.markCaughtUp(8, gen)).toBe(true);
    // A fetch started after the failure counts.
    expect(t.markCaughtUp(7, t.generation)).toBe(true);
  });

  it('forwards requestRetry to the handler (and is a no-op without one)', () => {
    const t = new CatchUpTracker();
    expect(() => t.requestRetry('nobody listens')).not.toThrow();
    const reasons: string[] = [];
    t.setRetryHandler((r) => reasons.push(r));
    t.requestRetry('a');
    t.requestRetry('b');
    expect(reasons).toEqual(['a', 'b']);
  });
});

describe('RetryBackoff', () => {
  it('doubles from the base up to the cap', () => {
    const b = new RetryBackoff(30_000, 15 * 60_000);
    const delays = Array.from({ length: 8 }, () => b.next());
    expect(delays).toEqual([30_000, 60_000, 120_000, 240_000, 480_000, 900_000, 900_000, 900_000]);
  });

  it('reset() starts over at once', () => {
    const b = new RetryBackoff(5_000, 60_000);
    b.next();
    b.next();
    expect(b.next()).toBe(20_000);
    b.reset();
    expect(b.next()).toBe(5_000);
  });
});

describe('StrikeCounter', () => {
  it('reports the last try once limit-1 strikes are recorded, and clears', () => {
    const s = new StrikeCounter(3);
    expect(s.isLastTry('c:1')).toBe(false);
    expect(s.hit('c:1')).toBe(1);
    expect(s.isLastTry('c:1')).toBe(false);
    expect(s.hit('c:1')).toBe(2);
    expect(s.isLastTry('c:1')).toBe(true);
    expect(s.isLastTry('c:2')).toBe(false);
    s.clear('c:1');
    expect(s.count('c:1')).toBe(0);
  });

  it('stays bounded, dropping the oldest keys', () => {
    const s = new StrikeCounter(5, 2);
    s.hit('a');
    s.hit('b');
    s.hit('c');
    expect(s.count('a')).toBe(0);
    expect(s.count('b')).toBe(1);
    expect(s.count('c')).toBe(1);
    s.clearAll();
    expect(s.count('c')).toBe(0);
  });
});

describe('CatchUpTracker — mappings born live (review 2026-09-26, b2a-cursor/b2b-errors)', () => {
  it('does not mark a born-live chat before a catch-up pass has completed since the reset', () => {
    const t = new CatchUpTracker();
    t.reset(); // new MAX socket — messages may have arrived while offline
    expect(t.markBornLive(1)).toBe(false);
    expect(t.isCaughtUp(1)).toBe(false);
    t.markSyncPassComplete(t.generation);
    expect(t.markBornLive(1)).toBe(true);
    expect(t.isCaughtUp(1)).toBe(true);
  });

  it('ignores a pass that straddled a reset', () => {
    const t = new CatchUpTracker();
    const gen = t.generation;
    t.reset();
    t.markSyncPassComplete(gen);
    expect(t.markBornLive(2)).toBe(false);
    t.markSyncPassComplete(t.generation);
    t.reset();
    expect(t.markBornLive(2)).toBe(false);
  });

  it('never overrides a pending markDirty (first push failed, second created the topic)', () => {
    const t = new CatchUpTracker();
    t.markSyncPassComplete(t.generation);
    t.markDirty(3);
    expect(t.markBornLive(3)).toBe(false);
    expect(t.isCaughtUp(3)).toBe(false);
    // The retry sync catches it up; from then on it simply stays caught up.
    expect(t.markCaughtUp(3, t.generation)).toBe(true);
    expect(t.markBornLive(3)).toBe(true);
  });

  it('asks for a retry when a chat refused during the pass is still not caught up at its end (catchup-r2#0)', () => {
    const t = new CatchUpTracker();
    const reasons: string[] = [];
    t.setRetryHandler((r) => reasons.push(r));
    t.reset();
    const gen = t.generation;
    // Born live during the pass: 40 before the pass listed its mappings (caught up by it), 57 after.
    expect(t.markBornLive(40)).toBe(false);
    expect(t.markBornLive(57)).toBe(false);
    expect(t.markCaughtUp(40, gen)).toBe(true);
    t.markSyncPassComplete(gen);
    expect(reasons).toHaveLength(1);
    expect(reasons[0]).toContain('57');
    expect(reasons[0]).not.toContain('40');
    // The refusal is consumed: the next completed pass does not ask again by itself.
    t.markSyncPassComplete(t.generation);
    expect(reasons).toHaveLength(1);
  });

  it('asks for no retry when the pass straddled a reset (the next pass lists the mapping anyway)', () => {
    const t = new CatchUpTracker();
    const reasons: string[] = [];
    t.setRetryHandler((r) => reasons.push(r));
    const gen = t.generation;
    expect(t.markBornLive(6)).toBe(false);
    t.reset();
    t.markSyncPassComplete(gen);
    t.markSyncPassComplete(t.generation);
    expect(reasons).toEqual([]);
  });
});

describe('StrikeCounter — minimum span (review 2026-09-26, b2b-errors)', () => {
  it('is not the last try until the strikes cover minSpanMs', () => {
    const s = new StrikeCounter(3, 500, 60_000);
    s.hit('k', 0);
    s.hit('k', 1_000);
    expect(s.isLastTry('k', 2_000)).toBe(false); // enough strikes, too little time
    expect(s.isLastTry('k', 60_000)).toBe(true);
    s.hit('k', 70_000); // later strikes keep the first one's time
    expect(s.isLastTry('k', 70_000)).toBe(true);
  });

  it('needs the strike count as well as the span', () => {
    const s = new StrikeCounter(3, 500, 60_000);
    s.hit('k', 0);
    expect(s.isLastTry('k', 10 * 60_000)).toBe(false);
  });
});

describe('CatchUpTracker — live messages delivered before the catch-up ends (review 2026-09-26, catchup-r1#1)', () => {
  it('keeps the newest noted time until it is taken', () => {
    const t = new CatchUpTracker();
    t.noteLiveDelivered(5, 2000);
    t.noteLiveDelivered('5', 1500); // an older one never lowers it
    expect(t.takeLiveCursor(5)).toBe(2000);
    expect(t.takeLiveCursor(5)).toBeUndefined();
    t.noteLiveDelivered(5, Number.NaN);
    expect(t.takeLiveCursor(5)).toBeUndefined();
  });

  it('drops the notes on reset and on markDirty of that chat', () => {
    const t = new CatchUpTracker();
    t.noteLiveDelivered(1, 100);
    t.noteLiveDelivered(2, 200);
    t.markDirty(1); // a later live message failed: the note must not carry the cursor past it
    expect(t.takeLiveCursor(1)).toBeUndefined();
    expect(t.takeLiveCursor(2)).toBe(200);
    t.noteLiveDelivered(2, 300);
    t.reset();
    expect(t.takeLiveCursor(2)).toBeUndefined();
  });
});
