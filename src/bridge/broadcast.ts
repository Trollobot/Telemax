import { randomBytes, randomInt } from 'node:crypto';
import { Markup, type Context, type Telegraf } from 'telegraf';
import type { ChatAdministratorRights, InlineKeyboardButton, Message, MessageEntity } from 'telegraf/types';
import type { Broadcast, BroadcastStore } from '../store/broadcastStore.js';
import { createLogger } from '../logger.js';
import { splitTelegramText, truncateCodePoints, truncateUtf16, TELEGRAM_CAPTION_LIMIT, TELEGRAM_TEXT_LIMIT } from './text.js';
import { withFloodRetry } from './transient.js';

// «Трансляция»: new messages of one MAX chat copied into any number of Telegram groups or channels,
// for people without MAX (asked for via the bug-report bot, 2026-10-12). One-way: what readers
// write there goes nowhere. Text is sent anew (the topic's text is plain — no entities to keep) so
// «🧑 Вы:» can name the owner; attachments are copied from the topic (copyMessage), never re-uploaded.
// Edits and deletions follow while the bridge runs (the copy map is in memory, like the topic's).

const logger = createLogger('broadcast');

/** A MAX message the topic just received, as the broadcast needs it. */
export interface IncomingCopy {
  maxChatId: string;
  maxMessageId: unknown;
  /** MAX time of the message (ms) — compared with each broadcast's cursor. */
  time: number;
  /** The text as the topic shows it («🧑 Вы:» / «👤 Имя:» first); undefined for media only. */
  text?: string;
  /** Topic messages copied as they are: the attachments (not the text pieces, not a lone keyboard). */
  mediaIds: number[];
  /** A reply the topic shows natively — the quoted MAX message and its text. */
  quote?: { maxMessageId: unknown; text: string };
}

export interface BroadcastDeps {
  bot: Telegraf;
  targetGroupId: string;
  store: BroadcastStore;
  /** The MAX chat's name — the card and the notices name it. */
  chatTitle: (maxChatId: string) => Promise<string>;
  /** The MAX chat behind a topic — /broadcast is written in it. */
  chatOfTopic: (topicId: number) => Promise<string | undefined>;
  /** The MAX chat's topic — where «включена / остановлена» notices go. */
  topicOf: (maxChatId: string) => Promise<number | undefined>;
  /** The MAX account owner's name — «🧑 Вы:» means nothing to readers. */
  ownerName: () => Promise<string>;
  isGroupAdmin: (userId: number) => Promise<boolean>;
}

export interface Broadcasts {
  /** A MAX message landed in its topic (live or catch-up). */
  copyIncoming(c: IncomingCopy): void;
  /** The owner wrote in the topic from Telegram and it went to MAX. */
  copyOwner(maxChatId: string, maxMessageId: unknown, time: number, msg: Message, quote?: { maxMessageId: unknown; text: string }, lead?: string): void;
  /** MAX edited a message — `marked` is the topic's new text (edit marker included). */
  copyEdit(maxChatId: string, maxMessageId: unknown, marked: string): void;
  /** MAX deleted a message. */
  copyDelete(maxChatId: string, maxMessageId: unknown): void;
  /** True for a chat that receives a broadcast — the bridge leaves its updates alone. */
  isTarget(chatId: number): Promise<boolean>;
  /** The DM part of switching one on (deep link, chat picker); true when the update was ours. */
  handlePrivate(ctx: Context): Promise<boolean>;
  /** /broadcast and the card's buttons — registered after the bridge's admin gate. */
  register(): void;
}

/** The topic's text for readers: «🧑 Вы:» (the bridge owner) becomes the owner's name, an edit marker in front included. */
export function readerText(text: string, owner: string): string {
  return text.replace(/^(✏️ \(\d{1,2}:\d{2}\) )?🧑 Вы:\n/, (_m, edit: string | undefined) => `${edit ?? ''}🧑 ${owner}:\n`);
}

