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

