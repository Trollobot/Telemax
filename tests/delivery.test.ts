import { describe, expect, it, vi } from 'vitest';
import type { Telegraf } from 'telegraf';
import { splitTelegramText, truncateCodePoints, truncateUtf16, MAX_TEXT_LIMIT, TELEGRAM_TEXT_LIMIT } from '../src/bridge/text.js';
import { dialogParticipantIds, isFallbackTitle, resolveChatName, resolveContactDisplayName } from '../src/max/names.js';
import { clampTopicTitle, ensureTopicForMaxChat, withTopicLock } from '../src/telegram/bot.js';
import { telegramSendKind, TELEGRAM_PHOTO_LIMIT_BYTES, TELEGRAM_UPLOAD_LIMIT_BYTES } from '../src/bridge/attachments.js';
import {
  buildLinkIds,
  describeUnrelayableTelegramMessage,
  discardPartialDelivery,
  HISTORY_FROM_AHEAD_MS,
  historyStartTime,
  isChatClosedNotice,
  isNoticeOf,
  isPermanentTelegramRefusal,
  linkMaxIds,
  linkTelegramIds,
  MessageLinkStore,
  renderPollAsText,
  sendAttachments,
  sendTextPieces,
} from '../src/bridge/sync.js';
import { TransientDownloadError } from '../src/bridge/transient.js';
import type { ChatMapStore } from '../src/store/chatMapStore.js';

const EMOJI = '😀'; // one code point, two UTF-16 units
const hasLoneSurrogate = (s: string): boolean => /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/.test(s);

describe('truncateUtf16', () => {
  it('leaves a short string alone', () => {
    expect(truncateUtf16('abc', 5)).toBe('abc');
  });

  it('never ends on half of a surrogate pair', () => {
    const s = 'a'.repeat(127) + EMOJI; // the emoji sits on units 127-128
    const cut = truncateUtf16(s, 128);
    expect(cut).toBe('a'.repeat(127));
    expect(hasLoneSurrogate(cut)).toBe(false);
  });

  it('keeps a pair that fits whole', () => {
    expect(truncateUtf16('a' + EMOJI + 'b', 3)).toBe('a' + EMOJI);
  });
});

describe('truncateCodePoints', () => {
  it('counts an emoji as one and adds the ellipsis only when cutting', () => {
    const quote = 'x'.repeat(79) + EMOJI + 'tail';
    expect(truncateCodePoints(quote, 80, '…')).toBe('x'.repeat(79) + EMOJI + '…');
    expect(truncateCodePoints('short', 80, '…')).toBe('short');
    expect(hasLoneSurrogate(truncateCodePoints(EMOJI.repeat(100), 80, '…'))).toBe(false);
  });
});

