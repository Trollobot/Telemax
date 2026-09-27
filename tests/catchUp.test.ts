import { describe, expect, it } from 'vitest';
import { RetryBackoff, StrikeCounter, liveCursorTime } from '../src/bridge/catchUp.js';

describe('StrikeCounter', () => {
  it('strikes out after `limit` hits spread over at least minSpanMs, and clears', () => {
    const s = new StrikeCounter(3, 500, 60_000);
    expect(s.isLastTry('k', 0)).toBe(false);
    s.hit('k', 0);
    s.hit('k', 1_000);
    expect(s.hit('k', 2_000)).toBe(3);
    expect(s.isLastTry('k', 3_000)).toBe(false); // enough strikes, too little time (a short outage)
    expect(s.isLastTry('k', 60_000)).toBe(true);
    s.hit('k', 70_000); // later strikes keep the first one's time
    expect(s.isLastTry('k', 70_000)).toBe(true);
    expect(s.isLastTry('other', 70_000)).toBe(false);
    s.clear('k');
    expect(s.isLastTry('k', 70_000)).toBe(false);
  });

  it('needs the strike count as well as the span, and stays bounded', () => {
    const s = new StrikeCounter(3, 2, 0);
    s.hit('a');
    expect(s.isLastTry('a', 10 * 60_000)).toBe(false);
    s.hit('b');
    s.hit('c'); // evicts 'a'
    s.hit('a');
    expect(s.hit('a')).toBe(2);
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
