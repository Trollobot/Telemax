import { mkdtemp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import type { Telegraf } from 'telegraf';
import type { Message } from 'telegraf/types';
import { broadcastCard, createBroadcasts, isGoneError, readerText, shiftEntities, withQuote } from '../src/bridge/broadcast.js';
import { BroadcastStore, type Broadcast } from '../src/store/broadcastStore.js';

const tempStore = async () => new BroadcastStore(path.join(await mkdtemp(path.join(tmpdir(), 'tlmx-bc-')), 'broadcasts.json'));
const broadcast = (over: Partial<Broadcast> = {}): Broadcast => ({
  id: 'b1',
  maxChatId: '100',
  targetChatId: -500,
  targetTitle: 'Читалка',
  targetType: 'group',
  since: 1000,
  cursor: 1000,
  ...over,
});

describe('broadcast texts', () => {
  it('names the owner instead of «Вы», an edit marker in front included', () => {
    expect(readerText('🧑 Вы:\nпривет', 'Сергей')).toBe('🧑 Сергей:\nпривет');
    expect(readerText('✏️ (12:05) 🧑 Вы:\nпоправил', 'Сергей')).toBe('✏️ (12:05) 🧑 Сергей:\nпоправил');
    expect(readerText('👤 Петя:\nВы где?', 'Сергей')).toBe('👤 Петя:\nВы где?');
    expect(readerText('просто текст про 🧑 Вы:\n', 'Сергей')).toBe('просто текст про 🧑 Вы:\n');
  });

  it('puts a quote line under the author line', () => {
    expect(withQuote('👤 Петя:\nда', 'ты придёшь?')).toBe('👤 Петя:\n↩️ В ответ на «ты придёшь?»:\nда');
    expect(withQuote('да', 'ты придёшь?')).toBe('↩️ В ответ на «ты придёшь?»:\nда');
    expect(withQuote(undefined, '')).toBe('↩️ В ответ на сообщение:');
  });

  it('shifts entities by the prefix', () => {
    expect(shiftEntities([{ type: 'bold', offset: 0, length: 3 }], 10)).toEqual([{ type: 'bold', offset: 10, length: 3 }]);
    expect(shiftEntities(undefined, 10)).toBeUndefined();
  });

  it('tells a lost target from a passing failure', () => {
    expect(isGoneError({ response: { error_code: 403, description: 'Forbidden: bot was kicked from the supergroup chat' } })).toBe(true);
    expect(isGoneError({ response: { error_code: 400, description: 'Bad Request: chat not found' } })).toBe(true);
    expect(isGoneError({ response: { error_code: 400, description: 'Bad Request: need administrator rights in the channel chat' } })).toBe(true);
    expect(isGoneError({ response: { error_code: 400, description: 'Bad Request: message to copy not found' } })).toBe(false);
    expect(isGoneError(new Error('socket hang up'))).toBe(false);
  });

  it('the card lists the places with a stop button each and offers one more', () => {
    const empty = broadcastCard('Дача', [], 'https://t.me/bot?start=bc_x');
    expect(empty.text).toMatch(/Нажмите кнопку/);
    expect(empty.markup.inline_keyboard.flat().map((b) => b.text)).toEqual(['📡 Выбрать группу или канал', '◀️ Готово']);
    const two = broadcastCard('Дача', [broadcast(), broadcast({ id: 'b2', targetTitle: 'Новости', targetType: 'channel' })], 'https://t.me/bot?start=bc_y');
    expect(two.text).toMatch(/👥 Читалка/);
    expect(two.text).toMatch(/📢 Новости/);
    expect(two.markup.inline_keyboard.flat().map((b) => ('callback_data' in b ? b.callback_data : b.text))).toEqual([
      'tlmx_bc:stop:b1',
      'tlmx_bc:stop:b2',
      '➕ Ещё группа или канал',
      'tlmx_panel:dismiss',
    ]);
  });
});

describe('BroadcastStore', () => {
  it('keeps any number of places per chat, moves the cursor only forward, persists', async () => {
    const store = await tempStore();
    await store.add(broadcast());
    await store.add(broadcast({ id: 'b2', targetChatId: -600 }));
    expect((await store.forChat('100')).map((b) => b.id)).toEqual(['b1', 'b2']);
    expect(await store.isTarget(-600)).toBe(true);
    expect(await store.isTarget(-700)).toBe(false);
    await store.advance('b1', 2000);
    await store.advance('b1', 1500);
    expect((await store.get('b1'))!.cursor).toBe(2000);
    expect((await store.remove('b2'))!.id).toBe('b2');
    expect(await store.remove('b2')).toBeUndefined();
    const onDisk = JSON.parse(await readFile((store as unknown as { filePath: string }).filePath, 'utf8')) as Broadcast[];
    expect(onDisk.map((b) => [b.id, b.cursor])).toEqual([['b1', 2000]]);
  });
});

describe('copying into broadcasts', () => {
  function fakeBot() {
    let next = 1;
    const telegram = {
      sendMessage: vi.fn(async (_chatId: number | string, _text: string, _extra?: unknown) => ({ message_id: next++ })),
      copyMessage: vi.fn(async (_chatId: number | string, _from: number | string, _id: number, _extra?: unknown) => ({ message_id: next++ })),
      editMessageText: vi.fn(async (_chatId: number | string, _id: number, _inline: unknown, _text: string) => true),
      deleteMessages: vi.fn(async (_chatId: number | string, _ids: number[]) => true),
    };
    return { telegram, botInfo: { id: 42, username: 'tlmx_bot' }, command: vi.fn(), action: vi.fn() };
  }
  async function setup(...list: Broadcast[]) {
    const store = await tempStore();
    for (const b of list) await store.add(b);
    const bot = fakeBot();
    const bc = createBroadcasts({
      bot: bot as unknown as Telegraf,
      targetGroupId: '-1001',
      store,
      chatTitle: async () => 'Дача',
      chatOfTopic: async () => '100',
      topicOf: async () => 77,
      ownerName: async () => 'Сергей',
      isGroupAdmin: async () => true,
    });
    return { store, bot, bc };
  }

  it('sends the text anew under the owner name and copies the attachments, to every place', async () => {
    const { store, bot, bc } = await setup(broadcast(), broadcast({ id: 'b2', targetChatId: -600 }));
    bc.copyIncoming({ maxChatId: '100', maxMessageId: 7, time: 2000, text: '🧑 Вы:\nфото с дачи', mediaIds: [55] });
    await vi.waitFor(async () => expect((await store.get('b2'))!.cursor).toBe(2000));
    expect(bot.telegram.sendMessage.mock.calls.map((c) => [c[0], c[1]])).toEqual([
      [-500, '🧑 Сергей:\nфото с дачи'],
      [-600, '🧑 Сергей:\nфото с дачи'],
    ]);
    expect(bot.telegram.copyMessage.mock.calls.map((c) => [c[0], c[1], c[2]])).toEqual([
      [-500, '-1001', 55],
      [-600, '-1001', 55],
    ]);
  });

  it('skips what the cursor has seen — a replayed history is not copied again', async () => {
    const { bot, bc } = await setup(broadcast({ cursor: 5000 }));
    bc.copyIncoming({ maxChatId: '100', maxMessageId: 1, time: 4000, text: 'старое', mediaIds: [] });
    bc.copyIncoming({ maxChatId: '100', maxMessageId: 2, time: 6000, text: 'новое', mediaIds: [] });
    await vi.waitFor(() => expect(bot.telegram.sendMessage).toHaveBeenCalledTimes(1));
    expect(bot.telegram.sendMessage.mock.calls[0]![1]).toBe('новое');
  });

  it('follows edits and deletions of a copied message, and replies to a copied one natively', async () => {
    const { store, bot, bc } = await setup(broadcast());
    bc.copyIncoming({ maxChatId: '100', maxMessageId: 7, time: 2000, text: '👤 Петя:\nпривет', mediaIds: [] });
    bc.copyIncoming({ maxChatId: '100', maxMessageId: 8, time: 3000, text: '🧑 Вы:\nи тебе', mediaIds: [], quote: { maxMessageId: 7, text: 'привет' } });
    await vi.waitFor(async () => expect((await store.get('b1'))!.cursor).toBe(3000));
    expect(bot.telegram.sendMessage.mock.calls[1]![2]).toEqual({ reply_parameters: { message_id: 1, allow_sending_without_reply: true } });
    bc.copyEdit('100', 8, '✏️ (12:05) 🧑 Вы:\nи тебе!');
    await vi.waitFor(() => expect(bot.telegram.editMessageText).toHaveBeenCalledWith(-500, 2, undefined, '✏️ (12:05) 🧑 Сергей:\nи тебе!'));
    bc.copyDelete('100', 7);
    await vi.waitFor(() => expect(bot.telegram.deleteMessages).toHaveBeenCalledWith(-500, [1]));
  });

  it('a quote of something never copied becomes a quote line', async () => {
    const { bot, bc } = await setup(broadcast());
    bc.copyIncoming({ maxChatId: '100', maxMessageId: 9, time: 2000, text: '👤 Петя:\nда', mediaIds: [], quote: { maxMessageId: 1, text: 'идёшь?' } });
    await vi.waitFor(() => expect(bot.telegram.sendMessage).toHaveBeenCalledWith(-500, '👤 Петя:\n↩️ В ответ на «идёшь?»:\nда', {}));
  });

  it('stops a broadcast whose place is gone and says so in the topic', async () => {
    const { store, bot, bc } = await setup(broadcast());
    bot.telegram.sendMessage.mockImplementation(async (chatId: number | string) => {
      if (chatId === -500) throw Object.assign(new Error('403'), { response: { error_code: 403, description: 'Forbidden: bot was kicked from the group chat' } });
      return { message_id: 99 };
    });
    bc.copyIncoming({ maxChatId: '100', maxMessageId: 7, time: 2000, text: 'привет', mediaIds: [] });
    await vi.waitFor(async () => expect(await store.get('b1')).toBeUndefined());
    await vi.waitFor(() => expect(bot.telegram.sendMessage).toHaveBeenCalledWith('-1001', expect.stringMatching(/Трансляция в «Читалка» остановлена/), { message_thread_id: 77 }));
  });

  it("copies the owner's Telegram messages under their name, formatting kept", async () => {
    const { bot, bc } = await setup(broadcast());
    const text = { message_id: 10, text: 'жирный', entities: [{ type: 'bold', offset: 0, length: 6 }] } as unknown as Message;
    bc.copyOwner('100', 11, 2000, text);
    const photo = { message_id: 12, photo: [{ file_id: 'x' }], caption: 'дача' } as unknown as Message;
    bc.copyOwner('100', 13, 3000, photo, undefined, '↩️ Переслано от Пети');
    const sticker = { message_id: 14, sticker: { file_id: 's' } } as unknown as Message;
    bc.copyOwner('100', 15, 4000, sticker);
    await vi.waitFor(() => expect(bot.telegram.copyMessage).toHaveBeenCalledTimes(2));
    const prefix = '🧑 Сергей:\n';
    expect(bot.telegram.sendMessage.mock.calls[0]).toEqual([-500, `${prefix}жирный`, { entities: [{ type: 'bold', offset: prefix.length, length: 6 }] }]);
    expect(bot.telegram.copyMessage.mock.calls[0]).toEqual([-500, '-1001', 12, { caption: `${prefix}↩️ Переслано от Пети\nдача`, caption_entities: undefined }]);
    expect(bot.telegram.sendMessage.mock.calls[1]![1]).toBe('🧑 Сергей:');
    expect(bot.telegram.copyMessage.mock.calls[1]!.slice(0, 3)).toEqual([-500, '-1001', 14]);
  });
});
