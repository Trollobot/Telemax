import path from 'node:path';
import { writeFile } from 'node:fs/promises';
import { Markup, type Telegraf } from 'telegraf';
import type { ChatAction, TelegramEmoji } from 'telegraf/types';
import type { MaxClient, MaxMessageEvent, MaxHistoryMessage } from '../max/client.js';
import { OPCODES, formatOpcode } from '../max/opcodes.js';
import { resolveContactDisplayName, type ContactProfile } from '../max/names.js';
import type { ChatMapStore } from '../store/chatMapStore.js';
import { ensureTopicForMaxChat } from '../telegram/bot.js';
import { downloadMaxAttachment, describeAttachment, type MaxAttachment, type DownloadContext } from './attachments.js';
import { uploadTelegramAttachmentToMax } from './upload.js';
import { checkVersion, shortSha, type VersionStatus } from './version.js';
import { createLogger, jsonStringify } from '../logger.js';

const logger = createLogger('bridge');

/** Matches the exact VCARD 2.1 shape MAX itself sends for a self-contained CONTACT attach. */
function buildVcard(firstName: string, lastName: string, phone: string): string {
  const fullName = [firstName, lastName].filter(Boolean).join(' ');
  return `BEGIN:VCARD\r\nVERSION:2.1\r\nN:${lastName};${firstName};;;\r\nFN:${fullName}\r\nTEL;CELL:${phone}\r\nEND:VCARD\r\n`;
}

/**
 * Telegram's own forward metadata (Bot API 7.0+ `forward_origin`, replacing the
 * older forward_from/forward_from_chat fields) — present on any message dragged in
 * from elsewhere in Telegram, whether or not it ever touched MAX. Used to prefix a
 * "↩️ Переслано..." label on the regular relay path (bot.on('message') below)
 * instead of needing a dedicated /fwd command: a plain drag-forward into a topic
 * already relays its content just fine (same code path as any other message), this
 * only adds the label. Replaces /fwd entirely per explicit user direction 2026-08-13.
 */
type TelegramForwardOrigin =
  | { type: 'user'; sender_user: { first_name: string; last_name?: string; username?: string } }
  | { type: 'hidden_user'; sender_user_name: string }
  | { type: 'chat'; sender_chat: { title?: string } }
  | { type: 'channel'; chat: { title?: string } };

