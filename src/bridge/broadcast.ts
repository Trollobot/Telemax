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
  /** An update from a broadcast's place: the «… закрепил» line Telegram adds for the bot's own pin goes away. */
  onTargetUpdate(ctx: Context): Promise<void>;
  /** The DM part of switching one on (deep link, chat picker); true when the update was ours. */
  handlePrivate(ctx: Context): Promise<boolean>;
  /** A group or channel outside the bridge: the bot added there by a card's link (true = ours, nothing else may answer it). */
  handleChat(ctx: Context): Promise<boolean>;
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
  links: AddLinks | undefined,
): { text: string; markup: { inline_keyboard: InlineKeyboardButton[][] } } {
  const day = (ms: number) => new Date(ms).toLocaleDateString('ru-RU', { day: '2-digit', month: '2-digit', timeZone: process.env.TZ || 'Europe/Moscow' });
  const where = (b: Broadcast) => `${b.targetType === 'channel' ? '📢' : '👥'} ${b.targetTitle}`;
  const lines = [`📡 Трансляция чата «${chatTitle}»`];
  if (list.length === 0) {
    lines.push(
      'Новые сообщения этого чата можно копировать в группы и каналы Telegram — для тех, у кого нет MAX. Мест — сколько угодно. История до включения не переносится, а что пишут там — в MAX не уходит.',
    );
  } else {
    lines.push(
      'Новые сообщения копируются сюда:',
      ...list.map((b) => `• ${where(b)} — с ${day(b.since)}${b.pin ? ', 📌 закрепляются' : ''}`),
      '',
      '«📌» — закреплять там каждое новое сообщение, тихо: в группе, где все пишут, их легко найти по закрепам.',
    );
  }
  if (links) {
    lines.push(
      '',
      '«👥 В группу» / «📢 В канал» — Telegram покажет ваши группы или каналы и сам добавит туда бота администратором (публиковать, закреплять). Бот уже там — «🔎 Бот уже там».',
    );
  } else {
    lines.push('', '⚠️ Бот ещё не знает своё имя — повторите /broadcast через минуту.');
  }
  const rows: InlineKeyboardButton[][] = list.map((b) => [
    Markup.button.callback(`⏹ Остановить: ${truncateCodePoints(b.targetTitle, 30, '…')}`, `tlmx_bc:stop:${b.id}`),
    Markup.button.callback(b.pin ? '📌 Закреп: вкл' : '📌 Закреп: выкл', `tlmx_bc:pin:${b.id}`),
  ]);
  if (links) {
    rows.push([Markup.button.url('👥 В группу', links.group), Markup.button.url('📢 В канал', links.channel)]);
    rows.push([Markup.button.url('🔎 Бот уже там', links.pick)]);
  }
  rows.push([Markup.button.callback('◀️ Готово', 'tlmx_panel:dismiss')]);
  return { text: lines.join('\n'), markup: { inline_keyboard: rows } };
}

/** The card's three ways to add a place — all carry the same one-time code (see createBroadcasts). */
export type AddLinks = { group: string; channel: string; pick: string };

/**
 * Telegram's own «add the bot» links: a group gets `/start@bot bc_<code>` (the code says which chat);
 * both make the bot an admin with these rights — pinning for «📌» (a channel pins with
 * edit_messages), deleting for the «… закрепил» line each pin leaves.
 */