/** A reply whose quoted message has no copy here: «↩️ В ответ на «…»:» goes under the author line. */
export function withQuote(text: string | undefined, quoted: string): string {
  const snippet = quoted ? `«${truncateCodePoints(quoted, 80, '…')}»` : 'сообщение';
  const line = `↩️ В ответ на ${snippet}:`;
  if (!text) return line;
  const author = /^(?:🧑|👤) [^\n]*:\n/.exec(text);
  return author ? `${author[0]}${line}\n${text.slice(author[0].length)}` : `${line}\n${text}`;
}

/** Entities of a text that got `by` UTF-16 units put in front of it. */
export function shiftEntities(entities: MessageEntity[] | undefined, by: number): MessageEntity[] | undefined {
  return entities?.map((e) => ({ ...e, offset: e.offset + by }));
}

/** Telegram says the bot can't post there any more: kicked, left, demoted, the chat gone. */
export function isGoneError(err: unknown): boolean {
  const r = (err as { response?: { error_code?: number; description?: string } } | null)?.response;
  if (r?.error_code === 403) return true;
  return /chat not found|not enough rights|need administrator rights|CHAT_WRITE_FORBIDDEN|CHAT_ADMIN_REQUIRED|have no rights|bot is not a member|bot was kicked/i.test(r?.description ?? '');
}

/** The /broadcast card for a MAX chat: its broadcasts with «⏹», a deep link to add one. */
export function broadcastCard(
  chatTitle: string,
  list: Broadcast[],
  addLink: string | undefined,
): { text: string; markup: { inline_keyboard: InlineKeyboardButton[][] } } {
  const day = (ms: number) => new Date(ms).toLocaleDateString('ru-RU', { day: '2-digit', month: '2-digit', timeZone: process.env.TZ || 'Europe/Moscow' });
  const where = (b: Broadcast) => `${b.targetType === 'channel' ? '📢' : '👥'} ${b.targetTitle}`;
  const lines = [`📡 Трансляция чата «${chatTitle}»`];
  if (list.length === 0) {
    lines.push(
      'Новые сообщения этого чата можно копировать в группы и каналы Telegram — для тех, у кого нет MAX. Мест — сколько угодно. История до включения не переносится, а что пишут там — в MAX не уходит.',
      '',
      'Нажмите кнопку — откроется личка с ботом, там выберите группу или канал.',
    );
  } else {
    lines.push('Новые сообщения копируются сюда:', ...list.map((b) => `• ${where(b)} — с ${day(b.since)}`));
  }
  if (!addLink) lines.push('', '⚠️ Бот ещё не знает своё имя — повторите /broadcast через минуту.');
  const rows: InlineKeyboardButton[][] = list.map((b) => [Markup.button.callback(`⏹ Остановить: ${truncateCodePoints(b.targetTitle, 40, '…')}`, `tlmx_bc:stop:${b.id}`)]);
  if (addLink) rows.push([Markup.button.url(list.length ? '➕ Ещё группа или канал' : '📡 Выбрать группу или канал', addLink)]);
  rows.push([Markup.button.callback('◀️ Готово', 'tlmx_panel:dismiss')]);
  return { text: lines.join('\n'), markup: { inline_keyboard: rows } };
}

/** What a channel's admin rights must include for the bot (and so for the user who picks it). */
const CHANNEL_RIGHTS: ChatAdministratorRights = {
  is_anonymous: false,
  can_manage_chat: false,
  can_delete_messages: false,
  can_manage_video_chats: false,
  can_restrict_members: false,
  can_promote_members: false,
  can_change_info: false,
  can_invite_users: false,
  can_post_messages: true,
  can_edit_messages: true,
};
const LINK_TTL_MS = 30 * 60_000;
const COPY_MAP_CAP = 1000;
const CANCEL = '✖️ Отмена';

type CopyLink = { broadcastId: string; targetChatId: number; ids: number[]; anchor?: number };
type PickRequest = { maxChatId: string; requesterId: number; at: number };