describe('splitTelegramText', () => {
  it('returns a fitting text as one piece and a blank one as none', () => {
    expect(splitTelegramText('hello')).toEqual(['hello']);
    expect(splitTelegramText('')).toEqual([]);
    expect(splitTelegramText('   ')).toEqual([]);
  });

  it('keeps every piece within the limit and loses nothing but the cut separators', () => {
    const lines = Array.from({ length: 300 }, (_, i) => `line ${i} ${'z'.repeat(20)}`);
    const text = lines.join('\n');
    expect(text.length).toBeGreaterThan(TELEGRAM_TEXT_LIMIT);
    const pieces = splitTelegramText(text);
    expect(pieces.length).toBeGreaterThan(1);
    for (const p of pieces) expect(p.length).toBeLessThanOrEqual(TELEGRAM_TEXT_LIMIT);
    expect(pieces.join('\n')).toBe(text); // cut on newlines only
  });

  it('prefers a space when there is no newline', () => {
    const words = Array.from({ length: 2000 }, (_, i) => `w${i}`).join(' ');
    const pieces = splitTelegramText(words, 100);
    for (const p of pieces) {
      expect(p.length).toBeLessThanOrEqual(100);
      expect(p.startsWith(' ')).toBe(false);
      expect(p.endsWith(' ')).toBe(false);
    }
    expect(pieces.join(' ')).toBe(words);
  });

  it('hard-cuts a run with no separator without splitting an emoji', () => {
    const text = EMOJI.repeat(3000); // 6000 units, no spaces
    const pieces = splitTelegramText(text);
    expect(pieces.length).toBe(2);
    for (const p of pieces) {
      expect(p.length).toBeLessThanOrEqual(TELEGRAM_TEXT_LIMIT);
      expect(hasLoneSurrogate(p)).toBe(false);
    }
    expect(pieces.join('')).toBe(text);
  });

  it('can cut exactly at the limit when the separator sits right after it', () => {
    const text = 'a'.repeat(10) + '\n' + 'b'.repeat(5);
    expect(splitTelegramText(text, 10)).toEqual(['a'.repeat(10), 'b'.repeat(5)]);
  });

  it('cuts a long Telegram text into pieces MAX accepts, on line boundaries', () => {
    const lines = Array.from({ length: 85 }, (_, i) => `Строка ${String(i + 1).padStart(3, '0')} 🚀 проверка нарезки длинных сообщений моста`);
    const text = lines.join('\n');
    expect(text.length).toBeGreaterThan(MAX_TEXT_LIMIT);
    const pieces = splitTelegramText(text, MAX_TEXT_LIMIT);
    expect(pieces.length).toBe(2);
    for (const p of pieces) {
      expect(p.length).toBeLessThanOrEqual(MAX_TEXT_LIMIT);
      expect(hasLoneSurrogate(p)).toBe(false);
      expect(p.startsWith('Строка ')).toBe(true);
      expect(p.endsWith(' моста')).toBe(true);
    }
    expect(pieces.join('\n').split('\n')).toEqual(lines);
  });

  it('falls back to a word boundary for one long line at the MAX limit', () => {
    const text = Array.from({ length: 700 }, (_, i) => `слово${i}`).join(' ');
    expect(text.length).toBeGreaterThan(MAX_TEXT_LIMIT);
    const pieces = splitTelegramText(text, MAX_TEXT_LIMIT);
    for (const p of pieces) {
      expect(p.length).toBeLessThanOrEqual(MAX_TEXT_LIMIT);
      expect(p).toMatch(/^слово\d+ .* слово\d+$/);
    }
    expect(pieces.join(' ')).toBe(text);
  });
});

describe('linkMaxIds', () => {
  it('lists the anchor first, then every further piece', () => {
    expect(linkMaxIds({ maxMessageId: 100n })).toEqual([100n]);
    expect(linkMaxIds({ maxMessageId: 100n, extraMaxMessageIds: [101n, 102n] })).toEqual([100n, 101n, 102n]);
  });

  it('keeps the further pieces out of the by-MAX index', () => {
    const store = new MessageLinkStore();
    store.add({ maxChatId: 1, maxMessageId: 100n, extraMaxMessageIds: [101n], telegramMessageId: 7, outgoing: true });
    expect(linkMaxIds(store.getByTelegram(7) as { maxMessageId: unknown })).toEqual([100n, 101n]);
    expect(store.getByMax(1, 101n)).toBeUndefined();
  });

  it('covers() knows every piece, so a catch-up does not post a later piece again', () => {
    const store = new MessageLinkStore();
    store.add({ maxChatId: 1, maxMessageId: 100n, extraMaxMessageIds: [101n], telegramMessageId: 7, outgoing: true });
    expect(store.covers(1, 100n)).toBe(true);
    expect(store.covers('1', 101n)).toBe(true);
    expect(store.covers(1, 102n)).toBe(false);
    expect(store.covers(2, 101n)).toBe(false); // another chat's id
  });
});

describe('isChatClosedNotice', () => {
  it('matches the exact phrase, whatever the case, spaces around and a trailing period', () => {
    for (const t of ['Чат закрыт', ' чат закрыт. ', 'ЧАТ ЗАКРЫТ']) expect(isChatClosedNotice(t)).toBe(true);
  });

  it('is false for any other notice with the word in it — the answer deletes a topic', () => {
    for (const t of ['Доступ к чату закрыт администратором', 'Опрос закрыт', 'Чат закрыт администратором', '', undefined, null, 42]) {
      expect(isChatClosedNotice(t)).toBe(false);
    }
  });
});

