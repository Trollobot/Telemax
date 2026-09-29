import { existsSync } from 'node:fs';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { MessageLinkStore } from '../src/bridge/sync.js';
import { ChatMapStore, cursorToMs, normalizeChatMappings } from '../src/store/chatMapStore.js';
import { SessionStore } from '../src/store/sessionStore.js';

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

  it('removeByChat() drops every link of one chat (incl. extra ids) and nothing else', () => {
    const store = new MessageLinkStore();
    store.add({ maxChatId: 5n, maxMessageId: 1, telegramMessageId: 11, extraTelegramMessageIds: [111], outgoing: true });
    store.add({ maxChatId: '5', maxMessageId: 2, telegramMessageId: 22, outgoing: true });
    store.add({ maxChatId: -5, maxMessageId: 3, telegramMessageId: 33, outgoing: true });
    store.add({ maxChatId: 55, maxMessageId: 4, telegramMessageId: 44 });

    expect(store.removeByChat(5)).toBe(2); // BigInt and string forms of chat 5 both match
    expect(store.getByMax(5, 1)).toBeUndefined();
    expect(store.getByMax(5, 2)).toBeUndefined();
    expect(store.getByTelegram(11)).toBeUndefined();
    expect(store.getByTelegram(111)).toBeUndefined();
    expect(store.getByTelegram(22)).toBeUndefined();
    // Neighbouring ids that merely share digits survive.
    expect(store.getByMax(-5, 3)?.telegramMessageId).toBe(33);
    expect(store.getByMax(55, 4)?.telegramMessageId).toBe(44);
    expect(store.outgoingLinks().map((l) => l.telegramMessageId)).toEqual([33]);
    expect(store.removeByChat(5)).toBe(0);
  });

  it('removeByChat() frees capacity so later adds do not evict survivors early', () => {
    const store = new MessageLinkStore(2);
    store.add({ maxChatId: 1, maxMessageId: 1, telegramMessageId: 11 });
    store.add({ maxChatId: 2, maxMessageId: 2, telegramMessageId: 22 });
    store.removeByChat(1);
    store.add({ maxChatId: 3, maxMessageId: 3, telegramMessageId: 33 });
    expect(store.getByMax(2, 2)?.telegramMessageId).toBe(22);
    expect(store.getByMax(3, 3)?.telegramMessageId).toBe(33);
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

  it('advanceHistoryCursor never moves the cursor backwards', async () => {
    const store = new ChatMapStore(filePath);
    await store.upsert({ maxChatId: 1, telegramTopicId: 10, createdAt: 'now', historyBackfillCursor: '2000' });

    // A backfill replaying an older snapshot message must not drag it back...
    await store.advanceHistoryCursor(1, 1500);
    expect((await store.getByMaxChatId(1))?.historyBackfillCursor).toBe('2000');
    // ...nor does an equal value rewrite it; a newer one moves it forward.
    await store.advanceHistoryCursor(1, 2000);
    await store.advanceHistoryCursor(1, 2500);
    expect((await store.getByMaxChatId(1))?.historyBackfillCursor).toBe('2500');
    // Garbage in (NaN from a missing time) is ignored.
    await store.advanceHistoryCursor(1, Number.NaN);
    expect((await store.getByMaxChatId(1))?.historyBackfillCursor).toBe('2500');
  });

  it('advanceHistoryCursor compares numerically against a legacy raw-number cursor', async () => {
    // Pre-normalization files could store the cursor as a number; '900' > '10000' as strings.
    await writeFile(filePath, JSON.stringify([{ maxChatId: 7, telegramTopicId: 3, createdAt: 'x', historyBackfillCursor: 10000 }]), 'utf8');
    const store = new ChatMapStore(filePath);
    await store.advanceHistoryCursor(7, 900);
    expect((await store.getByMaxChatId(7))?.historyBackfillCursor).toBe('10000');
    await store.advanceHistoryCursor('7', 20000);
    expect((await store.getByMaxChatId(7))?.historyBackfillCursor).toBe('20000');
  });

  it('merges a legacy numeric record and its string twin on load', async () => {
    // What the old strict-=== upsert left behind: the legacy numeric entry (found first by every
    // lookup) plus a string twin that received the later writes (a newer cursor, a /ban).
    await writeFile(
      filePath,
      JSON.stringify([
        { maxChatId: 123, telegramTopicId: 11, title: 'Старое', createdAt: 'a', historyBackfillCursor: '1000' },
        { maxChatId: '999', telegramTopicId: 12, createdAt: 'b' },
        { maxChatId: '123', telegramTopicId: 11, title: 'Новое', createdAt: 'a', historyBackfillCursor: '5000', banned: true },
      ]),
      'utf8',
    );
    const store = new ChatMapStore(filePath);

    const all = await store.list();
    expect(all.map((m) => m.maxChatId)).toEqual(['123', '999']);
    const merged = await store.getByMaxChatId(123);
    expect(merged).toMatchObject({ maxChatId: '123', title: 'Новое', banned: true, historyBackfillCursor: '5000' });

    // Writes now land in the one entry every lookup reads.
    await store.advanceHistoryCursor(123, 6000);
    await store.setBanned(123n, false);
    const raw = JSON.parse(await readFile(filePath, 'utf8')) as Array<{ maxChatId: unknown; historyBackfillCursor?: string; banned?: boolean }>;
    expect(raw.filter((m) => String(m.maxChatId) === '123')).toEqual([expect.objectContaining({ maxChatId: '123', historyBackfillCursor: '6000', banned: false })]);
  });

  it('upsert and remove match a loaded legacy numeric id without leaving a twin', async () => {
    await writeFile(filePath, JSON.stringify([{ maxChatId: 42, telegramTopicId: 1, createdAt: 'x' }]), 'utf8');
    const store = new ChatMapStore(filePath);
    await store.upsert({ maxChatId: 42, telegramTopicId: 2, createdAt: 'y' });
    expect(await store.list()).toEqual([{ maxChatId: '42', telegramTopicId: 2, createdAt: 'y' }]);
    await store.remove('42');
    expect(await store.list()).toEqual([]);
  });

  it('starts empty when the file does not exist', async () => {
    const store = new ChatMapStore(path.join(dir, 'missing.json'));
    expect(await store.list()).toEqual([]);
  });

  it('setTitle merges only the title into the CURRENT entry', async () => {
    const store = new ChatMapStore(filePath);
    await store.upsert({ maxChatId: 1, telegramTopicId: 10, title: 'old', createdAt: 'x', historyBackfillCursor: '5000' });
    // A rename read the entry, then awaited editForumTopic while the backfill advanced the cursor
    // and the owner pressed /ban.
    await store.advanceHistoryCursor(1, 6000);
    await store.setBanned(1, true);
    await store.setTitle(1, 10, 'Анна');
    expect(await store.getByMaxChatId(1)).toMatchObject({ title: 'Анна', historyBackfillCursor: '6000', banned: true, telegramTopicId: 10 });
  });

  it('setTitle leaves a chat alone that is gone or moved to another topic meanwhile', async () => {
    const store = new ChatMapStore(filePath);
    await store.upsert({ maxChatId: 1, telegramTopicId: 20, title: 'new topic', createdAt: 'x' });
    await store.setTitle(1, 10, 'renamed old topic'); // recreated 10 -> 20 during the rename
    expect((await store.getByMaxChatId(1))?.title).toBe('new topic');
    await store.setTitle(2, 10, 'ghost');
    expect(await store.getByMaxChatId(2)).toBeUndefined();
  });
});

