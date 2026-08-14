import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { MessageLinkStore } from '../src/bridge/sync.js';
import { ChatMapStore } from '../src/store/chatMapStore.js';

describe('MessageLinkStore', () => {
  it('resolves links in both directions, including extra Telegram ids', () => {
    const store = new MessageLinkStore();
    store.add({ maxChatId: 1n, maxMessageId: 100n, telegramMessageId: 7, extraTelegramMessageIds: [8] });

    expect(store.getByMax(1n, 100n)?.telegramMessageId).toBe(7);
    expect(store.getByTelegram(7)?.maxMessageId).toBe(100n);
    expect(store.getByTelegram(8)?.maxMessageId).toBe(100n);
  });

  it('matches BigInt and string forms of the same id (String()-keyed)', () => {
    const store = new MessageLinkStore();
    store.add({ maxChatId: '55', maxMessageId: 900n, telegramMessageId: 1 });
    expect(store.getByMax(55n, '900')?.telegramMessageId).toBe(1);
  });

  it('ignores links with a null maxMessageId', () => {
    const store = new MessageLinkStore();
    store.add({ maxChatId: 1, maxMessageId: null, telegramMessageId: 5 });
    expect(store.getByTelegram(5)).toBeUndefined();
  });

  it('evicts the oldest link (and its extra ids) past capacity', () => {
    const store = new MessageLinkStore(2);
    store.add({ maxChatId: 1, maxMessageId: 1, telegramMessageId: 11, extraTelegramMessageIds: [111] });
    store.add({ maxChatId: 1, maxMessageId: 2, telegramMessageId: 22 });
    store.add({ maxChatId: 1, maxMessageId: 3, telegramMessageId: 33 });

    expect(store.getByMax(1, 1)).toBeUndefined();
    expect(store.getByTelegram(11)).toBeUndefined();
    expect(store.getByTelegram(111)).toBeUndefined();
    expect(store.getByMax(1, 2)?.telegramMessageId).toBe(22);
    expect(store.getByMax(1, 3)?.telegramMessageId).toBe(33);
  });

  it('clear() wipes everything', () => {
    const store = new MessageLinkStore();
    store.add({ maxChatId: 1, maxMessageId: 1, telegramMessageId: 11 });
    store.clear();
    expect(store.getByMax(1, 1)).toBeUndefined();
    expect(store.getByTelegram(11)).toBeUndefined();
  });
});

describe('ChatMapStore', () => {
  let dir: string;
  let filePath: string;

  beforeEach(async () => {
    dir = await mkdtemp(path.join(tmpdir(), 'telemax-chatmap-'));
    filePath = path.join(dir, 'chat-map.json');
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('normalizes maxChatId to a decimal string on upsert', async () => {
    const store = new ChatMapStore(filePath);
    await store.upsert({ maxChatId: 123456789012345n, telegramTopicId: 5, createdAt: 'now' });

    const raw = JSON.parse(await readFile(filePath, 'utf8')) as Array<{ maxChatId: unknown }>;
    expect(raw[0]?.maxChatId).toBe('123456789012345');
  });

  it('getByMaxChatId matches across number/string/BigInt forms', async () => {
    const store = new ChatMapStore(filePath);
    await store.upsert({ maxChatId: 42, telegramTopicId: 9, createdAt: 'now' });

    expect((await store.getByMaxChatId('42'))?.telegramTopicId).toBe(9);
    expect((await store.getByMaxChatId(42n))?.telegramTopicId).toBe(9);
  });

  it('upsert replaces an existing entry instead of duplicating it', async () => {
    const store = new ChatMapStore(filePath);
    await store.upsert({ maxChatId: 1, telegramTopicId: 10, createdAt: 'now' });
    await store.upsert({ maxChatId: '1', telegramTopicId: 20, createdAt: 'later' });

    const all = await store.list();
    expect(all).toHaveLength(1);
    expect(all[0]?.telegramTopicId).toBe(20);
  });

  it('advanceHistoryCursor persists the cursor for an existing mapping only', async () => {
    const store = new ChatMapStore(filePath);
    await store.upsert({ maxChatId: 1, telegramTopicId: 10, createdAt: 'now' });

    await store.advanceHistoryCursor(1, 1723600000000);
    expect((await store.getByMaxChatId(1))?.historyBackfillCursor).toBe('1723600000000');

    // No mapping for chat 2 — must be a no-op, not a crash or a phantom entry.
    await store.advanceHistoryCursor(2, 123);
    expect(await store.getByMaxChatId(2)).toBeUndefined();
  });

  it('survives concurrent upserts without corrupting the file (serialized writes)', async () => {
    const store = new ChatMapStore(filePath);
    await Promise.all(
      Array.from({ length: 20 }, (_, i) => store.upsert({ maxChatId: i, telegramTopicId: i, createdAt: 'now' })),
    );

    const raw = JSON.parse(await readFile(filePath, 'utf8')) as unknown[];
    expect(raw).toHaveLength(20);
  });

  it('starts empty when the file does not exist', async () => {
    const store = new ChatMapStore(path.join(dir, 'missing.json'));
    expect(await store.list()).toEqual([]);
  });
});