export function addLinks(username: string, code: string): AddLinks {
  return {
    group: `https://t.me/${username}?startgroup=bc_${code}&admin=pin_messages+delete_messages`,
    channel: `https://t.me/${username}?startchannel&admin=post_messages+edit_messages+delete_messages`,
    pick: `https://t.me/${username}?start=bc_${code}`,
  };
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
const PINNED_CAP = 200;

/** Telegram refusing the bot a pin for want of rights (not an admin, no «Закрепление сообщений»). */
export function isPinRefusal(err: unknown): boolean {
  const r = (err as { response?: { error_code?: number; description?: string } } | null)?.response;
  return r?.error_code === 403 || /not enough rights|need administrator rights|CHAT_ADMIN_REQUIRED|have no rights/i.test(r?.description ?? '');
}
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

  /** The bot's own pins, `${chatId}:${messageId}` — only their «… закрепил» line is removed (onTargetUpdate). */
  const pinned = new Set<string>();
  /** «📌»: the first copy of a message pinned, silently. No right to pin → the flag goes off and the topic says why, once. */
  async function pinCopy(b: Broadcast, messageId: number): Promise<void> {
    const key = `${b.targetChatId}:${messageId}`;
    if (pinned.size >= PINNED_CAP) pinned.delete(pinned.values().next().value!);
    pinned.add(key);
    try {
      await withFloodRetry(() => bot.telegram.pinChatMessage(b.targetChatId, messageId, { disable_notification: true }));
    } catch (err) {
      pinned.delete(key);
      if (!isPinRefusal(err)) {
        logger.error(`Broadcast ${b.id}: pinning message ${messageId} in ${b.targetChatId} failed`, err);
        return;
      }
      if (!(await store.setPin(b.id, false))) return;
      logger.info(`Broadcast ${b.id}: «📌» off — no right to pin in ${b.targetChatId} (${(err as Error).message})`);
      await notifyTopic(b.maxChatId, `📌 Закреп в «${b.targetTitle}» выключен: у бота там нет права закреплять сообщения. Дайте его и включите «📌» снова — /broadcast.`);
    }
  }
  /** What the bot may do in a place for «📌»: pin (a channel pins with the right to edit) and delete the «закрепил» line. */
  async function pinRights(b: Broadcast): Promise<{ pin: boolean; del: boolean }> {
    const botId = bot.botInfo?.id;
    const m = botId != null ? await bot.telegram.getChatMember(b.targetChatId, botId).catch(() => undefined) : undefined;
    if (m?.status !== 'administrator') return { pin: false, del: false };
    return { pin: b.targetType === 'channel' ? m.can_edit_messages === true : m.can_pin_messages !== false, del: m.can_delete_messages === true };
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
        if (b.pin && ids.length) await pinCopy(b, ids[0]!);
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
        if (b.pin && ids.length) await pinCopy(b, ids[0]!);
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

  // --- Switching one on --------------------------------------------------------------------------
  // The /broadcast card carries three links with one code: Telegram's «add the bot to a group»
  // (the group then gets `/start@bot bc_<code>` — the code names the MAX chat), «add the bot to a
  // channel as admin» (no code travels: the my_chat_member update of that promotion is matched to
  // the admin's latest card), and the DM chat picker for a place the bot is already in. Telegram's
  // picker does NOT add the bot by itself (live 2026-10-13) — hence the add links.
  /** The newest card's code per admin — a channel promotion carries no code, it takes this one. */
  const latestCode = new Map<number, string>();
  function issue(maxChatId: string, requesterId: number): AddLinks | undefined {
    const username = bot.botInfo?.username;
    if (!username) return undefined;
    for (const [code, p] of codes) if (Date.now() - p.at > LINK_TTL_MS) codes.delete(code);
    const code = randomBytes(9).toString('base64url');
    codes.set(code, { maxChatId, requesterId, at: Date.now() });
    latestCode.set(requesterId, code);
    return addLinks(username, code);
  }
  /** A live code of this admin: the one named, or (no code given) their newest. */
  function codeOf(userId: number, code?: string): PickRequest | undefined {
    const p = codes.get(code ?? latestCode.get(userId) ?? '');
    return p && p.requesterId === userId && Date.now() - p.at <= LINK_TTL_MS ? p : undefined;
  }
  async function card(maxChatId: string, requesterId: number) {
    return broadcastCard(await deps.chatTitle(maxChatId), await store.forChat(maxChatId), issue(maxChatId, requesterId));
  }
  const removeKeyboard = { reply_markup: { remove_keyboard: true as const } };
  const botHandle = () => (bot.botInfo?.username ? `@${bot.botInfo.username}` : 'бота');

  /** Can the bot post into `chatId`? A channel needs it as an admin allowed to publish, a group as a member allowed to write. */
  async function canPost(chatId: number, kind: 'group' | 'channel'): Promise<boolean> {
    const botId = bot.botInfo?.id;
    const member = botId != null ? await bot.telegram.getChatMember(chatId, botId).catch(() => undefined) : undefined;
    if (kind === 'channel') return member?.status === 'administrator' && member.can_post_messages === true;
    return member?.status === 'member' || member?.status === 'administrator' || (member?.status === 'restricted' && member.can_send_messages);
  }

  /** Switches the broadcast on (rights checked by the caller): saved, a hello in the place, a notice in the topic. Returns what to tell the admin. */
  async function bind(p: PickRequest, chatId: number, kind: 'group' | 'channel', knownTitle?: string): Promise<string> {
    if (String(chatId) === targetGroupId) return 'Это группа самого моста — выберите другую.';
    if ((await store.forChat(p.maxChatId)).some((b) => b.targetChatId === chatId)) return 'Этот чат уже транслируется туда.';
    const chat = knownTitle ? undefined : await bot.telegram.getChat(chatId).catch(() => undefined);
    const targetTitle = knownTitle ?? (chat && 'title' in chat ? chat.title : undefined) ?? String(chatId);
    const title = await deps.chatTitle(p.maxChatId);
    const now = Date.now();
    await store.add({ id: randomBytes(6).toString('base64url'), maxChatId: p.maxChatId, targetChatId: chatId, targetTitle, targetType: kind, since: now, cursor: now });
    logger.info(`Broadcast on: MAX chat ${p.maxChatId} -> ${kind} ${chatId}`);
    await bot.telegram
      .sendMessage(chatId, `📡 Сюда транслируется чат «${title}» из MAX — новые сообщения будут появляться здесь.`)
      .catch((err) => logger.error('Broadcast hello to the target failed', err));
    await notifyTopic(p.maxChatId, `📡 Трансляция в «${targetTitle}» включена — новые сообщения этого чата копируются туда. Управление — /broadcast.`);
    return `✅ Готово: чат «${title}» транслируется в «${targetTitle}». Остановить — /broadcast в теме чата.`;
  }

  async function handlePrivate(ctx: Context): Promise<boolean> {
    const msg = ctx.message;
    const userId = ctx.from?.id;
    if (!msg || userId == null) return false;

    // «🔎 Бот уже там»: the DM chat picker.
    const start = 'text' in msg ? /^\/start bc_([\w-]+)$/.exec(msg.text) : null;
    if (start) {
      const p = codeOf(userId, start[1]!);
      if (!p) {
        await ctx.reply('Ссылка устарела или открыта не тем администратором — напишите /broadcast в теме чата ещё раз.');
        return true;
      }
      if (!(await deps.isGroupAdmin(userId).catch(() => false))) {
        await ctx.reply('Трансляцию включает только администратор группы моста.');
        return true;
      }
      for (const [id, r] of requests) if (r.requesterId === userId || Date.now() - r.at > LINK_TTL_MS) requests.delete(id);
      const groupReq = randomInt(1, 2 ** 31 - 1);
      const channelReq = randomInt(1, 2 ** 31 - 1);
      requests.set(groupReq, { ...p, at: Date.now(), kind: 'group' });
      requests.set(channelReq, { ...p, at: Date.now(), kind: 'channel' });
      const title = await deps.chatTitle(p.maxChatId);
      await ctx.reply(
        `📡 Куда транслировать чат «${title}»?\n\nНажмите кнопку внизу и выберите группу или канал, где бот уже есть (в канале — администратором с правом публиковать). Если его там нет — вернитесь к /broadcast и нажмите «👥 В группу» или «📢 В канал»: так Telegram добавит его сам.`,
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
      if (!(await canPost(chatId, r.kind))) {
        await ctx.reply(
          r.kind === 'channel'
            ? `Бот не администратор этого канала или ему нельзя публиковать. Проще всего — /broadcast в теме чата → «📢 В канал»: Telegram сам добавит ${botHandle()} администратором.`
            : `Бота нет в этой группе или ему запрещено писать. Проще всего — /broadcast в теме чата → «👥 В группу»: Telegram сам добавит ${botHandle()}.`,
        );
        return true;
      }
      const answer = await bind(r, chatId, r.kind);
      for (const [id, x] of requests) if (x.requesterId === userId) requests.delete(id);
      await ctx.reply(answer, removeKeyboard);
      return true;
    }

    if ('text' in msg && msg.text === CANCEL && [...requests.values()].some((r) => r.requesterId === userId)) {
      for (const [id, r] of requests) if (r.requesterId === userId) requests.delete(id);
      await ctx.reply('Отменено.', removeKeyboard);
      return true;
    }
    return false;
  }

  async function handleChat(ctx: Context): Promise<boolean> {
    const userId = ctx.from?.id;
    const chat = ctx.chat;
    if (!chat || chat.type === 'private') return false;

    // «📢 В канал»: Telegram made the bot an admin there — the promoting admin's newest card says which MAX chat.
    const change = ctx.myChatMember;
    if (change) {
      const now = change.new_chat_member;
      const before = change.old_chat_member.status;
      const promoted = chat.type === 'channel' && now.status === 'administrator' && before !== 'administrator';
      const p = promoted && userId != null ? codeOf(userId) : undefined;
      if (!p || userId == null) return true; // nothing of ours — and never a reply into someone's channel
      if (!(now.status === 'administrator' && now.can_post_messages)) {
        await bot.telegram
          .sendMessage(userId, `Бота добавили в «${chat.title}» без права публиковать сообщения — трансляции туда не будет. Дайте ему это право и нажмите «📢 В канал» ещё раз.`)
          .catch(() => {});
        return true;
      }
      const answer = await bind(p, chat.id, 'channel', chat.title);
      await bot.telegram.sendMessage(userId, answer).catch((err) => logger.error('Broadcast: could not tell the admin in DM', err));
      return true;
    }

    // «👥 В группу»: Telegram added the bot and sent `/start@bot bc_<code>` into the group.
    const text = (ctx.message as { text?: string } | undefined)?.text;
    const start = text ? /^\/start(?:@\w+)? bc_([\w-]+)$/.exec(text) : null;
    if (!start) return false;
    const p = userId != null ? codeOf(userId, start[1]!) : undefined;
    if (!p) {
      await ctx.reply('Ссылка устарела или открыта не тем администратором — напишите /broadcast в теме чата ещё раз.').catch(() => {});
      return true;
    }
    if (!(await canPost(chat.id, 'group'))) {
      await ctx.reply('Боту здесь запрещено писать — разрешите ему отправку сообщений и нажмите «👥 В группу» ещё раз.').catch(() => {});
      return true;
    }
    const answer = await bind(p, chat.id, 'group', 'title' in chat ? chat.title : undefined);
    // The hello already went into the group; the admin gets the outcome in DM (a refusal stays visible there).
    if (!answer.startsWith('✅')) await ctx.reply(answer).catch(() => {});
    await bot.telegram.sendMessage(userId!, answer).catch(() => {});
    return true;
  }

  async function onTargetUpdate(ctx: Context): Promise<void> {
    const msg = (ctx.channelPost ?? ctx.message) as { message_id: number; pinned_message?: { message_id: number } } | undefined;
    const chatId = ctx.chat?.id;
    const pinnedId = msg?.pinned_message?.message_id;
    if (!msg || chatId == null || pinnedId == null) return;
    // Someone else's pin is theirs — only the line of the bot's own goes.
    if (!pinned.delete(`${chatId}:${pinnedId}`)) return;
    await bot.telegram
      .deleteMessage(chatId, msg.message_id)
      .then(() => logger.info(`Broadcast: removed the «pinned» line of message ${pinnedId} in ${chatId}`))
      .catch((err) => logger.info(`Broadcast: the «pinned» line in ${chatId} stays (${(err as Error).message})`));
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

    bot.action(/^tlmx_bc:pin:([\w-]+)$/, async (ctx) => {
      const b = await store.get(ctx.match[1]!);
      if (!b) {
        await ctx.answerCbQuery('Эта трансляция уже остановлена').catch(() => {});
      } else if (b.pin) {
        await store.setPin(b.id, false);
        await ctx.answerCbQuery('📌 Закреп выключен').catch(() => {});
      } else {
        const rights = await pinRights(b);
        if (!rights.pin) {
          const right = b.targetType === 'channel' ? '«Редактирование сообщений»' : '«Закрепление сообщений»';
          await ctx.answerCbQuery(`Чтобы закреплять в «${truncateCodePoints(b.targetTitle, 40, '…')}», бот должен быть там администратором с правом ${right}. Выдайте его и нажмите ещё раз.`, { show_alert: true }).catch(() => {});
        } else {
          await store.setPin(b.id, true);
          logger.info(`Broadcast ${b.id}: «📌» on in ${b.targetChatId}`);
          await ctx
            .answerCbQuery(
              rights.del
                ? '📌 Новые сообщения будут закрепляться'
                : '📌 Включено. Строка «… закрепил» останется в чате: у бота нет права удалять сообщения — дайте его, чтобы её не было.',
              { show_alert: !rights.del },
            )
            .catch(() => {});
        }
      }
      if (!b) return;
      const { text, markup } = await card(b.maxChatId, ctx.from.id);
      await ctx.editMessageText(text, { reply_markup: markup }).catch(() => {});
    });
  }

  return {
    copyIncoming,
    copyOwner,
    copyEdit,
    copyDelete,
    isTarget: (chatId) => store.isTarget(chatId),
    onTargetUpdate,
    handlePrivate,
    handleChat,
    register,
  };
}
