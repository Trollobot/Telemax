import { describe, expect, it } from 'vitest';
import { staleTelegramUpdate } from '../src/bridge/sync.js';

describe('staleTelegramUpdate', () => {
  const now = 1_800_000_000_000;
  const sec = (msAgo: number) => Math.floor((now - msAgo) / 1000);
  it('lets fresh messages, edits and reactions through', () => {
    expect(staleTelegramUpdate({ message: { date: sec(60_000) } }, now)).toBeNull();
    expect(staleTelegramUpdate({ edited_message: { date: sec(3_600_000), edit_date: sec(30_000) } }, now)).toBeNull(); // an old message edited just now
    expect(staleTelegramUpdate({ message_reaction: { date: sec(5_000) } }, now)).toBeNull();
    expect(staleTelegramUpdate({}, now)).toBeNull();
  });
  it('stops what waited ten minutes or more in Telegram', () => {
    expect(staleTelegramUpdate({ message: { date: sec(3 * 3_600_000) } }, now)).toEqual({ what: 'message', minutes: 180 });
    expect(staleTelegramUpdate({ edited_message: { edit_date: sec(11 * 60_000) } }, now)).toEqual({ what: 'edit', minutes: 11 });
    expect(staleTelegramUpdate({ message_reaction: { date: sec(20 * 60_000) } }, now)).toEqual({ what: 'reaction', minutes: 20 });
  });
});


describe('STALE_TELEGRAM_MINUTES', () => {
  const now = 1_800_000_000_000;
  const old = { message: { date: Math.floor((now - 30 * 60_000) / 1000) } };
  it('defaults to 10 minutes, takes a number, and off relays everything', async () => {
    const { staleTelegramUpdate, staleCutoffMs } = await import('../src/bridge/sync.js');
    expect(staleCutoffMs({})).toBe(600_000);
    expect(staleCutoffMs({ STALE_TELEGRAM_MINUTES: '60' })).toBe(3_600_000);
    expect(staleCutoffMs({ STALE_TELEGRAM_MINUTES: 'garbage' })).toBe(600_000);
    expect(staleTelegramUpdate(old, now, {})).not.toBeNull();
    expect(staleTelegramUpdate(old, now, { STALE_TELEGRAM_MINUTES: '60' })).toBeNull();
    for (const v of ['off', '0', 'false', 'no']) expect(staleTelegramUpdate(old, now, { STALE_TELEGRAM_MINUTES: v })).toBeNull();
  });
});