describe('isFallbackTitle', () => {
  it('recognizes every generic stand-in title', () => {
    for (const t of ['CHAT 123', 'CHAT -70000000001', 'DIALOG 5', 'CHANNEL -100', 'GROUP 7', 'Chat 9', 'MAX ID 42', 'MAX chat 484245649']) {
      expect(isFallbackTitle(t)).toBe(true);
    }
  });

  it('matches what names.ts actually produces', () => {
    expect(isFallbackTitle(resolveContactDisplayName(42, undefined))).toBe(true);
    expect(isFallbackTitle(resolveChatName({ id: 77, type: 'CHANNEL' }, null, new Map()))).toBe(true);
    expect(isFallbackTitle(resolveChatName({ id: 77 }, null, new Map()))).toBe(true);
  });

  it('does not mistake a real title for a fallback', () => {
    for (const t of ['Chat друзей', 'Dialog club', 'MAX ID fans', 'Chat 9 friends', 'chat 12', 'Иван Петров', '', undefined]) {
      expect(isFallbackTitle(t)).toBe(false);
    }
  });
});

describe('clampTopicTitle', () => {
  it('trims, clamps to 128 units without splitting an emoji, and drops a blank title', () => {
    expect(clampTopicTitle('  Name  ')).toBe('Name');
    const long = 'a'.repeat(127) + EMOJI + 'rest';
    const clamped = clampTopicTitle(long) as string;
    expect(clamped.length).toBeLessThanOrEqual(128);
    expect(hasLoneSurrogate(clamped)).toBe(false);
    expect(clampTopicTitle('   ')).toBeUndefined();
    expect(clampTopicTitle(undefined)).toBeUndefined();
  });
});

function fakeTopicWorld() {
  const mappings = new Map<string, { maxChatId: string; telegramTopicId: number; title?: string }>();
  const tick = () => new Promise((r) => setTimeout(r, 5));
  const store = {
    async getByMaxChatId(id: unknown) {
      await tick();
      return mappings.get(String(id));
    },
    async upsert(m: { maxChatId: unknown; telegramTopicId: number; title?: string }) {
      await tick();
      mappings.set(String(m.maxChatId), { ...m, maxChatId: String(m.maxChatId) });
    },
    async setTitle(id: unknown, topicId: number, title: string) {
      await tick();
      const m = mappings.get(String(id));
      if (m && m.telegramTopicId === topicId) m.title = title;
    },
  } as unknown as ChatMapStore;
  let nextTopic = 100;
  const createForumTopic = vi.fn(async (_g: string, name: string) => {
    await tick();
    return { message_thread_id: nextTopic++, name };
  });
  const editForumTopic = vi.fn(async () => true);
  const bot = { telegram: { createForumTopic, editForumTopic, sendMessage: vi.fn() } } as unknown as Telegraf;
  return { mappings, store, bot, createForumTopic, editForumTopic };
}

describe('ensureTopicForMaxChat', () => {
  it('opens ONE topic for concurrent pushes of a new chat', async () => {
    const w = fakeTopicWorld();
    const results = await Promise.all([
      ensureTopicForMaxChat(w.bot, 'g', 555, w.store, 'Анна'),
      ensureTopicForMaxChat(w.bot, 'g', 555, w.store, 'Анна'),
      ensureTopicForMaxChat(w.bot, 'g', '555', w.store),
    ]);
    expect(w.createForumTopic).toHaveBeenCalledTimes(1);
    expect(new Set(results.map((r) => r.topicId)).size).toBe(1);
    expect(results.filter((r) => r.created)).toHaveLength(1);
  });

  it('never renames an existing topic to a fallback title', async () => {
    const w = fakeTopicWorld();
    w.mappings.set('9', { maxChatId: '9', telegramTopicId: 1, title: 'Анна' });
    await ensureTopicForMaxChat(w.bot, 'g', 9, w.store, 'MAX ID 9');
    await ensureTopicForMaxChat(w.bot, 'g', 9, w.store, 'CHAT 9');
    expect(w.editForumTopic).not.toHaveBeenCalled();
    expect(w.mappings.get('9')?.title).toBe('Анна');
  });

  it('clamps a long title for both rename and create', async () => {
    const w = fakeTopicWorld();
    w.mappings.set('9', { maxChatId: '9', telegramTopicId: 1, title: 'old' });
    const long = 'Я'.repeat(200);
    await ensureTopicForMaxChat(w.bot, 'g', 9, w.store, long);
    expect((w.editForumTopic.mock.calls[0] as unknown[])[2]).toEqual({ name: 'Я'.repeat(128) });
    expect(w.mappings.get('9')?.title).toBe('Я'.repeat(128));
    await ensureTopicForMaxChat(w.bot, 'g', 10, w.store, long);
    expect((w.createForumTopic.mock.calls[0] as unknown[])[1]).toBe('Я'.repeat(128));
  });

  it('waits out a flood-control 429 and creates the topic on the retry', async () => {
    vi.useFakeTimers();
    try {
      const w = fakeTopicWorld();
      w.createForumTopic.mockRejectedValueOnce(Object.assign(new Error('429: Too Many Requests: retry after 3'), { response: { error_code: 429, parameters: { retry_after: 3 } } }));
      const run = ensureTopicForMaxChat(w.bot, 'g', 77, w.store, 'Анна');
      await vi.advanceTimersByTimeAsync(5000);
      await expect(run).resolves.toMatchObject({ created: true });
      expect(w.createForumTopic).toHaveBeenCalledTimes(2);
    } finally {
      vi.useRealTimers();
    }
  });

  it('keeps going after a failed run holding the lock', async () => {
    const order: string[] = [];
    const failing = withTopicLock('k', async () => {
      order.push('a');
      throw new Error('boom');
    });
    const next = withTopicLock('k', async () => {
      order.push('b');
      return 1;
    });
    await expect(failing).rejects.toThrow('boom');
    await expect(next).resolves.toBe(1);
    expect(order).toEqual(['a', 'b']);
  });
});

