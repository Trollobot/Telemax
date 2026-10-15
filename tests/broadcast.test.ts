import { mkdtemp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import type { Telegraf } from 'telegraf';
import type { Message } from 'telegraf/types';
import { addLinks, broadcastCard, createBroadcasts, isGoneError, readerText, shiftEntities, withQuote } from '../src/bridge/broadcast.js';
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

  it("adds the bot through Telegram's own links: a group gets the code, both the admin rights «📌» needs", () => {
    expect(addLinks('tlmx_bot', 'abc')).toEqual({
      group: 'https://t.me/tlmx_bot?startgroup=bc_abc&admin=pin_messages+delete_messages',
      channel: 'https://t.me/tlmx_bot?startchannel&admin=post_messages+edit_messages+delete_messages',
      pick: 'https://t.me/tlmx_bot?start=bc_abc',
    });
  });

  it('the card lists the places with a stop button each and offers more', () => {
    const links = addLinks('tlmx_bot', 'x');
    const empty = broadcastCard('Дача', [], links);
    expect(empty.text).toMatch(/сам добавит туда бота/);
    expect(empty.markup.inline_keyboard.flat().map((b) => b.text)).toEqual(['👥 В группу', '📢 В канал', '🔎 Бот уже в группе или канале', '◀️ Готово']);
    const two = broadcastCard('Дача', [broadcast(), broadcast({ id: 'b2', targetTitle: 'Новости', targetType: 'channel', pin: true })], links);
    expect(two.text).toMatch(/👥 Читалка — с \d\d\.\d\d\n/);
    expect(two.text).toMatch(/📢 Новости — с \d\d\.\d\d, 📌 закрепляются/);
    expect(two.markup.inline_keyboard[0]!.map((b) => b.text)).toEqual(['⏹ Остановить: Читалка', '📌 Закреп: выкл']);
    expect(two.markup.inline_keyboard[1]!.map((b) => b.text)).toEqual(['⏹ Остановить: Новости', '📌 Закреп: вкл']);
    expect(two.markup.inline_keyboard.flat().map((b) => ('callback_data' in b ? b.callback_data : b.text))).toEqual([
      'tlmx_bc:stop:b1',
      'tlmx_bc:pin:b1',
      'tlmx_bc:stop:b2',
      'tlmx_bc:pin:b2',
      '👥 В группу',
      '📢 В канал',
      '🔎 Бот уже в группе или канале',
      'tlmx_panel:dismiss',
    ]);
    expect(broadcastCard('Дача', [], undefined).text).toMatch(/не знает своё имя/);
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
      deleteMessage: vi.fn(async (_chatId: number | string, _id: number) => true),
      pinChatMessage: vi.fn(async (_chatId: number | string, _id: number, _extra?: unknown) => true),
      getChatMember: vi.fn(async (_chatId: number | string, _userId: number): Promise<Record<string, unknown>> => ({ status: 'member' })),
      getChat: vi.fn(async (chatId: number | string) => ({ id: chatId, title: 'Из getChat' })),
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

  it('«📌»: the first copy of every message is pinned, silently — the owner\'s too; a place without the flag is left alone', async () => {
    const { store, bot, bc } = await setup(broadcast({ pin: true }), broadcast({ id: 'b2', targetChatId: -600 }));
    bc.copyIncoming({ maxChatId: '100', maxMessageId: 7, time: 2000, text: '👤 Петя:\nфото', mediaIds: [55, 56] });
    bc.copyOwner('100', 8, 3000, { message_id: 10, text: 'ок' } as unknown as Message);
    await vi.waitFor(async () => expect((await store.get('b2'))!.cursor).toBe(3000));
    await vi.waitFor(async () => expect((await store.get('b1'))!.cursor).toBe(3000));
    const toPlace = (chatId: number) => bot.telegram.sendMessage.mock.results.filter((_r, i) => bot.telegram.sendMessage.mock.calls[i]![0] === chatId);
    const firstIds = await Promise.all(toPlace(-500).map((r) => r.value as Promise<{ message_id: number }>));
    expect(bot.telegram.pinChatMessage.mock.calls).toEqual(firstIds.map((m) => [-500, m.message_id, { disable_notification: true }]));
  });

  it('«📌» without the right to pin goes off and says so in the topic; copying goes on', async () => {
    const { store, bot, bc } = await setup(broadcast({ pin: true }));
    bot.telegram.pinChatMessage.mockRejectedValue(Object.assign(new Error('400'), { response: { error_code: 400, description: 'Bad Request: not enough rights to manage pinned messages in the chat' } }));
    bc.copyIncoming({ maxChatId: '100', maxMessageId: 7, time: 2000, text: 'раз', mediaIds: [] });
    await vi.waitFor(async () => expect((await store.get('b1'))!.cursor).toBe(2000));
    expect((await store.get('b1'))!.pin).toBeUndefined();
    expect(bot.telegram.sendMessage).toHaveBeenCalledWith('-1001', expect.stringMatching(/Закреп в «Читалка» выключен: у бота там нет права закреплять/), { message_thread_id: 77 });
    bc.copyIncoming({ maxChatId: '100', maxMessageId: 8, time: 3000, text: 'два', mediaIds: [] });
    await vi.waitFor(async () => expect((await store.get('b1'))!.cursor).toBe(3000));
    expect(bot.telegram.pinChatMessage).toHaveBeenCalledTimes(1);
  });

  it('the «… закрепил» line goes only for the bot\'s own pin', async () => {
    const { store, bot, bc } = await setup(broadcast({ pin: true }));
    bc.copyIncoming({ maxChatId: '100', maxMessageId: 7, time: 2000, text: 'раз', mediaIds: [] });
    await vi.waitFor(async () => expect((await store.get('b1'))!.cursor).toBe(2000));
    const ours = bot.telegram.pinChatMessage.mock.calls[0]![1];
    await bc.onTargetUpdate({ chat: { id: -500 }, message: { message_id: 300, pinned_message: { message_id: 999 } } } as never);
    expect(bot.telegram.deleteMessage).not.toHaveBeenCalled();
    await bc.onTargetUpdate({ chat: { id: -500 }, message: { message_id: 301, pinned_message: { message_id: ours } } } as never);
    expect(bot.telegram.deleteMessage).toHaveBeenCalledWith(-500, 301);
    // A channel's line arrives as a channel post.
    bc.copyIncoming({ maxChatId: '100', maxMessageId: 8, time: 3000, text: 'два', mediaIds: [] });
    await vi.waitFor(() => expect(bot.telegram.pinChatMessage).toHaveBeenCalledTimes(2));
    await bc.onTargetUpdate({ chat: { id: -500 }, channelPost: { message_id: 302, pinned_message: { message_id: bot.telegram.pinChatMessage.mock.calls[1]![1] } } } as never);
    expect(bot.telegram.deleteMessage).toHaveBeenLastCalledWith(-500, 302);
  });

  it('the «📌» button switches it on only where the bot may pin, and off again', async () => {
    const { store, bot, bc } = await setup(broadcast());
    bc.register();
    const [, onPin] = bot.action.mock.calls.find((c) => String(c[0]).includes('pin'))! as [RegExp, (ctx: unknown) => Promise<void>];
    const press = () => {
      const ctx = { match: ['', 'b1'], from: { id: 9 }, answerCbQuery: vi.fn(async () => true), editMessageText: vi.fn(async () => true) };
      return onPin(ctx).then(() => ctx);
    };
    let ctx = await press(); // a plain member
    expect(ctx.answerCbQuery).toHaveBeenCalledWith(expect.stringMatching(/администратором с правом «Закрепление сообщений»/), { show_alert: true });
    expect((await store.get('b1'))!.pin).toBeUndefined();
    bot.telegram.getChatMember.mockResolvedValue({ status: 'administrator', can_pin_messages: true, can_delete_messages: false });
    ctx = await press();
    expect((await store.get('b1'))!.pin).toBe(true);
    expect(ctx.answerCbQuery).toHaveBeenCalledWith(expect.stringMatching(/закрепил» останется/), { show_alert: true });
    expect(ctx.editMessageText).toHaveBeenCalledWith(expect.stringMatching(/📌 закрепляются/), expect.anything());
    ctx = await press();
    expect((await store.get('b1'))!.pin).toBeUndefined();
    expect(ctx.answerCbQuery).toHaveBeenCalledWith('📌 Закреп выключен');
  });
});

describe('switching a broadcast on', () => {
  async function setup() {
    const store = await tempStore();
    let next = 1;
    const telegram = {
      sendMessage: vi.fn(async (_chatId: number | string, _text: string, _extra?: unknown) => ({ message_id: next++ })),
      getChatMember: vi.fn(async (_chatId: number | string, _userId: number): Promise<Record<string, unknown>> => ({ status: 'member' })),
      getChat: vi.fn(async (chatId: number | string) => ({ id: chatId, title: 'Из getChat' })),
      editMessageText: vi.fn(async (_chatId: number | string, _id: number, _inline: unknown, _text: string, _extra?: unknown) => true),
    };
    const bot = { telegram, botInfo: { id: 42, username: 'tlmx_bot' }, command: vi.fn(), action: vi.fn() };
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
    bc.register();
    // An admin (id 9) writes /broadcast in the chat's topic: the card's links carry a fresh code.
    const onBroadcast = bot.command.mock.calls.find((c) => c[0] === 'broadcast')![1] as (ctx: unknown) => Promise<void>;
    const reply = vi.fn(async () => ({ message_id: 500 }));
    await onBroadcast({ message: { message_thread_id: 5 }, from: { id: 9 }, reply });
    const markup = (reply.mock.calls[0] as unknown as [string, { reply_markup: { inline_keyboard: Array<Array<{ url?: string }>> } }])[1].reply_markup;
    const groupLink = markup.inline_keyboard.flat().find((b) => b.url?.includes('startgroup'))!.url!;
    const code = /bc_([\w-]+)/.exec(groupLink)![1]!;
    return { store, telegram, bc, code };
  }
  const groupCtx = (from: number, text: string) => ({ chat: { id: -700, type: 'supergroup', title: 'Читалка' }, from: { id: from }, message: { text }, reply: vi.fn(async () => ({})) });

  it('«👥 В группу»: the /start the group gets switches it on, with a hello there, a notice in the topic and a DM', async () => {
    const { store, telegram, bc, code } = await setup();
    expect(await bc.handleChat(groupCtx(9, `/start@tlmx_bot bc_${code}`) as never)).toBe(true);
    expect((await store.forChat('100')).map((b) => [b.targetChatId, b.targetType, b.targetTitle])).toEqual([[-700, 'group', 'Читалка']]);
    expect(telegram.sendMessage.mock.calls.map((c) => c[0])).toEqual([-700, '-1001', 9]);
    expect(telegram.sendMessage.mock.calls[0]![1]).toMatch(/Сюда транслируется чат «Дача»/);
    expect(telegram.sendMessage.mock.calls[1]![1]).toMatch(/Трансляция в «Читалка» включена/);
    expect(telegram.sendMessage.mock.calls[2]![1]).toMatch(/^✅ Готово: чат «Дача» транслируется в «Читалка»/);
  });

  it('«👥 В группу» with admin rights: the join itself switches it on, the card in the topic shows it, a later /start adds nothing', async () => {
    const { store, telegram, bc, code } = await setup();
    telegram.getChatMember.mockResolvedValue({ status: 'administrator', can_pin_messages: true, can_delete_messages: true });
    const join = { chat: { id: -700, type: 'supergroup', title: 'Читалка' }, from: { id: 9 }, myChatMember: { old_chat_member: { status: 'left' }, new_chat_member: { status: 'administrator', can_pin_messages: true } } };
    expect(await bc.handleChat(join as never)).toBe(true);
    // Added with the right to pin: «📌» is on from the start.
    expect((await store.forChat('100')).map((b) => [b.targetChatId, b.targetType, b.targetTitle, b.pin])).toEqual([[-700, 'group', 'Читалка', true]]);
    expect(telegram.sendMessage.mock.calls[0]![1]).toMatch(/и закрепляться/);
    expect(telegram.editMessageText).toHaveBeenCalledWith('-1001', 500, undefined, expect.stringMatching(/👥 Читалка/), expect.anything());
    expect(telegram.sendMessage).toHaveBeenLastCalledWith(9, expect.stringMatching(/^✅ Готово/));
    const sends = telegram.sendMessage.mock.calls.length;
    const start = groupCtx(9, `/start@tlmx_bot bc_${code}`);
    expect(await bc.handleChat(start as never)).toBe(true);
    expect(start.reply).not.toHaveBeenCalled();
    expect(telegram.sendMessage.mock.calls.length).toBe(sends);
    expect(await store.all()).toHaveLength(1);
    // Someone without a card adding the bot somewhere switches nothing on.
    expect(await bc.handleChat({ ...join, chat: { id: -701, type: 'group', title: 'Чужая' }, from: { id: 10 } } as never)).toBe(true);
    expect(await store.all()).toHaveLength(1);
  });

  it("someone else's /start with the code switches nothing on", async () => {
    const { store, bc, code } = await setup();
    const ctx = groupCtx(10, `/start@tlmx_bot bc_${code}`);
    expect(await bc.handleChat(ctx as never)).toBe(true);
    expect(await store.all()).toEqual([]);
    expect(ctx.reply).toHaveBeenCalledWith(expect.stringMatching(/устарела или открыта не тем/));
    expect(await bc.handleChat(groupCtx(9, 'просто сообщение') as never)).toBe(false);
  });

  it('«📢 В канал»: the promotion to admin is matched to the admin who opened the card', async () => {
    const { store, telegram, bc } = await setup();
    const promotion = (from: number, rights: Record<string, unknown>) => ({
      chat: { id: -800, type: 'channel', title: 'Новости' },
      from: { id: from },
      myChatMember: { old_chat_member: { status: 'left' }, new_chat_member: { status: 'administrator', ...rights } },
    });
    expect(await bc.handleChat(promotion(10, { can_post_messages: true }) as never)).toBe(true);
    expect(await store.all()).toEqual([]);
    expect(await bc.handleChat(promotion(9, { can_post_messages: false }) as never)).toBe(true);
    expect(await store.all()).toEqual([]);
    expect(telegram.sendMessage).toHaveBeenLastCalledWith(9, expect.stringMatching(/без права публиковать/));
    expect(await bc.handleChat(promotion(9, { can_post_messages: true }) as never)).toBe(true);
    expect((await store.forChat('100')).map((b) => [b.targetChatId, b.targetType, b.targetTitle])).toEqual([[-800, 'channel', 'Новости']]);
  });
});
