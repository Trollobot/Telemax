import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Telegraf } from 'telegraf';
import type { MaxClient, MaxHistoryMessage } from '../src/max/client.js';
import { ChatMapStore } from '../src/store/chatMapStore.js';
import { ChatBannedError, StrikeCounter } from '../src/bridge/catchUp.js';
import { ChatCatchUp, MessageLinkStore, syncAllChatsToTelegram } from '../src/bridge/sync.js';

// One writer per chat, catch-up on first touch, and the cursor gate — see ChatCatchUp in sync.ts.

let dir: string;
let store: ChatMapStore;

beforeEach(async () => {
  dir = await mkdtemp(path.join(tmpdir(), 'telemax-catchup-'));
  store = new ChatMapStore(path.join(dir, 'chat-map.json'));
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

const badGateway = () => Object.assign(new Error('502: Bad Gateway'), { response: { error_code: 502, description: 'Bad Gateway' } });
const threadNotFound = () => Object.assign(new Error('400: Bad Request: message thread not found'), { response: { error_code: 400, description: 'Bad Request: message thread not found' } });
const msg = (id: number, time: number, text: string): MaxHistoryMessage => ({ id, time, text }) as unknown as MaxHistoryMessage;
const tick = (ms = 20) => new Promise((r) => setTimeout(r, ms));

function fakeWorld(history: MaxHistoryMessage[] = [], onSend?: (text: string, topicId: number) => Promise<void> | void, strikes?: StrikeCounter) {
  const sends: Array<{ text: string; topicId: number }> = [];
  let nextId = 1000;
  const telegram = {
    sendMessage: vi.fn(async (_group: string, text: string, extra: { message_thread_id: number }) => {
      await onSend?.(text, extra.message_thread_id);
      sends.push({ text, topicId: extra.message_thread_id });
      return { message_id: nextId++ };
    }),
    sendLocation: vi.fn(async () => ({ message_id: nextId++ })),
    createForumTopic: vi.fn(async (_group: string, name: string) => ({ message_thread_id: 999, name })),
    editForumTopic: vi.fn(async (_group: string, _topicId: number, _extra?: { name?: string }) => true),
    deleteForumTopic: vi.fn(async () => true),
    deleteMessage: vi.fn(async (_group: string, _id: number) => true),
  };
  // One page: fetchFullHistory filters by its cursor and stops on a batch that does not move back.
  const getChatHistory = vi.fn(async () => history);
  const links = new MessageLinkStore();
  const sendCard = vi.fn(async () => {});
  const forgetChatLinks = vi.fn((chatId: unknown) => {
    links.removeByChat(chatId);
  });
  let wiping = false;
  const sync = new ChatCatchUp({
    bot: { telegram } as unknown as Telegraf,
    groupId: 'g',
    max: { getChatHistory } as unknown as MaxClient,
    chatMapStore: store,
    messageLinks: links,
    getChats: () => [],
    getMyAccountId: () => null,
    getContactProfiles: () => new Map(),
    sendCard,
    forgetChatLinks,
    isWiping: () => wiping,
    ...(strikes ? { strikes } : {}),
  });
  const retry = vi.fn();
  sync.setRetryHandler(retry);
  /** What handleMaxPush does for a new message: open (catch up), skip when deferred or when the catch-up relayed it, else send and link. */
  const livePush = (chatId: unknown, m: MaxHistoryMessage) =>
    sync.runInChat(chatId, async () => {
      const opened = await sync.openTopic(chatId);
      if (!opened || opened.deferred || links.getByMax(chatId, m.id)) return;
      const sent = await telegram.sendMessage('g', m.text ?? '', { message_thread_id: opened.topicId });
      links.add({ maxChatId: chatId, maxMessageId: m.id, telegramMessageId: sent.message_id });
      await sync.advanceCursor(chatId, m.time, 'test');
    });
  return { sync, telegram, sends, links, sendCard, forgetChatLinks, retry, getChatHistory, livePush, setWiping: (v: boolean) => (wiping = v) };
}

describe('ChatCatchUp.runInChat — one writer per chat', () => {
  it('runs the jobs of one chat in order and lets different chats interleave', async () => {
    const { sync } = fakeWorld();
    const order: string[] = [];
    let release!: () => void;
    const gate = new Promise<void>((r) => {
      release = r;
    });
    const a1 = sync.runInChat(1, async () => {
      order.push('a1 start');
      await gate;
      order.push('a1 end');
    });
    const a2 = sync.runInChat('1', async () => {
      order.push('a2');
    });
    const b1 = sync.runInChat(2, async () => {
      order.push('b1');
    });
    await b1;
    await tick();
    expect(order).toEqual(['a1 start', 'b1']); // a2 waits for a1; chat 2 did not
    release();
    await Promise.all([a1, a2]);
    expect(order).toEqual(['a1 start', 'b1', 'a1 end', 'a2']);
  });

  it('keeps going after a failed job, and skips jobs while the group is being wiped', async () => {
    const w = fakeWorld();
    const ran: string[] = [];
    const failing = w.sync.runInChat(1, async () => {
      throw new Error('boom');
    });
    const next = w.sync.runInChat(1, async () => {
      ran.push('next');
    });
    await expect(failing).rejects.toThrow('boom');
    await next;
    expect(ran).toEqual(['next']);
    w.setWiping(true);
    await w.sync.runInChat(1, async () => {
      ran.push('during wipe');
    });
    await w.sync.drain();
    expect(ran).toEqual(['next']);
  });
});

describe('ChatCatchUp — catch-up on first touch', () => {
  it('a live push for a chat not caught up backfills the older messages first and is not delivered twice', async () => {
    await store.upsert({ maxChatId: '42', telegramTopicId: 100, title: 'Анна', createdAt: 'x', historyBackfillCursor: '50' });
    const live = msg(3, 300, 'live');
    const w = fakeWorld([msg(1, 100, 'older 1'), msg(2, 200, 'older 2'), live]);
    await w.livePush(42, live);
    expect(w.sends).toEqual([
      { text: 'older 1', topicId: 100 },
      { text: 'older 2', topicId: 100 },
      { text: 'live', topicId: 100 },
    ]);
    expect(w.telegram.sendMessage).toHaveBeenCalledTimes(3);
    expect(w.sync.isCaughtUp('42')).toBe(true);
    expect((await store.getByMaxChatId('42'))?.historyBackfillCursor).toBe('300');
    // The same push again (a repeat) finds its link: nothing more goes out.
    await w.livePush(42, live);
    expect(w.telegram.sendMessage).toHaveBeenCalledTimes(3);
    expect(w.getChatHistory).toHaveBeenCalledTimes(2); // one catch-up (two pages), none once caught up
    expect(w.retry).not.toHaveBeenCalled();
  });

  it('a chat born live (no mapping) gets its topic, its card and its whole history from a null cursor', async () => {
    const first = msg(2, 200, 'hello');
    const w = fakeWorld([msg(1, 100, 'earlier, while offline'), first]);
    await w.livePush(7, first);
    expect(w.telegram.createForumTopic).toHaveBeenCalledTimes(1);
    expect(w.sendCard).toHaveBeenCalledWith(7, 999, undefined);
    expect(w.sends.map((s) => s.text)).toEqual(['earlier, while offline', 'hello']);
    expect(w.sync.isCaughtUp(7)).toBe(true);
    expect((await store.getByMaxChatId(7))?.historyBackfillCursor).toBe('200');
  });

  it('a transient failure in the catch-up leaves the cursor before the failed message and the chat out of caughtUp', async () => {
    await store.upsert({ maxChatId: '42', telegramTopicId: 100, title: 'Анна', createdAt: 'x', historyBackfillCursor: '50' });
    let telegramDown = true;
    const w = fakeWorld([msg(1, 100, 'one'), msg(2, 200, 'two')], (text) => {
      if (telegramDown && text === 'two') throw badGateway();
    });
    await expect(w.sync.runInChat(42, () => w.sync.ensureCaughtUp(42).then(() => undefined))).rejects.toThrow('Bad Gateway');
    expect(w.sync.isCaughtUp('42')).toBe(false);
    expect((await store.getByMaxChatId('42'))?.historyBackfillCursor).toBe('100');
    // A live push meanwhile: openTopic defers it (it is in the history above the cursor) and asks for a retry.
    await w.livePush(42, msg(3, 300, 'three'));
    expect(w.sends.map((s) => s.text)).toEqual(['one']);
    expect(w.retry).toHaveBeenCalledTimes(1);
    // Telegram is back: the retry resumes at the failed message, skipping what is linked already.
    telegramDown = false;
    await w.sync.runInChat(42, () => w.sync.ensureCaughtUp(42).then(() => undefined));
    expect(w.sends.map((s) => s.text)).toEqual(['one', 'two']);
    expect(w.sync.isCaughtUp('42')).toBe(true);
    expect((await store.getByMaxChatId('42'))?.historyBackfillCursor).toBe('200');
  });

  it('a deferred catch-up still lets an event outside the history (a call) into the existing topic', async () => {
    await store.upsert({ maxChatId: '42', telegramTopicId: 100, title: 'Анна', createdAt: 'x' });
    const w = fakeWorld([msg(1, 100, 'one')], (text) => {
      if (text === 'one') throw badGateway();
    });
    await expect(w.sync.runInChat(42, async () => {
      expect(await w.sync.openTopic(42)).toEqual({ topicId: 100, deferred: true });
    })).resolves.toBeUndefined();
    expect(w.retry).toHaveBeenCalledTimes(1);
  });

  it('a MAX reconnect during a catch-up keeps the chat out of caughtUp: its snapshot could not see the new gap', async () => {
    await store.upsert({ maxChatId: '42', telegramTopicId: 100, title: 'Анна', createdAt: 'x', historyBackfillCursor: '50' });
    const w = fakeWorld([msg(1, 100, 'one'), msg(2, 200, 'two')], (text) => {
      if (text === 'one') w.sync.reset(); // the socket dropped and came back while this went out
    });
    await w.sync.ensureCaughtUp(42);
    expect(w.sends.map((s) => s.text)).toEqual(['one', 'two']);
    expect(w.sync.isCaughtUp(42)).toBe(false);
    expect((await store.getByMaxChatId('42'))?.historyBackfillCursor).toBe('200'); // advanced per message anyway
    // The LOGIN pass fetches again from the cursor — nothing new here — and only then marks it.
    await w.sync.ensureCaughtUp(42);
    expect(w.sends).toHaveLength(2);
    expect(w.sync.isCaughtUp(42)).toBe(true);
  });

  it('the cursor moves for a live delivery only when the chat is caught up', async () => {
    await store.upsert({ maxChatId: '42', telegramTopicId: 100, title: 'Анна', createdAt: 'x', historyBackfillCursor: '50' });
    const w = fakeWorld();
    await w.sync.advanceCursor(42, 900, 'outgoing send');
    expect((await store.getByMaxChatId('42'))?.historyBackfillCursor).toBe('50');
    w.sync.markCaughtUp(42);
    await w.sync.advanceCursor(42, 900, 'outgoing send');
    expect((await store.getByMaxChatId('42'))?.historyBackfillCursor).toBe('900');
    w.sync.markDirty(42);
    await w.sync.advanceCursor(42, 950, 'outgoing send');
    expect((await store.getByMaxChatId('42'))?.historyBackfillCursor).toBe('900');
  });

  it('after the strikes of one message have struck out, the next try degrades it to a placeholder', async () => {
    await store.upsert({ maxChatId: '42', telegramTopicId: 100, title: 'Анна', createdAt: 'x' });
    const location = { id: 1, time: 100, attaches: [{ _type: 'LOCATION', latitude: 1, longitude: 2 }] } as unknown as MaxHistoryMessage;
    const w = fakeWorld([location], undefined, new StrikeCounter(3, 500, 0));
    w.telegram.sendLocation.mockRejectedValue(badGateway());
    for (let i = 0; i < 3; i++) await expect(w.sync.ensureCaughtUp(42)).rejects.toThrow('Bad Gateway');
    expect((await store.getByMaxChatId('42'))?.historyBackfillCursor).toBeUndefined();
    await w.sync.ensureCaughtUp(42);
    expect(w.sends).toHaveLength(1); // the placeholder text
    expect(w.sync.isCaughtUp('42')).toBe(true);
    expect((await store.getByMaxChatId('42'))?.historyBackfillCursor).toBe('100');
    // With the default minimum span, three quick strikes (a short outage) do not strike out.
    await store.upsert({ maxChatId: '43', telegramTopicId: 101, title: 'Борис', createdAt: 'x' });
    const w2 = fakeWorld([location]);
    w2.telegram.sendLocation.mockRejectedValue(badGateway());
    for (let i = 0; i < 4; i++) await expect(w2.sync.ensureCaughtUp(43)).rejects.toThrow('Bad Gateway');
    expect(w2.sends).toHaveLength(0);
    expect((await store.getByMaxChatId('43'))?.historyBackfillCursor).toBeUndefined();
  });
});

describe('ChatCatchUp.restoreTopic', () => {
  it('a topic found deleted mid-catch-up comes back with the whole history, its old links forgotten', async () => {
    await store.upsert({ maxChatId: '42', telegramTopicId: 100, title: 'Анна', createdAt: 'x', historyBackfillCursor: '500' });
    const w = fakeWorld([msg(1, 100, 'old'), msg(2, 600, 'new')], (_text, topicId) => {
      if (topicId === 100) throw threadNotFound();
    });
    w.links.add({ maxChatId: '42', maxMessageId: 1, telegramMessageId: 5, outgoing: true });
    expect(await w.sync.ensureCaughtUp(42)).toBe(999); // the recreated topic
    expect(w.forgetChatLinks).toHaveBeenCalledWith(42);
    expect(w.telegram.createForumTopic).toHaveBeenCalledTimes(1);
    expect(w.sendCard).toHaveBeenCalledWith(42, 999);
    expect(w.sends).toEqual([
      { text: 'old', topicId: 999 },
      { text: 'new', topicId: 999 },
    ]);
    const mapping = await store.getByMaxChatId('42');
    expect(mapping?.telegramTopicId).toBe(999);
    expect(mapping?.title).toBe('Анна');
    expect(mapping?.historyBackfillCursor).toBe('600');
    expect(w.sync.isCaughtUp('42')).toBe(true);
  });

  it('a /ban landing mid-backfill stops the chat instead of recreating its topic', async () => {
    await store.upsert({ maxChatId: '7', telegramTopicId: 100, title: 'Группа', createdAt: 'x' });
    const w = fakeWorld([msg(1, 100, 'first'), msg(2, 200, 'second')], async (text) => {
      // The first message goes out, then the owner bans the chat (setBanned + topic deleted).
      if (text === 'first') await store.setBanned('7', true);
      if (text === 'second') throw threadNotFound();
    });
    await syncAllChatsToTelegram(w.sync, [{ id: 7, status: 'ACTIVE' }], () => 'Группа');
    expect(w.sends.map((s) => s.text)).toEqual(['first']);
    expect(w.telegram.createForumTopic).not.toHaveBeenCalled();
    const mapping = await store.getByMaxChatId('7');
    expect(mapping?.banned).toBe(true);
    expect(mapping?.telegramTopicId).toBe(100);
    expect(w.sync.isCaughtUp('7')).toBe(false);
    expect(w.retry).not.toHaveBeenCalled(); // a ban is not a transient failure
    // A live event for the banned chat is not written either.
    await expect(w.sync.restoreTopic(7)).rejects.toBeInstanceOf(ChatBannedError);
  });
});

describe('syncAllChatsToTelegram', () => {
  it('creates missing topics with their card, catches every chat up, and covers mapped chats missing from the snapshot', async () => {
    await store.upsert({ maxChatId: '8', telegramTopicId: 80, title: 'Старый', createdAt: 'x', historyBackfillCursor: '150' });
    await store.upsert({ maxChatId: '11', telegramTopicId: 81, title: 'Бан', createdAt: 'x', banned: true });
    const w = fakeWorld([msg(1, 100, 'one'), msg(2, 200, 'two')]);
    await syncAllChatsToTelegram(w.sync, [{ id: 9, status: 'ACTIVE' }, { id: 10, status: 'CLOSED' }], () => 'Новый');
    expect(w.telegram.createForumTopic).toHaveBeenCalledTimes(1);
    expect(w.sendCard).toHaveBeenCalledWith(9, 999);
    expect(w.sends).toEqual([
      { text: 'one', topicId: 999 },
      { text: 'two', topicId: 999 },
      { text: 'two', topicId: 80 }, // chat 8: mapped, not in the snapshot, cursor-bounded
    ]);
    expect(w.sync.isCaughtUp('9')).toBe(true);
    expect(w.sync.isCaughtUp('8')).toBe(true);
    expect(w.sync.isCaughtUp('10')).toBe(false);
    expect(w.sync.isCaughtUp('11')).toBe(false); // banned: nothing fetched for it
  });

  it('a transient failure keeps the chat out of caughtUp and asks for a retry; a cancelled run stops', async () => {
    const w = fakeWorld([msg(1, 100, 'offline 1')]);
    w.telegram.createForumTopic.mockRejectedValueOnce(badGateway());
    await syncAllChatsToTelegram(w.sync, [{ id: 9, status: 'ACTIVE' }], () => 'Новый');
    expect(w.retry).toHaveBeenCalledTimes(1);
    expect(w.sync.isCaughtUp('9')).toBe(false);
    expect(await store.getByMaxChatId(9)).toBeUndefined();
    await syncAllChatsToTelegram(w.sync, [{ id: 9, status: 'ACTIVE' }], () => 'Новый', () => true);
    expect(w.telegram.createForumTopic).toHaveBeenCalledTimes(1);
    expect(w.sends).toHaveLength(0);
  });

  it('backfills a poll as its text rendering, options included (delivery-r2#3)', async () => {
    await store.upsert({ maxChatId: '42', telegramTopicId: 100, title: 'Анна', createdAt: 'x', historyBackfillCursor: '50' });
    const poll = {
      id: 1,
      time: 100,
      attaches: [{ _type: 'POLL', title: 'Куда едем?', answers: [{ text: 'Море', answerId: 1 }, { text: 'Горы', answerId: 2 }], settings: 0 }],
    } as unknown as MaxHistoryMessage;
    const w = fakeWorld([poll]);
    await syncAllChatsToTelegram(w.sync, [{ id: 42, status: 'ACTIVE' }], () => 'Анна');
    expect(w.sends).toHaveLength(1);
    expect(w.sends[0]?.text).toContain('📊 Опрос: Куда едем?');
    expect(w.sends[0]?.text).toContain('• Море');
    expect(w.sends[0]?.text).toContain('• Горы');
    expect(w.links.getByTelegram(1000)?.maxMessageId).toBe(1);
  });
});

describe('ChatBannedError', () => {
  it('names the chat', () => {
    const err = new ChatBannedError('7');
    expect(err.chatId).toBe('7');
    expect(err.name).toBe('ChatBannedError');
  });
});