function describeForwardOrigin(origin: TelegramForwardOrigin | undefined): string | null {
  if (!origin) return null;
  switch (origin.type) {
    case 'user': {
      const name = [origin.sender_user.first_name, origin.sender_user.last_name].filter(Boolean).join(' ') || origin.sender_user.username;
      return `↩️ Переслано от ${name || 'кого-то'}:`;
    }
    case 'hidden_user':
      return `↩️ Переслано от ${origin.sender_user_name}:`;
    case 'chat':
      return `↩️ Переслано из «${origin.sender_chat.title || 'чата'}»:`;
    case 'channel':
      return `↩️ Переслано из «${origin.chat.title || 'канала'}»:`;
    default:
      return null;
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Telegram's flood-control 429 carries how long to wait — honor it instead of failing the send. */
async function withFloodRetry<T>(fn: () => Promise<T>): Promise<T> {
  for (;;) {
    try {
      return await fn();
    } catch (err) {
      const retryAfter = (err as { response?: { parameters?: { retry_after?: number } } })?.response?.parameters?.retry_after;
      if (!retryAfter) throw err;
      logger.info(`Telegram flood control: waiting ${retryAfter}s`);
      await sleep((retryAfter + 1) * 1000);
    }
  }
}

interface MaxPushPayload {
  chatId?: unknown; // may be a plain number, BigInt, or (large/negative — e.g. channels) only representable as BigInt
  message?: {
    id?: unknown; // BigInt — needed for FILE_DOWNLOAD
    cid?: number;
    text?: string;
    sender?: unknown;
    attaches?: MaxAttachment[];
    // PUSH_MESSAGE (0x0080) is the single channel for new/edited/deleted messages
    // alike — a repeat push carrying the same message.id is either an edit
    // (status: "EDITED") or a deletion (status: "REMOVED"); undefined/absent means
    // a genuinely new message. Confirmed by the user's own protocol docs
    // 2026-08-13 — NOTIF_MSG_DELETE (the opcode this bridge originally assumed
    // deletions would use) apparently isn't how MAX actually signals this.
    status?: string;
    // Present when this message IS a forward someone sent us — the wrapper message's own
    // text/attaches are empty; the real content lives in link.message. Confirmed live 2026-08-13.
    // `link.message.id` + `link.chatId` (the ORIGINAL message/chat, not the wrapper's own)
    // are needed for FILE_DOWNLOAD/VIDEO_PLAY — those opcodes validate the attachment's
    // fileId/videoId against the message+chat it was actually uploaded in, so passing the
    // wrapper's own id/chatId gets rejected and silently drops the attachment.
    link?: { type?: string; message?: { id?: unknown; text?: string; sender?: unknown; attaches?: MaxAttachment[] }; chatId?: unknown };
  };
}

interface MaxTypingPayload {
  chatId?: unknown;
  type?: string;
}

// Only STICKER and PHOTO have been observed live; the rest are a reasonable guess
// at what MAX would use for other attachment types, same spirit as the FILE
// download fallback in attachments.ts — falls back to plain 'typing' if unknown.
const TYPING_TYPE_TO_CHAT_ACTION: Record<string, ChatAction> = {
  TEXT: 'typing',
  STICKER: 'choose_sticker',
  PHOTO: 'upload_photo',
  VIDEO: 'upload_video',
  VIDEO_NOTE: 'record_video_note',
  VOICE: 'record_voice',
  AUDIO: 'upload_voice',
  FILE: 'upload_document',
};

interface MessageLink {
  maxChatId: unknown;
  maxMessageId: unknown; // BigInt
  telegramMessageId: number;
  // A forward with an attachment produces TWO Telegram messages (the "↩️ Переслано
  // из..." prefix, then the attachment) from a SINGLE MAX message — without this,
  // deleting that MAX message only knew to delete the prefix, leaving the
  // attachment orphaned. Confirmed live 2026-08-13.
  extraTelegramMessageIds?: number[];
}

/** Bidirectional, bounded MAX messageId <-> Telegram message_id correlation — needed for edit/react to know which message on the other side to touch. In-memory only: lost on restart, same trade-off as the rest of this bridge's runtime state. */
export class MessageLinkStore {
  private readonly byMax = new Map<string, MessageLink>();
  private readonly byTelegram = new Map<number, MessageLink>();
  private readonly order: string[] = [];
  constructor(private readonly capacity = 500) {}

  private key(maxChatId: unknown, maxMessageId: unknown): string {
    return `${String(maxChatId)}:${String(maxMessageId)}`;
  }

  add(link: MessageLink): void {
    if (link.maxMessageId == null) return;
    const key = this.key(link.maxChatId, link.maxMessageId);
    this.byMax.set(key, link);
    this.byTelegram.set(link.telegramMessageId, link);
    for (const extraId of link.extraTelegramMessageIds ?? []) {
      this.byTelegram.set(extraId, link);
    }
    this.order.push(key);
    if (this.order.length > this.capacity) {
      const oldestKey = this.order.shift();
      const old = oldestKey ? this.byMax.get(oldestKey) : undefined;
      if (oldestKey) this.byMax.delete(oldestKey);
      if (old) {
        this.byTelegram.delete(old.telegramMessageId);
        for (const extraId of old.extraTelegramMessageIds ?? []) this.byTelegram.delete(extraId);
      }
    }
  }

  getByMax(maxChatId: unknown, maxMessageId: unknown): MessageLink | undefined {
    return this.byMax.get(this.key(maxChatId, maxMessageId));
  }

  getByTelegram(telegramMessageId: number): MessageLink | undefined {
    return this.byTelegram.get(telegramMessageId);
  }

  /** Wipes every link — used by /reboot to force a full from-scratch resync. */
  clear(): void {
    this.byMax.clear();
    this.byTelegram.clear();
    this.order.length = 0;
  }
}

interface PollLink {
  maxChatId: unknown;
  maxMessageId: unknown;
  maxPollId: unknown;
  /** Telegram poll option index -> MAX's own assigned answerId (server-assigned on creation, order-preserving). */
  answerIdByOptionIndex: number[];
}

/** Maps a Telegram poll (by its `poll.id`) back to the MAX poll it mirrors, so poll_answer updates know what to vote on. Bounded/in-memory, same trade-off as MessageLinkStore. */
class PollLinkStore {
  private readonly byTelegramPollId = new Map<string, PollLink>();
  private readonly order: string[] = [];
  constructor(private readonly capacity = 200) {}

  add(telegramPollId: string, link: PollLink): void {
    this.byTelegramPollId.set(telegramPollId, link);
    this.order.push(telegramPollId);
    if (this.order.length > this.capacity) {
      const oldest = this.order.shift();
      if (oldest) this.byTelegramPollId.delete(oldest);
    }
  }

  getByTelegramPollId(telegramPollId: string): PollLink | undefined {
    return this.byTelegramPollId.get(telegramPollId);
  }

  /** Wipes every link — used by /reboot to force a full from-scratch resync. */
  clear(): void {
    this.byTelegramPollId.clear();
    this.order.length = 0;
  }
}

/** Bounded recent-cid set so a handful of our own outgoing messages don't get re-forwarded when MAX echoes them back as pushes. */
class RecentCids {
  private readonly ids: number[] = [];
  private readonly set = new Set<number>();
  constructor(private readonly capacity = 200) {}

  remember(cid: number): void {
    if (this.set.has(cid)) return;
    this.ids.push(cid);
    this.set.add(cid);
    if (this.ids.length > this.capacity) {
      const oldest = this.ids.shift();
      if (oldest !== undefined) this.set.delete(oldest);
    }
  }

  has(cid: number): boolean {
    return this.set.has(cid);
  }
}

/** Returns the first sent Telegram message_id — one MAX message can carry several attaches, but we only need one anchor to link for edit/react. */
async function sendAttachments(
  bot: Telegraf,
  groupId: string,
  topicId: number,
  attaches: MaxAttachment[],
  downloadCtx: DownloadContext,
): Promise<number | undefined> {
  let firstMessageId: number | undefined;
  for (const att of attaches) {
    let sent;
    if (att._type === 'LOCATION' && att.latitude != null && att.longitude != null) {
      sent = await bot.telegram.sendLocation(groupId, att.latitude, att.longitude, { message_thread_id: topicId });
      firstMessageId ??= sent.message_id;
      continue;
    }
    if (att._type === 'CONTACT') {
      // Two distinct shapes seen live: a self-contained vCard-style card (`phone` right
      // on the attach) and a reference to an existing MAX user (`contactId`, no phone —
      // needs its own CONTACT_INFO lookup). sendContact requires a real number either
      // way, so fall back to plain text (naming the contact) if neither yields one
      // rather than fabricating a placeholder phone.
      const displayName = [att.firstName, att.lastName].filter(Boolean).join(' ') || att.name || 'Контакт';
      let phone = att.phone;
      if (phone == null) {
        const contactId = Number(att.contactId);
        if (!Number.isNaN(contactId)) {
          try {
            const contacts = await downloadCtx.max.getContactInfo([contactId]);
            phone = (contacts[0] as { phone?: unknown } | undefined)?.phone;
          } catch (err) {
            logger.error(`Failed to fetch CONTACT_INFO for shared contact ${contactId}`, err);
          }
        }
      }
      sent =
        phone != null
          ? await bot.telegram.sendContact(groupId, `+${String(phone)}`, displayName, { message_thread_id: topicId })
          : await bot.telegram.sendMessage(groupId, `👤 Контакт: ${displayName}`, { message_thread_id: topicId });
      firstMessageId ??= sent.message_id;
      continue;
    }
    const downloaded = await downloadMaxAttachment(att, downloadCtx);
    if (!downloaded) {
      sent = await bot.telegram.sendMessage(groupId, describeAttachment(att), { message_thread_id: topicId });
    } else {
      const source = { source: downloaded.buffer, filename: downloaded.filename };
      if (downloaded.kind === 'photo') {
        sent = await bot.telegram.sendPhoto(groupId, source, { message_thread_id: topicId });
      } else if (downloaded.kind === 'video') {
        sent = await bot.telegram.sendVideo(groupId, source, { message_thread_id: topicId });
      } else if (downloaded.kind === 'video_note') {
        try {
          // sendVideoNote is the only way Telegram renders the round "circle" bubble —
          // sendVideo would show the same file as a regular rectangular player instead.
          sent = await bot.telegram.sendVideoNote(groupId, source, { message_thread_id: topicId });
        } catch (err) {
          logger.error('sendVideoNote failed, falling back to sendVideo', err);
          sent = await bot.telegram.sendVideo(groupId, source, { message_thread_id: topicId });
        }
      } else if (downloaded.kind === 'voice') {
        try {
          // Telegram's voice bubble is picky about codec (wants OGG/OPUS) — MAX's actual
          // encoding is unconfirmed, so fall back to a regular playable audio file rather
          // than losing the message if sendVoice rejects the format.
          sent = await bot.telegram.sendVoice(groupId, source, { message_thread_id: topicId });
        } catch (err) {
          logger.error('sendVoice failed, falling back to sendAudio', err);
          sent = await bot.telegram.sendAudio(groupId, source, { message_thread_id: topicId });
        }
      } else if (downloaded.kind === 'sticker') {
        try {
          sent = await bot.telegram.sendSticker(groupId, source, { message_thread_id: topicId });
        } catch (err) {
          logger.error('sendSticker failed, falling back to sendDocument', err);
          sent = await bot.telegram.sendDocument(groupId, source, { message_thread_id: topicId });
        }
      } else {
        sent = await bot.telegram.sendDocument(groupId, source, { message_thread_id: topicId });
      }
    }
    firstMessageId ??= sent.message_id;
  }
  return firstMessageId;
}

const HISTORY_BATCH_SIZE = 100;
// Safety valve, not an expected ceiling — user's own numbers put 10k messages at
// ~1min of MAX-side fetching; this just stops a pagination bug from looping forever.
const HISTORY_MAX_BATCHES = 2000;
// Telegram's per-chat flood limit is roughly 1 msg/sec — this backfill can dump
// thousands of messages into one chat, so it paces itself instead of relying on
// withFloodRetry alone (retrying after every 429 would still get flagged as abuse).
const HISTORY_SEND_DELAY_MS = 1100;

/**
 * Walks CHAT_HISTORY backward from "now" until it runs dry, deduping by message
 * id (batches can re-include the boundary message) and returning everything in
 * chronological (oldest-first) order, ready to replay into Telegram.
 */
/**
 * `sinceTime`: when set, only messages strictly newer are returned, and pagination
 * stops as soon as a batch's oldest message is already at/before it — turns this
 * from "walk the whole chat" into a cheap "what's new since last time" call, used
 * on every reconnect to catch up on messages missed during the disconnected gap
 * (a live push arriving while we're between TCP sessions is otherwise lost forever —
 * hit live 2026-08-12, a message sent mid-redeploy never reached Telegram).
 */
async function fetchFullHistory(max: MaxClient, chatId: unknown, sinceTime: number | null = null): Promise<MaxHistoryMessage[]> {
  const all: MaxHistoryMessage[] = [];
  const seenIds = new Set<string>();
  let fromTime = Date.now();
  for (let i = 0; i < HISTORY_MAX_BATCHES; i++) {
    const batch = await max.getChatHistory(chatId, fromTime, HISTORY_BATCH_SIZE);
    if (batch.length === 0) break;
    let oldestTime = fromTime;
    for (const m of batch) {
      const key = String(m.id);
      if (seenIds.has(key)) continue;
      seenIds.add(key);
      // `time` arrives as BigInt for the same reason `from` has to be sent as one —
      // normalize to Number right away (safe: ms timestamps are far under
      // Number.MAX_SAFE_INTEGER) so every later comparison/sort/arithmetic on it
      // stays plain-number instead of throwing on a stray BigInt (hit live 2026-08-08).
      const time = Number(m.time);
      if (time < oldestTime) oldestTime = time;
      if (sinceTime == null || time > sinceTime) all.push({ ...m, time });
    }
    // Stop once this batch's oldest message is already at/before the cursor —
    // everything further back was already delivered in a previous run.
    if (sinceTime != null && oldestTime <= sinceTime) break;
    // Either the server stopped returning anything new, or `from` isn't moving
    // (would loop forever) — both mean we've reached the start of the chat.
    if (!(oldestTime < fromTime)) break;
    fromTime = oldestTime;
  }
  all.sort((a, b) => a.time - b.time);
  return all;
}

/**
 * Replays fetched history into a freshly-created topic, oldest-first, pacing
 * sends to stay under Telegram's flood limit. Advances a persisted cursor
 * after every message (sent or not) so a restart mid-backfill — a crash, a
 * redeploy, or just a reconnect during a long flood-control wait — resumes
 * after the last one touched instead of replaying the whole chat and
 * duplicating everything already delivered (hit as a near-miss 2026-08-09).
 */
/**
 * Unwraps a forward's real content (link.message) with a "↩️ Переслано из..." prefix —
 * a forward's own text/attaches are empty, so without this it's silently dropped by
 * the `!text && attaches.length === 0` check below. Simpler cousin of handleMaxPush's
 * own inline version (no contactProfiles cache — backfill/catch-up runs infrequently
 * enough that a fresh CONTACT_INFO lookup per forward is fine).
 */
async function resolveForwardContent(
  max: MaxClient,
  chats: unknown[],
  link: MaxHistoryMessage['link'],
): Promise<{ text: string; attaches: MaxAttachment[]; sourceChatId: unknown; sourceMessageId: unknown } | null> {
  if (link?.type !== 'FORWARD') return null;
  const original = link.message;
  const attaches = Array.isArray(original?.attaches) ? (original.attaches as MaxAttachment[]) : [];
  const senderId = typeof original?.sender === 'number' ? original.sender : Number(original?.sender);
  let senderName = Number.isNaN(senderId) ? 'неизвестно' : `MAX ID ${senderId}`;
  if (!Number.isNaN(senderId)) {
    try {
      const contacts = await max.getContactInfo([senderId]);
      if (contacts[0]) senderName = resolveContactDisplayName(senderId, contacts[0]);
    } catch (err) {
      logger.error(`Failed to fetch CONTACT_INFO for forward sender ${senderId}`, err);
    }
  }
  const sourceChat = chats.find((c) => c && typeof c === 'object' && String((c as { id?: unknown }).id) === String(link.chatId)) as
    | { title?: string }
    | undefined;
  const sourceLabel = sourceChat?.title || `MAX chat ${String(link.chatId)}`;
  const prefix = `↩️ Переслано из «${sourceLabel}» (от ${senderName}):`;
  return {
    text: original?.text ? `${prefix}\n${original.text}` : prefix,
    attaches,
    // Attachments were uploaded against the ORIGINAL message/chat, not the wrapper —
    // FILE_DOWNLOAD/VIDEO_PLAY need those ids or they reject the request and the
    // attachment silently drops (hit live 2026-08-13).
    sourceChatId: link.chatId,
    sourceMessageId: original?.id,
  };
}

async function backfillHistoryToTelegram(
  bot: Telegraf,
  groupId: string,
  topicId: number,
  messages: MaxHistoryMessage[],
  max: MaxClient,
  maxChatId: unknown,
  messageLinks: MessageLinkStore,
  chatMapStore: ChatMapStore,
  chats: unknown[],
): Promise<void> {
  for (const msg of messages) {
    const forwarded = await resolveForwardContent(max, chats, msg.link);
    const text = forwarded ? forwarded.text : msg.text;
    const attaches = forwarded ? forwarded.attaches : Array.isArray(msg.attaches) ? (msg.attaches as MaxAttachment[]) : [];
    if (!text && attaches.length === 0) {
      await chatMapStore.advanceHistoryCursor(maxChatId, msg.time);
      continue;
    }
    try {
      let textMessageId: number | undefined;
      let attachMessageId: number | undefined;
      if (text) {
        const sent = await withFloodRetry(() => bot.telegram.sendMessage(groupId, text, { message_thread_id: topicId }));
        textMessageId = sent.message_id;
        await sleep(HISTORY_SEND_DELAY_MS);
      }
      if (attaches.length > 0) {
        const downloadCtx: DownloadContext = {
          max,
          chatId: forwarded?.sourceChatId ?? maxChatId,
          messageId: forwarded?.sourceMessageId ?? msg.id,
        };
        attachMessageId = await withFloodRetry(() => sendAttachments(bot, groupId, topicId, attaches, downloadCtx));
        await sleep(HISTORY_SEND_DELAY_MS);
      }
      // A forward with both text AND an attachment sends TWO separate Telegram
      // messages from one MAX message — track both so a later deletion removes both
      // instead of orphaning the attachment (confirmed live 2026-08-13).
      const telegramMessageId = textMessageId ?? attachMessageId;
      if (telegramMessageId != null && msg.id != null) {
        const extraTelegramMessageIds = textMessageId != null && attachMessageId != null && attachMessageId !== telegramMessageId ? [attachMessageId] : undefined;
        messageLinks.add({ maxChatId, maxMessageId: msg.id, telegramMessageId, extraTelegramMessageIds });
      }
    } catch (err) {
      logger.error(`Failed to backfill MAX message ${String(msg.id)} in chat ${String(maxChatId)}`, err);
    } finally {
      await chatMapStore.advanceHistoryCursor(maxChatId, msg.time);
    }
  }
}

/** Builds and sends the contact/chat card — shared by the /info command and the auto-send on first contact with a new chat. Returns the sent message's id so auto-send callers can pin it. */
async function sendContactInfoCard(
  bot: Telegraf,
  targetGroupId: string,
  topicId: number,
  fallbackTitle: string,
  chatType: string | undefined,
  participantCount: number | undefined,
  otherId: number | undefined,
  profile: ContactProfile | undefined,
): Promise<number> {
  if (chatType !== 'DIALOG' || otherId == null) {
    const sent = await bot.telegram.sendMessage(
      targetGroupId,
      [`ℹ️ ${fallbackTitle}`, chatType ? `Тип: ${chatType}` : null, participantCount != null ? `Участников: ${participantCount}` : null]
        .filter(Boolean)
        .join('\n'),
      { message_thread_id: topicId },
    );
    return sent.message_id;
  }

  if (!profile) {
    const sent = await bot.telegram.sendMessage(targetGroupId, 'ℹ️ Нет данных о контакте.', { message_thread_id: topicId });
    return sent.message_id;
  }

  const p = profile as ContactProfile & { registrationTime?: unknown; country?: string; baseUrl?: string; description?: string };
  const lines = [`👤 ${resolveContactDisplayName(otherId, profile)}`];
  const custom = p.names?.find((n) => n.type === 'CUSTOM')?.name;
  const oneme = p.names?.find((n) => n.type === 'ONEME')?.name;
  if (custom) lines.push(`Метка: ${custom}`);
  if (oneme && oneme !== custom) lines.push(`Ник: ${oneme}`);
  if (p.phone != null) lines.push(`Телефон: +${String(p.phone)}`);
  if (p.country) lines.push(`Страна: ${p.country}`);
  if (p.description) lines.push(`О себе: ${p.description}`);
  if (p.registrationTime != null) lines.push(`Регистрация: ${new Date(Number(p.registrationTime)).toLocaleDateString('ru-RU')}`);
  lines.push(`ID: ${otherId}`);
  const caption = lines.join('\n');

  try {
    const sent = p.baseUrl
      ? await bot.telegram.sendPhoto(targetGroupId, p.baseUrl, { caption, message_thread_id: topicId })
      : await bot.telegram.sendMessage(targetGroupId, caption, { message_thread_id: topicId });
    return sent.message_id;
  } catch (err) {
    logger.error('Failed to send contact info card, falling back to text-only', err);
    const sent = await bot.telegram.sendMessage(targetGroupId, caption, { message_thread_id: topicId });
    return sent.message_id;
  }
}

/** Pins the auto-sent intro card so it stays visible at the top of the topic even after the chat scrolls — not used for on-demand /info, only the first-contact auto-card. */
async function pinInfoCard(bot: Telegraf, targetGroupId: string, messageId: number): Promise<void> {
  try {
    await bot.telegram.pinChatMessage(targetGroupId, messageId, { disable_notification: true });
  } catch (err) {
    logger.error('Failed to pin auto contact-info card', err);
  }
}

/** Same lookup setup.sh does once at install time, run live for /apikey's link — best-effort, `null` just falls back to the bare key. */
async function detectPublicIp(): Promise<string | null> {
  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 5000);
    const res = await fetch('https://ifconfig.me/ip', { signal: controller.signal }).finally(() => clearTimeout(timeout));
    if (!res.ok) return null;
    return (await res.text()).trim();
  } catch (err) {
    logger.error('Failed to detect public IP for /apikey link', err);
    return null;
  }
}