describe('telegramSendKind (Bot API upload limits)', () => {
  it('passes what fits, turns a big photo into a document, refuses over 50 MB', () => {
    expect(telegramSendKind('video', 1000)).toBe('video');
    expect(telegramSendKind('photo', TELEGRAM_PHOTO_LIMIT_BYTES)).toBe('photo');
    expect(telegramSendKind('photo', TELEGRAM_PHOTO_LIMIT_BYTES + 1)).toBe('document');
    expect(telegramSendKind('document', TELEGRAM_UPLOAD_LIMIT_BYTES)).toBe('document');
    expect(telegramSendKind('video', TELEGRAM_UPLOAD_LIMIT_BYTES + 1)).toBeNull();
    expect(telegramSendKind('photo', TELEGRAM_UPLOAD_LIMIT_BYTES + 1)).toBeNull();
  });
});

describe('buildLinkIds', () => {
  it('anchors on the first text piece and keeps every other id as extra', () => {
    expect(buildLinkIds([10, 11], [12, 13, 14])).toEqual({ telegramMessageId: 10, extraTelegramMessageIds: [11, 12, 13, 14] });
  });

  it('anchors an attachment-only album on its first item', () => {
    expect(buildLinkIds([], [5, 6, 7])).toEqual({ telegramMessageId: 5, extraTelegramMessageIds: [6, 7] });
  });

  it('has no extras for a single message and nothing for none', () => {
    expect(buildLinkIds([3], [])).toEqual({ telegramMessageId: 3 });
    expect(buildLinkIds([], [])).toBeUndefined();
  });

  it('lets a deletion find every photo of an album', () => {
    const store = new MessageLinkStore();
    store.add({ maxChatId: 1, maxMessageId: 99n, ...(buildLinkIds([], [5, 6, 7]) as { telegramMessageId: number }) });
    for (const id of [5, 6, 7]) expect(store.getByTelegram(id)?.maxMessageId).toBe(99n);
    const link = store.getByMax(1, 99n);
    expect([link?.telegramMessageId, ...(link?.extraTelegramMessageIds ?? [])]).toEqual([5, 6, 7]);
  });
});

describe('isPermanentTelegramRefusal', () => {
  const answered = (code: number, description = 'Bad Request') => Object.assign(new Error(description), { response: { error_code: code, description } });

  it('is true for an answered 4xx refusal', () => {
    expect(isPermanentTelegramRefusal(answered(413, 'Request Entity Too Large'))).toBe(true);
    expect(isPermanentTelegramRefusal(answered(400, 'Bad Request: poll question length must not exceed 300'))).toBe(true);
  });

  it('is false for a deleted topic, flood control, 5xx, network and a transient download', () => {
    expect(isPermanentTelegramRefusal(answered(400, 'Bad Request: message thread not found'))).toBe(false);
    expect(isPermanentTelegramRefusal(answered(429, 'Too Many Requests'))).toBe(false);
    expect(isPermanentTelegramRefusal(answered(502))).toBe(false);
    expect(isPermanentTelegramRefusal(Object.assign(new Error('socket hang up'), { code: 'ECONNRESET' }))).toBe(false);
    expect(isPermanentTelegramRefusal(new TransientDownloadError('MAX CDN answered 503'))).toBe(false);
  });
});

