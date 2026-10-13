import { describe, expect, it, vi } from 'vitest';
import type { MaxClient } from '../src/max/client.js';
import type { ContactProfile } from '../src/max/names.js';
import { forwardDownloadIds, resolveForwardContent, resolveProfile } from '../src/bridge/sync.js';

const VLADIMIR: ContactProfile = { id: 7, names: [{ type: 'ONEME', firstName: 'Владимир', lastName: 'П.' }] };

function fakeMax(answer: () => Promise<ContactProfile[]>): { max: MaxClient; getContactInfo: ReturnType<typeof vi.fn> } {
  const getContactInfo = vi.fn(answer);
  return { max: { getContactInfo } as unknown as MaxClient, getContactInfo };
}

describe('resolveProfile (the one fetch-and-cache for MAX profiles)', () => {
  it('answers from the cache without a round trip', async () => {
    const { max, getContactInfo } = fakeMax(async () => []);
    const cache = new Map<number, ContactProfile>([[7, VLADIMIR]]);
    expect(await resolveProfile(max, 7, 'caller', cache)).toBe(VLADIMIR);
    expect(getContactInfo).not.toHaveBeenCalled();
  });

  it('fetches a missing profile once and stores it in the cache', async () => {
    const { max, getContactInfo } = fakeMax(async () => [VLADIMIR]);
    const cache = new Map<number, ContactProfile>();
    expect(await resolveProfile(max, 7, 'caller', cache)).toBe(VLADIMIR);
    expect(getContactInfo).toHaveBeenCalledWith([7]);
    expect(cache.get(7)).toBe(VLADIMIR);
  });

  it('works without a cache', async () => {
    const { max } = fakeMax(async () => [VLADIMIR]);
    expect(await resolveProfile(max, 7, 'voter')).toBe(VLADIMIR);
  });

  it('returns undefined (and caches nothing) when MAX knows no such user or the lookup fails', async () => {
    const cache = new Map<number, ContactProfile>();
    expect(await resolveProfile(fakeMax(async () => []).max, 7, 'caller', cache)).toBeUndefined();
    expect(await resolveProfile(fakeMax(async () => Promise.reject(new Error('timeout'))).max, 7, 'caller', cache)).toBeUndefined();
    expect(cache.size).toBe(0);
  });
});

describe('forwardDownloadIds', () => {
  it('downloads from the source message/chat, with the wrapper as the fallback', () => {
    expect(forwardDownloadIds({ chatId: 555, message: { id: 'orig-1' } }, 100, 'wrap-1')).toEqual({
      chatId: 555,
      messageId: 'orig-1',
      fallbackChatId: 100,
      fallbackMessageId: 'wrap-1',
    });
  });

  it('keeps a hidden source chat (chatId 0) as primary — the fallback is what rescues the file', () => {
    const ids = forwardDownloadIds({ chatId: 0, message: { id: 'orig-1' } }, 100, 'wrap-1');
    expect(ids.chatId).toBe(0);
    expect(ids.fallbackChatId).toBe(100);
    expect(ids.fallbackMessageId).toBe('wrap-1');
  });

  it('falls back to the wrapper ids when the link lacks them', () => {
    expect(forwardDownloadIds({}, 100, 'wrap-1')).toEqual({ chatId: 100, messageId: 'wrap-1', fallbackChatId: 100, fallbackMessageId: 'wrap-1' });
  });
});

describe('resolveForwardContent (shared by the live path and the backfill)', () => {
  const chats = [{ id: 555, title: 'Рабочий чат' }];

  it('is null for anything but a forward', async () => {
    const { max } = fakeMax(async () => []);
    expect(await resolveForwardContent(max, chats, undefined, 100, 1)).toBeNull();
    expect(await resolveForwardContent(max, chats, { type: 'REPLY', message: { id: 1 } }, 100, 1)).toBeNull();
  });

  it('unwraps text, attachments, source label and sender, and carries the download fallback', async () => {
    const { max } = fakeMax(async () => [VLADIMIR]);
    const photo = { _type: 'PHOTO', photoId: 1 };
    const out = await resolveForwardContent(
      max,
      chats,
      { type: 'FORWARD', chatId: 555, message: { id: 'orig-1', text: 'привет', sender: 7, attaches: [photo] } },
      100,
      'wrap-1',
    );
    expect(out?.text).toBe('↩️ Переслано из «Рабочий чат» (от Владимир П.):\nпривет');
    expect(out?.attaches).toEqual([photo]);
    expect(out?.download).toEqual({ chatId: 555, messageId: 'orig-1', fallbackChatId: 100, fallbackMessageId: 'wrap-1' });
  });

  it('a forward from a hidden chat (the backfill used to drop its file) still gets the recipient-chat fallback', async () => {
    const { max } = fakeMax(async () => []);
    const out = await resolveForwardContent(max, chats, { type: 'FORWARD', chatId: 0, message: { id: 'orig-1', sender: 7, attaches: [{ _type: 'FILE' }] } }, 100, 'wrap-1');
    // No name for the source — no «MAX chat 0» stand-in either (seen live as «MAX chat 381718116»).
    expect(out?.text).toBe('↩️ Переслано (от MAX ID 7):');
    expect(out?.download.fallbackChatId).toBe(100);
    expect(out?.download.fallbackMessageId).toBe('wrap-1');
  });

  it('names a 1:1 dialog by the other person, and skips it when that is the sender again', async () => {
    const { max } = fakeMax(async () => [VLADIMIR]);
    const profiles = new Map<number, ContactProfile>([[9, { id: 9, names: [{ name: 'Анна', type: 'ONEME' }] }]]);
    const dialogs = [
      { id: 381718116, type: 'DIALOG', participants: { 1: 0, 9: 0 } },
      { id: 381718117, type: 'DIALOG', participants: { 1: 0, 7: 0 } },
    ];
    const fromAnna = await resolveForwardContent(max, dialogs, { type: 'FORWARD', chatId: 381718116, message: { text: 'x', sender: 7 } }, 100, 'w', profiles, 1);
    expect(fromAnna?.text).toBe('↩️ Переслано из «Анна» (от Владимир П.):\nx');
    const fromVladimir = await resolveForwardContent(max, dialogs, { type: 'FORWARD', chatId: 381718117, message: { text: 'y', sender: 7 } }, 100, 'w', profiles, 1);
    expect(fromVladimir?.text).toBe('↩️ Переслано (от Владимир П.):\ny');
  });

  it('uses and fills the profile cache when one is passed', async () => {
    const { max, getContactInfo } = fakeMax(async () => [VLADIMIR]);
    const cache = new Map<number, ContactProfile>();
    const link = { type: 'FORWARD', chatId: 555, message: { id: 'o', sender: 7 } };
    await resolveForwardContent(max, chats, link, 100, 'w', cache);
    await resolveForwardContent(max, chats, link, 100, 'w', cache);
    expect(getContactInfo).toHaveBeenCalledTimes(1);
    expect(cache.get(7)).toBe(VLADIMIR);
  });

  it('names an unknown sender «неизвестно» without a lookup', async () => {
    const { max, getContactInfo } = fakeMax(async () => []);
    const out = await resolveForwardContent(max, chats, { type: 'FORWARD', chatId: 555, message: { text: 'x' } }, 100, 'w');
    expect(out?.text).toBe('↩️ Переслано из «Рабочий чат» (от неизвестно):\nx');
    expect(getContactInfo).not.toHaveBeenCalled();
  });
});