/** Picked up within a minute by update-watcher.sh on the host (see setup.sh) — writing it is the only thing the container itself does towards an update, everything else (git pull, rebuild, restart) happens outside it. */
const UPDATE_REQUESTED_MARKER = path.join(process.cwd(), '.data', 'update-requested');

/** Shared by /version and the daily scheduled check — same text/buttons either way. */
function formatVersionMessage(status: VersionStatus): { text: string; replyMarkup?: ReturnType<typeof Markup.inlineKeyboard>['reply_markup'] } {
  const currentLabel = status.current ? shortSha(status.current) : 'неизвестна (образ собран без GIT_COMMIT)';
  if (!status.latest) {
    return { text: `📦 Текущая версия: ${currentLabel}\n\n⚠️ Не удалось проверить обновления на GitHub — сеть недоступна или лимит запросов.` };
  }
  if (!status.updateAvailable) {
    return { text: `📦 Текущая версия: ${currentLabel}\n\n✅ Это последняя версия.` };
  }
  const text = `📦 Текущая версия: ${currentLabel}\n🆕 Доступна новая: ${shortSha(status.latest.sha)} — ${status.latest.message}\n\nОбновить сейчас? Пересборка и перезапуск займут пару минут, история переписки не затрагивается.`;
  const replyMarkup = Markup.inlineKeyboard([
    Markup.button.callback('🔄 Обновить', 'tlmx_update'),
    Markup.button.callback('⏰ Позже', 'tlmx_dismiss'),
  ]).reply_markup;
  return { text, replyMarkup };
}

export interface BridgeOptions {
  max: MaxClient;
  bot: Telegraf;
  chatMapStore: ChatMapStore;
  targetGroupId: string;
  /** Always-current accessors (module state in server/app.ts refreshes on every login) — used by /info to resolve who's on the other end of a topic. */
  getChats: () => unknown[];
  getMyAccountId: () => number | null;
  getContactProfiles: () => Map<number, ContactProfile>;
  /** Refetches MAX's chat list and re-runs the full backfill sync — used by /reboot after wiping local state. Fire-and-forget on the caller's side (server/app.ts already guards against overlapping runs). */
  triggerFullResync: () => Promise<void>;
  /** Disconnects from MAX and deletes the encrypted session — used by /kill. Awaited (unlike triggerFullResync) since /kill's own confirmation message should only go out once this has actually finished. */
  killEverything: () => Promise<void>;
}

/** Wires MAX push messages <-> Telegram forum topics in both directions (ТЗ.md §1.2). */
export interface WiredBridge {
  messageLinks: MessageLinkStore;
}