describe('renderPollAsText', () => {
  it('lists the question, flags and every option', () => {
    const text = renderPollAsText('Куда едем?', ['Море', 'Горы'], 3);
    expect(text).toContain('📊 Опрос: Куда едем? (анонимный, несколько ответов)');
    expect(text).toContain('• Море\n• Горы');
    expect(text).toContain('/poll');
  });

  it('copes with a missing title and plain settings', () => {
    expect(renderPollAsText(undefined, ['x'])).toMatch(/^📊 Опрос: без названия\n• x/);
  });
});

describe('describeUnrelayableTelegramMessage', () => {
  it('labels content types MAX has no equivalent for', () => {
    expect(describeUnrelayableTelegramMessage({ dice: { emoji: '🎲', value: 4 } })).toBe('кубик 🎲');
    expect(describeUnrelayableTelegramMessage({ story: { id: 1 } })).toBe('история');
    expect(describeUnrelayableTelegramMessage({ game: { title: 'x' } })).toBe('игра');
    expect(describeUnrelayableTelegramMessage({ paid_media: {} })).toBe('платное медиа');
  });

  it('stays silent for service updates and unknown shapes', () => {
    expect(describeUnrelayableTelegramMessage({ pinned_message: {} })).toBeNull();
    expect(describeUnrelayableTelegramMessage({ new_chat_members: [] })).toBeNull();
    expect(describeUnrelayableTelegramMessage({})).toBeNull();
  });
});

describe('partial delivery', () => {
  const answered = (code: number, description = 'Bad Gateway') => Object.assign(new Error(description), { response: { error_code: code, description } });
  const location = { _type: 'LOCATION', latitude: 55.75, longitude: 37.62 };

  it('sendAttachments reports every id already sent when a later send fails transiently', async () => {
    let next = 100;
    const sendLocation = vi.fn(async () => {
      if (next === 102) throw answered(502);
      return { message_id: next++ };
    });
    const bot = { telegram: { sendLocation } } as unknown as Telegraf;
    const sent: number[] = [];
    await expect(sendAttachments(bot, 'g', 7, [location, location, location] as never, { max: {} } as never, undefined, undefined, sent)).rejects.toThrow('Bad Gateway');
    expect(sent).toEqual([100, 101]);
  });

  it('on the last try a transient failure degrades to a placeholder and the rest still go out', async () => {
    let next = 100;
    const sendLocation = vi.fn(async () => {
      if (next === 101) {
        next++;
        throw answered(502);
      }
      return { message_id: next++ };
    });
    const sendMessage = vi.fn(async () => ({ message_id: 900 }));
    const bot = { telegram: { sendLocation, sendMessage } } as unknown as Telegraf;
    const sent: number[] = [];
    const ids = await sendAttachments(bot, 'g', 7, [location, location, location] as never, { max: {} } as never, undefined, undefined, sent, true);
    expect(ids).toEqual([100, 900, 102]);
    expect(sent).toEqual([100, 900, 102]);
    expect(sendMessage).toHaveBeenCalledTimes(1); // the placeholder of the one that failed
    // A deleted topic still propagates: the caller recreates it.
    const gone = { telegram: { sendLocation: vi.fn(async () => { throw new Error('400: Bad Request: message thread not found'); }), sendMessage } } as unknown as Telegraf;
    await expect(sendAttachments(gone, 'g', 7, [location] as never, { max: {} } as never, undefined, undefined, undefined, true)).rejects.toThrow('thread not found');
  });

  it('sendTextPieces reports each piece as it goes out', async () => {
    let next = 1;
    const sendMessage = vi.fn(async () => {
      if (next === 3) throw answered(500, 'Internal Server Error');
      return { message_id: next++ };
    });
    const bot = { telegram: { sendMessage } } as unknown as Telegraf;
    const sent: number[] = [];
    const long = 'a'.repeat(TELEGRAM_TEXT_LIMIT * 2 + 10); // three pieces
    await expect(sendTextPieces(bot, 'g', 7, long, { sent })).rejects.toThrow('Internal Server Error');
    expect(sent).toEqual([1, 2]);
  });

  it('discardPartialDelivery deletes what went out and moves past an id it cannot delete', async () => {
    const deleted: number[] = [];
    const deleteMessage = vi.fn(async (_chat: string, id: number) => {
      if (id === 11) throw answered(502);
      deleted.push(id);
      return true;
    });
    const bot = { telegram: { deleteMessage } } as unknown as Telegraf;
    await expect(discardPartialDelivery(bot, 'g', [10, 11, 12])).resolves.toBeUndefined();
    expect(deleted).toEqual([10, 12]);
    expect(deleteMessage).toHaveBeenCalledTimes(3);
  });
});