describe('SessionStore.clear', () => {
  let dir: string;
  let filePath: string;
  const session = { sessionToken: 't'.repeat(40), phone: '+70000000000', deviceId: 'd', savedAt: 'now' };

  beforeEach(async () => {
    dir = await mkdtemp(path.join(tmpdir(), 'telemax-session-'));
    filePath = path.join(dir, 'max.session.json');
    vi.stubEnv('MAX_SESSION_KEY', 'ab'.repeat(32));
  });

  afterEach(async () => {
    vi.unstubAllEnvs();
    await rm(dir, { recursive: true, force: true });
  });

  it('lands after a save still in flight, so the file does not come back', async () => {
    const store = new SessionStore(filePath);
    await Promise.all([store.save(session), store.save(session), store.clear()]);
    expect(existsSync(filePath)).toBe(false);
    expect(await store.load()).toBeNull();
    // The queue keeps working afterwards.
    await store.save(session);
    expect((await store.load())?.phone).toBe(session.phone);
  });

  it('removes the leftover .tmp and the parked .broken too, and is fine with nothing to remove', async () => {
    const store = new SessionStore(filePath);
    for (const file of [filePath, `${filePath}.tmp`, `${filePath}.broken`]) await writeFile(file, 'x', 'utf8');
    await store.clear();
    for (const file of [filePath, `${filePath}.tmp`, `${filePath}.broken`]) expect(existsSync(file)).toBe(false);
    await expect(store.clear()).resolves.toBeUndefined();
  });
});

describe('normalizeChatMappings', () => {
  it('keeps the more advanced cursor even when the newer twin carries an older one', () => {
    const out = normalizeChatMappings([
      { maxChatId: 5, telegramTopicId: 1, createdAt: 'a', historyBackfillCursor: 9000 },
      { maxChatId: '5', telegramTopicId: 2, createdAt: 'b', historyBackfillCursor: '3000' },
    ]);
    expect(out).toEqual([{ maxChatId: '5', telegramTopicId: 2, createdAt: 'b', historyBackfillCursor: '9000' }]);
  });

  it('drops junk entries and a non-array file body', () => {
    expect(normalizeChatMappings({ not: 'an array' })).toEqual([]);
    expect(normalizeChatMappings([null, 'x', { telegramTopicId: 1 }, { maxChatId: 1, telegramTopicId: 2, createdAt: 'c', historyBackfillCursor: 'garbage' }])).toEqual([
      { maxChatId: '1', telegramTopicId: 2, createdAt: 'c' },
    ]);
  });
});

describe('cursorToMs', () => {
  it('reads string, number and BigInt cursors; null for absent/garbage', () => {
    expect(cursorToMs('1723600000000')).toBe(1723600000000);
    expect(cursorToMs(1723600000000)).toBe(1723600000000);
    expect(cursorToMs(1723600000000n)).toBe(1723600000000);
    expect(cursorToMs(undefined)).toBeNull();
    expect(cursorToMs('')).toBeNull();
    expect(cursorToMs('abc')).toBeNull();
    expect(cursorToMs({})).toBeNull();
  });
});