export function wireBridge({
  max,
  bot,
  chatMapStore,
  targetGroupId,
  getChats,
  getMyAccountId,
  getContactProfiles,
  triggerFullResync,
  killEverything,
}: BridgeOptions): WiredBridge {
  // Every update Telegraf would otherwise route to a command/action/message
  // handler below passes through here first. /reboot and /kill only gate on
  // typing a confirmation phrase — and that phrase is public (open-source repo,
  // even echoed back in /help) — so without this, anyone who finds the bot on
  // Telegram (a direct DM, or being added to a totally unrelated group) could
  // trigger them, or /newgroup, or anything else. The target group is meant to
  // BE the trust boundary; this is what actually enforces that. poll_answer
  // updates carry no `chat` at all and are separately authorized by their own
  // poll_id lookup (see bot.on('poll_answer') below), so those pass through.
  bot.use((ctx, next) => {
    if (ctx.chat && String(ctx.chat.id) !== targetGroupId) {
      if (ctx.callbackQuery) {
        ctx.answerCbQuery('Не вы меня создали.').catch(() => {});
      } else {
        ctx.reply('Не вы меня создали — идите в жопу.').catch(() => {});
      }
      return;
    }
    return next();
  });

  const outgoingCids = new RecentCids();
  const messageLinks = new MessageLinkStore();
  const pollLinks = new PollLinkStore();

  /**
   * `outgoingCids` and `messageLinks` are both in-memory only, so neither survives a
   * restart — meaning the live-push echo check (handleMaxPush) can't protect a
   * message we just sent Telegram -> MAX if a reconnect/redeploy's catch-up backfill
   * (bridge/sync.ts's cursor-bounded CHAT_HISTORY re-read) runs before any LATER
   * message naturally advances the cursor past it. Without this, that catch-up sees
   * our own just-sent message sitting past the stale cursor and relays it to
   * Telegram a second time — hit live 2026-08-13 testing the sticker relay. Advancing
   * the cursor to "now" right after every outgoing send closes that window.
   */
  function rememberOutgoingSend(chatId: unknown, cid: number): void {
    outgoingCids.remember(cid);
    chatMapStore.advanceHistoryCursor(chatId, Date.now()).catch((err) => logger.error('Failed to advance history cursor after outgoing send', err));
  }

  // Keyed by `${chatId}:${messageId}` -> what we last relayed, so the sticky
  // lastReactedMessageId/lastReaction fields on a CHAT_UPDATE (which repeat
  // across unrelated chat-update pushes) don't re-trigger the same Telegram call.
  // Also doubles as the poll list for reaction *removal* (see below) — keeps the
  // original messageId (BigInt), not just its string form, since MSG_GET_REACTIONS
  // needs the same integer encoding as every other messageId-taking call.
  const lastRelayedReaction = new Map<string, { chatId: unknown; messageId: unknown; emoji: string }>();

  // Poll votes arrive as a repeat PUSH_MESSAGE (same messageId, updated attaches[0].state) —
  // same mechanism as text edits, confirmed live 2026-08-10. Telegram's native poll widget has
  // no API for injecting an externally-cast vote, so this dedup gate (by poll `version`) guards
  // a follow-up text message reporting the new tally instead of trying to edit the poll itself.
  const lastRelayedPollVersion = new Map<string, number>();

  // MAX sends no live push for reaction removal (see handleMaxChatUpdate below),
  // so this is the only way to notice it — poll each message we know has an
  // active relayed reaction and clear it in Telegram once MAX reports it gone.
  const REACTION_POLL_INTERVAL_MS = 60_000;
  setInterval(() => void pollReactionRemovals(), REACTION_POLL_INTERVAL_MS);

  async function pollReactionRemovals(): Promise<void> {
    for (const [key, relayed] of lastRelayedReaction) {
      const link = messageLinks.getByMax(relayed.chatId, relayed.messageId);
      if (!link) {
        lastRelayedReaction.delete(key);
        continue;
      }
      try {
        const counters = await max.getReactions(relayed.chatId, relayed.messageId);
        const stillPresent = counters.some((c) => c.reaction === relayed.emoji && c.count > 0);
        if (!stillPresent) {
          await bot.telegram.setMessageReaction(targetGroupId, link.telegramMessageId, []);
          lastRelayedReaction.delete(key);
        }
      } catch (err) {
        logger.error(`Failed to poll MAX reactions for chat ${relayed.chatId} message ${String(relayed.messageId)}`, err);
      }
    }
  }

  // Checked roughly once a day, at a jittered offset rather than a fixed clock
  // time — spreads GitHub API calls out and means a restart doesn't permanently
  // pin the check to the exact minute the container happened to boot.
  const VERSION_CHECK_MIN_MS = 20 * 60 * 60 * 1000;
  const VERSION_CHECK_MAX_MS = 28 * 60 * 60 * 1000;
  scheduleVersionCheck();

  function scheduleVersionCheck(): void {
    const delay = VERSION_CHECK_MIN_MS + Math.random() * (VERSION_CHECK_MAX_MS - VERSION_CHECK_MIN_MS);
    setTimeout(() => void runScheduledVersionCheck().finally(scheduleVersionCheck), delay);
  }

  async function runScheduledVersionCheck(): Promise<void> {
    const status = await checkVersion();
    if (!status.updateAvailable) return;
    const { text, replyMarkup } = formatVersionMessage(status);
    await bot.telegram.sendMessage(targetGroupId, text, { reply_markup: replyMarkup }).catch((err) => logger.error('Failed to send scheduled version-update notice', err));
  }

  max.on('message', (event: MaxMessageEvent) => {
    if (event.opcode === OPCODES.PUSH_MESSAGE) {
      // handleMaxPush's own try/catch only wraps its final send step — anything
      // thrown earlier (e.g. in forward-sender resolution) was an unhandled
      // rejection that silently vanished. Confirmed live 2026-08-13 while
      // debugging a forwarded FILE attachment that never reached Telegram.
      handleMaxPush(event.payload as MaxPushPayload).catch((err) => logger.error('handleMaxPush crashed', err));
    } else if (event.opcode === OPCODES.PUSH_TYPING) {
      void handleMaxTyping(event.payload as MaxTypingPayload);
    } else if (event.opcode === OPCODES.CHAT_UPDATE) {
      void handleMaxChatUpdate(event.payload);
    } else if (event.opcode === OPCODES.NOTIF_CALL_START) {
      void handleIncomingCall(event.payload as { caller?: unknown; callId?: unknown; chatId?: unknown });
    } else if (event.opcode === OPCODES.NOTIF_MSG_DELETE) {
      void handleMaxMessageDelete(event.payload);
    } else if (event.opcode === OPCODES.NOTIF_MSG_REACTIONS_CHANGED || event.opcode === OPCODES.NOTIF_MSG_YOU_REACTED) {
      // Tested live 2026-08-08: never fired for a real reaction from another
      // user. Logged in case it turns out to be conditional (e.g. group chats,
      // a different client version) — CHAT_UPDATE below is what's actually wired up.
      logger.info(`${formatOpcode(event.opcode)} payload:`, jsonStringify(event.payload));
    }
  });

  /**
   * Reaction *additions* only: MAX sends no push at all for removals through any
   * mechanism found so far (NOTIF_MSG_REACTIONS_CHANGED/NOTIF_MSG_YOU_REACTED don't
   * fire either — tested live 2026-08-08). This piggybacks on the general "chat
   * updated" push, whose `lastReactedMessageId`/`lastReaction` fields reliably
   * correlated with real reaction-add events across every live test, despite also
   * appearing on unrelated resyncs (hence the dedup above).
   */
  async function handleMaxChatUpdate(payload: unknown): Promise<void> {
    const chat = (payload as { chat?: { id?: unknown; lastReactedMessageId?: unknown; lastReaction?: string } } | null)?.chat;
    if (!chat || chat.id == null || chat.lastReactedMessageId == null || !chat.lastReaction) return;
    const link = messageLinks.getByMax(chat.id, chat.lastReactedMessageId);
    if (!link) return;

    const key = `${chat.id}:${String(chat.lastReactedMessageId)}`;
    if (lastRelayedReaction.get(key)?.emoji === chat.lastReaction) return;
    lastRelayedReaction.set(key, { chatId: chat.id, messageId: chat.lastReactedMessageId, emoji: chat.lastReaction });

    try {
      // Telegram only accepts a fixed emoji set (TelegramEmoji); MAX's is presumably wider,
      // so an unsupported one will reject at the API call — caught below, not fatal.
      await bot.telegram.setMessageReaction(targetGroupId, link.telegramMessageId, [
        { type: 'emoji', emoji: chat.lastReaction as TelegramEmoji },
      ]);
    } catch (err) {
      logger.error('Failed to relay MAX reaction to Telegram', err);
    }
  }

  /** Reports a poll's new tally as a reply, since Telegram's native poll widget can't be updated with a vote it didn't itself receive. */
  async function relayPollUpdate(chatId: unknown, telegramMessageId: number, pollAttach: MaxAttachment): Promise<void> {
    const mapping = await chatMapStore.getByMaxChatId(chatId);
    if (!mapping) return;
    const lines = (pollAttach.answers ?? []).map((a) => {
      const result = pollAttach.state?.result?.find((r) => String(r.answerId) === String(a.answerId));
      return `${a.text ?? '—'}: ${result?.voteCount ?? 0}`;
    });
    await bot.telegram.sendMessage(targetGroupId, `🗳 Обновление опроса «${pollAttach.title ?? ''}»:\n${lines.join('\n')}`, {
      message_thread_id: mapping.telegramTopicId,
      reply_parameters: { message_id: telegramMessageId },
    });
    logger.info(`Relayed poll tally update (pollId=${String(pollAttach.pollId)}) to Telegram topic ${mapping.telegramTopicId}`);
  }

  /**
   * Never once observed live (2026-08-13 testing showed deletions actually arrive as
   * a repeat PUSH_MESSAGE with status:"REMOVED" — see handleMaxPush) — kept as a
   * fallback in case this opcode does fire in some other scenario (e.g. group
   * chats). Payload shape still unconfirmed; best-effort field names mirroring
   * MSG_DELETE's own request shape.
   */
  async function handleMaxMessageDelete(payload: unknown): Promise<void> {
    const p = payload as { chatId?: unknown; messageIds?: unknown[] } | null;
    if (p?.chatId == null || !Array.isArray(p.messageIds)) {
      logger.info('NOTIF_MSG_DELETE payload (unrecognized shape):', jsonStringify(payload));
      return;
    }
    for (const messageId of p.messageIds) {
      const link = messageLinks.getByMax(p.chatId, messageId);
      if (!link) continue;
      for (const id of [link.telegramMessageId, ...(link.extraTelegramMessageIds ?? [])]) {
        try {
          await bot.telegram.deleteMessage(targetGroupId, id);
        } catch (err) {
          logger.error(`Failed to relay MAX message deletion (messageId=${String(messageId)}, telegramMessageId=${id}) to Telegram`, err);
        }
      }
    }
  }

  /** Real-time "phone is ringing" notification — actually placing/joining the call needs WebRTC, out of scope for a Bot API bridge, so this is notification-only. */
  async function handleIncomingCall(payload: { caller?: unknown; callId?: unknown; chatId?: unknown }): Promise<void> {
    if (payload?.chatId == null) return;
    try {
      const { topicId } = await ensureTopicForMaxChat(bot, targetGroupId, payload.chatId, chatMapStore);
      const callerId = typeof payload.caller === 'number' ? payload.caller : Number(payload.caller);
      let callerName = `MAX ID ${String(payload.caller)}`;
      if (!Number.isNaN(callerId)) {
        let profile = getContactProfiles().get(callerId);
        if (!profile) {
          try {
            const contacts = await max.getContactInfo([callerId]);
            profile = contacts[0];
            if (profile) getContactProfiles().set(callerId, profile);
          } catch (err) {
            logger.error(`Failed to fetch CONTACT_INFO for caller ${callerId}`, err);
          }
        }
        callerName = resolveContactDisplayName(callerId, profile);
      }
      await bot.telegram.sendMessage(targetGroupId, `📞 Входящий звонок от ${callerName}`, { message_thread_id: topicId });
    } catch (err) {
      logger.error('Failed to relay incoming call notification to Telegram', err);
    }
  }

  async function handleMaxTyping(payload: MaxTypingPayload): Promise<void> {
    if (payload?.chatId == null) return;
    // Only relay for chats that already have a topic — typing alone shouldn't create one.
    const mapping = await chatMapStore.getByMaxChatId(payload.chatId);
    if (!mapping) return;
    const action = TYPING_TYPE_TO_CHAT_ACTION[payload.type ?? ''] ?? 'typing';
    try {
      await bot.telegram.sendChatAction(targetGroupId, action, { message_thread_id: mapping.telegramTopicId });
    } catch (err) {
      logger.error('Failed to relay typing indicator to Telegram', err);
    }
  }

  /**
   * Sends the intro card the moment a topic is created for a chat we've never
   * seen before. Prefers the normal chat-aware lookup (covers DIALOG and
   * group/channel correctly); if the chat isn't in the last CHATS_LIST snapshot
   * yet (a genuinely brand-new contact writing for the first time), falls back
   * to the push's `message.sender` and fetches that one contact's CONTACT_INFO
   * fresh, caching it for later /info calls and future auto-cards.
   */
  async function sendAutoInfoCard(chatId: unknown, senderId: unknown, topicId: number): Promise<void> {
    const { chat, otherId, profile } = resolveDialogContact(String(chatId));
    if (chat) {
      const count = chat.participants ? Object.keys(chat.participants).length : undefined;
      const messageId = await sendContactInfoCard(bot, targetGroupId, topicId, chat.title || `MAX chat ${String(chatId)}`, chat.type, count, otherId, profile);
      await pinInfoCard(bot, targetGroupId, messageId);
      return;
    }
    const id = typeof senderId === 'number' ? senderId : Number(senderId);
    if (Number.isNaN(id)) return;
    let senderProfile = getContactProfiles().get(id);
    if (!senderProfile) {
      try {
        const contacts = await max.getContactInfo([id]);
        senderProfile = contacts[0];
        if (senderProfile) getContactProfiles().set(id, senderProfile);
      } catch (err) {
        logger.error(`Failed to fetch CONTACT_INFO for new contact ${id}`, err);
      }
    }
    const messageId = await sendContactInfoCard(bot, targetGroupId, topicId, `MAX ID ${id}`, 'DIALOG', undefined, id, senderProfile);
    await pinInfoCard(bot, targetGroupId, messageId);
  }

  async function handleMaxPush(payload: MaxPushPayload): Promise<void> {
    const chatId = payload?.chatId;
    const message = payload?.message;
    if (chatId == null || !message) return;
    if (message.cid != null && outgoingCids.has(message.cid)) return; // our own message echoed back

    let text = message.text;
    let attaches = Array.isArray(message.attaches) ? message.attaches : [];
    // Attachments in a forward were uploaded against the ORIGINAL message/chat, not the
    // wrapper — FILE_DOWNLOAD/VIDEO_PLAY need those ids, not the wrapper's own.
    let downloadChatId: unknown = chatId;
    let downloadMessageId: unknown = message.id;

    // A forward we RECEIVE: the wrapper message's own text/attaches are empty — the
    // real content is in link.message. Confirmed live 2026-08-13. (Sending a forward
    // FROM us doesn't work yet — MAX's response to our own FORWARD request comes back
    // essentially empty and no message is actually created; still unresolved.)
    if (message.link?.type === 'FORWARD') {
      const original = message.link.message;
      attaches = Array.isArray(original?.attaches) ? original.attaches : [];
      if (message.link.chatId != null) downloadChatId = message.link.chatId;
      if (original?.id != null) downloadMessageId = original.id;
      const senderId = typeof original?.sender === 'number' ? original.sender : Number(original?.sender);
      let senderName = Number.isNaN(senderId) ? 'неизвестно' : `MAX ID ${senderId}`;
      if (!Number.isNaN(senderId)) {
        let profile = getContactProfiles().get(senderId);
        if (!profile) {
          try {
            const contacts = await max.getContactInfo([senderId]);
            profile = contacts[0];
            if (profile) getContactProfiles().set(senderId, profile);
          } catch (err) {
            logger.error(`Failed to fetch CONTACT_INFO for forward sender ${senderId}`, err);
          }
        }
        senderName = resolveContactDisplayName(senderId, profile);
      }
      const sourceChat = getChats().find((c) => c && typeof c === 'object' && String((c as { id?: unknown }).id) === String(message.link?.chatId)) as
        | { title?: string }
        | undefined;
      const sourceLabel = sourceChat?.title || `MAX chat ${String(message.link.chatId)}`;
      const prefix = `↩️ Переслано из «${sourceLabel}» (от ${senderName}):`;
      text = original?.text ? `${prefix}\n${original.text}` : prefix;
    }

    // Edits AND deletions both arrive as a repeat PUSH_MESSAGE carrying the SAME
    // message.id — not separate opcodes. Distinguished only by `status`: "EDITED"
    // vs "REMOVED" (undefined/absent means a genuinely new message). Confirmed by
    // the user's own protocol docs 2026-08-13 — NOTIF_MSG_DELETE (handleMaxMessageDelete
    // below) is apparently not how MAX actually signals a deletion; kept as a
    // fallback in case it fires in some other scenario, but this is the real path.
    const existingLink = message.id != null ? messageLinks.getByMax(chatId, message.id) : undefined;
    if (existingLink && message.status === 'REMOVED') {
      const idsToDelete = [existingLink.telegramMessageId, ...(existingLink.extraTelegramMessageIds ?? [])];
      for (const id of idsToDelete) {
        try {
          await bot.telegram.deleteMessage(targetGroupId, id);
        } catch (err) {
          logger.error(`Failed to relay MAX deletion to Telegram (telegramMessageId=${id})`, err);
        }
      }
      return;
    }
    if (existingLink) {
      if (text != null) {
        try {
          await bot.telegram.editMessageText(targetGroupId, existingLink.telegramMessageId, undefined, text);
        } catch (err) {
          logger.error('Failed to relay MAX edit to Telegram', err);
        }
      }
      const updatedPoll = attaches.find((a) => (a as MaxAttachment)._type === 'POLL') as MaxAttachment | undefined;
      if (updatedPoll) {
        const key = `${String(chatId)}:${String(message.id)}`;
        const version = typeof updatedPoll.version === 'number' ? updatedPoll.version : undefined;
        if (version == null || lastRelayedPollVersion.get(key) !== version) {
          if (version != null) lastRelayedPollVersion.set(key, version);
          await relayPollUpdate(chatId, existingLink.telegramMessageId, updatedPoll).catch((err) =>
            logger.error('Failed to relay poll update to Telegram', err),
          );
        }
      }
      return;
    }

    if (!text && attaches.length === 0) return;

    const pollAttach = attaches.find((a) => (a as MaxAttachment)._type === 'POLL') as MaxAttachment | undefined;
    if (pollAttach) {
      try {
        const { topicId, created } = await ensureTopicForMaxChat(bot, targetGroupId, chatId, chatMapStore);
        if (created) {
          await sendAutoInfoCard(chatId, message.sender, topicId).catch((err) => logger.error('Failed to send auto contact-info card', err));
        }
        const options = (pollAttach.answers ?? []).map((a) => a.text || '—');
        const settings = pollAttach.settings ?? 0;
        const sentPoll = await bot.telegram.sendPoll(targetGroupId, pollAttach.title || 'Опрос', options, {
          is_anonymous: (settings & 1) !== 0,
          allows_multiple_answers: (settings & 2) !== 0,
          message_thread_id: topicId,
        });
        logger.info(`Relayed MAX poll "${pollAttach.title}" (pollId=${String(pollAttach.pollId)}) to Telegram topic ${topicId}`);
        // MAX sends no push for votes, and Telegram's native poll widget has no API for
        // injecting one cast on MAX's side — so it will never reflect those on its own.
        await bot.telegram
          .sendMessage(targetGroupId, '💡 Голоса с MAX сюда не попадают — ответь на это сообщение командой /poll, чтобы увидеть актуальный счёт.', {
            message_thread_id: topicId,
            reply_parameters: { message_id: sentPoll.message_id },
          })
          .catch((err) => logger.error('Failed to send poll reminder', err));
        if (message.id != null) messageLinks.add({ maxChatId: chatId, maxMessageId: message.id, telegramMessageId: sentPoll.message_id });
        if (pollAttach.pollId != null) {
          pollLinks.add(sentPoll.poll.id, {
            maxChatId: chatId,
            maxMessageId: message.id,
            maxPollId: pollAttach.pollId,
            answerIdByOptionIndex: (pollAttach.answers ?? []).map((a, i) => Number(a.answerId ?? i + 1)),
          });
        }
        // A freshly created Telegram poll always starts at zero — there's no Bot API
        // way to pre-seed a vote — so if the creator (or anyone) already voted by the
        // time this push arrived (e.g. a client that auto-votes the creator's pick),
        // that tally is otherwise invisible on the Telegram side. Report it right away.
        if ((pollAttach.state?.result?.some((r) => (r.voteCount ?? 0) > 0)) && message.id != null) {
          const key = `${String(chatId)}:${String(message.id)}`;
          if (typeof pollAttach.version === 'number') lastRelayedPollVersion.set(key, pollAttach.version);
          await relayPollUpdate(chatId, sentPoll.message_id, pollAttach).catch((err) =>
            logger.error('Failed to relay initial poll tally to Telegram', err),
          );
        }
      } catch (err) {
        logger.error('Failed to relay MAX poll to Telegram', err);
      }
      return;
    }

    try {
      const { topicId, created } = await ensureTopicForMaxChat(bot, targetGroupId, chatId, chatMapStore);
      if (created) {
        await sendAutoInfoCard(chatId, message.sender, topicId).catch((err) => logger.error('Failed to send auto contact-info card', err));
      }
      let textMessageId: number | undefined;
      let attachMessageId: number | undefined;
      if (text) textMessageId = (await bot.telegram.sendMessage(targetGroupId, text, { message_thread_id: topicId })).message_id;
      if (attaches.length > 0) {
        // NOT `telegramMessageId ??= await sendAttachments(...)` — `??=` short-circuits
        // and never even CALLS sendAttachments when telegramMessageId is already set,
        // which it always is for a forward (the "↩️ Переслано из..." prefix always
        // produces text, even when the original was attachment-only). That silently
        // dropped every forwarded attachment with no error anywhere (root-caused live
        // 2026-08-13 after the catch-up path — which calls sendAttachments
        // unconditionally — kept delivering the same messages fine).
        const downloadCtx: DownloadContext = { max, chatId: downloadChatId, messageId: downloadMessageId };
        attachMessageId = await sendAttachments(bot, targetGroupId, topicId, attaches, downloadCtx);
      }
      // A forward with both text AND an attachment sends TWO separate Telegram
      // messages from one MAX message — track both so a later deletion removes both
      // instead of orphaning the attachment (confirmed live 2026-08-13).
      const telegramMessageId = textMessageId ?? attachMessageId;
      if (telegramMessageId != null) {
        const extraTelegramMessageIds = textMessageId != null && attachMessageId != null && attachMessageId !== telegramMessageId ? [attachMessageId] : undefined;
        messageLinks.add({ maxChatId: chatId, maxMessageId: message.id, telegramMessageId, extraTelegramMessageIds });
      }
    } catch (err) {
      logger.error('MAX -> Telegram forward failed', err);
    }
  }

  /** Resolves the "other participant" + their profile for a DIALOG chat, looking them up in cachedChats/contactProfiles. */
  function resolveDialogContact(maxChatId: string): { chat: { type?: string; title?: string; participants?: Record<string, unknown> } | undefined; otherId: number | undefined; profile: ContactProfile | undefined } {
    const chat = getChats().find((c) => c && typeof c === 'object' && String((c as { id?: unknown }).id) === maxChatId) as
      | { type?: string; title?: string; participants?: Record<string, unknown> }
      | undefined;
    const myAccountId = getMyAccountId();
    const participantIds = chat?.participants ? Object.keys(chat.participants).map(Number) : [];
    const otherId = participantIds.find((id) => id !== myAccountId);
    const profile = otherId != null ? getContactProfiles().get(otherId) : undefined;
    return { chat, otherId, profile };
  }

  /** Full command reference + the two platform-level gaps that aren't discoverable from the UI. Doubles as the bot profile's setMyDescription text (server/app.ts), just with room to actually explain each command instead of a 512-char squeeze. */
  bot.command('help', async (ctx) => {
    const text = `🌉 Мост MAX (+7XXXXXXXXXX) ↔ Telegram

Сообщения, файлы, голосовые, стикеры и опросы синхронизируются в обе стороны автоматически — команды нужны только для управления. Обычная пересылка сообщений (drag-forward) в тему тоже работает сама — прилетит в привязанный MAX-чат с пометкой «↩️ Переслано от/из...». Звонки — только текстовые уведомления (входящий звонит / завершённый / пропущенный), без передачи аудио — для этого нужен WebRTC, вне рамок Bot API-моста.

/info — карточка контакта или чата (просто в теме, ответ на сообщение не нужен)

Ответом на сообщение:
/poll — актуальный счёт опроса (голоса из MAX сами в виджет Telegram не попадают)
/delete — удалить сообщение с обеих сторон (/delete me — только у себя)

Управление группой (без ответа):
/newgroup <название> — создать группу в MAX
/invite <MAX ID> — пригласить участника
/kick <MAX ID> — удалить участника
/rename <название> — переименовать (MAX иногда молча игнорирует переименование — известный баг платформы)
/setdesc <описание> — изменить описание
/leavegroup — выйти из группы (требует подтверждения)
/deletegroup — удалить группу (требует подтверждения)

Обслуживание бота:
/apikey — показать ключ для входа в веб-панель (если потерял/не сохранил при установке)
Первая авторизация MAX — прямо в консоли при установке (setup.sh спросит номер и код из SMS). Всё, что потом (повторная авторизация после /kill, смена номера) — через веб-панель по ссылке из /apikey.
/version — проверить версию, обновить по кнопке (раз в сутки бот сам напомнит, если вышло обновление)
/reboot — удалить ВСЕ темы в этой Telegram-группе и пересинхронизировать всё с нуля из MAX (требует подтверждения, MAX не затрагивается)
/kill — то же самое + разлогинить MAX-сессию (нужна новая SMS-авторизация через веб-панель). Необратимо, требует подтверждения.

⚠️ Ограничения платформы:
• Свайп-удаление в Telegram бот не видит — такого события просто нет в Bot API. Удаляй командой /delete.
• Голоса за опрос из MAX не отражаются в виджете Telegram сами — актуальный счёт смотри через /poll.

💛 Поддержать проект — /donate`;
    await bot.telegram.sendMessage(ctx.chat.id, text, { message_thread_id: ctx.message.message_thread_id });
  });

  bot.command('donate', async (ctx) => {
    await bot.telegram.sendMessage(ctx.chat.id, '💛 Спасибо, что пользуешься мостом! Выбери способ:', {
      message_thread_id: ctx.message.message_thread_id,
      reply_markup: Markup.inlineKeyboard(
        [
          Markup.button.url('💳 Рублями (CloudTips)', 'https://pay.cloudtips.ru/p/3c71b5e8'),
          // ton://transfer/<address> opens Telegram's own @wallet / any TON wallet app
          // with the recipient pre-filled, so this works as a native in-app link.
          Markup.button.url('💎 GRAM (TON)', 'ton://transfer/UQALpK2PKI90-XpupOM8sRJGdwrFMsPcwQZPR0k180umXBcA'),
        ],
        { columns: 1 },
      ).reply_markup,
    });
  });

  /** Recovers the web-panel API_KEY without needing SSH/file access to the server — safe now that the target-group middleware above actually gates who can ask. Bundles it into a ready-to-open link (App.tsx reads ?key= and logs straight in) when the server's public IP can be detected, falling back to the bare key otherwise. */
  bot.command('apikey', async (ctx) => {
    const apiKey = process.env.API_KEY;
    if (!apiKey) {
      await bot.telegram.sendMessage(ctx.chat.id, 'API_KEY не задан в .env.', { message_thread_id: ctx.message.message_thread_id });
      return;
    }
    const port = process.env.PORT ?? '3000';
    const ip = await detectPublicIp();
    const text = ip
      ? `🔑 Вход в веб-панель (ссылка сразу авторизует):\nhttp://${ip}:${port}/?key=${encodeURIComponent(apiKey)}`
      : `🔑 Ключ для веб-панели (не удалось определить IP сервера — откройте панель вручную и введите ключ):\n<code>${apiKey}</code>`;
    await bot.telegram.sendMessage(ctx.chat.id, text, {
      message_thread_id: ctx.message.message_thread_id,
      parse_mode: 'HTML',
      link_preview_options: { is_disabled: true },
    });
  });

  bot.command('version', async (ctx) => {
    const status = await checkVersion();
    const { text, replyMarkup } = formatVersionMessage(status);
    await bot.telegram.sendMessage(ctx.chat.id, text, { message_thread_id: ctx.message.message_thread_id, reply_markup: replyMarkup });
  });

  bot.action('tlmx_update', async (ctx) => {
    await ctx.answerCbQuery('Обновление запрошено');
    try {
      await writeFile(UPDATE_REQUESTED_MARKER, new Date().toISOString(), 'utf8');
      await ctx.editMessageText('⏳ Обновление запрошено — вотчер на сервере подхватит его в течение минуты, пересоберёт и перезапустит бота. История переписки не затрагивается.');
    } catch (err) {
      logger.error('Failed to write update-requested marker', err);
      await ctx.editMessageText('❌ Не удалось запросить обновление — смотри логи контейнера.');
    }
  });

  bot.action('tlmx_dismiss', async (ctx) => {
    await ctx.answerCbQuery('Ок');
    await ctx.editMessageText('⏰ Отложено — напомню при следующей ежедневной проверке.');
  });

  /** Contact card for the person/group on the other end of this topic — name, phone, country, registration date, and (best-effort) their avatar. */
  bot.command('info', async (ctx) => {
    const topicId = ctx.message.message_thread_id;
    if (!topicId) return;
    const mapping = await chatMapStore.getByTopicId(topicId);
    if (!mapping) return;

    const { chat, otherId, profile } = resolveDialogContact(mapping.maxChatId);
    const count = chat?.participants ? Object.keys(chat.participants).length : undefined;
    await sendContactInfoCard(bot, targetGroupId, topicId, chat?.title || mapping.title || 'Чат', chat?.type, count, otherId, profile);
  });

  /** Formats a poll's current tally — MAX sends no push for votes, so callers always pull it live via CHAT_HISTORY first. */
  async function formatPollResultsText(pollAttach: MaxAttachment): Promise<string> {
    const anonymous = ((pollAttach.settings ?? 0) & 1) !== 0;
    const lines = await Promise.all(
      (pollAttach.answers ?? []).map(async (a) => {
        const result = pollAttach.state?.result?.find((r) => String(r.answerId) === String(a.answerId));
        const icon = (result?.voteCount ?? 0) > 0 ? '✅' : '⬜';
        let namesLine = '';
        if (!anonymous && result?.votes?.length) {
          const names = await Promise.all(
            result.votes.map(async (v) => {
              const uid = Number(v.userId);
              if (Number.isNaN(uid)) return null;
              let voterProfile = getContactProfiles().get(uid);
              if (!voterProfile) {
                try {
                  const contacts = await max.getContactInfo([uid]);
                  voterProfile = contacts[0];
                  if (voterProfile) getContactProfiles().set(uid, voterProfile);
                } catch (err) {
                  logger.error(`Failed to fetch CONTACT_INFO for voter ${uid}`, err);
                }
              }
              return resolveContactDisplayName(uid, voterProfile);
            }),
          );
          const joined = names.filter(Boolean).join(', ');
          if (joined) namesLine = `\n   👤 ${joined}`;
        }
        return `${icon} ${a.text ?? '—'} — ${result?.voteCount ?? 0} (${result?.rate ?? 0}%)${namesLine}`;
      }),
    );
    return `🗳️ «${pollAttach.title ?? ''}»\n${lines.join('\n')}`;
  }

  /** Re-fetches a poll's message from CHAT_HISTORY and posts its current tally as a reply. Throws if the poll/mapping can't be found — callers decide whether that's worth surfacing. */
  async function postPollResults(maxChatId: unknown, maxMessageId: unknown, telegramMessageId: number): Promise<void> {
    const mapping = await chatMapStore.getByMaxChatId(maxChatId);
    if (!mapping) throw new Error(`No Telegram topic mapped for MAX chat ${String(maxChatId)}`);
    const history = await max.getChatHistory(maxChatId, Date.now(), 50);
    const msg = history.find((m) => String(m.id) === String(maxMessageId));
    const pollAttach = (Array.isArray(msg?.attaches) ? msg.attaches : []).find((a) => (a as MaxAttachment)._type === 'POLL') as
      | MaxAttachment
      | undefined;
    if (!pollAttach) throw new Error(`Poll message ${String(maxMessageId)} not found in chat ${String(maxChatId)} history`);
    const text = await formatPollResultsText(pollAttach);
    await bot.telegram.sendMessage(targetGroupId, text, {
      message_thread_id: mapping.telegramTopicId,
      reply_parameters: { message_id: telegramMessageId },
    });
  }

  /** On-demand poll results. Reply to the poll message with /poll to use it. */
  bot.command('poll', async (ctx) => {
    const topicId = ctx.message.message_thread_id;
    if (!topicId) return;
    const replyTo = (ctx.message as { reply_to_message?: { message_id: number } }).reply_to_message;
    if (!replyTo) {
      await bot.telegram.sendMessage(targetGroupId, 'Ответь этой командой на сообщение с опросом.', { message_thread_id: topicId });
      return;
    }
    const link = messageLinks.getByTelegram(replyTo.message_id);
    if (!link) {
      await bot.telegram.sendMessage(targetGroupId, 'Не нашёл опрос, связанный с этим сообщением.', { message_thread_id: topicId });
      return;
    }
    try {
      await postPollResults(link.maxChatId, link.maxMessageId, replyTo.message_id);
    } catch (err) {
      logger.error('Failed to fetch poll results', err);
      await bot.telegram.sendMessage(targetGroupId, 'Не удалось получить результаты опроса.', { message_thread_id: topicId });
    }
  });

  /** Creates a MAX group and its Telegram topic. Usable from any topic (or General) — there's no existing topic to reply from yet. */
  bot.command('newgroup', async (ctx) => {
    const title = (ctx as unknown as { payload?: string }).payload?.trim();
    if (!title) {
      await bot.telegram.sendMessage(targetGroupId, 'Использование: /newgroup <название>');
      return;
    }
    try {
      const { chatId } = await max.createGroup(title, []);
      const { topicId } = await ensureTopicForMaxChat(bot, targetGroupId, chatId, chatMapStore, title);
      await bot.telegram.sendMessage(targetGroupId, `✅ Группа «${title}» создана. Пригласить участников: /invite <MAX ID> в этой теме.`, {
        message_thread_id: topicId,
      });
    } catch (err) {
      logger.error('Failed to create MAX group', err);
      await bot.telegram.sendMessage(targetGroupId, 'Не удалось создать группу.');
    }
  });

  bot.command('invite', async (ctx) => {
    const topicId = ctx.message.message_thread_id;
    if (!topicId) return;
    const mapping = await chatMapStore.getByTopicId(topicId);
    if (!mapping) return;
    const userId = Number((ctx as unknown as { payload?: string }).payload?.trim());
    if (Number.isNaN(userId)) {
      await bot.telegram.sendMessage(targetGroupId, 'Использование: /invite <MAX ID>', { message_thread_id: topicId });
      return;
    }
    try {
      await max.updateChatMembers(mapping.maxChatId, [userId], 'add');
      await bot.telegram.sendMessage(targetGroupId, `✅ Приглашён MAX ID ${userId}.`, { message_thread_id: topicId });
    } catch (err) {
      logger.error('Failed to invite chat member', err);
      await bot.telegram.sendMessage(targetGroupId, 'Не удалось пригласить участника.', { message_thread_id: topicId });
    }
  });

  bot.command('kick', async (ctx) => {
    const topicId = ctx.message.message_thread_id;
    if (!topicId) return;
    const mapping = await chatMapStore.getByTopicId(topicId);
    if (!mapping) return;
    const userId = Number((ctx as unknown as { payload?: string }).payload?.trim());
    if (Number.isNaN(userId)) {
      await bot.telegram.sendMessage(targetGroupId, 'Использование: /kick <MAX ID>', { message_thread_id: topicId });
      return;
    }
    try {
      await max.updateChatMembers(mapping.maxChatId, [userId], 'remove');
      await bot.telegram.sendMessage(targetGroupId, `✅ Удалён MAX ID ${userId}.`, { message_thread_id: topicId });
    } catch (err) {
      logger.error('Failed to remove chat member', err);
      await bot.telegram.sendMessage(targetGroupId, 'Не удалось удалить участника.', { message_thread_id: topicId });
    }
  });

  bot.command('rename', async (ctx) => {
    const topicId = ctx.message.message_thread_id;
    if (!topicId) return;
    const mapping = await chatMapStore.getByTopicId(topicId);
    if (!mapping) return;
    const title = (ctx as unknown as { payload?: string }).payload?.trim();
    if (!title) {
      await bot.telegram.sendMessage(targetGroupId, 'Использование: /rename <новое название>', { message_thread_id: topicId });
      return;
    }
    try {
      await max.updateChatInfo(mapping.maxChatId, { title });
      await chatMapStore.upsert({ ...mapping, title });
      await bot.telegram.editForumTopic(targetGroupId, topicId, { name: title }).catch(() => undefined);
      // Confirmed live 2026-08-10: MAX sometimes silently keeps the old title despite
      // an OK response (same class of quirk as avatarId being accepted-but-ignored) —
      // so this is what we asked for, not a guarantee of what MAX actually applied.
      await bot.telegram.sendMessage(targetGroupId, `Запросил переименование в «${title}».`, { message_thread_id: topicId });
    } catch (err) {
      logger.error('Failed to rename chat', err);
      await bot.telegram.sendMessage(targetGroupId, 'Не удалось переименовать группу.', { message_thread_id: topicId });
    }
  });

  bot.command('setdesc', async (ctx) => {
    const topicId = ctx.message.message_thread_id;
    if (!topicId) return;
    const mapping = await chatMapStore.getByTopicId(topicId);
    if (!mapping) return;
    const description = (ctx as unknown as { payload?: string }).payload?.trim();
    if (!description) {
      await bot.telegram.sendMessage(targetGroupId, 'Использование: /setdesc <описание>', { message_thread_id: topicId });
      return;
    }
    try {
      await max.updateChatInfo(mapping.maxChatId, { description });
      await bot.telegram.sendMessage(targetGroupId, '✅ Описание обновлено.', { message_thread_id: topicId });
    } catch (err) {
      logger.error('Failed to update chat description', err);
      await bot.telegram.sendMessage(targetGroupId, 'Не удалось обновить описание.', { message_thread_id: topicId });
    }
  });

  /** Destructive — requires typing the confirmation word so a stray /leavegroup doesn't cost real chat history. */
  bot.command('leavegroup', async (ctx) => {
    const topicId = ctx.message.message_thread_id;
    if (!topicId) return;
    const mapping = await chatMapStore.getByTopicId(topicId);
    if (!mapping) return;
    const confirm = (ctx as unknown as { payload?: string }).payload?.trim().toUpperCase();
    if (confirm !== 'ПОДТВЕРДИТЬ') {
      await bot.telegram.sendMessage(targetGroupId, '⚠️ Это выход из группы на стороне MAX. Для подтверждения: /leavegroup ПОДТВЕРДИТЬ', {
        message_thread_id: topicId,
      });
      return;
    }
    try {
      await max.leaveChat(mapping.maxChatId);
      await bot.telegram.sendMessage(targetGroupId, '✅ Вышел из группы на стороне MAX.', { message_thread_id: topicId });
    } catch (err) {
      logger.error('Failed to leave chat', err);
      await bot.telegram.sendMessage(targetGroupId, 'Не удалось выйти из группы.', { message_thread_id: topicId });
    }
  });

  /** Destructive and, with ВСЕМ, irreversible for every participant — requires an explicit confirmation phrase, not just the bare command. */
  bot.command('deletegroup', async (ctx) => {
    const topicId = ctx.message.message_thread_id;
    if (!topicId) return;
    const mapping = await chatMapStore.getByTopicId(topicId);
    if (!mapping) return;
    const args = (ctx as unknown as { payload?: string }).payload?.trim().toUpperCase().split(/\s+/) ?? [];
    if (args[0] !== 'УДАЛИТЬ') {
      await bot.telegram.sendMessage(
        targetGroupId,
        '⚠️ Это удаление группы на стороне MAX. /deletegroup УДАЛИТЬ — удалить только у себя. /deletegroup УДАЛИТЬ ВСЕМ — удалить для всех участников (необратимо для них тоже).',
        { message_thread_id: topicId },
      );
      return;
    }
    const forAll = args[1] === 'ВСЕМ';
    const chat = getChats().find((c) => c && typeof c === 'object' && String((c as { id?: unknown }).id) === mapping.maxChatId) as
      | { lastEventTime?: unknown }
      | undefined;
    const lastEventTime = Number(chat?.lastEventTime);
    if (Number.isNaN(lastEventTime)) {
      await bot.telegram.sendMessage(targetGroupId, 'Не нашёл lastEventTime этого чата — попробуй чуть позже (после следующей синхронизации).', {
        message_thread_id: topicId,
      });
      return;
    }
    try {
      await max.deleteChat(mapping.maxChatId, lastEventTime, forAll);
      await bot.telegram.sendMessage(targetGroupId, `✅ Группа удалена ${forAll ? 'для всех' : 'у меня'}.`, { message_thread_id: topicId });
    } catch (err) {
      logger.error('Failed to delete chat', err);
      await bot.telegram.sendMessage(targetGroupId, 'Не удалось удалить группу.', { message_thread_id: topicId });
    }
  });

  /**
   * Nukes every Telegram topic + all local MAX<->Telegram state (persisted chat map,
   * in-memory message/poll links) and re-runs the full backfill from scratch — for
   * when something's drifted enough that "just redeploy" won't fix it. Not scoped to
   * a topic (unlike the other group-management commands) since it acts on the whole
   * bridge group. MAX's own data is untouched — this only resets OUR view of it.
   */
  bot.command('reboot', async (ctx) => {
    const confirm = (ctx as unknown as { payload?: string }).payload?.trim().toUpperCase();
    if (confirm !== 'ПОДТВЕРДИТЬ') {
      await bot.telegram.sendMessage(
        targetGroupId,
        '⚠️ Это удалит ВСЕ темы и историю в этой Telegram-группе (сообщения в MAX не пострадают) и запустит полную пересинхронизацию с нуля. Подтверди: /reboot ПОДТВЕРДИТЬ',
      );
      return;
    }
    try {
      const mappings = await chatMapStore.list();
      await bot.telegram.sendMessage(targetGroupId, `🔄 Удаляю ${mappings.length} тем и запускаю полную пересинхронизацию...`);
      for (const mapping of mappings) {
        await bot.telegram.deleteForumTopic(targetGroupId, mapping.telegramTopicId).catch((err) => {
          logger.error(`Failed to delete Telegram topic ${mapping.telegramTopicId} during reboot`, err);
        });
        await sleep(HISTORY_SEND_DELAY_MS);
      }
      await chatMapStore.clear();
      messageLinks.clear();
      pollLinks.clear();
      triggerFullResync().catch((err) => logger.error('Full resync after /reboot failed', err));
      await bot.telegram.sendMessage(targetGroupId, '✅ Пересинхронизация запущена — темы появятся по мере обработки.');
    } catch (err) {
      logger.error('Reboot failed', err);
      await bot.telegram.sendMessage(targetGroupId, 'Не удалось выполнить reboot.');
    }
  });

  /**
   * Beyond everything /reboot wipes, this also logs the bridge OUT of MAX: deletes
   * the encrypted session file (server/app.ts's killEverything), so a fresh SMS
   * login is required before the bridge can do anything again. No known MAX opcode
   * for a real server-side logout was ever reverse-engineered, so this is a local
   * "forget the credentials and disconnect" — the session token itself may remain
   * valid on MAX's servers until it naturally expires, we just stop holding it.
   * The process keeps running so the web UI stays reachable to re-authenticate.
   */
  bot.command('kill', async (ctx) => {
    const confirm = (ctx as unknown as { payload?: string }).payload?.trim().toUpperCase();
    if (confirm !== 'УНИЧТОЖИТЬ') {
      await bot.telegram.sendMessage(
        targetGroupId,
        '☢️ Это разлогинит MAX-сессию (после потребуется новая SMS-авторизация через веб-панель) и удалит ВСЕ темы, историю и связки в этой Telegram-группе. Необратимо. Подтверди: /kill УНИЧТОЖИТЬ',
      );
      return;
    }
    try {
      const mappings = await chatMapStore.list();
      await bot.telegram.sendMessage(targetGroupId, `☢️ Удаляю ${mappings.length} тем, разлогиниваю MAX и стираю все данные...`);
      for (const mapping of mappings) {
        await bot.telegram.deleteForumTopic(targetGroupId, mapping.telegramTopicId).catch((err) => {
          logger.error(`Failed to delete Telegram topic ${mapping.telegramTopicId} during kill`, err);
        });
        await sleep(HISTORY_SEND_DELAY_MS);
      }
      await chatMapStore.clear();
      messageLinks.clear();
      pollLinks.clear();
      await killEverything();
      await bot.telegram.sendMessage(
        targetGroupId,
        '✅ Готово. MAX-сессия удалена, все данные стёрты. Чтобы продолжить — авторизуйся заново через веб-панель.',
      );
    } catch (err) {
      logger.error('Kill failed', err);
      await bot.telegram.sendMessage(targetGroupId, 'Не удалось выполнить kill.');
    }
  });

  /** Reply to a message with /delete to remove it on MAX (and, since we sent it, on Telegram too). */
  bot.command('delete', async (ctx) => {
    const topicId = ctx.message.message_thread_id;
    if (!topicId) return;
    const replyTo = (ctx.message as { reply_to_message?: { message_id: number } }).reply_to_message;
    if (!replyTo) {
      await bot.telegram.sendMessage(targetGroupId, 'Ответь этой командой на сообщение, которое нужно удалить. /delete me — удалить только у себя.', {
        message_thread_id: topicId,
      });
      return;
    }
    const link = messageLinks.getByTelegram(replyTo.message_id);
    if (!link) {
      await bot.telegram.sendMessage(targetGroupId, 'Не нашёл это сообщение в связке с MAX.', { message_thread_id: topicId });
      return;
    }
    const forMe = (ctx as unknown as { payload?: string }).payload?.trim().toLowerCase() === 'me';
    try {
      await max.deleteMessages(link.maxChatId, [link.maxMessageId], forMe);
      await bot.telegram.deleteMessage(targetGroupId, replyTo.message_id).catch((err) => logger.error('Failed to delete Telegram message', err));
    } catch (err) {
      logger.error('Failed to delete MAX message', err);
      await bot.telegram.sendMessage(targetGroupId, 'Не удалось удалить сообщение.', { message_thread_id: topicId });
    }
  });

  bot.on('message', async (ctx) => {
    const topicId = ctx.message.message_thread_id;
    if (!topicId) return;
    const mapping = await chatMapStore.getByTopicId(topicId);
    if (!mapping) return;

    const forwardPrefix = describeForwardOrigin((ctx.message as { forward_origin?: TelegramForwardOrigin }).forward_origin);
    const rawText = (ctx.message as { text?: string; caption?: string }).text;
    const rawCaption = (ctx.message as { caption?: string }).caption ?? '';
    const text = forwardPrefix ? (rawText ? `${forwardPrefix}\n${rawText}` : undefined) : rawText;
    const caption = forwardPrefix ? (rawCaption ? `${forwardPrefix}\n${rawCaption}` : forwardPrefix) : rawCaption;
    const photo = (ctx.message as { photo?: Array<{ file_id: string }> }).photo;
    const document = (ctx.message as { document?: { file_id: string; file_name?: string } }).document;
    // GIFs — MAX only takes these as FILE. Telegram represents a forwarded GIF as `document`
    // in practice (confirmed live 2026-08-07), but `animation` is the dedicated type, so handle both.
    const animation = (ctx.message as { animation?: { file_id: string; file_name?: string } }).animation;
    const video = (ctx.message as { video?: { file_id: string; file_name?: string } }).video;
    const videoNote = (ctx.message as { video_note?: { file_id: string } }).video_note;
    const voice = (ctx.message as { voice?: { file_id: string; duration?: number } }).voice;
    const sticker = (ctx.message as { sticker?: { file_id: string; is_animated?: boolean; is_video?: boolean } }).sticker;
    const poll = (ctx.message as { poll?: { id: string; question: string; options: Array<{ text: string }>; is_anonymous: boolean; allows_multiple_answers: boolean } }).poll;
    const location = (ctx.message as { location?: { latitude: number; longitude: number } }).location;
    const contact = (ctx.message as { contact?: { phone_number: string; first_name: string; last_name?: string } }).contact;

    try {
      if (location) {
        const locationAttach = { _type: 'LOCATION', latitude: location.latitude, longitude: location.longitude, zoom: 14 };
        const { cid, messageId } = await max.sendMessage(mapping.maxChatId, null, [locationAttach]);
        rememberOutgoingSend(mapping.maxChatId, cid);
        messageLinks.add({ maxChatId: mapping.maxChatId, maxMessageId: messageId, telegramMessageId: ctx.message.message_id });
        return;
      }

      if (contact) {
        // Unlike the contactId-reference shape, MAX's vCard-style CONTACT attach is
        // self-contained (phone/name right on it) — no existing-MAX-user lookup needed,
        // so an arbitrary Telegram contact can go over as a real card, not just text.
        const lastName = contact.last_name ?? '';
        const contactAttach = {
          _type: 'CONTACT',
          firstName: contact.first_name,
          lastName,
          phone: contact.phone_number,
          vcfBody: buildVcard(contact.first_name, lastName, contact.phone_number),
          name: contact.first_name,
        };
        const { cid, messageId } = await max.sendMessage(mapping.maxChatId, null, [contactAttach]);
        rememberOutgoingSend(mapping.maxChatId, cid);
        messageLinks.add({ maxChatId: mapping.maxChatId, maxMessageId: messageId, telegramMessageId: ctx.message.message_id });
        return;
      }

      if (poll) {
        const settings = (poll.is_anonymous ? 1 : 0) | (poll.allows_multiple_answers ? 2 : 0);
        const pollAttach = {
          _type: 'POLL',
          title: poll.question,
          answers: poll.options.map((o) => ({ text: o.text, answerId: null })),
          settings,
        };
        const { cid, messageId, attaches } = await max.sendMessage(mapping.maxChatId, null, [pollAttach]);
        rememberOutgoingSend(mapping.maxChatId, cid);
        messageLinks.add({ maxChatId: mapping.maxChatId, maxMessageId: messageId, telegramMessageId: ctx.message.message_id });
        const createdPoll = attaches.find((a) => (a as MaxAttachment)._type === 'POLL') as MaxAttachment | undefined;
        if (createdPoll?.pollId != null) {
          pollLinks.add(poll.id, {
            maxChatId: mapping.maxChatId,
            maxMessageId: messageId,
            maxPollId: createdPoll.pollId,
            answerIdByOptionIndex: (createdPoll.answers ?? []).map((a, i) => Number(a.answerId ?? i + 1)),
          });
        }
        return;
      }

      if (text) {
        const { cid, messageId } = await max.sendMessage(mapping.maxChatId, text);
        rememberOutgoingSend(mapping.maxChatId, cid);
        messageLinks.add({ maxChatId: mapping.maxChatId, maxMessageId: messageId, telegramMessageId: ctx.message.message_id });
        return;
      }

      let attach: Record<string, unknown> | null = null;
      const largestPhoto = photo?.[photo.length - 1];
      if (largestPhoto) {
        attach = await uploadTelegramAttachmentToMax(bot, max, largestPhoto.file_id, 'photo');
      } else if (video) {
        attach = await uploadTelegramAttachmentToMax(bot, max, video.file_id, 'video', video.file_name ?? 'video.mp4');
      } else if (videoNote) {
        // No confirmed MAX-side "round video" flag (unlike voice's type:2) — goes
        // through the same working video pipeline, so it may land as a regular
        // rectangular video on MAX rather than a circle.
        attach = await uploadTelegramAttachmentToMax(bot, max, videoNote.file_id, 'video', 'video_note.mp4');
      } else if (document) {
        attach = await uploadTelegramAttachmentToMax(bot, max, document.file_id, 'document', document.file_name ?? 'file');
      } else if (animation) {
        attach = await uploadTelegramAttachmentToMax(bot, max, animation.file_id, 'document', animation.file_name ?? 'animation.gif');
      } else if (voice) {
        attach = await uploadTelegramAttachmentToMax(bot, max, voice.file_id, 'voice', 'voice.ogg', voice.duration ?? 0);
      } else if (sticker) {
        // No confirmed MAX-side sticker-upload opcode. Static webp is a real raster
        // image, so it goes through the PHOTO pipeline to render inline (confirmed
        // live 2026-08-13). Video stickers (webm) are a real video container, so they
        // go through the proven VIDEO_UPLOAD pipeline directly. Animated (tgs/Lottie)
        // stickers get rendered to a WebM first (see lottie.ts) — MAX's own animated
        // stickers arrive as autoplaying VIDEO attaches, so this lands the same way.
        if (sticker.is_video) {
          attach = await uploadTelegramAttachmentToMax(bot, max, sticker.file_id, 'video', 'sticker.webm');
        } else if (sticker.is_animated) {
          attach = await uploadTelegramAttachmentToMax(bot, max, sticker.file_id, 'sticker_animated');
        } else {
          attach = await uploadTelegramAttachmentToMax(bot, max, sticker.file_id, 'photo');
        }
      }
      if (!attach) return; // nothing we know how to forward

      const { cid, messageId } = await max.sendMessage(mapping.maxChatId, caption, [attach]);
      rememberOutgoingSend(mapping.maxChatId, cid);
      messageLinks.add({ maxChatId: mapping.maxChatId, maxMessageId: messageId, telegramMessageId: ctx.message.message_id });
    } catch (err) {
      logger.error('Telegram -> MAX forward failed', err);
    }
  });

  bot.on('edited_message', async (ctx) => {
    const topicId = ctx.editedMessage.message_thread_id;
    if (!topicId) return;
    const mapping = await chatMapStore.getByTopicId(topicId);
    if (!mapping) return;
    const link = messageLinks.getByTelegram(ctx.editedMessage.message_id);
    if (!link) return;
    const newText = (ctx.editedMessage as { text?: string; caption?: string }).text ?? (ctx.editedMessage as { caption?: string }).caption;
    if (newText == null) return;
    try {
      await max.editMessage(mapping.maxChatId, link.maxMessageId, newText);
    } catch (err) {
      logger.error('Failed to relay Telegram edit to MAX', err);
    }
  });

  bot.on('message_reaction', async (ctx) => {
    const update = ctx.messageReaction;
    const link = messageLinks.getByTelegram(update.message_id);
    if (!link) return;

    const oldEmojis = new Set(update.old_reaction.filter((r) => r.type === 'emoji').map((r) => r.emoji));
    const newEmojis = update.new_reaction.filter((r) => r.type === 'emoji').map((r) => r.emoji);
    const added = newEmojis.find((e) => !oldEmojis.has(e));

    try {
      if (added) {
        await max.addReaction(link.maxChatId, link.maxMessageId, added);
      } else if (newEmojis.length === 0 && oldEmojis.size > 0) {
        await max.removeReaction(link.maxChatId, link.maxMessageId);
      }
    } catch (err) {
      logger.error('Failed to relay Telegram reaction to MAX', err);
    }
  });

  // Telegram only tells a bot about votes on polls the bot itself sent — exactly
  // the polls this bridge mirrors, so pollLinks always has a match when it matters.
  // Note this can't run the other way: Telegram's native poll widget has no API for
  // injecting a vote cast by a MAX user, so votes cast on the MAX side don't show up
  // here even though the underlying poll message does get a repeat push on change.
  bot.on('poll_answer', async (ctx) => {
    const answer = ctx.pollAnswer;
    const link = pollLinks.getByTelegramPollId(answer.poll_id);
    if (!link) return;

    const answerIds = answer.option_ids.map((i) => link.answerIdByOptionIndex[i]).filter((id): id is number => id != null);
    try {
      await max.sendVote(link.maxChatId, link.maxMessageId, link.maxPollId, answerIds);
      const msgLink = messageLinks.getByMax(link.maxChatId, link.maxMessageId);
      if (msgLink) {
        // Best-effort — the vote itself already landed on MAX even if this fails.
        await postPollResults(link.maxChatId, link.maxMessageId, msgLink.telegramMessageId).catch((err) =>
          logger.error('Failed to auto-post poll results after Telegram vote', err),
        );
      }
    } catch (err) {
      logger.error('Failed to relay Telegram poll vote to MAX', err);
    }
  });

  return { messageLinks };
}

