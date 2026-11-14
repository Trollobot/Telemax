import { describe, expect, it } from 'vitest';
import { healthSnapshot } from '../src/server/health.js';

describe('healthSnapshot', () => {
  const now = 1_800_000_000_000;
  it('is ok only with MAX logged in and a Telegram poll answered in the last 3 minutes', () => {
    expect(healthSnapshot({ maxState: 'loggedIn', maxLoggedIn: true, lastPollOkAt: now - 30_000, telegramEnabled: true, now }).ok).toBe(true);
    expect(healthSnapshot({ maxState: 'loggedIn', maxLoggedIn: true, lastPollOkAt: now - 4 * 60_000, telegramEnabled: true, now }).ok).toBe(false);
    expect(healthSnapshot({ maxState: 'loggedIn', maxLoggedIn: true, lastPollOkAt: 0, telegramEnabled: true, now }).ok).toBe(false);
    expect(healthSnapshot({ maxState: 'reconnecting', maxLoggedIn: false, lastPollOkAt: now, telegramEnabled: true, now }).ok).toBe(false);
    expect(healthSnapshot({ maxState: 'loggedIn', maxLoggedIn: false, lastPollOkAt: now, telegramEnabled: true, now }).ok).toBe(false);
  });
  it('reports what it saw', () => {
    expect(healthSnapshot({ maxState: 'loggedIn', maxLoggedIn: true, lastPollOkAt: now - 12_400, telegramEnabled: true, now })).toEqual({ ok: true, max: 'loggedIn', telegramAgoS: 12, at: new Date(now).toISOString() });
  });
});
