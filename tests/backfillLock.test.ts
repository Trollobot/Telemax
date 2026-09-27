import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Telegraf } from 'telegraf';
import type { MaxClient, MaxHistoryMessage } from '../src/max/client.js';
import { ChatMapStore } from '../src/store/chatMapStore.js';
import { CatchUpTracker, ChatBannedError } from '../src/bridge/catchUp.js';
import { MessageLinkStore, syncAllChatsToTelegram, withChatBackfillLock } from '../src/bridge/sync.js';

// One history refill per chat at a time, and a /ban mid-refill is never undone (review 2026-09-26, cross).

let dir: string;
let store: ChatMapStore;

beforeEach(async () => {
  dir = await mkdtemp(path.join(tmpdir(), 'telemax-backfill-'));
  store = new ChatMapStore(path.join(dir, 'chat-map.json'));
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

function fakeBot(onSend?: (text: string, topicId: number) => Promise<void> | void) {
  const sends: Array<{ text: string; topicId: number }> = [];
  let nextId = 1000;
  const telegram = {
    sendMessage: vi.fn(async (_group: string, text: string, extra: { message_thread_id: number }) => {
      await onSend?.(text, extra.message_thread_id);
      sends.push({ text, topicId: extra.message_thread_id });
      return { message_id: nextId++ };
    }),
    createForumTopic: vi.fn(async () => ({ message_thread_id: 999, name: 'new' })),
    editForumTopic: vi.fn(async () => true),
    deleteForumTopic: vi.fn(async () => true),
    deleteMessage: vi.fn(async (_group: string, _id: number) => true),
  };
  return { bot: { telegram } as unknown as Telegraf, telegram, sends };
}

function fakeMax(history: MaxHistoryMessage[], onFetch?: () => void) {
  const getChatHistory = vi.fn(async () => {
    onFetch?.();
    // One page: fetchFullHistory filters by its cursor and stops on a batch that does not move back.
    return history;
  });
  return { max: { getChatHistory } as unknown as MaxClient, getChatHistory };
}

const msg = (id: number, time: number, text: string): MaxHistoryMessage => ({ id, time, text }) as unknown as MaxHistoryMessage;

describe('syncAllChatsToTelegram under the chat backfill lock', () => {
  it('waits for a topic restore holding the lock, then uses the topic and cursor it left', async () => {
    await store.upsert({ maxChatId: '42', telegramTopicId: 100, title: 'Анна', createdAt: 'x' });
    const { bot, sends } = fakeBot();
    let lockReleased = false;
    let fetchedBeforeRelease = false;
    const { max } = fakeMax([msg(1, 900, 'old'), msg(2, 1100, 'new')], () => {
      if (!lockReleased) fetchedBeforeRelease = true;
    });
    let release!: () => void;
    const held = withChatBackfillLock('42', async () => {
      // The restore: recreated the topic (100 -> 200) and replayed history up to time 1000.
      await new Promise<void>((resolve) => {
        release = resolve;
      });
      await store.upsert({ maxChatId: '42', telegramTopicId: 200, title: 'Анна', createdAt: 'x', historyBackfillCursor: '1000' });
      lockReleased = true;
    });
    const catchUp = new CatchUpTracker();
    const run = syncAllChatsToTelegram(bot, store, 'g', [{ id: 42, status: 'ACTIVE' }], () => 'Анна', max, new MessageLinkStore(), null, new Map(), catchUp);
    await new Promise((r) => setTimeout(r, 20));
    expect(sends).toHaveLength(0); // still waiting for the lock
    release();
    await held;
    await run;
    expect(fetchedBeforeRelease).toBe(false);
    expect(sends).toEqual([{ text: 'new', topicId: 200 }]);
    expect(catchUp.isCaughtUp('42')).toBe(true);
  });

  it('a /ban landing mid-backfill stops the chat instead of recreating its topic', async () => {
    await store.upsert({ maxChatId: '7', telegramTopicId: 100, title: 'Группа', createdAt: 'x' });
    const { bot, telegram, sends } = fakeBot(async (text) => {
      // The first message goes out, then the owner bans the chat (setBanned + topic deleted).
      if (text === 'second') throw new Error('400: Bad Request: message thread not found');
    });
    const afterFirst = telegram.sendMessage.getMockImplementation()!;
    telegram.sendMessage.mockImplementation(async (group: string, text: string, extra: { message_thread_id: number }) => {
      const res = await afterFirst(group, text, extra);
      if (text === 'first') await store.setBanned('7', true);
      return res;
    });
    const { max } = fakeMax([msg(1, 100, 'first'), msg(2, 200, 'second')]);
    const catchUp = new CatchUpTracker();
    const retry = vi.fn();
    catchUp.setRetryHandler(retry);
    await syncAllChatsToTelegram(bot, store, 'g', [{ id: 7, status: 'ACTIVE' }], () => 'Группа', max, new MessageLinkStore(), null, new Map(), catchUp);
    expect(sends.map((s) => s.text)).toEqual(['first']);
    expect(telegram.createForumTopic).not.toHaveBeenCalled();
    const mapping = await store.getByMaxChatId('7');
    expect(mapping?.banned).toBe(true);
    expect(mapping?.telegramTopicId).toBe(100);
    expect(catchUp.isCaughtUp('7')).toBe(false);
    expect(retry).not.toHaveBeenCalled(); // a ban is not a transient failure
  });
});

describe('ChatBannedError', () => {
  it('names the chat', () => {
    const err = new ChatBannedError('7');
    expect(err.chatId).toBe('7');
    expect(err.name).toBe('ChatBannedError');
  });
});

describe('syncAllChatsToTelegram — catch-up bookkeeping (review 2026-09-26)', () => {
  const badGateway = () => Object.assign(new Error('502: Bad Gateway'), { response: { error_code: 502, description: 'Bad Gateway' } });

  it('a chat whose topic creation failed in the pass is not treated as born live later (catchup-r1#0)', async () => {
    const { bot, telegram } = fakeBot();
    telegram.createForumTopic.mockRejectedValueOnce(badGateway());
    const { max } = fakeMax([msg(1, 100, 'offline 1'), msg(2, 200, 'offline 2')]);
    const catchUp = new CatchUpTracker();
    const retry = vi.fn();
    catchUp.setRetryHandler(retry);
    await syncAllChatsToTelegram(bot, store, 'g', [{ id: 9, status: 'ACTIVE' }], () => 'Новый', max, new MessageLinkStore(), null, new Map(), catchUp);
    expect(retry).toHaveBeenCalled();
    // The next live message opens the topic: it must not count as caught up (its cursor would jump
    // past the two messages that arrived while the bridge was offline).
    expect(catchUp.markBornLive(9)).toBe(false);
    expect(catchUp.isCaughtUp(9)).toBe(false);
  });

  it('moves the cursor up to live messages delivered while the chat was being caught up (catchup-r1#1)', async () => {
    await store.upsert({ maxChatId: '42', telegramTopicId: 100, title: 'Анна', createdAt: 'x', historyBackfillCursor: '50' });
    const catchUp = new CatchUpTracker();
    // While the gap message goes out, a newer message arrives live: relayed and linked, but the
    // chat is not caught up yet, so the live path only notes its time (advanceLiveCursor).
    const { bot } = fakeBot((text) => {
      if (text === 'gap') catchUp.noteLiveDelivered('42', 900);
    });
    const { max } = fakeMax([msg(1, 100, 'gap')]);
    await syncAllChatsToTelegram(bot, store, 'g', [{ id: 42, status: 'ACTIVE' }], () => 'Анна', max, new MessageLinkStore(), null, new Map(), catchUp);
    expect(catchUp.isCaughtUp('42')).toBe(true);
    expect((await store.getByMaxChatId('42'))?.historyBackfillCursor).toBe('900');
  });

  it('waits for a live delivery of the same message instead of sending it twice (delivery-r1#6)', async () => {
    await store.upsert({ maxChatId: '42', telegramTopicId: 100, title: 'Анна', createdAt: 'x', historyBackfillCursor: '50' });
    const { bot, sends } = fakeBot();
    const { max } = fakeMax([msg(1, 100, 'photo')]);
    const links = new MessageLinkStore();
    // The live push of message 1 is still downloading/uploading when the catch-up reaches it.
    let finishLive!: () => void;
    const live = new Promise<void>((resolve) => {
      finishLive = () => {
        links.add({ maxChatId: '42', maxMessageId: 1, telegramMessageId: 77 });
        resolve();
      };
    });
    links.trackDelivery('42', 1, live);
    const run = syncAllChatsToTelegram(bot, store, 'g', [{ id: 42, status: 'ACTIVE' }], () => 'Анна', max, links, null, new Map(), new CatchUpTracker());
    await new Promise((r) => setTimeout(r, 20));
    finishLive();
    await run;
    expect(sends).toHaveLength(0);
    expect((await store.getByMaxChatId('42'))?.historyBackfillCursor).toBe('100');
    expect(links.pendingDelivery('42', 1)).toBeUndefined();
  });

  it('a message given up on keeps what went out linked together with its orphan-edit stub (delivery-r1#7)', async () => {
    await store.upsert({ maxChatId: '42', telegramTopicId: 100, title: 'Анна', createdAt: 'x', historyBackfillCursor: '50' });
    const { bot } = fakeBot((text) => {
      if (text.startsWith('B')) throw Object.assign(new Error('400: Bad Request: nope'), { response: { error_code: 400, description: 'Bad Request: nope' } });
    });
    const { max } = fakeMax([msg(1, 100, `${'A'.repeat(4000)}\n${'B'.repeat(200)}`)]);
    const links = new MessageLinkStore();
    links.add({ maxChatId: '42', maxMessageId: 1, telegramMessageId: 50, orphanEdit: true });
    await syncAllChatsToTelegram(bot, store, 'g', [{ id: 42, status: 'ACTIVE' }], () => 'Анна', max, links, null, new Map(), new CatchUpTracker());
    const link = links.getByMax('42', 1);
    expect(link?.orphanEdit).toBeUndefined();
    expect(link?.telegramMessageId).toBe(1000); // the first text piece
    expect(link?.extraTelegramMessageIds).toEqual([50]);
    expect((await store.getByMaxChatId('42'))?.historyBackfillCursor).toBe('100');
  });

  it('a message delivered whole replaces its orphan-edit stub, deleting it (delivery-r2#2)', async () => {
    await store.upsert({ maxChatId: '42', telegramTopicId: 100, title: 'Анна', createdAt: 'x', historyBackfillCursor: '50' });
    const { bot, telegram, sends } = fakeBot();
    const { max } = fakeMax([msg(1, 100, 'fixed typo')]);
    const links = new MessageLinkStore();
    links.add({ maxChatId: '42', maxMessageId: 1, telegramMessageId: 50, noticeTelegramMessageIds: [51], orphanEdit: true, createdAt: Date.now() - 1000 });
    await syncAllChatsToTelegram(bot, store, 'g', [{ id: 42, status: 'ACTIVE' }], () => 'Анна', max, links, null, new Map(), new CatchUpTracker());
    expect(sends.map((s) => s.text)).toEqual(['fixed typo']);
    expect(telegram.deleteMessage.mock.calls.map((c) => c[1])).toEqual([50, 51]);
    const link = links.getByMax('42', 1);
    expect(link?.telegramMessageId).toBe(1000);
    expect(link?.extraTelegramMessageIds).toBeUndefined();
    expect(links.getByTelegram(50)).toBeUndefined();
  });

  it('a stub posted by a live edit while the message went out is kept, folded into its link (delivery-r2#4, delivery-r3.1#0)', async () => {
    await store.upsert({ maxChatId: '42', telegramTopicId: 100, title: 'Анна', createdAt: 'x', historyBackfillCursor: '50' });
    const links = new MessageLinkStore();
    const { bot, telegram } = fakeBot((text) => {
      // Edited after the snapshot was read: the stub may hold the only copy of the new text.
      if (text === 'album') links.add({ maxChatId: '42', maxMessageId: 1, telegramMessageId: 60, orphanEdit: true, createdAt: Date.now() + 1000 });
    });
    const { max } = fakeMax([msg(1, 100, 'album')]);
    await syncAllChatsToTelegram(bot, store, 'g', [{ id: 42, status: 'ACTIVE' }], () => 'Анна', max, links, null, new Map(), new CatchUpTracker());
    expect(telegram.deleteMessage).not.toHaveBeenCalled();
    const link = links.getByMax('42', 1);
    expect(link?.telegramMessageId).toBe(1000);
    expect(link?.extraTelegramMessageIds).toEqual([60]);
    expect(link?.orphanEdit).toBeUndefined();
  });

  it('skips a message MAX deleted after the snapshot, and takes back one deleted while it went out (delivery-r2#1)', async () => {
    await store.upsert({ maxChatId: '42', telegramTopicId: 100, title: 'Анна', createdAt: 'x', historyBackfillCursor: '50' });
    const links = new MessageLinkStore();
    links.noteRemoved('42', 1); // REMOVED push before the backfill reached it
    const { bot, telegram, sends } = fakeBot((text) => {
      if (text === 'two') links.noteRemoved('42', 2); // REMOVED push while it was being sent
    });
    const { max } = fakeMax([msg(1, 100, 'one'), msg(2, 200, 'two'), msg(3, 300, 'three')]);
    await syncAllChatsToTelegram(bot, store, 'g', [{ id: 42, status: 'ACTIVE' }], () => 'Анна', max, links, null, new Map(), new CatchUpTracker());
    expect(sends.map((s) => s.text)).toEqual(['two', 'three']);
    expect(telegram.deleteMessage.mock.calls.map((c) => c[1])).toEqual([1000]);
    expect(links.getByMax('42', 2)).toBeUndefined();
    expect(links.getByMax('42', 3)?.telegramMessageId).toBe(1001);
    expect((await store.getByMaxChatId('42'))?.historyBackfillCursor).toBe('300');
  });

  it('backfills a poll as its text rendering, options included (delivery-r2#3)', async () => {
    await store.upsert({ maxChatId: '42', telegramTopicId: 100, title: 'Анна', createdAt: 'x', historyBackfillCursor: '50' });
    const { bot, sends } = fakeBot();
    const poll = {
      id: 1,
      time: 100,
      attaches: [{ _type: 'POLL', title: 'Куда едем?', answers: [{ text: 'Море', answerId: 1 }, { text: 'Горы', answerId: 2 }], settings: 0 }],
    } as unknown as MaxHistoryMessage;
    const { max } = fakeMax([poll]);
    const links = new MessageLinkStore();
    await syncAllChatsToTelegram(bot, store, 'g', [{ id: 42, status: 'ACTIVE' }], () => 'Анна', max, links, null, new Map(), new CatchUpTracker());
    expect(sends).toHaveLength(1);
    expect(sends[0]?.text).toContain('📊 Опрос: Куда едем?');
    expect(sends[0]?.text).toContain('• Море');
    expect(sends[0]?.text).toContain('• Горы');
    expect(links.getByTelegram(1000)?.maxMessageId).toBe(1);
  });
});