/**
 * Ensures every MAX chat has a Telegram topic, backfilling brand-new topics
 * with the chat's full history (paginated via CHAT_HISTORY, oldest-first) so
 * Telegram isn't empty on first contact. For chats already synced, runs a
 * cheap cursor-bounded catch-up instead — cursor-filtered CHAT_HISTORY, not a
 * push, so it also recovers messages that arrived during the gap between
 * disconnect and reconnect (a live push is otherwise lost forever if it
 * arrives while we're offline — hit live 2026-08-12, mid-redeploy). Safe to
 * call on every LOGIN (fresh auth or a reconnect's resumed session).
 */
export async function syncAllChatsToTelegram(
  bot: Telegraf,
  chatMapStore: ChatMapStore,
  targetGroupId: string,
  chats: unknown[],
  resolveDisplayName: (chat: unknown) => string,
  max: MaxClient,
  messageLinks: MessageLinkStore,
  myAccountId: number | null,
  contactProfiles: Map<number, ContactProfile>,
): Promise<void> {
  for (const chat of chats) {
    if (!chat || typeof chat !== 'object') continue;
    const c = chat as { id?: unknown; type?: string; status?: string; participants?: Record<string, unknown>; lastMessage?: { text?: string } };
    if (c.id == null) continue;
    // CHATS_LIST keeps returning chats the account left/closed (status "CLOSED") —
    // MAX's own client hides those, so mirror that instead of creating a Telegram
    // topic for an abandoned test group every full resync (confirmed live 2026-08-13).
    if (c.status && c.status !== 'ACTIVE') continue;

    try {
      const name = resolveDisplayName(chat);
      const { topicId, created } = await ensureTopicForMaxChat(bot, targetGroupId, c.id, chatMapStore, name);
      if (created) {
        // Same intro card the live-push path sends on first contact (sendAutoInfoCard) —
        // this bulk-sync path (used by /reboot and startup resync) never went through
        // that code and silently skipped it for every topic it creates.
        const participantIds = c.participants ? Object.keys(c.participants).map(Number) : [];
        const otherId = participantIds.find((id) => id !== myAccountId);
        const participantCount = c.participants ? participantIds.length : undefined;
        try {
          const messageId = await sendContactInfoCard(bot, targetGroupId, topicId, name, c.type, participantCount, otherId, otherId != null ? contactProfiles.get(otherId) : undefined);
          await pinInfoCard(bot, targetGroupId, messageId);
        } catch (err) {
          logger.error('Failed to send auto contact-info card', err);
        }
      }
      const mapping = await chatMapStore.getByMaxChatId(c.id);
      const cursor = mapping?.historyBackfillCursor != null ? Number(mapping.historyBackfillCursor) : null;
      const history = await fetchFullHistory(max, c.id, cursor);
      if (history.length > 0) {
        logger.info(`${cursor == null ? 'Backfilling' : 'Catching up on'} ${history.length} messages for MAX chat ${String(c.id)}`);
        await backfillHistoryToTelegram(bot, targetGroupId, topicId, history, max, c.id, messageLinks, chatMapStore, chats);
      }
      await chatMapStore.markHistorySynced(c.id);
    } catch (err) {
      logger.error(`Failed to sync MAX chat ${c.id} to Telegram`, err);
    }
  }
}
