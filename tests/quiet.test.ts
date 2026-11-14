import { describe, expect, it } from 'vitest';
import { installQuietSends, quietlyIf, runQuietly } from '../src/telegram/quiet.js';
import { isLateDelivery } from '../src/bridge/sync.js';

function fakeTelegram() {
  const calls: { method: string; payload: Record<string, unknown> }[] = [];
  const telegram = {
    callApi: async (method: string, payload: object) => {
      calls.push({ method, payload: payload as Record<string, unknown> });
      return true;
    },
  };
  installQuietSends(telegram);
  return { telegram, calls };
}

describe('quiet sends (history and catch-up)', () => {
  it('adds disable_notification to posting calls inside runQuietly only', async () => {
    const { telegram, calls } = fakeTelegram();
    await telegram.callApi('sendMessage', { text: 'live' });
    await runQuietly(async () => {
      await telegram.callApi('sendMessage', { text: 'old' });
      await telegram.callApi('sendMediaGroup', { media: [] });
      await telegram.callApi('copyMessage', {});
      await telegram.callApi('sendChatAction', { action: 'typing' }); // has no such parameter
      await telegram.callApi('editMessageText', { text: 'x' }); // not a new message
    });
    expect(calls.map((c) => [c.method, c.payload.disable_notification])).toEqual([
      ['sendMessage', undefined],
      ['sendMessage', true],
      ['sendMediaGroup', true],
      ['copyMessage', true],
      ['sendChatAction', undefined],
      ['editMessageText', undefined],
    ]);
  });

  it('quietlyIf is scoped to its function: a live message after a quiet history batch still rings', async () => {
    const { telegram, calls } = fakeTelegram();
    async function deliver(late: boolean): Promise<void> {
      await quietlyIf(late, async () => {
        await Promise.resolve();
        await telegram.callApi('sendMessage', { text: late ? 'old' : 'new' });
      });
    }
    await deliver(true);
    await telegram.callApi('sendMessage', { text: 'caller, after a quiet delivery' });
    await deliver(false);
    expect(calls.map((c) => c.payload.disable_notification)).toEqual([true, undefined, undefined]);
  });

  it('counts a message as late from five minutes old', () => {
    const now = 1_800_000_000_000;
    expect(isLateDelivery(now - 5 * 60_000, now)).toBe(true);
    expect(isLateDelivery(now - 60_000, now)).toBe(false);
    expect(isLateDelivery('garbage', now)).toBe(false);
  });
});