export function createBroadcasts(deps: BroadcastDeps): Broadcasts {
  const { bot, targetGroupId, store } = deps;
  /** `${maxChatId}:${maxMessageId}` → the copies of that message in every broadcast. */
  const copies = new Map<string, CopyLink[]>();
  /** One chain per broadcast — copies keep the chat's order. */
  const queues = new Map<string, Promise<void>>();
  /** Deep-link codes from /broadcast cards and the picker requests they open in the DM. */
  const codes = new Map<string, PickRequest>();
  const requests = new Map<number, PickRequest & { kind: 'group' | 'channel' }>();

  const keyOf = (maxChatId: string, maxMessageId: unknown) => `${maxChatId}:${String(maxMessageId)}`;
  function remember(key: string, link: CopyLink): void {
    if (!copies.has(key) && copies.size >= COPY_MAP_CAP) {
      const oldest = copies.keys().next().value;
      if (oldest !== undefined) copies.delete(oldest);
    }
    copies.set(key, [...(copies.get(key) ?? []), link]);
  }
  function enqueue(id: string, job: () => Promise<void>): void {
    const run = (queues.get(id) ?? Promise.resolve()).then(job);
    queues.set(id, run.catch(() => undefined));
  }

  async function notifyTopic(maxChatId: string, text: string): Promise<void> {
    const topicId = await deps.topicOf(maxChatId);
    if (topicId == null) return;
    await bot.telegram.sendMessage(targetGroupId, text, { message_thread_id: topicId }).catch((err) => logger.error('Broadcast notice to the topic failed', err));
  }

  /** A send into the broadcast failed: gone → the broadcast stops and the topic says why; anything else is logged. */
  async function failed(b: Broadcast, err: unknown, what: string): Promise<void> {
    if (!isGoneError(err)) {
      logger.error(`Broadcast ${b.id} (MAX chat ${b.maxChatId} -> ${b.targetChatId}): ${what} failed`, err);
      return;
    }
    if (!(await store.remove(b.id))) return;
    logger.info(`Broadcast ${b.id} stopped: Telegram refuses posts to ${b.targetChatId} (${(err as Error).message})`);
    await notifyTopic(
      b.maxChatId,
      `⏹ Трансляция в «${b.targetTitle}» остановлена: бота убрали ${b.targetType === 'channel' ? 'из канала или лишили права публиковать' : 'из группы или запретили ему писать'}. Включить снова — /broadcast.`,
    );
  }

  /** Runs `send` for every broadcast of the chat that hasn't seen `time` yet, in that broadcast's order. */
  async function fanOut(maxChatId: string, time: number, what: string, send: (b: Broadcast) => Promise<void>): Promise<void> {
    if (!Number.isFinite(time)) time = Date.now(); // a cursor must never become NaN
    for (const b of await store.forChat(maxChatId)) {
      if (time <= b.cursor) continue;
      enqueue(b.id, async () => {
        const fresh = await store.get(b.id);
        if (!fresh || time <= fresh.cursor) return; // stopped, or a catch-up already copied it
        try {
          await send(fresh);
        } catch (err) {
          await failed(fresh, err, what);
        }
        await store.advance(fresh.id, time);
      });
    }
  }

  /** Reply target in this broadcast for a quoted MAX message — its copy's anchor, if it was copied. */
  function replyTo(b: Broadcast, maxChatId: string, quote?: { maxMessageId: unknown }): number | undefined {
    if (!quote) return undefined;
    const link = copies.get(keyOf(maxChatId, quote.maxMessageId))?.find((l) => l.broadcastId === b.id);
    return link ? (link.anchor ?? link.ids[0]) : undefined;
  }
  const replyExtra = (id: number | undefined) => (id ? { reply_parameters: { message_id: id, allow_sending_without_reply: true } } : {});

  function copyIncoming(c: IncomingCopy): void {
    void fanOut(c.maxChatId, c.time, `copy of MAX message ${String(c.maxMessageId)}`, async (b) => {
      const ids: number[] = [];
      let anchor: number | undefined;
      try {
        let text = c.text != null ? readerText(c.text, await deps.ownerName()) : undefined;
        const reply = replyTo(b, c.maxChatId, c.quote);
        if (c.quote && !reply) text = withQuote(text, c.quote.text);
        if (text?.trim()) {
          for (const [i, piece] of splitTelegramText(text).entries()) {
            const m = await withFloodRetry(() => bot.telegram.sendMessage(b.targetChatId, piece, i === 0 ? replyExtra(reply) : {}));
            ids.push(m.message_id);
            anchor ??= m.message_id;
          }
        }
        for (const id of c.mediaIds) {
          const m = await withFloodRetry(() => bot.telegram.copyMessage(b.targetChatId, targetGroupId, id, ids.length === 0 ? replyExtra(reply) : {}));
          ids.push(m.message_id);
        }
      } finally {
        if (ids.length) remember(keyOf(c.maxChatId, c.maxMessageId), { broadcastId: b.id, targetChatId: b.targetChatId, ids, anchor });
      }
    });
  }

  /** `lead`: a line under the name — «↩️ Переслано от …» for a forward (a copy carries no forward header). */
  function copyOwner(maxChatId: string, maxMessageId: unknown, time: number, msg: Message, quote?: { maxMessageId: unknown; text: string }, lead?: string): void {
    void fanOut(maxChatId, time, `copy of the owner's message ${String(maxMessageId)}`, async (b) => {
      const ids: number[] = [];
      let anchor: number | undefined;
      try {
        let prefix = `🧑 ${await deps.ownerName()}:\n${lead ? `${lead}\n` : ''}`;
        const reply = replyTo(b, maxChatId, quote);
        if (quote && !reply) prefix = withQuote(prefix, quote.text);
        const send = async (text: string, extra: object = {}) => {
          const m = await withFloodRetry(() => bot.telegram.sendMessage(b.targetChatId, text, { ...(ids.length === 0 ? replyExtra(reply) : {}), ...extra }));
          ids.push(m.message_id);
          anchor ??= m.message_id;
        };
        const copy = async (extra: object = {}) => {
          const m = await withFloodRetry(() => bot.telegram.copyMessage(b.targetChatId, targetGroupId, msg.message_id, { ...(ids.length === 0 ? replyExtra(reply) : {}), ...extra }));
          ids.push(m.message_id);
          anchor ??= m.message_id;
        };
        if ('text' in msg) {
          const full = prefix + msg.text;
          if (full.length <= TELEGRAM_TEXT_LIMIT) await send(full, { entities: shiftEntities(msg.entities, prefix.length) });
          else {
            await send(prefix.trimEnd());
            await copy();
          }
        } else if ('poll' in msg) {
          // A copied poll would collect votes MAX never sees — readers get it as text.
          await send(`${prefix}📊 ${msg.poll.question}\n${msg.poll.options.map((o) => `• ${o.text}`).join('\n')}`);
        } else if ('photo' in msg || 'video' in msg || 'document' in msg || 'audio' in msg || 'animation' in msg || 'voice' in msg) {
          const own = 'caption' in msg ? (msg.caption ?? '') : '';
          const entities = 'caption_entities' in msg ? msg.caption_entities : undefined;
          if ((prefix + own).length <= TELEGRAM_CAPTION_LIMIT) await copy({ caption: prefix + own, caption_entities: shiftEntities(entities, prefix.length) });
          else {
            await send(prefix.trimEnd());
            await copy();
          }
        } else {
          // Sticker, video note, location, contact — no caption: the name goes first.
          await send(prefix.trimEnd());
          await copy();
        }
      } finally {
        if (ids.length) remember(keyOf(maxChatId, maxMessageId), { broadcastId: b.id, targetChatId: b.targetChatId, ids, anchor });
      }
    });
  }

  function copyEdit(maxChatId: string, maxMessageId: unknown, marked: string): void {
    for (const link of copies.get(keyOf(maxChatId, maxMessageId)) ?? []) {
      if (link.anchor == null) continue;
      enqueue(link.broadcastId, async () => {
        let text = readerText(marked, await deps.ownerName());
        if (text.length > TELEGRAM_TEXT_LIMIT) text = `${truncateUtf16(text, TELEGRAM_TEXT_LIMIT - 1)}…`;
        await bot.telegram.editMessageText(link.targetChatId, link.anchor, undefined, text).catch((err) => {
          if (!/not modified/i.test((err as Error).message)) logger.error(`Broadcast ${link.broadcastId}: edit of MAX message ${String(maxMessageId)} failed`, err);
        });
      });
    }
  }

  function copyDelete(maxChatId: string, maxMessageId: unknown): void {
    const key = keyOf(maxChatId, maxMessageId);
    for (const link of copies.get(key) ?? []) {
      enqueue(link.broadcastId, async () => {
        await bot.telegram.deleteMessages(link.targetChatId, link.ids).catch((err) => logger.error(`Broadcast ${link.broadcastId}: deletion of MAX message ${String(maxMessageId)} failed`, err));
      });
    }
    copies.delete(key);
  }

  // --- Switching one on: /broadcast card → deep link → the DM's chat picker ----------------------
  function deepLink(maxChatId: string, requesterId: number): string | undefined {
    const username = bot.botInfo?.username;
    if (!username) return undefined;
    for (const [code, p] of codes) if (Date.now() - p.at > LINK_TTL_MS) codes.delete(code);
    const code = randomBytes(9).toString('base64url');
    codes.set(code, { maxChatId, requesterId, at: Date.now() });
    return `https://t.me/${username}?start=bc_${code}`;
  }
  async function card(maxChatId: string, requesterId: number) {
    return broadcastCard(await deps.chatTitle(maxChatId), await store.forChat(maxChatId), deepLink(maxChatId, requesterId));
  }
  const removeKeyboard = { reply_markup: { remove_keyboard: true as const } };

  async function handlePrivate(ctx: Context): Promise<boolean> {
    const msg = ctx.message;
    const userId = ctx.from?.id;
    if (!msg || userId == null) return false;

    const start = 'text' in msg ? /^\/start bc_([\w-]+)$/.exec(msg.text) : null;
    if (start) {
      const p = codes.get(start[1]!);
      if (!p || Date.now() - p.at > LINK_TTL_MS) {
        await ctx.reply('Ссылка устарела — напишите /broadcast в теме чата ещё раз.');
        return true;
      }
      if (p.requesterId !== userId || !(await deps.isGroupAdmin(userId).catch(() => false))) {
        await ctx.reply('Эта ссылка открывает трансляцию только тому администратору, который её запросил.');
        return true;
      }
      for (const [id, r] of requests) if (r.requesterId === userId || Date.now() - r.at > LINK_TTL_MS) requests.delete(id);
      const groupReq = randomInt(1, 2 ** 31 - 1);
      const channelReq = randomInt(1, 2 ** 31 - 1);
      requests.set(groupReq, { ...p, at: Date.now(), kind: 'group' });
      requests.set(channelReq, { ...p, at: Date.now(), kind: 'channel' });
      const title = await deps.chatTitle(p.maxChatId);
      await ctx.reply(
        `📡 Куда транслировать чат «${title}»?\n\nНажмите кнопку внизу и выберите группу или канал из своих. Бот должен там быть: для канала — администратором с правом публиковать, Telegram предложит добавить его сам.`,
        Markup.keyboard([
          [Markup.button.groupRequest('👥 Выбрать группу', groupReq, { bot_is_member: true })],
          [Markup.button.channelRequest('📢 Выбрать канал', channelReq, { bot_administrator_rights: CHANNEL_RIGHTS, user_administrator_rights: CHANNEL_RIGHTS })],
          [CANCEL],
        ])
          .resize()
          .oneTime(),
      );
      return true;
    }

    if ('chat_shared' in msg) {
      const r = requests.get(msg.chat_shared.request_id);
      if (!r || r.requesterId !== userId) {
        await ctx.reply('Этот выбор устарел — напишите /broadcast в теме чата ещё раз.', removeKeyboard);
        return true;
      }
      const chatId = msg.chat_shared.chat_id;
      const botId = bot.botInfo?.id;
      const member = botId != null ? await bot.telegram.getChatMember(chatId, botId).catch(() => undefined) : undefined;
      const canPost =
        r.kind === 'channel'
          ? member?.status === 'creator' || (member?.status === 'administrator' && member.can_post_messages === true)
          : member?.status === 'member' || member?.status === 'administrator' || member?.status === 'creator' || (member?.status === 'restricted' && member.can_send_messages);
      if (!canPost) {
        const who = bot.botInfo?.username ? `@${bot.botInfo.username}` : 'бота';
        await ctx.reply(
          r.kind === 'channel'
            ? `Бот не администратор этого канала или ему нельзя публиковать. Добавьте ${who} в администраторы канала с правом «Публикация сообщений» и выберите канал ещё раз.`
            : `Бота нет в этой группе или ему запрещено писать. Добавьте ${who} в группу и выберите её ещё раз.`,
        );
        return true;
      }
      if (String(chatId) === targetGroupId) {
        await ctx.reply('Это группа самого моста — выберите другую.');
        return true;
      }
      if ((await store.forChat(r.maxChatId)).some((b) => b.targetChatId === chatId)) {
        await ctx.reply('Этот чат уже транслируется туда.', removeKeyboard);
        return true;
      }
      const chat = await bot.telegram.getChat(chatId).catch(() => undefined);
      const targetTitle = (chat && 'title' in chat ? chat.title : undefined) ?? String(chatId);
      const title = await deps.chatTitle(r.maxChatId);
      const now = Date.now();
      await store.add({ id: randomBytes(6).toString('base64url'), maxChatId: r.maxChatId, targetChatId: chatId, targetTitle, targetType: r.kind, since: now, cursor: now });
      for (const [id, x] of requests) if (x.requesterId === userId) requests.delete(id);
      logger.info(`Broadcast on: MAX chat ${r.maxChatId} -> ${r.kind} ${chatId}`);
      await bot.telegram
        .sendMessage(chatId, `📡 Сюда транслируется чат «${title}» из MAX — новые сообщения будут появляться здесь.`)
        .catch((err) => logger.error('Broadcast hello to the target failed', err));
      await notifyTopic(r.maxChatId, `📡 Трансляция в «${targetTitle}» включена — новые сообщения этого чата копируются туда. Управление — /broadcast.`);
      await ctx.reply(`✅ Готово: чат «${title}» транслируется в «${targetTitle}». Остановить — /broadcast в теме чата.`, removeKeyboard);
      return true;
    }

    if ('text' in msg && msg.text === CANCEL && [...requests.values()].some((r) => r.requesterId === userId)) {
      for (const [id, r] of requests) if (r.requesterId === userId) requests.delete(id);
      await ctx.reply('Отменено.', removeKeyboard);
      return true;
    }
    return false;
  }

  function register(): void {
    bot.command('broadcast', async (ctx) => {
      const topicId = ctx.message.message_thread_id;
      const userId = ctx.from?.id;
      const maxChatId = topicId != null ? await deps.chatOfTopic(topicId) : undefined;
      if (!maxChatId || userId == null) {
        await ctx.reply('Напишите /broadcast в теме того чата MAX, который нужно транслировать.').catch(() => {});
        return;
      }
      const { text, markup } = await card(maxChatId, userId);
      await ctx.reply(text, { message_thread_id: topicId, reply_markup: markup });
    });

    bot.action(/^tlmx_bc:stop:([\w-]+)$/, async (ctx) => {
      const gone = await store.remove(ctx.match[1]!);
      await ctx.answerCbQuery(gone ? 'Трансляция остановлена' : 'Уже остановлена').catch(() => {});
      if (gone) {
        logger.info(`Broadcast off: MAX chat ${gone.maxChatId} -> ${gone.targetChatId}`);
        await bot.telegram.sendMessage(gone.targetChatId, '⏹ Трансляция остановлена.').catch(() => {});
      }
      const topicId = (ctx.callbackQuery.message as { message_thread_id?: number } | undefined)?.message_thread_id;
      const maxChatId = gone?.maxChatId ?? (topicId != null ? await deps.chatOfTopic(topicId) : undefined);
      if (!maxChatId) return;
      const { text, markup } = await card(maxChatId, ctx.from.id);
      await ctx.editMessageText(text, { reply_markup: markup }).catch(() => {});
    });
  }

  return {
    copyIncoming,
    copyOwner,
    copyEdit,
    copyDelete,
    isTarget: (chatId) => store.isTarget(chatId),
    handlePrivate,
    register,
  };
}