describe('MessageLinkStore.addNotice (poll tally)', () => {
  it('adds a later notice to an existing link so a deletion finds it, apart from the content ids', () => {
    const store = new MessageLinkStore();
    store.add({ maxChatId: 1, maxMessageId: 5n, telegramMessageId: 50, extraTelegramMessageIds: [51] });
    store.addNotice(1, 5n, 60);
    store.addNotice(1, 5n, 60); // idempotent
    store.addNotice(1, 5n, 50); // the anchor itself is no notice
    store.addNotice(1, 5n, 51); // nor is a content extra
    const link = store.getByMax(1, 5n);
    expect(link?.extraTelegramMessageIds).toEqual([51]);
    expect(link?.noticeTelegramMessageIds).toEqual([60]);
    expect(link && linkTelegramIds(link)).toEqual([50, 51, 60]);
    // Resolvable (/poll, a native reply) but marked as a notice (no 👎 delete, /delete, reaction relay).
    expect(store.getByTelegram(60)?.maxMessageId).toBe(5n);
    expect(link && isNoticeOf(link, 60)).toBe(true);
    expect(link && isNoticeOf(link, 50)).toBe(false);
    expect(link && isNoticeOf(link, 51)).toBe(false);
    store.remove(1, 5n);
    expect(store.getByTelegram(60)).toBeUndefined();
  });

  it('indexes notices passed to add() and evicts them with the link', () => {
    const store = new MessageLinkStore(1);
    store.add({ maxChatId: 1, maxMessageId: 5n, telegramMessageId: 50, noticeTelegramMessageIds: [52], outgoing: true });
    expect(store.getByTelegram(52)?.maxMessageId).toBe(5n);
    store.add({ maxChatId: 1, maxMessageId: 6n, telegramMessageId: 70 });
    expect(store.getByTelegram(52)).toBeUndefined();
  });

  it('is a no-op without a link', () => {
    const store = new MessageLinkStore();
    store.addNotice(1, 5n, 60);
    expect(store.getByTelegram(60)).toBeUndefined();
  });
});

describe('MessageLinkStore — replacing a link', () => {
  it('replaces an existing link for the same message cleanly', () => {
    const store = new MessageLinkStore(2);
    // A partial delivery linked first, then the whole message linked over it.
    store.add({ maxChatId: 1, maxMessageId: 5n, telegramMessageId: 90 });
    store.add({ maxChatId: 1, maxMessageId: 5n, telegramMessageId: 50, extraTelegramMessageIds: [51] });
    expect(store.getByTelegram(90)).toBeUndefined(); // no stale id left pointing at the dead link
    expect(store.getByTelegram(51)?.telegramMessageId).toBe(50);
    // The key is in the eviction order once: one more link does not evict the current one early.
    store.add({ maxChatId: 1, maxMessageId: 6n, telegramMessageId: 60 });
    expect(store.getByMax(1, 5n)?.telegramMessageId).toBe(50);
    expect(store.getByMax(1, 6n)?.telegramMessageId).toBe(60);
  });
});

describe('historyStartTime (slow host clock)', () => {
  it('starts paging ahead of the local clock', () => {
    expect(historyStartTime(1_000_000)).toBe(1_000_000 + HISTORY_FROM_AHEAD_MS);
    expect(HISTORY_FROM_AHEAD_MS).toBeGreaterThan(0);
  });
});

describe('dialogParticipantIds', () => {
  it('collects the other side of 1:1 dialogs only, deduplicated', () => {
    const me = 1;
    const chats = [
      { id: 10, type: 'DIALOG', participants: { 1: 0, 2: 0 } },
      { id: 11, type: 'CHAT', title: '', participants: { 1: 0, 3: 0 } }, // createDialog-style 1:1
      { id: 12, type: 'CHAT', title: 'Большая группа', participants: { 1: 0, 4: 0, 5: 0, 6: 0 } },
      { id: 13, type: 'DIALOG', participants: { 1: 0, 2: 0 } },
      { id: 14, type: 'DIALOG' },
      null,
    ];
    expect(dialogParticipantIds(chats, me).sort()).toEqual([2, 3]);
  });
});
