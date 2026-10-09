import path from 'node:path';
import { rm, stat, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { Markup, type Telegraf } from 'telegraf';
import type { ChatAction, TelegramEmoji } from 'telegraf/types';
import type { MaxClient, MaxMessageEvent, MaxHistoryMessage } from '../max/client.js';
import { OPCODES, formatOpcode } from '../max/opcodes.js';
import { resolveContactDisplayName, resolveChatName, isFallbackTitle, type ContactProfile } from '../max/names.js';
import { cursorToMs, type ChatMapStore } from '../store/chatMapStore.js';
import { ensureTopicForMaxChat, clampTopicTitle } from '../telegram/bot.js';
import {
  downloadMaxAttachment,
  describeAttachment,
  telegramSendKind,
  TELEGRAM_UPLOAD_LIMIT_BYTES,
  takeKeyboard,
  KEYBOARD_NA,
  KEYBOARD_PRESS,
  KEYBOARD_GEO,
  KEYBOARD_CONTACT,
  pressableButton,
  type MaxAttachment,
  type DownloadContext,
} from './attachments.js';
import { splitTelegramText, truncateCodePoints, truncateUtf16, MAX_TEXT_LIMIT, TELEGRAM_CAPTION_LIMIT, TELEGRAM_TEXT_LIMIT } from './text.js';
import { uploadTelegramAttachmentToMax } from './upload.js';
import { FileShare, fileShareOptionsFromEnv, TELEGRAM_BOT_DOWNLOAD_LIMIT } from './fileShare.js';
import { createBigFiles } from './bigFiles.js';
import { canRenderAnimatedStickers } from './lottie.js';
import { reportBridgeError } from './errorReporter.js';
import { wireControlPanel, type PauseControl } from './panel.js';
import { createBugReports, isBugReportInboxEnabled, BUGREPORT_BOT_HANDLE, type BugReports } from './bugReports.js';
import { createMaxAuthFlow, type MaxAuthCallbacks } from './maxAuthFlow.js';
import { createTelemetry } from './telemetry.js';
import { checkVersion, type VersionStatus } from './version.js';
import { buildStatusText, collectHostStats, maskPhone } from './status.js';
import { toTelegramReaction } from '../max/reactions.js';
import { ChatBannedError, StrikeCounter, SyncCancelledError, liveCursorTime } from './catchUp.js';
import { isThreadNotFound, isTransientMaxError, isTransientTelegramError, TransientDownloadError, withFloodRetry } from './transient.js';
import { createLogger, jsonStringify, redactSecrets } from '../logger.js';

const logger = createLogger('bridge');

/** Matches the exact VCARD 2.1 shape MAX itself sends for a self-contained CONTACT attach. */
function buildVcard(firstName: string, lastName: string, phone: string): string {
  const fullName = [firstName, lastName].filter(Boolean).join(' ');
  return `BEGIN:VCARD\r\nVERSION:2.1\r\nN:${lastName};${firstName};;;\r\nFN:${fullName}\r\nTEL;CELL:${phone}\r\nEND:VCARD\r\n`;
}

/**
 * Telegram's own forward metadata (Bot API 7.0+ `forward_origin`) — present on any message dragged
 * in from elsewhere in Telegram. A drag-forward relays like any other message; this only adds the
 * "↩️ Переслано..." label (no dedicated /fwd command).
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

/**
 * A human label for Telegram message content the bridge has no MAX equivalent for, so the topic
 * can say it was NOT relayed instead of it vanishing silently. Null for anything else — service
 * updates (pins, joins, …) must stay silent. Pure + exported for unit testing.
 */
export function describeUnrelayableTelegramMessage(message: object): string | null {
  const m = message as Record<string, unknown>;
  if (m.dice) {
    const emoji = (m.dice as { emoji?: unknown }).emoji;
    return typeof emoji === 'string' && emoji ? `кубик ${emoji}` : 'кубик';
  }
  if (m.story) return 'история';
  if (m.game) return 'игра';
  if (m.paid_media) return 'платное медиа';
  if (m.invoice) return 'счёт на оплату';
  if (m.giveaway || m.giveaway_winners) return 'розыгрыш';
  if (m.checklist) return 'чек-лист';
  return null;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Decay ladder for the deletion probe — how long to wait between pings for one of our own relayed
 * messages, by its age: dense right after send (≈90% of deletions land in the first minutes),
 * thinning out over hours, then `null` = stop probing. Pure + exported for unit testing.
 */
export function probeIntervalMs(ageMs: number): number | null {
  if (ageMs < 2 * 60_000) return 15_000;
  if (ageMs < 15 * 60_000) return 60_000;
  if (ageMs < 60 * 60_000) return 5 * 60_000;
  if (ageMs < 6 * 60 * 60_000) return 30 * 60_000;
  return null;
}

/**
 * Classifies a failed empty-`setMessageReaction` probe from its error text: a live message errors
 * `REACTION_EMPTY`, a deleted one `message to react not found` (confirmed live 2026-08-15). 'gone'
 * ONLY on the exact not-found shapes — never on 429/network — because a false 'gone' would
 * irreversibly delete a still-live message on MAX. Pure + exported for unit testing.
 */
export function classifyProbeResult(errText: string): 'alive' | 'gone' | 'unknown' {
  const t = errText.toLowerCase();
  if (t.includes('reaction_empty')) return 'alive';
  if (
    t.includes('message to react not found') ||
    t.includes('message not found') ||
    t.includes('message to delete not found') ||
    // A deleted USER message answers MESSAGE_ID_INVALID, not "not found" (confirmed live
    // 2026-08-15). Safe as 'gone': a live id answers REACTION_EMPTY, a rate limit 429.
    t.includes('message_id_invalid')
  ) {
    return 'gone';
  }
  return 'unknown';
}

/**
 * Telegram refused the emoji itself (outside its fixed reaction set) — the probe
 * re-affirming a relayed MAX reaction then learns nothing about the message, so it
 * retries once with an empty set. Pure + exported for unit testing.
 */
export function isReactionInvalid(errText: string): boolean {
  return /reaction_invalid|reaction_not_allowed/i.test(errText);
}

/**
 * Pre-flight for one outgoing link before the deletion probe may touch it. A 'gone' probe ends in
 * an irreversible forAll delete on MAX, so anything that means "the whole topic went away" rather
 * than "the owner deleted this one message" drops the link here: no mapping (chat closed, /reboot,
 * /kill), a banned chat, or a mapping now pointing at a different topic than the one the message
 * was written in (deleted and recreated). Pure + exported for unit testing.
 */
export function probeLinkGuard(link: { telegramTopicId?: number }, mapping: { telegramTopicId: number; banned?: boolean } | undefined): 'probe' | 'drop' {
  if (!mapping || mapping.banned) return 'drop';
  if (link.telegramTopicId != null && link.telegramTopicId !== mapping.telegramTopicId) return 'drop';
  return 'probe';
}

/**
 * Classifies a no-op rename (editForumTopic with the topic's current name) used as an existence
 * check: a live topic answers TOPIC_NOT_MODIFIED (or ok, when the name did differ), a deleted one
 * TOPIC_ID_INVALID. sendChatAction and a field-less editForumTopic answer ok for a DELETED topic
 * (confirmed live 2026-09-29: the probe trusted sendChatAction and mirror-deleted the owner's MAX
 * messages along with a topic deleted by hand). `null` = the call succeeded. Pure + exported.
 */
export function classifyTopicProbe(errText: string | null): 'alive' | 'gone' | 'unknown' {
  if (errText == null || /TOPIC_NOT_MODIFIED/i.test(errText)) return 'alive';
  return isThreadNotFound(errText) ? 'gone' : 'unknown';
}

/** Does the forum topic still exist? 'unknown' on anything inconclusive (429, network, no title to rename to). */
export async function probeTopic(bot: Pick<Telegraf, 'telegram'>, groupId: string, topicId: number, title: string | undefined): Promise<'alive' | 'gone' | 'unknown'> {
  const name = clampTopicTitle(title);
  if (!name) return 'unknown';
  try {
    await bot.telegram.editForumTopic(groupId, topicId, { name });
    return 'alive';
  } catch (err) {
    const description = (err as { response?: { description?: string } })?.response?.description;
    return classifyTopicProbe(String(description ?? (err as Error)?.message ?? err));
  }
}

/**
 * Is this system CONTROL text MAX's «Чат закрыт»? The exact phrase only: the answer deletes the
 * topic with its history, and any other notice that merely contains «закрыт» must not.
 * Pure + exported for unit testing.
 */
export function isChatClosedNotice(text: unknown): boolean {
  return typeof text === 'string' && /^чат закрыт\.?$/i.test(text.trim());
}

/**
 * How a relayed MAX message's Telegram copies are linked: the first text piece (or, with no text,
 * the first attachment) is the anchor edits/replies/reactions use; every other message it produced
 * (further text pieces, every attachment of an album) goes into extraTelegramMessageIds, so deleting
 * the MAX message deletes all of them. Pure + exported for unit testing.
 */
export function buildLinkIds(
  textIds: readonly number[],
  attachIds: readonly number[],
): { telegramMessageId: number; extraTelegramMessageIds?: number[] } | undefined {
  const all = [...new Set([...textIds, ...attachIds])];
  if (all.length === 0) return undefined;
  const [telegramMessageId, ...extra] = all as [number, ...number[]];
  return { telegramMessageId, ...(extra.length > 0 ? { extraTelegramMessageIds: extra } : {}) };
}

/**
 * Telegram refused THIS message for good (400 bad request, 413 too large, …) — worth degrading
 * to a text placeholder instead of failing the whole MAX message. Not a deleted topic (the caller
 * recreates it and replays), and not a transient failure (429/5xx/network — the caller retries
 * later; a placeholder now would stand in for a file that can still arrive).
 */
export function isPermanentTelegramRefusal(err: unknown): boolean {
  return !(err instanceof TransientDownloadError) && !isThreadNotFound(err) && !isTransientTelegramError(err);
}

function telegramErrorText(err: unknown): string {
  return String((err as { response?: { description?: string } })?.response?.description ?? (err as Error)?.message ?? '');
}

/** Telegram refused the message because of its inline keyboard (BUTTON_URL_INVALID, BUTTON_COPY_TEXT_INVALID, …). */
export function isMarkupRefusal(err: unknown): boolean {
  return /BUTTON_|reply markup/i.test(telegramErrorText(err));
}

/** Two inline keyboards as one, `a`'s rows first; undefined when neither exists. */
function joinMarkups(a: InlineMarkup | undefined, b: InlineMarkup | undefined): InlineMarkup | undefined {
  return a && b ? { inline_keyboard: [...a.inline_keyboard, ...b.inline_keyboard] } : (a ?? b);
}

/**
 * Sends a text that may exceed Telegram's 4096-unit limit as consecutive messages
 * (splitTelegramText), each through withFloodRetry; the reply goes on the first piece, the inline
 * keyboard on the last. Returns every sent message_id in order; `sent`, when given, gets each id
 * as soon as it is sent, so a caller knows what went out when a later piece throws.
 */
export async function sendTextPieces(
  bot: Telegraf,
  groupId: string,
  topicId: number,
  text: string,
  extra: {
    replyParameters?: { message_id: number; allow_sending_without_reply: boolean };
    replyMarkup?: InlineMarkup;
    paceMs?: number;
    sent?: number[];
    /** Only names the message in the log when Telegram refuses its keyboard. */
    maxMessageId?: unknown;
  } = {},
): Promise<number[]> {
  const pieces = splitTelegramText(text);
  const ids: number[] = [];
  for (let i = 0; i < pieces.length; i++) {
    const piece = pieces[i] as string;
    const send = (markup?: InlineMarkup) =>
      withFloodRetry(() =>
        bot.telegram.sendMessage(groupId, piece, {
          message_thread_id: topicId,
          ...(i === 0 && extra.replyParameters ? { reply_parameters: extra.replyParameters } : {}),
          ...(markup ? { reply_markup: markup } : {}),
        }),
      );
    const markup = i === pieces.length - 1 ? extra.replyMarkup : undefined;
    // A button Telegram refuses must not cost the message: it goes out again without the keyboard.
    const sent = await send(markup).catch((err) => {
      if (!markup || !isMarkupRefusal(err)) throw err;
      logger.info(`Telegram refused the keyboard of MAX message ${String(extra.maxMessageId)} (${telegramErrorText(err)}) — sent without it`);
      return send();
    });
    ids.push(sent.message_id);
    extra.sent?.push(sent.message_id);
    if (extra.paceMs) await sleep(extra.paceMs);
  }
  return ids;
}

/**
 * A MAX keyboard that had no text piece to ride on (an attachment-only or keyboard-only message)
 * goes out on a short message of its own, after the attachments. Returns its id(s) for the link.
 */
function sendKeyboardAlone(
  bot: Telegraf,
  groupId: string,
  topicId: number,
  keyboard: InlineMarkup,
  extra: Omit<NonNullable<Parameters<typeof sendTextPieces>[4]>, 'replyMarkup'>,
): Promise<number[]> {
  return sendTextPieces(bot, groupId, topicId, '⌨️', { ...extra, replyMarkup: keyboard });
}

/** Deletes the bot's own Telegram messages one by one, so one failure doesn't keep the rest. Never throws; `why` names the cause in the error log. */
async function deleteBotMessages(bot: Pick<Telegraf, 'telegram'>, groupId: string, ids: readonly number[], why: string): Promise<void> {
  for (const id of ids) {
    await bot.telegram.deleteMessage(groupId, id).catch((err) => logger.error(`Failed to delete Telegram message ${id} (${why})`, err));
  }
}

/**
 * A MAX message goes out as several Telegram messages. When a transient failure hits after some of
 * them went out, the next catch-up delivers the whole message again (it finds no link) — so the
 * parts already posted are deleted first, or they would show up twice. Best effort.
 */
export function discardPartialDelivery(bot: Pick<Telegraf, 'telegram'>, groupId: string, ids: readonly number[]): Promise<void> {
  return deleteBotMessages(bot, groupId, ids, 'left over from a partly delivered MAX message');
}

/** A failure after which the MAX message is delivered again later (the catch-up) — its partial parts must go. */
function isRetriedDeliveryFailure(err: unknown): boolean {
  return err instanceof TransientDownloadError || isTransientTelegramError(err);
}

/**
 * A MAX poll as plain text — the fallback when Telegram refuses it as a native poll (question over
 * 300 chars, an option over 100, fewer than 2 or more than 10 options). Voting stays on MAX.
 */
export function renderPollAsText(title: string | undefined, options: readonly string[], settings = 0): string {
  const flags = [(settings & 1) !== 0 ? 'анонимный' : '', (settings & 2) !== 0 ? 'несколько ответов' : ''].filter(Boolean);
  const lines = [`📊 Опрос: ${title || 'без названия'}${flags.length > 0 ? ` (${flags.join(', ')})` : ''}`];
  for (const option of options) lines.push(`• ${option}`);
  lines.push('', '💡 Голосовать — в MAX. Ответьте на это сообщение командой /poll, чтобы увидеть счёт.');
  return lines.join('\n');
}

interface MaxPushPayload {
  chatId?: unknown; // may be a plain number, BigInt, or (large/negative — e.g. channels) only representable as BigInt
  message?: {
    id?: unknown; // BigInt — needed for FILE_DOWNLOAD
    cid?: number;
    // MAX server ms timestamp (may be a BigInt), same field as in CHAT_HISTORY — feeds the cursor.
    time?: unknown;
    text?: string;
    sender?: unknown;
    attaches?: MaxAttachment[];
    // PUSH_MESSAGE (0x0080) is the single channel for new/edited/deleted messages: a repeat push
    // with the same message.id is an edit (status "EDITED") or a deletion ("REMOVED"); absent
    // means new. Confirmed 2026-08-13 — NOTIF_MSG_DELETE is apparently not how MAX signals it.
    status?: string;
    // Set when this message IS a forward: the wrapper's own text/attaches are empty, the real
    // content is in link.message (confirmed live 2026-08-13). Downloads need the ORIGINAL
    // message/chat ids — see forwardDownloadIds.
    link?:{ type?: string; message?: { id?: unknown; text?: string; sender?: unknown; attaches?: MaxAttachment[] }; chatId?: unknown };
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
  // Every further Telegram message the MAX message produced (a forward's prefix + attachment, a
  // split text, an album) — deleted together with the anchor. Confirmed live 2026-08-13.
  extraTelegramMessageIds?: number[];
  // True when WE sent this to MAX. Only our own messages get 👎-deleted forAll and probed:
  // MAX -> Telegram deletions arrive natively as a REMOVED push, and someone else's message isn't ours to delete.
  outgoing?: boolean;
  // Epoch ms this link was created — places the message on the probe's decay ladder.
  createdAt?: number;
  // Topic the message was written in (outgoing links) — see probeLinkGuard.
  telegramTopicId?: number;
  // Bot-written notices about this message (a poll's vote hint, a tally reply, an edit relayed as
  // a reply): deleted with it and resolvable by getByTelegram, but never the target of a 👎 delete,
  // /delete or a relayed reaction (a 👎 on the hint used to delete the owner's poll on both sides).
  noticeTelegramMessageIds?: number[];
  // Further MAX messages ONE Telegram message produced (a text over MAX_TEXT_LIMIT goes out in
  // pieces) — deleted together with the anchor. Not indexed in byMax: an edit, a reaction or a
  // REMOVED push for one of them finds no link.
  extraMaxMessageIds?: unknown[];
}

/** Every MAX message a link covers: anchor first, then the further pieces. Pure + exported for unit testing. */
export function linkMaxIds(link: Pick<MessageLink, 'maxMessageId' | 'extraMaxMessageIds'>): unknown[] {
  return [link.maxMessageId, ...(link.extraMaxMessageIds ?? [])];
}

/**
 * A Telegram text as the pieces MAX accepts: Telegram allows 4096 units, MAX only MAX_TEXT_LIMIT.
 * A text that fits stays exactly as it is (one piece).
 */
function piecesForMax(text: string): string[] {
  return text.length > MAX_TEXT_LIMIT ? splitTelegramText(text, MAX_TEXT_LIMIT) : [text];
}

/** Every Telegram message a link covers: anchor, content extras, notices. Pure + exported for unit testing. */
export function linkTelegramIds(link: Pick<MessageLink, 'telegramMessageId' | 'extraTelegramMessageIds' | 'noticeTelegramMessageIds'>): number[] {
  return [...new Set([link.telegramMessageId, ...(link.extraTelegramMessageIds ?? []), ...(link.noticeTelegramMessageIds ?? [])])];
}

/** Whether `telegramMessageId` is one of the link's bot notices rather than a copy of the message itself. */
export function isNoticeOf(link: Pick<MessageLink, 'noticeTelegramMessageIds'>, telegramMessageId: number): boolean {
  return link.noticeTelegramMessageIds?.includes(telegramMessageId) ?? false;
}

/** Bidirectional, bounded MAX messageId <-> Telegram message_id correlation for edit/react/delete. In-memory only: lost on restart. */
export class MessageLinkStore {
  private readonly byMax = new Map<string, MessageLink>();
  private readonly byTelegram = new Map<number, MessageLink>();
  private readonly order: string[] = [];
  constructor(private readonly capacity = 500) {}

  private key(maxChatId: unknown, maxMessageId: unknown): string {
    return `${String(maxChatId)}:${String(maxMessageId)}`;
  }

  /** Links a MAX message; a link already stored for it is replaced cleanly (its Telegram ids and its place in the eviction order go first). */
  add(link: MessageLink): void {
    if (link.maxMessageId == null) {
      // Dropping silently already cost a debugging session (2026-08-14): without a MAX-side id
      // every later /delete or edit on this message reports "no link" with no trace of why.
      logger.warn(`MessageLinkStore: no MAX messageId for Telegram message ${link.telegramMessageId} — edit/delete for it won't work`);
      return;
    }
    link.createdAt ??= Date.now();
    this.remove(link.maxChatId, link.maxMessageId);
    const key = this.key(link.maxChatId, link.maxMessageId);
    this.byMax.set(key, link);
    for (const id of linkTelegramIds(link)) this.byTelegram.set(id, link);
    this.order.push(key);
    while (this.order.length > this.capacity) {
      const oldestKey = this.order.shift() as string;
      const old = this.byMax.get(oldestKey);
      this.byMax.delete(oldestKey);
      if (old) this.unindex(old);
    }
  }

  /** Drops the link's Telegram ids from byTelegram — only those still pointing at this very link. */
  private unindex(link: MessageLink): void {
    for (const id of linkTelegramIds(link)) {
      if (this.byTelegram.get(id) === link) this.byTelegram.delete(id);
    }
  }

  getByMax(maxChatId: unknown, maxMessageId: unknown): MessageLink | undefined {
    return this.byMax.get(this.key(maxChatId, maxMessageId));
  }

  /** Adds a bot notice produced later for an already-linked MAX message (a tally reply, an edit relayed as a reply) — see noticeTelegramMessageIds. No-op when the link is gone. */
  addNotice(maxChatId: unknown, maxMessageId: unknown, telegramMessageId: number): void {
    const link = this.byMax.get(this.key(maxChatId, maxMessageId));
    if (!link || linkTelegramIds(link).includes(telegramMessageId)) return;
    link.noticeTelegramMessageIds = [...(link.noticeTelegramMessageIds ?? []), telegramMessageId];
    this.byTelegram.set(telegramMessageId, link);
  }

  getByTelegram(telegramMessageId: number): MessageLink | undefined {
    return this.byTelegram.get(telegramMessageId);
  }

  /** Snapshot of our own (outgoing) links — the deletion probe only watches these. Returned as an array so the caller can iterate without holding the live map. */
  outgoingLinks(): MessageLink[] {
    const out: MessageLink[] = [];
    for (const link of this.byMax.values()) if (link.outgoing) out.push(link);
    return out;
  }

  /** The chat's most recently linked message that came FROM MAX (a bot-written copy in the topic) — the probe's second witness. */
  newestIncoming(maxChatId: unknown): MessageLink | undefined {
    const chatKey = String(maxChatId);
    let newest: MessageLink | undefined;
    for (const link of this.byMax.values()) if (!link.outgoing && String(link.maxChatId) === chatKey) newest = link;
    return newest;
  }

  /** Whether the MAX message is already in Telegram: linked itself, or a later piece of a split outgoing text (those are not indexed in byMax). */
  covers(maxChatId: unknown, maxMessageId: unknown): boolean {
    if (this.getByMax(maxChatId, maxMessageId)) return true;
    const chatKey = String(maxChatId);
    const id = String(maxMessageId);
    for (const link of this.byMax.values()) {
      if (link.extraMaxMessageIds && String(link.maxChatId) === chatKey && link.extraMaxMessageIds.some((extra) => String(extra) === id)) return true;
    }
    return false;
  }

  /** Drops a single link once the probe confirms its Telegram message is gone, so it isn't pinged again. */
  remove(maxChatId: unknown, maxMessageId: unknown): void {
    const key = this.key(maxChatId, maxMessageId);
    const link = this.byMax.get(key);
    if (!link) return;
    this.byMax.delete(key);
    this.unindex(link);
    const idx = this.order.indexOf(key);
    if (idx >= 0) this.order.splice(idx, 1);
  }

  /**
   * Drops every link of one MAX chat. Called BEFORE its Telegram topic is deleted (/ban, «Чат
   * закрыт», a topic restore): a surviving outgoing link would probe 'gone' and get mirror-deleted
   * on MAX forAll — wiping the owner's messages for a topic removal. Returns how many were dropped.
   */
  removeByChat(maxChatId: unknown): number {
    const chatKey = String(maxChatId);
    let dropped = 0;
    for (const link of [...this.byMax.values()]) {
      if (String(link.maxChatId) !== chatKey) continue;
      this.remove(link.maxChatId, link.maxMessageId);
      dropped++;
    }
    return dropped;
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

/**
 * Whether sendAttachments will actually render this attach. Mirrors its silent skip (below) of
 * CONTROL/service events that aren't new/join/leave/title (e.g. 'system', pin). Used so a message
 * whose ONLY content is such an event doesn't post a bare author prefix ("👤 Имя:" with nothing) —
 * reported live 2026-08-23 for a group service event attributed to a member.
 */
export function isRenderableAttach(att: MaxAttachment): boolean {
  // A keyboard is no message of its own: it rides on the message's text as reply_markup (takeKeyboard).
  if (att._type === 'INLINE_KEYBOARD') return false;
  return !(att._type === 'CONTROL' && !['new', 'join', 'leave', 'title'].includes(String((att as { event?: unknown }).event)));
}

type SentMessage = { message_id: number };
type AttachmentSendOpts = { message_thread_id: number; reply_parameters?: { message_id: number; allow_sending_without_reply: boolean } };

/** Set by wireBridge: sends a MAX file over Telegram's bot upload limit as a download link. */
let bigFileRelay: ((att: MaxAttachment, ctx: DownloadContext, opts: AttachmentSendOpts) => Promise<SentMessage>) | null = null;

/**
 * Sends a MAX message's attachments into a topic, one Telegram message each, and returns EVERY
 * sent message_id in order — the caller links them all (buildLinkIds). Each Telegram call has its
 * own withFloodRetry (see the NOTE there), and each attachment degrades on its own: one Telegram
 * refuses for good (over the upload limit, a rejected format) becomes its text placeholder and the
 * rest still go out. Only a deleted topic, a transient failure (the caller retries later) or a
 * refused placeholder propagate. `sent` gets each id as soon as it is sent (see sendTextPieces).
 * `degradeTransient` (the backfill's last try on a message): a transient failure of one attachment
 * degrades to its placeholder too instead of dropping it and every one after it.
 */
export async function sendAttachments(
  bot: Telegraf,
  groupId: string,
  topicId: number,
  attaches: MaxAttachment[],
  downloadCtx: DownloadContext,
  replyParameters?: { message_id: number; allow_sending_without_reply: boolean },
  paceMs?: number,
  sent?: number[],
  degradeTransient = false,
): Promise<number[]> {
  const ids: number[] = [];
  for (const att of attaches) {
    // CONTROL events with no useful rendering (`system`: a history clear; «Чат закрыт» is caught
    // earlier by handleMaxPush) must not become a "[системное событие: system]" junk message.
    if (!isRenderableAttach(att)) continue;
    // A native reply applies only to the FIRST message this MAX message produces.
    const opts: AttachmentSendOpts =
      ids.length === 0 && replyParameters
        ? { message_thread_id: topicId, reply_parameters: replyParameters }
        : { message_thread_id: topicId };
    let msg: SentMessage;
    try {
      msg = await sendOneAttachment(bot, groupId, att, downloadCtx, opts);
    } catch (err) {
      if (isThreadNotFound(err) || (!degradeTransient && !isPermanentTelegramRefusal(err))) throw err;
      logger.error(`Could not send a MAX ${att._type ?? 'attachment'} to Telegram — sending its placeholder instead`, err);
      msg = await withFloodRetry(() => bot.telegram.sendMessage(groupId, describeAttachment(att), opts));
    }
    ids.push(msg.message_id);
    sent?.push(msg.message_id);
    // The backfill's pacing per attachment: an album is the likeliest thing to trip flood control.
    if (paceMs) await sleep(paceMs);
  }
  return ids;
}

async function sendOneAttachment(
  bot: Telegraf,
  groupId: string,
  att: MaxAttachment,
  downloadCtx: DownloadContext,
  opts: AttachmentSendOpts,
): Promise<SentMessage> {
  if (att._type === 'LOCATION' && att.latitude != null && att.longitude != null) {
    const { latitude, longitude } = att;
    return withFloodRetry(() => bot.telegram.sendLocation(groupId, latitude, longitude, opts));
  }
  if (att._type === 'CONTACT') {
    // Two shapes seen live (see MaxAttachment): a vCard-style card with `phone` on it, and a
    // reference to a MAX user (`contactId`, needs CONTACT_INFO). sendContact requires a real
    // number, so with neither the contact goes as plain text rather than a fabricated phone.
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
    return phone != null
      ? withFloodRetry(() => bot.telegram.sendContact(groupId, `+${String(phone)}`, displayName, opts))
      : withFloodRetry(() => bot.telegram.sendMessage(groupId, `👤 Контакт: ${displayName}`, opts));
  }
  // A file the bot can't upload to Telegram goes through a download link (bigFiles.ts).
  if (bigFileRelay && att._type === 'FILE' && Number(att.size ?? 0) > TELEGRAM_UPLOAD_LIMIT_BYTES) {
    return bigFileRelay(att, downloadCtx, opts);
  }
  const downloaded = await downloadMaxAttachment(att, downloadCtx);
  // Bot API upload limits (50 MB, a photo 10 MB) — see telegramSendKind.
  const kind = downloaded ? telegramSendKind(downloaded.kind, downloaded.buffer.byteLength) : null;
  if (!downloaded || !kind) {
    if (downloaded) {
      logger.error(`MAX ${att._type ?? 'attachment'} is ${downloaded.buffer.byteLength} bytes — over Telegram's upload limit, sending its placeholder`);
    }
    return withFloodRetry(() => bot.telegram.sendMessage(groupId, describeAttachment(att), opts));
  }
  const source = { source: downloaded.buffer, filename: downloaded.filename };
  if (kind === 'photo') return withFloodRetry(() => bot.telegram.sendPhoto(groupId, source, opts));
  if (kind === 'video') return withFloodRetry(() => bot.telegram.sendVideo(groupId, source, opts));
  if (kind === 'video_note') {
    try {
      // sendVideoNote is the only way Telegram renders the round "circle" bubble.
      return await withFloodRetry(() => bot.telegram.sendVideoNote(groupId, source, opts));
    } catch (err) {
      if (!isPermanentTelegramRefusal(err)) throw err;
      logger.error('sendVideoNote failed, falling back to sendVideo', err);
      return withFloodRetry(() => bot.telegram.sendVideo(groupId, source, opts));
    }
  }
  if (kind === 'voice') {
    try {
      // Telegram's voice bubble wants OGG/OPUS and MAX's encoding is unconfirmed — fall back
      // to a regular audio file rather than lose the message.
      return await withFloodRetry(() => bot.telegram.sendVoice(groupId, source, opts));
    } catch (err) {
      if (!isPermanentTelegramRefusal(err)) throw err;
      logger.error('sendVoice failed, falling back to sendAudio', err);
      return withFloodRetry(() => bot.telegram.sendAudio(groupId, source, opts));
    }
  }
  if (kind === 'sticker') {
    try {
      return await withFloodRetry(() => bot.telegram.sendSticker(groupId, source, opts));
    } catch (err) {
      if (!isPermanentTelegramRefusal(err)) throw err;
      logger.error('sendSticker failed, falling back to sendDocument', err);
      return withFloodRetry(() => bot.telegram.sendDocument(groupId, source, opts));
    }
  }
  return withFloodRetry(() => bot.telegram.sendDocument(groupId, source, opts));
}

const HISTORY_BATCH_SIZE = 100;
// Safety valve, not an expected ceiling — just stops a pagination bug from looping forever.
const HISTORY_MAX_BATCHES = 2000;
// A bot may post about 20 messages a minute into one group. At the former 1.1 s a backfill ran
// into a 30-40 s flood wait in nearly every chat (seen live 2026-09-29) — same total time, but
// repeated 429s risk being flagged as abuse. 3 s stays under the limit.
const HISTORY_SEND_DELAY_MS = 3000;
// Pause between topic deletions of /reboot and /kill.
const TOPIC_DELETE_DELAY_MS = 1100;

/**
 * Where fetchFullHistory starts paging: a little AHEAD of the local clock. CHAT_HISTORY only
 * returns messages older than `from`, and the cursor is MAX server time — with a host clock behind
 * MAX's, "now" sat below messages that arrived during the gap and the first page missed them.
 * A future `from` is accepted. Pure + exported for unit testing.
 */
export const HISTORY_FROM_AHEAD_MS = 15 * 60_000;
export function historyStartTime(now: number = Date.now()): number {
  return now + HISTORY_FROM_AHEAD_MS;
}

/**
 * Walks CHAT_HISTORY backward from historyStartTime until it runs dry, deduping by message id
 * (batches can re-include the boundary message), oldest-first. With `sinceTime` only strictly
 * newer messages are returned and paging stops once a batch's oldest is at/before it — the cheap
 * "what's new since last time" every catch-up runs (a push arriving between TCP sessions is
 * otherwise lost forever — hit live 2026-08-12, mid-redeploy).
 */
async function fetchFullHistory(
  max: MaxClient,
  chatId: unknown,
  sinceTime: number | null = null,
  isCancelled?: () => boolean,
): Promise<MaxHistoryMessage[]> {
  const all: MaxHistoryMessage[] = [];
  const seenIds = new Set<string>();
  let fromTime = historyStartTime();
  for (let i = 0; i < HISTORY_MAX_BATCHES; i++) {
    // A big chat pages for a minute or more — /reboot and /kill wait for the run to stop.
    if (isCancelled?.()) throw new SyncCancelledError();
    const batch = await max.getChatHistory(chatId, fromTime, HISTORY_BATCH_SIZE);
    if (batch.length === 0) break;
    let oldestTime = fromTime;
    for (const m of batch) {
      const key = String(m.id);
      if (seenIds.has(key)) continue;
      seenIds.add(key);
      // `time` arrives as BigInt — normalize to Number right away so every later comparison/sort
      // stays plain-number instead of throwing on a stray BigInt (hit live 2026-08-08).
      const time = Number(m.time);
      if (time < oldestTime) oldestTime = time;
      if (sinceTime == null || time > sinceTime) all.push({ ...m, time });
    }
    // Everything further back was already delivered in a previous run.
    if (sinceTime != null && oldestTime <= sinceTime) break;
    // `from` not moving = the start of the chat (and would loop forever).
    if (!(oldestTime < fromTime)) break;
    fromTime = oldestTime;
  }
  all.sort((a, b) => a.time - b.time);
  return all;
}

/** A received forward's `link` — the same shape on PUSH_MESSAGE and in CHAT_HISTORY. */
type ForwardLink = { type?: string; message?: { id?: unknown; text?: string; sender?: unknown; attaches?: unknown[] }; chatId?: unknown };

/** Where a forward's attachments are downloaded from: the source ids first, the wrapper's as the fallback. */
export interface ForwardDownloadIds {
  chatId: unknown;
  messageId: unknown;
  fallbackChatId: unknown;
  fallbackMessageId: unknown;
}

/**
 * Download ids for a forward's attachments. Files live on the ORIGINAL message/chat: FILE_DOWNLOAD/
 * VIDEO_PLAY validate the id against the message+chat it was uploaded in, so the wrapper's own ids
 * are rejected and the attachment silently drops (hit live 2026-08-13). A forward from a chat we're
 * NOT in arrives with link.chatId = 0 and the download is denied there — the RECIPIENT chat + the
 * wrapper message id are the fallback: the file is present in our own dialog with the forwarder.
 */
export function forwardDownloadIds(link: ForwardLink, wrapperChatId: unknown, wrapperMessageId: unknown): ForwardDownloadIds {
  return {
    chatId: link.chatId != null ? link.chatId : wrapperChatId,
    messageId: link.message?.id != null ? link.message.id : wrapperMessageId,
    fallbackChatId: wrapperChatId,
    fallbackMessageId: wrapperMessageId,
  };
}

/**
 * Unwraps a forward we RECEIVE (see MaxPushPayload.link): its text with a "↩️ Переслано из «…»
 * (от …):" prefix, its attachments and their download ids (forwardDownloadIds); null when `link`
 * isn't a forward. Shared by the live path and the backfill. (Sending a forward FROM us doesn't
 * work: MAX's answer to our own FORWARD request is empty and no message is created — unresolved.)
 */
export async function resolveForwardContent(
  max: MaxClient,
  chats: unknown[],
  link: ForwardLink | undefined,
  wrapperChatId: unknown,
  wrapperMessageId: unknown,
  profiles?: Map<number, ContactProfile>,
): Promise<{ text: string; attaches: MaxAttachment[]; download: ForwardDownloadIds } | null> {
  if (link?.type !== 'FORWARD') return null;
  const original = link.message;
  const attaches = Array.isArray(original?.attaches) ? (original.attaches as MaxAttachment[]) : [];
  const senderId = typeof original?.sender === 'number' ? original.sender : Number(original?.sender);
  const senderName = Number.isNaN(senderId)
    ? 'неизвестно'
    : resolveContactDisplayName(senderId, await resolveProfile(max, senderId, 'forward sender', profiles));
  const sourceChat = chats.find((c) => c && typeof c === 'object' && String((c as { id?: unknown }).id) === String(link.chatId)) as
    | { title?: string }
    | undefined;
  const sourceLabel = sourceChat?.title || `MAX chat ${String(link.chatId)}`;
  const prefix = `↩️ Переслано из «${sourceLabel}» (от ${senderName}):`;
  return {
    text: original?.text ? `${prefix}\n${original.text}` : prefix,
    attaches,
    download: forwardDownloadIds(link, wrapperChatId, wrapperMessageId),
  };
}

/** Forces a fresh topic for a chat (one the user deleted in Telegram): drops the stale mapping, recreates it under the stored title, returns the new topic id. */
async function recreateTopicForChat(bot: Telegraf, groupId: string, chatId: unknown, chatMapStore: ChatMapStore): Promise<number> {
  const existing = await chatMapStore.getByMaxChatId(chatId);
  // /ban deleted that topic on purpose — healing it would recreate a mapping without the ban.
  if (existing?.banned) throw new ChatBannedError(String(chatId));
  const title = existing?.title;
  await chatMapStore.remove(chatId);
  const { topicId } = await ensureTopicForMaxChat(bot, groupId, chatId, chatMapStore, title);
  return topicId;
}

/**
 * One MAX profile by id: from `cache` when it's there, else one CONTACT_INFO round trip whose
 * answer is stored back into `cache`. undefined when the lookup fails (logged under `what`, e.g.
 * 'caller') or MAX knows no such user — callers then show "MAX ID <n>" (resolveContactDisplayName).
 */
export async function resolveProfile(
  max: Pick<MaxClient, 'getContactInfo'>,
  id: number,
  what: string,
  cache?: Map<number, ContactProfile>,
): Promise<ContactProfile | undefined> {
  const cached = cache?.get(id);
  if (cached) return cached;
  try {
    const profile = (await max.getContactInfo([id]))[0];
    if (profile && cache) cache.set(id, profile);
    return profile;
  } catch (err) {
    logger.error(`Failed to fetch CONTACT_INFO for ${what} ${id}`, err);
    return undefined;
  }
}

/**
 * A one-line "who sent this" prefix so a Telegram topic isn't an anonymous stream. OUR OWN messages
 * get "🧑 Вы:" everywhere (1:1 backfill included), other people "👤 Name:" only in GROUP chats — in
 * a 1:1 the topic already IS the contact. '' when the sender can't be determined. `profiles` caches
 * the looked-up names (without it every group message of a synced history cost a CONTACT_INFO trip).
 */
async function resolveAuthorPrefix(
  chat: unknown,
  senderId: unknown,
  myAccountId: number | null,
  max: MaxClient,
  profiles?: Map<number, ContactProfile>,
): Promise<string> {
  const id = typeof senderId === 'number' ? senderId : Number(senderId);
  if (Number.isNaN(id)) return '';
  if (myAccountId != null && id === myAccountId) return '🧑 Вы:\n';
  const participants = (chat as { participants?: Record<string, unknown> } | null)?.participants;
  if (!participants || Object.keys(participants).length <= 2) return ''; // 1:1 (or unknown) — contact's line stays plain
  const profile = await resolveProfile(max, id, 'group sender', profiles);
  return `👤 ${resolveContactDisplayName(id, profile)}:\n`;
}

/** What ChatCatchUp needs from the bridge (server/app.ts's module state and wireBridge's helpers). */
export interface ChatCatchUpDeps {
  bot: Telegraf;
  groupId: string;
  max: MaxClient;
  chatMapStore: ChatMapStore;
  messageLinks: MessageLinkStore;
  getChats: () => unknown[];
  getMyAccountId: () => number | null;
  getContactProfiles: () => Map<number, ContactProfile>;
  /** The pinned info card at the top of a topic just (re)created for the chat; `sender` names the contact when the chat is not cached yet. */
  sendCard: (chatId: unknown, topicId: number, sender?: unknown) => Promise<void>;
  /** Forgets every link of a chat whose topic is going away — call BEFORE recreating it (see MessageLinkStore.removeByChat). */
  forgetChatLinks: (chatId: unknown) => void;
  /** True while /reboot or /kill wipes the group: queued jobs return at once, a running backfill stops. */
  isWiping: () => boolean;
  /** Transient strikes per message before the backfill gives up on it (StrikeCounter) — injectable for tests. */
  strikes?: StrikeCounter;
  /** Pause after each backfilled message (HISTORY_SEND_DELAY_MS) — injectable for tests. */
  paceMs?: number;
}

/**
 * One writer per MAX chat, and catch-up on first touch — all the bookkeeping behind the per-chat
 * history cursor (ChatMapping.historyBackfillCursor).
 *
 * INVARIANT: the cursor never passes a message that was not delivered. The cursor is the lower
 * bound of every catch-up (fetchFullHistory: `time > cursor`), so anything older is never fetched
 * again.
 *
 * - Every unit of work that writes into a chat's topic or moves its cursor — a live push, a call
 *   notice, the LOGIN sync's pass, a topic restore, an outgoing send's cursor move — runs through
 *   runInChat: one at a time per chat, in arrival order; different chats run side by side. (Side
 *   by side within a chat, a later message delivered first moved the cursor past an earlier one
 *   still uploading, and when that one failed it was never fetched again.)
 * - `caughtUp` holds the chats whose history is known to be in Telegram this MAX session. Before a
 *   job writes into a chat not in it, ensureCaughtUp backfills the chat's history from its cursor —
 *   what arrived while the bridge was offline goes out first and in order, and the live push that
 *   follows finds its message linked and skips it. Emptied on every new MAX socket and by /reboot.
 * - The cursor moves only inside the chat's queue, after a successful delivery, and only for a
 *   chat in `caughtUp` — so it can never jump past a message still waiting for its catch-up.
 * - A transient failure aborts the job: the cursor stays before the failed message, the parts
 *   already posted are deleted, the chat leaves `caughtUp`, and a catch-up retry is requested
 *   (server/app.ts's backoff). A failure pinned on one message that keeps repeating (StrikeCounter)
 *   degrades it to placeholders on the next try, so one poisoned message cannot block its chat.
 */
export class ChatCatchUp {
  // Chats whose history is in Telegram this MAX session — see the class note.
  private readonly caughtUp = new Set<string>();
  // Bumped by every reset(): a catch-up that fetched under an older session may not mark its chat.
  private session = 0;
  private readonly queues = new Map<string, Promise<void>>();
  private readonly strikes: StrikeCounter;
  private retryHandler: ((reason: string) => void) | null = null;

  constructor(readonly deps: ChatCatchUpDeps) {
    this.strikes = deps.strikes ?? new StrikeCounter();
  }

  /** Runs `fn` after every earlier job of the same chat has settled. Skipped (resolves at once) while the group is being wiped. */
  runInChat(chatId: unknown, fn: () => Promise<void>): Promise<void> {
    const key = String(chatId);
    const previous = this.queues.get(key) ?? Promise.resolve();
    const run = previous.then(() => (this.deps.isWiping() ? undefined : fn()));
    const tail = run.catch(() => undefined);
    this.queues.set(key, tail);
    void tail.then(() => {
      if (this.queues.get(key) === tail) this.queues.delete(key);
    });
    return run;
  }

  /** Resolves once every chat queue has drained — /reboot and /kill, with isWiping set so queued jobs return at once. */
  async drain(): Promise<void> {
    await Promise.allSettled([...this.queues.values()]);
  }

  /** Who runs the catch-up retries (server/app.ts's scheduler — it owns the sync runs). */
  setRetryHandler(handler: ((reason: string) => void) | null): void {
    this.retryHandler = handler;
  }

  /** Something could not be caught up for a transient reason — ask for another catch-up run later. */
  requestRetry(reason: string): void {
    this.retryHandler?.(reason);
  }

  isCaughtUp(chatId: unknown): boolean {
    return this.caughtUp.has(String(chatId));
  }

  /** Forgets every chat (a new MAX socket, /reboot): all of them must be caught up again, and a catch-up still running may not mark its chat. */
  reset(): void {
    this.caughtUp.clear();
    this.session += 1;
  }

  /** A chat with no history to catch up — a group we just created, a 1:1 our first message just opened. */
  markCaughtUp(chatId: unknown): void {
    this.caughtUp.add(String(chatId));
  }

  /** Takes the chat out again (a live delivery failed, its topic is being recreated): its cursor stays put until the next catch-up. */
  markDirty(chatId: unknown): void {
    this.caughtUp.delete(String(chatId));
  }

  /** Inside the chat's queue, after a successful live delivery: the cursor moves to the message's MAX server time (liveCursorTime) — only for a caught-up chat. */
  async advanceCursor(chatId: unknown, serverTime: unknown, what: string): Promise<void> {
    if (!this.caughtUp.has(String(chatId))) return;
    await this.deps.chatMapStore.advanceHistoryCursor(chatId, liveCursorTime(serverTime)).catch((err) => logger.error(`Failed to advance history cursor after ${what}`, err));
  }

  /**
   * Inside the chat's queue: the chat's history since its cursor (all of it for a fresh topic) into
   * its topic, then the chat joins `caughtUp`. Returns the topic id — the recreated one when the
   * topic was found deleted meanwhile (restoreTopic) — or undefined when there is nothing to fill:
   * no topic, banned, or a pending 1:1 ("pending:<userId>", no MAX dialog yet). Throws on failure;
   * the chat stays out. `isCancelled` is the sync run's (/reboot, /kill).
   */
  async ensureCaughtUp(chatId: unknown, isCancelled?: () => boolean): Promise<number | undefined> {
    const mapping = await this.deps.chatMapStore.getByMaxChatId(chatId);
    if (!mapping || mapping.banned || mapping.pendingUserId != null) return undefined;
    if (this.caughtUp.has(String(chatId))) return mapping.telegramTopicId;
    const cancelled = (): boolean => this.deps.isWiping() || (isCancelled?.() ?? false);
    try {
      await this.replay(chatId, mapping.telegramTopicId, cursorToMs(mapping.historyBackfillCursor), cancelled);
      return mapping.telegramTopicId;
    } catch (err) {
      if (!isThreadNotFound(err)) throw err;
      return this.restoreTopic(chatId, cancelled);
    }
  }

  /**
   * Inside the chat's queue: a deleted topic comes back as the whole conversation, not an empty
   * shell (reported live 2026-08-15). The chat's links go first (they point into the dead topic —
   * see MessageLinkStore.removeByChat), then the topic is recreated with its info card and the
   * full history replayed from the fresh mapping's null cursor; the triggering message is part of
   * that history, so it is never sent separately. Returns the new topic id, or undefined for a
   * chat closed in MAX meanwhile («Чат закрыт» dropped its mapping); a banned one throws ChatBannedError.
   */
  async restoreTopic(chatId: unknown, cancelled: () => boolean = () => this.deps.isWiping()): Promise<number | undefined> {
    const key = String(chatId);
    if (this.deps.isWiping() || !(await this.deps.chatMapStore.getByMaxChatId(chatId))) return undefined;
    logger.info(`Telegram topic for MAX chat ${key} was deleted — recreating and restoring its history`);
    this.markDirty(chatId);
    this.deps.forgetChatLinks(chatId);
    const topicId = await recreateTopicForChat(this.deps.bot, this.deps.groupId, chatId, this.deps.chatMapStore);
    await this.deps.sendCard(chatId, topicId).catch((err) => logger.error('Failed to send the info card of a recreated topic', err));
    await this.replay(chatId, topicId, null, cancelled);
    return topicId;
  }

  /**
   * The history since `cursor` into `topicId`, then the chat joins `caughtUp` — unless a new MAX
   * socket came meanwhile: that snapshot could not see the new gap, so the next pass fetches again
   * from the cursor (advanced per message, so the re-run is cheap).
   */
  private async replay(chatId: unknown, topicId: number, cursor: number | null, cancelled: () => boolean): Promise<void> {
    const session = this.session;
    const history = await fetchFullHistory(this.deps.max, chatId, cursor, cancelled);
    if (history.length > 0) {
      logger.info(`${cursor == null ? 'Backfilling' : 'Catching up on'} ${history.length} messages for MAX chat ${String(chatId)}`);
      await this.backfill(chatId, topicId, history, cancelled);
    }
    if (session === this.session) this.caughtUp.add(String(chatId));
  }

  /**
   * Inside the chat's queue, before a live event is written into the chat: its topic (created on
   * first contact, with its info card) and its catch-up. Null when nothing may be written (banned,
   * or a wipe cancelled it). `deferred` ONLY when Telegram itself is failing: the event could not
   * be written anyway, so a message arrives with the retried catch-up (a call notice, not part of
   * the history, is still attempted). Any failure on the MAX side — its rate limit on history, a
   * timeout, a download — must not hold the event hostage: it is relayed now, the cursor stays put
   * and the catch-up is retried in the background (a rate-limited chat kept a system message back
   * for hours, live 2026-10-04). Cost: a restart before that catch-up succeeds replays it once more.
   */
  async openTopic(chatId: unknown, title?: string, sender?: unknown): Promise<{ topicId: number; deferred: boolean } | null> {
    const { bot, groupId, chatMapStore } = this.deps;
    const first = await ensureTopicForMaxChat(bot, groupId, chatId, chatMapStore, title);
    if (first.created) await this.deps.sendCard(chatId, first.topicId, sender).catch((err) => logger.error('Failed to send auto contact-info card', err));
    try {
      const topicId = await this.ensureCaughtUp(chatId);
      return topicId == null ? null : { topicId, deferred: false };
    } catch (err) {
      if (err instanceof ChatBannedError || err instanceof SyncCancelledError) return null;
      const deferred = isTransientTelegramError(err);
      if (deferred) {
        logger.error(`Catch-up of MAX chat ${String(chatId)} before a live event failed on the Telegram side — a message arrives with the retried catch-up`, err);
      } else {
        logger.error(`Catch-up of MAX chat ${String(chatId)} failed — relaying the live event anyway, its cursor stays put`, err);
      }
      if (deferred || isRetriedDeliveryFailure(err) || isTransientMaxError(err)) {
        this.requestRetry(`catch-up of MAX chat ${String(chatId)} hit a transient failure`);
      }
      return { topicId: first.topicId, deferred };
    }
  }

  /**
   * Replays `messages` (oldest-first) into the chat's topic, paced under Telegram's flood limit,
   * and moves the cursor after every message — sent, skipped (already linked, nothing to render)
   * or refused for good (a 4xx: a placeholder where possible) — so a restart mid-backfill resumes
   * after the last one (near-miss 2026-08-09). A transient failure throws BEFORE the cursor moves,
   * after discardPartialDelivery; one pinned on the message itself (its download, an attachment
   * upload — never a text send) counts as a strike, past which the next try degrades those parts
   * to placeholders. A deleted topic propagates to ensureCaughtUp, which restores it.
   */
  private async backfill(chatId: unknown, topicId: number, messages: MaxHistoryMessage[], cancelled: () => boolean): Promise<void> {
    const { bot, groupId, max, chatMapStore, messageLinks } = this.deps;
    const chats = this.deps.getChats();
    const myAccountId = this.deps.getMyAccountId();
    const profiles = this.deps.getContactProfiles();
    const chat = chats.find((c) => c && typeof c === 'object' && String((c as { id?: unknown }).id) === String(chatId));
    const paceMs = this.deps.paceMs ?? HISTORY_SEND_DELAY_MS;
    for (const msg of messages) {
      // /reboot or /kill wiped the state this run writes into: stop before the next message.
      if (cancelled()) throw new SyncCancelledError();
      // /ban or «Чат закрыт» landed mid-run: the topic is gone on purpose — stop instead of
      // recreating it on "thread not found".
      const mapping = await chatMapStore.getByMaxChatId(chatId);
      if (mapping?.banned) throw new ChatBannedError(String(chatId));
      if (!mapping) {
        logger.info(`MAX chat ${String(chatId)} was closed during its backfill — stopping it`);
        return;
      }
      // Already in Telegram: relayed live (either direction) before this catch-up reached it.
      if (msg.id != null && messageLinks.covers(chatId, msg.id)) {
        await chatMapStore.advanceHistoryCursor(chatId, msg.time);
        continue;
      }
      const forwarded = await resolveForwardContent(max, chats, msg.link, chatId, msg.id, profiles);
      let text = forwarded ? forwarded.text : msg.text;
      const taken = takeKeyboard(forwarded ? forwarded.attaches : Array.isArray(msg.attaches) ? (msg.attaches as MaxAttachment[]) : [], chatId);
      let attaches = taken.attaches;
      const keyboard = taken.keyboard;
      // A poll goes out as its text rendering, options included — sendAttachments only knows a
      // «[опрос: …]» placeholder for it.
      const pollAttach = attaches.find((a) => a._type === 'POLL');
      if (pollAttach) {
        const pollText = renderPollAsText(pollAttach.title, (pollAttach.answers ?? []).map((a) => a.text || '—'), pollAttach.settings ?? 0);
        text = text ? `${text}\n${pollText}` : pollText;
        attaches = attaches.filter((a) => a !== pollAttach);
      }
      if (!text && !keyboard && !attaches.some((a) => isRenderableAttach(a))) {
        await chatMapStore.advanceHistoryCursor(chatId, msg.time);
        continue;
      }
      // Same join/leave rendering as the live path (renderMemberEvent).
      let memberMarkup: InlineMarkup | undefined;
      const memberEvent = await renderMemberEvent(attaches, text, (msg as { sender?: unknown }).sender, myAccountId, max, profiles);
      if (memberEvent) {
        text = memberEvent.text;
        attaches = [];
        memberMarkup = memberEvent.markup;
      } else {
        const authorPrefix = await resolveAuthorPrefix(chat, (msg as { sender?: unknown }).sender, myAccountId, max, profiles);
        if (authorPrefix) text = text ? `${authorPrefix}${text}` : authorPrefix;
      }
      const abortKey = `${String(chatId)}:${String(msg.id ?? msg.time)}`;
      const lastTry = this.strikes.isLastTry(abortKey);
      const sent: number[] = [];
      let phase: 'text' | 'attachments' = 'text';
      try {
        let textIds: number[] = [];
        let attachIds: number[] = [];
        if (text) {
          textIds = await sendTextPieces(bot, groupId, topicId, text, { replyMarkup: joinMarkups(memberMarkup, keyboard), paceMs, sent, maxMessageId: msg.id });
        }
        if (attaches.length > 0) {
          phase = 'attachments';
          const downloadCtx: DownloadContext = {
            max,
            ...(forwarded ? forwarded.download : { chatId, messageId: msg.id }),
            throwOnTransient: !lastTry,
          };
          // withFloodRetry lives INSIDE sendAttachments, around each single send (see the NOTE there).
          attachIds = await sendAttachments(bot, groupId, topicId, attaches, downloadCtx, undefined, paceMs, sent, lastTry);
        }
        if (keyboard && textIds.length === 0) {
          phase = 'text';
          attachIds.push(...(await sendKeyboardAlone(bot, groupId, topicId, keyboard, { paceMs, sent, maxMessageId: msg.id })));
        }
        const linkIds = buildLinkIds(textIds, attachIds);
        if (linkIds && msg.id != null) messageLinks.add({ maxChatId: chatId, maxMessageId: msg.id, ...linkIds });
        this.strikes.clear(abortKey);
      } catch (err) {
        if (isThreadNotFound(err)) throw err;
        if (isRetriedDeliveryFailure(err)) {
          // On the last try everything pinned on the message is a placeholder already, so a
          // transient error still escaping is Telegram itself failing: retried like any outage.
          const strikes = !lastTry && (err instanceof TransientDownloadError || phase === 'attachments') ? this.strikes.hit(abortKey) : 0;
          await discardPartialDelivery(bot, groupId, sent);
          logger.error(
            `Backfill of MAX chat ${String(chatId)} stopped at message ${String(msg.id)} on a transient failure (${strikes}/${this.strikes.limit} strikes) — cursor left before it, the next catch-up resumes here`,
            err,
          );
          throw err;
        }
        // A permanent refusal (4xx): resending won't help — log it and move past it. Whatever part
        // of it did go out stays linked, so a later deletion in MAX removes it.
        logger.error(`Failed to backfill MAX message ${String(msg.id)} in chat ${String(chatId)}`, err);
        const partial = buildLinkIds(sent, []);
        if (partial && msg.id != null) messageLinks.add({ maxChatId: chatId, maxMessageId: msg.id, ...partial });
      }
      await chatMapStore.advanceHistoryCursor(chatId, msg.time);
    }
  }
}

/**
 * Roster for a GROUP chat's info card: each participant as {id, name, isSelf}. Batch-fetches any
 * uncached profiles in one CONTACT_INFO round trip. Returns undefined for 1:1 dialogs (no roster).
 * Capped at 80 lines to stay under Telegram's message limit; the card notes any overflow.
 */
async function buildRoster(
  participants: Record<string, unknown> | undefined,
  chatType: string | undefined,
  max: MaxClient,
  myAccountId: number | null,
  profiles: Map<number, ContactProfile>,
): Promise<Array<{ id: number; name: string; isSelf: boolean }> | undefined> {
  if (!participants || chatType === 'DIALOG') return undefined;
  const ids = Object.keys(participants).map(Number).filter((id) => !Number.isNaN(id));
  const uncached = ids.filter((id) => !profiles.has(id));
  if (uncached.length > 0) {
    try {
      for (const c of await max.getContactInfo(uncached)) {
        const cid = Number((c as { id?: unknown }).id);
        if (!Number.isNaN(cid)) profiles.set(cid, c);
      }
    } catch (err) {
      logger.error('Failed to fetch participant profiles for the roster', err);
    }
  }
  return ids.slice(0, 80).map((id) => ({
    id,
    name: resolveContactDisplayName(id, profiles.get(id)),
    isSelf: myAccountId != null && id === myAccountId,
  }));
}

type InlineMarkup = ReturnType<typeof Markup.inlineKeyboard>['reply_markup'];

/**
 * A group "member event" (CONTROL join/leave) rendered as ONE actionable message: who left / was
 * added, their MAX ID, and a «✍️ Имя» button per person that opens a 1:1 through the panel's
 * tlmx_panel:startchat:<id>. Reported live 2026-09-07: once someone leaves a group they vanish from
 * the roster, and a bare label left no way to reach them from Telegram. Undefined when the message
 * isn't such an event (or a join carries no userIds — the plain rendering applies).
 */
async function renderMemberEvent(
  attaches: MaxAttachment[],
  text: string | undefined,
  senderId: unknown,
  myAccountId: number | null,
  max: MaxClient,
  profiles: Map<number, ContactProfile>,
): Promise<{ text: string; markup: InlineMarkup | undefined } | undefined> {
  if (text) return undefined;
  const renderable = attaches.filter((a) => isRenderableAttach(a));
  const ev = renderable.length === 1 && renderable[0]!._type === 'CONTROL' ? renderable[0]! : undefined;
  if (!ev || (ev.event !== 'join' && ev.event !== 'leave')) return undefined;
  const actor = Number(senderId);
  const isSelf = (id: number) => myAccountId != null && id === myAccountId;
  let people: number[];
  if (ev.event === 'leave') {
    if (Number.isNaN(actor)) return undefined;
    people = [actor];
  } else {
    people = (Array.isArray(ev.userIds) ? ev.userIds : []).map(Number).filter((id) => !Number.isNaN(id));
    if (people.length === 0) return undefined;
  }
  // Names from the warm cache; batch-fetch the rest (same pattern as buildRoster).
  const uncached = [...new Set([...people, ...(Number.isNaN(actor) ? [] : [actor])])].filter((id) => !profiles.has(id) && !isSelf(id));
  if (uncached.length > 0) {
    try {
      for (const c of await max.getContactInfo(uncached)) {
        const cid = Number((c as { id?: unknown }).id);
        if (!Number.isNaN(cid)) profiles.set(cid, c);
      }
    } catch (err) {
      logger.error('Failed to fetch profiles for a member event', err);
    }
  }
  const nameOf = (id: number) => (isSelf(id) ? 'вы' : resolveContactDisplayName(id, profiles.get(id)));
  let line: string;
  if (ev.event === 'leave') {
    line = isSelf(actor) ? '➖ Вы вышли из группы' : `➖ Участник вышел: ${nameOf(actor)} · MAX ID ${actor}`;
  } else {
    const list = people.map((id) => (isSelf(id) ? 'вы' : `${nameOf(id)} (MAX ID ${id})`)).join(', ');
    line = `${people.length === 1 ? '➕ Участник добавлен' : '➕ Участники добавлены'}: ${list}`;
    if (!Number.isNaN(actor) && !people.includes(actor)) line += ` — добавил: ${nameOf(actor)}`;
  }
  const buttons = people
    .filter((id) => !isSelf(id))
    .slice(0, 10)
    .map((id) => [Markup.button.callback(`✍️ ${nameOf(id)}`, `tlmx_panel:startchat:${id}`)]);
  return { text: line, markup: buttons.length > 0 ? Markup.inlineKeyboard(buttons).reply_markup : undefined };
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
  roster?: Array<{ id: number; name: string; isSelf: boolean }>,
): Promise<number> {
  if (chatType !== 'DIALOG' || otherId == null) {
    const lines = [`ℹ️ ${fallbackTitle}`];
    if (participantCount != null) lines.push(`Участников: ${participantCount}`);
    if (roster && roster.length) {
      lines.push('Состав:');
      for (const p of roster) lines.push(`• ${p.isSelf ? '🧑 Вы' : `👤 ${p.name}`} — MAX ID ${p.id}`);
      if (participantCount != null && participantCount > roster.length) lines.push(`…и ещё ${participantCount - roster.length}`);
    }
    // "Open a DM with a participant" — expands into a button per person (tlmx_roster:open).
    const hasOthers = !!roster?.some((p) => !p.isSelf);
    const markup = hasOthers
      ? Markup.inlineKeyboard([[Markup.button.callback('💬 Открыть личку', 'tlmx_roster:open')]]).reply_markup
      : undefined;
    const sent = await bot.telegram.sendMessage(targetGroupId, lines.join('\n'), { message_thread_id: topicId, reply_markup: markup });
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

/** Picked up within a minute by update-watcher.sh on the host (see setup.sh) — writing it is the only thing the container itself does towards an update, everything else (git pull, rebuild, restart) happens outside it. */
const UPDATE_REQUESTED_MARKER = path.join(process.cwd(), '.data', 'update-requested');
/** Written by update.sh while it runs (data/ is the same mount as .data/) — lets the /version button refuse a second request mid-update. */
const UPDATE_IN_PROGRESS_MARKER = path.join(process.cwd(), '.data', 'update-in-progress');
/** Touched every minute by the host's update dispatcher for the directory it serves (update-watcher.sh). */
const WATCHER_HEARTBEAT_MARKER = path.join(process.cwd(), '.data', 'watcher-heartbeat');

/** Shared by /version and the daily scheduled check — same text/buttons either way. */
function formatVersionMessage(status: VersionStatus): { text: string; replyMarkup?: ReturnType<typeof Markup.inlineKeyboard>['reply_markup'] } {
  const currentLabel = status.current === 'unknown' ? 'неизвестна' : `v${status.current}`;
  if (!status.latest) {
    return { text: `📦 Текущая версия: ${currentLabel}\n\n⚠️ Не удалось проверить обновления на GitHub — сеть недоступна или лимит запросов.` };
  }
  if (!status.updateAvailable) {
    return { text: `📦 Текущая версия: ${currentLabel}\n\n✅ Это последняя версия.` };
  }
  const CHANGELOG_CAP = 12;
  const shown = (status.changelog ?? []).slice(0, CHANGELOG_CAP);
  const more = (status.changelog ?? []).length - shown.length;
  const header = shown.length
    ? `🆕 Доступна ${status.latest.tag}\n\nЧто нового:\n${shown.map((m) => `• ${m}`).join('\n')}${more > 0 ? `\n…и ещё ${more}` : ''}`
    : `🆕 Доступна ${status.latest.tag}`;
  const text = `📦 Текущая версия: ${currentLabel}\n${header}\n\nОбновить сейчас? Пересборка и перезапуск займут пару минут, история переписки не затрагивается.`;
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
  getActivePhone: () => string;
  /** Live MAX-leg state for the panel's «📊 Статус» (connected flag + when the last LOGIN succeeded). */
  getMaxState: () => { connected: boolean; lastLoginAt: number | null };
  /** Refetches MAX's chat list and re-runs the full backfill sync — used by /reboot after wiping local state. Fire-and-forget on the caller's side (server/app.ts already guards against overlapping runs). */
  triggerFullResync: () => Promise<void>;
  /** Disconnects from MAX and deletes the encrypted session — used by /kill. Awaited (unlike triggerFullResync) since /kill's own confirmation message should only go out once this has actually finished. */
  killEverything: () => Promise<void>;
  /** Cancels the in-flight history sync, waits for it to stop, and holds off new runs until the returned release is called — /reboot and /kill wrap their wipe in it so the old run can't refill the topics they delete. */
  suspendChatSync: () => Promise<() => void>;
  /** MAX auth steps for the in-Telegram /login flow (server/maxSession.ts). */
  auth: MaxAuthCallbacks;
  /** The panel's MAX pause (server/maxSession.ts). */
  pause: PauseControl;
}

/** Wires MAX push messages <-> Telegram forum topics in both directions (ТЗ.md §1.2). */
export interface WiredBridge {
  /** The per-chat queues and catch-up state — pass to syncAllChatsToTelegram (see ChatCatchUp). */
  chatSync: ChatCatchUp;
}

export function wireBridge({
  max,
  bot,
  chatMapStore,
  targetGroupId,
  getChats,
  getMyAccountId,
  getContactProfiles,
  getActivePhone,
  getMaxState,
  triggerFullResync,
  killEverything,
  suspendChatSync,
  auth,
  pause,
}: BridgeOptions): WiredBridge {
  // Bug-report channel: private DMs from outsiders become bug reports. The inbox is only ON where
  // BUGREPORT_INBOX is set (the maintainer's prod bot); elsewhere outsiders get a redirect stub.
  const bugReportInboxEnabled = isBugReportInboxEnabled();
  const bugReports: BugReports = createBugReports({ bot, targetGroupId, enabled: bugReportInboxEnabled });
  // In-Telegram MAX (re)authorization: a private /login conversation (SMS code + optional 2FA
  // password) — the only login path. In DM so code/password stay private, and admin-gated.
  const maxAuth = createMaxAuthFlow({ targetGroupId, auth });

  // The target group IS the trust boundary; this enforces it. /reboot and /kill only gate on a
  // confirmation phrase that is public (open-source, echoed in /help), so without this anyone who
  // finds the bot (a DM, an unrelated group) could trigger them. poll_answer updates carry no
  // `chat`: they pass through, and the poll_answer handler checks poll_id and the voter itself.
  bot.use(async (ctx, next) => {
    if (ctx.chat && String(ctx.chat.id) !== targetGroupId) {
      // A private DM from an outsider is a bug report (or a redirect); only GROUPS get the hard reject.
      if (ctx.chat.type === 'private') {
        // The /login auth flow gets first refusal (it admin-gates internally).
        if (await maxAuth.handlePrivate(ctx)) return;
        await bugReports.handleIncomingPrivate(ctx);
        return;
      }
      if (ctx.callbackQuery) {
        ctx.answerCbQuery('Не вы меня создали.').catch(() => {});
      } else {
        ctx.reply('Не вы меня создали — идите в жопу.').catch(() => {});
      }
      return;
    }
    return next();
  });

  // Messages/reactions are participation — anyone in the group may. Every BOT COMMAND and
  // inline button is admin-only: a plain member must not wipe the session or manage MAX groups
  // just by being in the chat. (The 👎-delete reaction and a poll vote check isGroupAdmin themselves.)
  bot.use(async (ctx, next) => {
    const text = (ctx.message as { text?: string } | undefined)?.text;
    const isCommand = typeof text === 'string' && text.startsWith('/');
    const isCallback = Boolean(ctx.callbackQuery);
    if (!isCommand && !isCallback) return next();

    // An anonymous admin («Remain anonymous») posts as the group itself: from = GroupAnonymousBot,
    // sender_chat = the group. Only the supergroup's admins can do that — same as the reaction
    // path's actor_chat check. Callback queries carry the real from.id.
    const senderChat = (ctx.message as { sender_chat?: { id: number } } | undefined)?.sender_chat;
    if (senderChat && String(senderChat.id) === targetGroupId) return next();

    const userId = ctx.from?.id;
    if (userId == null) return; // no sender — fail closed
    try {
      if (await isGroupAdmin(userId)) return next();
    } catch (err) {
      logger.error('Failed to check admin status for a bot command', err);
      return; // can't verify — fail closed
    }
    if (isCallback) {
      await ctx.answerCbQuery('Управлять ботом может только администратор группы.').catch(() => {});
    } else {
      await ctx.reply('Управлять ботом может только администратор группы.').catch(() => {});
    }
  });

  /** Creator/administrator of the bridge group — the one notion of "admin" for commands, buttons and the 👎 delete gesture. Throws when Telegram can't be asked; callers fail closed. */
  async function isGroupAdmin(userId: number): Promise<boolean> {
    const member = await bot.telegram.getChatMember(targetGroupId, userId);
    return member.status === 'creator' || member.status === 'administrator';
  }

  // When a message last crossed in each direction — for the panel's «📊 Статус» ("is it alive?").
  let lastInAt: number | null = null;
  let lastOutAt: number | null = null;
  const outgoingCids = new RecentCids();
  const messageLinks = new MessageLinkStore();
  const pollLinks = new PollLinkStore();
  // True while /reboot or /kill wipes the group: queued chat jobs return at once, pushes are dropped
  // and deleted topics are not restored, or the wipe would recreate topics as fast as it deletes them.
  let wiping = false;
  // One writer per chat and the catch-up state — see ChatCatchUp.
  const chatSync = new ChatCatchUp({
    bot,
    groupId: targetGroupId,
    max,
    chatMapStore,
    messageLinks,
    getChats,
    getMyAccountId,
    getContactProfiles,
    sendCard: (chatId, topicId, sender) => sendAutoInfoCard(chatId, sender, topicId),
    forgetChatLinks,
    isWiping: () => wiping,
  });

  /**
   * The cursor moves to the sent message's MAX server time after every outgoing send: `outgoingCids`
   * and `messageLinks` don't survive a restart, so a reconnect's catch-up would otherwise find our
   * own just-sent message past the stale cursor and relay it to Telegram a second time (hit live
   * 2026-08-13). Inside the chat's queue, so it lands after any incoming delivery still running.
   */
  function rememberOutgoingSend(chatId: unknown, cid: number, serverTime: unknown): void {
    outgoingCids.remember(cid);
    lastOutAt = Date.now();
    chatSync.runInChat(chatId, () => chatSync.advanceCursor(chatId, serverTime, 'outgoing send')).catch(() => undefined);
  }

  // Big files through links (fileShare.ts / bigFiles.ts): Telegram's bot limits are 20 MB down and
  // 50 MB up, MAX takes 4 GB.
  const fileShare = new FileShare(path.join(process.cwd(), '.data'), fileShareOptionsFromEnv());
  void fileShare
    .init()
    .then(() => fileShare.startBackground())
    .catch((err) => logger.error('Big-file storage failed to start', err));
  const bigFiles = createBigFiles({
    bot,
    max,
    targetGroupId,
    fileShare,
    onSentToMax: (ticket, sent) => {
      rememberOutgoingSend(ticket.maxChatId, sent.cid, sent.time);
      messageLinks.add({ maxChatId: ticket.maxChatId, maxMessageId: sent.messageId, telegramMessageId: ticket.telegramMessageId, telegramTopicId: ticket.topicId, outgoing: true });
    },
  });
  bigFileRelay = bigFiles.relayFromMax;

  // `${chatId}:${messageId}` -> what we last relayed, so the sticky lastReactedMessageId/lastReaction
  // fields on CHAT_UPDATE (repeated across unrelated pushes) don't re-trigger the same Telegram call.
  // Doubles as the poll list for reaction removal; keeps the original messageId (BigInt) for MSG_GET_REACTIONS.
  const lastRelayedReaction = new Map<string, { chatId: unknown; messageId: unknown; emoji: string }>();
  // `${chatId}:${messageId}|${emoji}` pairs Telegram rejected as outside its reaction set. FIFO-bounded.
  const rejectedReactions = new Set<string>();
  const REJECTED_REACTIONS_CAP = 200;

  /** Forgets one message's link together with its relayed-reaction entry — once it's deleted on either side nothing should poll or probe it again. */
  function forgetLink(maxChatId: unknown, maxMessageId: unknown): void {
    messageLinks.remove(maxChatId, maxMessageId);
    lastRelayedReaction.delete(`${String(maxChatId)}:${String(maxMessageId)}`);
  }

  /**
   * A linked message is gone (deleted on MAX, or by /delete or 👎): forgets its link FIRST, then
   * deletes every Telegram message it produced (plus `alsoIds`), each on its own. Forgetting first
   * matters: the deletion probe must never see the copies vanish while the link is still there.
   */
  async function dropLinkedMessage(link: MessageLink, why: string, alsoIds: number[] = []): Promise<void> {
    forgetLink(link.maxChatId, link.maxMessageId);
    for (const id of new Set([...alsoIds, ...linkTelegramIds(link)])) {
      await bot.telegram.deleteMessage(targetGroupId, id).catch((err) => logger.error(`Failed to delete Telegram message ${id} (${why})`, err));
    }
  }

  /** Forgets every link (and relayed reaction) of one MAX chat — call BEFORE deleting its topic, see MessageLinkStore.removeByChat. */
  function forgetChatLinks(maxChatId: unknown): void {
    const dropped = messageLinks.removeByChat(maxChatId);
    const prefix = `${String(maxChatId)}:`;
    for (const key of [...lastRelayedReaction.keys()]) {
      if (key.startsWith(prefix)) lastRelayedReaction.delete(key);
    }
    if (dropped > 0) logger.info(`Forgot ${dropped} message link(s) of MAX chat ${String(maxChatId)} — its topic is going away`);
  }

  /** Forgets ALL links — /reboot and /kill, before their topic-deletion loop. */
  function forgetAllLinks(): void {
    messageLinks.clear();
    pollLinks.clear();
    lastRelayedReaction.clear();
  }

  // Poll votes arrive as a repeat PUSH_MESSAGE (same messageId, updated attaches[0].state — confirmed
  // live 2026-08-10). Telegram's poll widget can't take an external vote, so a dedup by poll
  // `version` gates a follow-up tally message instead. FIFO-bounded.
  const lastRelayedPollVersion = new Map<string, number>();
  const POLL_VERSION_CAP = 500;
  function rememberPollVersion(key: string, version: number): void {
    if (!lastRelayedPollVersion.has(key) && lastRelayedPollVersion.size >= POLL_VERSION_CAP) {
      const oldest = lastRelayedPollVersion.keys().next().value;
      if (oldest !== undefined) lastRelayedPollVersion.delete(oldest);
    }
    lastRelayedPollVersion.set(key, version);
  }

  // MAX sends no live push for reaction removal (see handleMaxChatUpdate): poll each message with
  // an active relayed reaction and clear it in Telegram once MAX reports it gone.
  const REACTION_POLL_INTERVAL_MS = 60_000;
  setInterval(() => void pollReactionRemovals(), REACTION_POLL_INTERVAL_MS).unref();

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
        // REACTION_EMPTY = the message exists and has no bot reaction to clear: already in the
        // desired state, stop polling it instead of logging the same error every minute.
        if (classifyProbeResult(telegramErrorText(err)) === 'alive') {
          lastRelayedReaction.delete(key);
          continue;
        }
        logger.error(`Failed to poll MAX reactions for chat ${relayed.chatId} message ${String(relayed.messageId)}`, err);
      }
    }
  }

  /**
   * Deletion probe. Bot API never tells a bot that a message was deleted, so our OWN relayed
   * messages are polled with an (invisible) setMessageReaction and the error text read: a live
   * message answers REACTION_EMPTY, a deleted one "message to react not found" (classifyProbeResult).
   * A gone message is mirror-deleted on MAX forAll — it's ours — but only after probeLinkGuard and
   * a topic-liveness check rule out that the whole topic went away. The decay ladder
   * (probeIntervalMs) concentrates pings right after send, where ~90% of deletions happen.
   *
   * If a MAX user reacted to our message, the bot has placed that emoji on the Telegram side and a
   * bare empty probe would WIPE it — so the probe re-affirms the relayed reaction ([emoji]) rather
   * than clearing it ([]); idempotent, existence is still checked by the same call.
   */
  const PROBE_TICK_MS = 15_000;
  const PROBE_MAX_PER_TICK = 12; // comfortably under Telegram's ~30 req/s global cap
  const probeLastAt = new Map<string, number>();
  setInterval(() => void runProbeTick(), PROBE_TICK_MS).unref();

  /** Deletes a forum topic. One already gone (deleted by hand) is the wanted outcome, not an error. Never throws. */
  async function deleteTopic(topicId: number, what: string): Promise<void> {
    try {
      await withFloodRetry(() => bot.telegram.deleteForumTopic(targetGroupId, topicId));
    } catch (err) {
      if (isThreadNotFound(err)) logger.info(`Telegram topic ${topicId} was already gone (${what})`);
      else logger.error(`Failed to delete Telegram topic ${topicId} (${what})`, err);
    }
  }

  async function probeMessageState(link: MessageLink): Promise<'alive' | 'gone' | 'unknown'> {
    const relayed = lastRelayedReaction.get(`${String(link.maxChatId)}:${String(link.maxMessageId)}`);
    // relayed.emoji is stored in MAX form (pollReactionRemovals compares it against getReactions).
    const reaction = relayed ? [{ type: 'emoji' as const, emoji: toTelegramReaction(relayed.emoji) as TelegramEmoji }] : [];
    try {
      await bot.telegram.setMessageReaction(targetGroupId, link.telegramMessageId, reaction);
      return 'alive'; // ok — the message exists (reaction re-affirmed, or empty no-op accepted)
    } catch (err) {
      const errText = telegramErrorText(err);
      // The emoji itself was refused — says nothing about the message; retry with the empty probe.
      if (reaction.length > 0 && isReactionInvalid(errText)) {
        try {
          await bot.telegram.setMessageReaction(targetGroupId, link.telegramMessageId, []);
          return 'alive';
        } catch (retryErr) {
          return classifyProbeResult(telegramErrorText(retryErr));
        }
      }
      return classifyProbeResult(errText);
    }
  }

  async function runProbeTick(): Promise<void> {
    // /reboot or /kill is deleting every topic: messages vanish with them, and nothing here may
    // read that as the owner deleting them (the guard below re-checks per link: a wipe can start mid-tick).
    if (wiping) return;
    const now = Date.now();
    const due: MessageLink[] = [];
    const liveKeys = new Set<string>();
    for (const link of messageLinks.outgoingLinks()) {
      const key = `${String(link.maxChatId)}:${String(link.maxMessageId)}`;
      liveKeys.add(key);
      const interval = probeIntervalMs(now - (link.createdAt ?? now));
      if (interval == null) {
        probeLastAt.delete(key); // cooled off — stop probing (the link itself lives on for /delete & edit)
        continue;
      }
      if (now - (probeLastAt.get(key) ?? 0) >= interval) due.push(link);
    }
    // Entries whose link was evicted or removed would otherwise sit in probeLastAt forever.
    for (const key of probeLastAt.keys()) {
      if (!liveKeys.has(key)) probeLastAt.delete(key);
    }
    // Checked BEFORE and again AFTER the probe: a /ban, «Чат закрыт», topic restore, /reboot or
    // /kill can land while the probe call is in flight, and a 'gone' probe deletes on MAX forAll.
    const guard = async (link: MessageLink): Promise<{ verdict: 'probe' | 'skip' | 'drop'; topicId?: number; title?: string }> => {
      if (wiping) return { verdict: 'skip' };
      const mapping = await chatMapStore.getByMaxChatId(link.maxChatId);
      return { verdict: probeLinkGuard(link, mapping), topicId: mapping?.telegramTopicId, title: mapping?.title };
    };
    for (const link of due.slice(0, PROBE_MAX_PER_TICK)) {
      const key = `${String(link.maxChatId)}:${String(link.maxMessageId)}`;
      // Already dropped (forgetChatLinks, /ban, /delete, 👎, a REMOVED push) — checked again before the forAll delete.
      if (messageLinks.getByMax(link.maxChatId, link.maxMessageId) !== link) continue;
      const before = await guard(link);
      if (before.verdict === 'drop') {
        forgetLink(link.maxChatId, link.maxMessageId);
        continue;
      }
      if (before.verdict === 'skip') continue;
      probeLastAt.set(key, Date.now());
      const state = await probeMessageState(link);
      if (state !== 'gone') continue;
      const after = await guard(link);
      if (after.verdict !== 'probe' || after.topicId == null) {
        if (after.verdict === 'drop') forgetLink(link.maxChatId, link.maxMessageId);
        logger.info(`probe: Telegram message ${link.telegramMessageId} gone but chat ${String(link.maxChatId)} changed meanwhile (${after.verdict}) — not deleting on MAX`);
        continue;
      }
      // Two independent witnesses that only this ONE message went away, not its whole topic —
      // the forAll delete below is irreversible. First: the topic itself still exists.
      const topicState = await probeTopic(bot, targetGroupId, after.topicId, after.title);
      if (topicState === 'gone') {
        // None of the chat's links may reach the delete. The topic comes back with the chat's
        // next incoming message.
        forgetChatLinks(link.maxChatId);
        logger.info(`probe: Telegram message ${link.telegramMessageId} gone together with topic ${after.topicId} — dropped the chat's links, nothing deleted on MAX`);
        continue;
      }
      if (topicState === 'unknown') continue; // 429/network/no title — keep the link, retry on the ladder
      // Second, not relying on how Telegram answers for a topic: the newest copy the bot wrote
      // into the same topic is still there. Gone as well => treated as the topic vanishing.
      const witness = messageLinks.newestIncoming(link.maxChatId);
      if (witness) {
        const witnessState = await probeMessageState(witness);
        if (witnessState === 'unknown') continue;
        if (witnessState === 'gone') {
          forgetLink(witness.maxChatId, witness.maxMessageId);
          forgetLink(link.maxChatId, link.maxMessageId);
          logger.info(`probe: Telegram message ${link.telegramMessageId} gone, and so is the newest MAX copy in its topic — not deleting on MAX (use /delete if it was meant)`);
          continue;
        }
      }
      // Forgotten while the probe was in flight (/delete, 👎, a REMOVED push — each forgets the link
      // BEFORE deleting the copies, which is what the probe saw vanish): that deletion is already
      // handled, and a forAll here would turn a «/delete me» into a delete for everyone.
      if (messageLinks.getByMax(link.maxChatId, link.maxMessageId) !== link) continue;
      try {
        await max.deleteMessages(link.maxChatId, linkMaxIds(link), false); // forAll — it's ours
        forgetLink(link.maxChatId, link.maxMessageId);
        probeLastAt.delete(key);
        // Its bot notices would otherwise stay as replies to nothing.
        await deleteBotMessages(bot, targetGroupId, link.noticeTelegramMessageIds ?? [], 'probe-delete notices');
        logger.info(`probe-delete: Telegram message ${link.telegramMessageId} gone -> removed MAX message ${String(link.maxMessageId)} (forAll)`);
      } catch (err) {
        logger.error(`Probe saw Telegram message ${link.telegramMessageId} deleted but failed to mirror-delete on MAX`, err);
      }
      await sleep(200); // space out consecutive mirror-deletes
    }
  }

  // Roughly once a day at a jittered offset — spreads GitHub API calls out across installs.
  const VERSION_CHECK_MIN_MS = 20 * 60 * 60 * 1000;
  const VERSION_CHECK_MAX_MS = 28 * 60 * 60 * 1000;
  scheduleVersionCheck();

  // Anonymous install counter (opt out with TELEMETRY=off). Pinged once shortly after boot so
  // a fresh install registers without waiting up to a day, then on every version-check tick.
  const telemetry = createTelemetry();
  setTimeout(() => void telemetry.ping(), 60_000).unref();

  function scheduleVersionCheck(): void {
    const delay = VERSION_CHECK_MIN_MS + Math.random() * (VERSION_CHECK_MAX_MS - VERSION_CHECK_MIN_MS);
    setTimeout(() => void runScheduledVersionCheck().finally(scheduleVersionCheck), delay).unref();
  }

  async function runScheduledVersionCheck(): Promise<void> {
    void telemetry.ping();
    const status = await checkVersion();
    if (!status.updateAvailable) return;
    const { text, replyMarkup } = formatVersionMessage(status);
    await bot.telegram.sendMessage(targetGroupId, text, { reply_markup: replyMarkup }).catch((err) => logger.error('Failed to send scheduled version-update notice', err));
  }

  // A new MAX socket means a gap: whatever arrived meanwhile has to be caught up (ChatCatchUp)
  // before a live message may move any chat's cursor again. 'connected' too: a manual reconnect
  // tears the old socket down without emitting 'disconnected' (client.ts teardownSocket).
  max.on('disconnected', () => chatSync.reset());
  max.on('connected', () => chatSync.reset());

  max.on('message', (event: MaxMessageEvent) => {
    if (event.opcode === OPCODES.PUSH_MESSAGE) {
      // Anything thrown before handleMaxPush's own try/catch was an unhandled rejection that
      // silently vanished (confirmed live 2026-08-13 on a forwarded FILE that never arrived).
      const payload = event.payload as MaxPushPayload;
      if (payload?.chatId != null) chatSync.runInChat(payload.chatId, () => handleMaxPush(payload)).catch((err) => logger.error('handleMaxPush crashed', err));
    } else if (event.opcode === OPCODES.PUSH_TYPING) {
      void handleMaxTyping(event.payload as MaxTypingPayload);
    } else if (event.opcode === OPCODES.CHAT_UPDATE) {
      void handleMaxChatUpdate(event.payload);
    } else if (event.opcode === OPCODES.NOTIF_CALL_START) {
      const payload = event.payload as { caller?: unknown; callId?: unknown; chatId?: unknown } | null;
      // Same per-chat queue as the pushes: a call can open a brand-new chat's topic.
      if (payload?.chatId != null) void chatSync.runInChat(payload.chatId, () => handleIncomingCall(payload));
    } else if (event.opcode === OPCODES.NOTIF_MSG_DELETE) {
      void handleMaxMessageDelete(event.payload);
    } else if (event.opcode === OPCODES.NOTIF_MSG_REACTIONS_CHANGED || event.opcode === OPCODES.NOTIF_MSG_YOU_REACTED) {
      // Deliberate diagnostic, not dead code: never fired for a real reaction (tested live
      // 2026-08-08 — CHAT_UPDATE is the real path). Logged at `info` so that if it ever does fire
      // its payload shape shows up in default logs; redacted, since an unknown shape may carry anything.
      logger.info(`${formatOpcode(event.opcode)} payload:`, jsonStringify(redactSecrets(event.payload)));
    }
  });

  /**
   * Reaction *additions* only: MAX sends no push for removals through any mechanism found so far
   * (NOTIF_MSG_REACTIONS_CHANGED/NOTIF_MSG_YOU_REACTED don't fire either — tested live 2026-08-08).
   * The general "chat updated" push's `lastReactedMessageId`/`lastReaction` reliably correlated with
   * real reaction-add events, despite also appearing on unrelated resyncs (hence the dedup).
   */
  async function handleMaxChatUpdate(payload: unknown): Promise<void> {
    const rawChat = (payload as { chat?: unknown } | null)?.chat;
    const chat = rawChat as { id?: unknown; lastReactedMessageId?: unknown; lastReaction?: string } | undefined;
    if (!chat || chat.id == null) return;

    // Not a reaction → a chat state change (creation/rename/members): rename a topic stuck on the
    // "MAX chat <id>" fallback (the CONTROL 'new' push creates the topic before the chat is cached).
    if (chat.lastReactedMessageId == null || !chat.lastReaction) {
      const mapping = await chatMapStore.getByMaxChatId(chat.id);
      if (!mapping) return;
      const name = clampTopicTitle(resolveChatName(rawChat, getMyAccountId(), getContactProfiles()));
      if (!name || name === mapping.title || isFallbackTitle(name)) return;
      await bot.telegram
        .editForumTopic(targetGroupId, mapping.telegramTopicId, { name })
        .catch((err) => logger.error('Failed to rename topic on chat update', err));
      await chatMapStore.setTitle(chat.id, mapping.telegramTopicId, name); // title only — see setTitle
      logger.info(`Renamed topic ${mapping.telegramTopicId} for MAX chat ${String(chat.id)} -> "${name}"`);
      return;
    }

    const link = messageLinks.getByMax(chat.id, chat.lastReactedMessageId);
    if (!link) return;

    const key = `${chat.id}:${String(chat.lastReactedMessageId)}`;
    if (lastRelayedReaction.get(key)?.emoji === chat.lastReaction) return;
    if (rejectedReactions.has(`${key}|${chat.lastReaction}`)) return; // Telegram already refused this emoji here

    try {
      // Telegram only accepts a fixed emoji set; an unsupported one rejects here — not fatal.
      await bot.telegram.setMessageReaction(targetGroupId, link.telegramMessageId, [
        { type: 'emoji', emoji: toTelegramReaction(chat.lastReaction) as TelegramEmoji },
      ]);
      // Recorded only once Telegram accepted it: the probe re-affirms this exact emoji and
      // pollReactionRemovals clears it, so a rejected emoji must not be remembered.
      lastRelayedReaction.set(key, { chatId: chat.id, messageId: chat.lastReactedMessageId, emoji: chat.lastReaction });
    } catch (err) {
      // lastReaction is sticky across unrelated CHAT_UPDATEs — a refused emoji would be retried on every one.
      if (isReactionInvalid(telegramErrorText(err))) {
        if (rejectedReactions.size >= REJECTED_REACTIONS_CAP) {
          const oldest = rejectedReactions.values().next().value;
          if (oldest !== undefined) rejectedReactions.delete(oldest);
        }
        rejectedReactions.add(`${key}|${chat.lastReaction}`);
      }
      logger.error('Failed to relay MAX reaction to Telegram', err);
    }
  }

  /** Reports a poll's new tally as a reply (Telegram's poll widget can't take a vote it didn't receive), joined to the poll's link as a notice. Returns its message_id. */
  async function relayPollUpdate(chatId: unknown, maxMessageId: unknown, telegramMessageId: number, pollAttach: MaxAttachment): Promise<number | undefined> {
    const mapping = await chatMapStore.getByMaxChatId(chatId);
    if (!mapping) return undefined;
    const lines = (pollAttach.answers ?? []).map((a) => {
      const result = pollAttach.state?.result?.find((r) => String(r.answerId) === String(a.answerId));
      return `${a.text ?? '—'}: ${result?.voteCount ?? 0}`;
    });
    const sent = await withFloodRetry(() =>
      bot.telegram.sendMessage(targetGroupId, `🗳 Обновление опроса «${pollAttach.title ?? ''}»:\n${lines.join('\n')}`, {
        message_thread_id: mapping.telegramTopicId,
        reply_parameters: { message_id: telegramMessageId },
      }),
    );
    messageLinks.addNotice(chatId, maxMessageId, sent.message_id);
    logger.info(`Relayed poll tally update (pollId=${String(pollAttach.pollId)}) to Telegram topic ${mapping.telegramTopicId}`);
    return sent.message_id;
  }

  /**
   * Fallback + diagnostic for NOTIF_MSG_DELETE — never observed live (deletions arrive as a REMOVED
   * push, see handleMaxPush), kept in case it fires in some other scenario. Its payload shape is a
   * guess mirroring MSG_DELETE's request; any other shape is logged (redacted, at info) so a real
   * one can be wired up from the log.
   */
  async function handleMaxMessageDelete(payload: unknown): Promise<void> {
    const p = payload as { chatId?: unknown; messageIds?: unknown[] } | null;
    if (p?.chatId == null || !Array.isArray(p.messageIds)) {
      logger.info('NOTIF_MSG_DELETE payload (unrecognized shape):', jsonStringify(redactSecrets(payload)));
      return;
    }
    for (const messageId of p.messageIds) {
      const link = messageLinks.getByMax(p.chatId, messageId);
      if (!link) continue;
      await dropLinkedMessage(link, `MAX NOTIF_MSG_DELETE of message ${String(messageId)}`);
    }
  }

  /**
   * Real-time "phone is ringing" notification — joining the call needs WebRTC, out of scope for a
   * Bot API bridge. Delivered like a push (the chat's queue, its topic opened and caught up first):
   * a call can be a new contact's first sign of life.
   */
  async function handleIncomingCall(payload: { caller?: unknown; callId?: unknown; chatId?: unknown }): Promise<void> {
    const chatId = payload?.chatId;
    if (chatId == null || wiping) return;
    try {
      if ((await chatMapStore.getByMaxChatId(chatId))?.banned) return;
      const callerId = typeof payload.caller === 'number' ? payload.caller : Number(payload.caller);
      let callerName = `MAX ID ${String(payload.caller)}`;
      if (!Number.isNaN(callerId)) {
        callerName = resolveContactDisplayName(callerId, await resolveProfile(max, callerId, 'caller', getContactProfiles()));
      }
      // A call notice is not part of the history: it goes out even when the catch-up is deferred.
      const opened = await chatSync.openTopic(chatId, resolveTopicTitle(chatId), payload.caller);
      if (!opened) return;
      await sendToTopic(chatId, opened.topicId, async (id) => {
        await withFloodRetry(() => bot.telegram.sendMessage(targetGroupId, `📞 Входящий звонок от ${callerName}`, { message_thread_id: id }));
      });
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
   * Renames a topic stuck on a fallback title («MAX chat <id>») the moment the contact's profile
   * becomes known (the auto-card's CONTACT_INFO fetch). Closes the race where a fresh dialog's
   * CHAT_UPDATE arrives BEFORE the profile is cached and no later trigger fires (seen live 2026-09-22).
   */
  async function renameFallbackTopic(chatId: unknown, contactId: number, profile: ContactProfile | undefined): Promise<void> {
    const name = clampTopicTitle(resolveContactDisplayName(contactId, profile));
    if (!name || isFallbackTitle(name)) return; // profile fetch failed — still nothing real to rename to
    const mapping = await chatMapStore.getByMaxChatId(chatId);
    if (!mapping || (mapping.title && !isFallbackTitle(mapping.title))) return;
    try {
      await bot.telegram.editForumTopic(targetGroupId, mapping.telegramTopicId, { name });
      await chatMapStore.setTitle(chatId, mapping.telegramTopicId, name); // title only — see setTitle
      logger.info(`Renamed topic ${mapping.telegramTopicId} for MAX chat ${String(chatId)} -> "${name}" (profile learned via auto-card)`);
    } catch (err) {
      logger.error('Failed to rename topic after contact profile fetch', err);
    }
  }

  /**
   * Sends the intro card the moment a topic is created for a chat we've never seen before. If the
   * chat isn't in the last CHATS_LIST snapshot yet (a brand-new contact writing for the first time),
   * falls back to the push's `message.sender` and fetches that contact's CONTACT_INFO.
   */
  async function sendAutoInfoCard(chatId: unknown, senderId: unknown, topicId: number): Promise<void> {
    const { chat, otherId, profile } = resolveDialogContact(String(chatId));
    if (chat) {
      const count = chat.participants ? Object.keys(chat.participants).length : undefined;
      // A 1:1 created via createDialog comes back typed CHAT, not DIALOG (a 2-participant chat
      // with no title is a dialog) — render it as a contact card, not a generic group card.
      const looksLikeDialog = chat.type === 'DIALOG' || (!chat.title && count === 2 && otherId != null);
      if (looksLikeDialog && otherId != null) {
        const dialogProfile = profile ?? (await resolveProfile(max, otherId, 'dialog contact', getContactProfiles()));
        await renameFallbackTopic(chatId, otherId, dialogProfile);
        const messageId = await sendContactInfoCard(bot, targetGroupId, topicId, chat.title || `MAX chat ${String(chatId)}`, 'DIALOG', count, otherId, dialogProfile);
        await pinInfoCard(bot, targetGroupId, messageId);
        return;
      }
      const roster = await buildRoster(chat.participants, chat.type, max, getMyAccountId(), getContactProfiles());
      const messageId = await sendContactInfoCard(bot, targetGroupId, topicId, chat.title || `MAX chat ${String(chatId)}`, chat.type, count, otherId, profile, roster);
      await pinInfoCard(bot, targetGroupId, messageId);
      return;
    }
    const id = typeof senderId === 'number' ? senderId : Number(senderId);
    if (Number.isNaN(id)) return;
    // The owner wrote first (to a bot, from the MAX app) and the chat is not cached yet: the sender
    // is the owner, not the contact — the topic got the owner's own name and card (live 2026-10-04).
    // The title follows with the chat's next update; no card is better than a wrong one.
    if (String(id) === String(getMyAccountId())) return;
    const senderProfile = await resolveProfile(max, id, 'new contact', getContactProfiles());
    await renameFallbackTopic(chatId, id, senderProfile);
    const messageId = await sendContactInfoCard(bot, targetGroupId, topicId, `MAX ID ${id}`, 'DIALOG', undefined, id, senderProfile);
    await pinInfoCard(bot, targetGroupId, messageId);
  }

  /** A real display name for a chat from the cached snapshot, or undefined when only a
   * generic fallback ("CHAT <id>", "MAX chat <id>", "MAX ID <id>") is available — so we
   * never name/rename a topic TO a fallback. Names a topic at creation (the CONTROL
   * 'new' push creates it before a resync would) and keeps it current on later messages. */
  function resolveTopicTitle(chatId: unknown): string | undefined {
    const key = String(chatId);
    const chat = getChats().find((c) => c && typeof c === 'object' && String((c as { id?: unknown }).id) === key);
    if (!chat) return undefined;
    const name = clampTopicTitle(resolveChatName(chat, getMyAccountId(), getContactProfiles()));
    if (!name || isFallbackTitle(name)) return undefined;
    return name;
  }

  /**
   * Runs `send` against the chat's topic — inside the chat's queue, after openTopic. If the topic
   * was deleted out from under us, restores it (ChatCatchUp.restoreTopic) — without this, deleting
   * a topic silently black-holed every future message from that contact (reported live 2026-08-15).
   * Any other delivery failure is reported to the group (throttled) and rethrown.
   */
  async function sendToTopic(chatId: unknown, topicId: number, send: (topicId: number) => Promise<void>): Promise<void> {
    try {
      await send(topicId);
    } catch (err) {
      if (!isThreadNotFound(err)) {
        reportBridgeError(
          'tg-deliver',
          `⚠️ Не удаётся доставить сообщение в Telegram: ${(err as Error).message}. Проверьте права бота и связь с Telegram.`,
        );
        throw err;
      }
      // No re-send: the triggering message is part of the history the restore replays.
      await chatSync.restoreTopic(chatId);
    }
  }

  /**
   * A MAX edit that could not be applied to the anchor in place: a media anchor gets the text as
   * its caption when it fits, otherwise the edit goes out as a reply to the anchor (a notice). The
   * same text again needs nothing; an outgoing link's copy is the owner's own message — not editable.
   */
  async function relayEditFallback(chatId: unknown, maxMessageId: unknown, link: MessageLink, marked: string, err: unknown): Promise<void> {
    const errText = telegramErrorText(err);
    if (/message is not modified/i.test(errText)) return;
    // The owner deleted the copy in Telegram: bringing the content back as a reply would undo that.
    if (/message to edit not found/i.test(errText)) {
      logger.info(`MAX edit of message ${String(maxMessageId)} not relayed: its Telegram copy was deleted`);
      return;
    }
    if (link.outgoing) {
      logger.error('Failed to relay MAX edit to Telegram (the copy is the owner\'s own message)', err);
      return;
    }
    if (/no text in the message to edit/i.test(errText) && marked.length <= TELEGRAM_CAPTION_LIMIT) {
      try {
        await bot.telegram.editMessageCaption(targetGroupId, link.telegramMessageId, undefined, marked);
        return;
      } catch (captionErr) {
        logger.error('Failed to put a MAX edit into the caption of its media message — sending it as a reply', captionErr);
      }
    } else {
      logger.error('Failed to edit the Telegram copy of a MAX message — sending the edit as a reply', err);
    }
    const mapping = await chatMapStore.getByMaxChatId(chatId);
    if (!mapping) return;
    try {
      const sent = await withFloodRetry(() =>
        bot.telegram.sendMessage(targetGroupId, marked, {
          message_thread_id: mapping.telegramTopicId,
          reply_parameters: { message_id: link.telegramMessageId, allow_sending_without_reply: true },
        }),
      );
      messageLinks.addNotice(chatId, maxMessageId, sent.message_id);
    } catch (replyErr) {
      logger.error('Failed to relay MAX edit to Telegram', replyErr);
    }
  }

  async function handleMaxPush(payload: MaxPushPayload): Promise<void> {
    const chatId = payload?.chatId;
    const message = payload?.message;
    if (chatId == null || !message) return;
    // /reboot or /kill is deleting every topic right now — a push would only recreate one.
    if (wiping) return;
    // Our own message echoed back. Only a NEW message is an echo: a deletion in the MAX app of a
    // message sent from Telegram is a REMOVED repeat push with the same cid, and must go through.
    // An EDITED repeat stays dropped — that copy is the owner's own Telegram message.
    if (message.cid != null && outgoingCids.has(message.cid) && message.status !== 'REMOVED') return;
    // Banned chat (/ban): drop everything for it — no mirror, no topic recreate.
    const banCheck = await chatMapStore.getByMaxChatId(chatId);
    if (banCheck?.banned) return;

    let text = message.text;
    let attaches = Array.isArray(message.attaches) ? message.attaches : [];
    // Chat deletion: a PUSH_MESSAGE carrying a CONTROL attach with event:"system" and message
    // "Чат закрыт" (confirmed live 2026-08-17 — NOT a CHAT_UPDATE status:CLOSED). Mirror it: delete
    // the topic and drop the mapping. Other "system" events fall through to sendAttachments' skip.
    const controlAttach = (attaches as Array<{ _type?: string; event?: string; message?: string; shortMessage?: string }>).find(
      (a) => a?._type === 'CONTROL',
    );
    if (controlAttach?.event === 'system' && isChatClosedNotice(controlAttach.message ?? controlAttach.shortMessage)) {
      if (banCheck) {
        // Links first — see MessageLinkStore.removeByChat.
        forgetChatLinks(chatId);
        await deleteTopic(banCheck.telegramTopicId, 'MAX chat closed');
        await chatMapStore.remove(chatId);
        logger.info(`MAX chat ${String(chatId)} deleted ("Чат закрыт") — removed Telegram topic ${banCheck.telegramTopicId}`);
      }
      return;
    }
    // A deletion is a repeat push with status "REMOVED" (see MaxPushPayload.status) — the real path,
    // not NOTIF_MSG_DELETE.
    if (message.status === 'REMOVED') {
      if (message.id == null || !banCheck) return;
      // Caught up first: a message the catch-up relayed moments ago has its link by now, so the
      // deletion finds it. No link (relayed before a restart, evicted) — nothing to delete.
      await chatSync.ensureCaughtUp(chatId).catch((err) => onLiveDeliveryFailed(chatId, err, 'Catch-up before a MAX deletion'));
      const link = messageLinks.getByMax(chatId, message.id);
      if (link) {
        await dropLinkedMessage(link, `MAX deletion of message ${String(message.id)}`);
        logger.info(`MAX -> TG: deletion of message ${String(message.id)} in chat ${String(chatId)} mirrored (${linkTelegramIds(link).length} Telegram message(s) removed)`);
      }
      return;
    }
    // Everything below writes into the chat's topic: open it and catch the chat up first
    // (ChatCatchUp) — a message that arrived while the bridge was offline goes out before this
    // one, and this one, if that catch-up already relayed it, is found linked below.
    let opened: Awaited<ReturnType<ChatCatchUp['openTopic']>>;
    try {
      opened = await chatSync.openTopic(chatId, resolveTopicTitle(chatId), message.sender);
    } catch (err) {
      onLiveDeliveryFailed(chatId, err, 'Opening the topic for a MAX message');
      return;
    }
    // Deferred: this message is in the history above the cursor and arrives with the retried catch-up.
    if (!opened || opened.deferred) return;
    const topicId = opened.topicId;

    const forwarded = await resolveForwardContent(max, getChats(), message.link, chatId, message.id, getContactProfiles());
    if (forwarded) {
      text = forwarded.text;
      attaches = forwarded.attaches;
    }
    // The keyboard leaves the attaches here: it is no message of its own (see sendKeyboardAlone).
    const taken = takeKeyboard(attaches, chatId);
    attaches = taken.attaches;
    const keyboard = taken.keyboard;
    // Text of its own, before any forward/reply prefix — an orphan edit without it has nothing to post.
    const hasOwnText = Boolean(forwarded ? message.link?.message?.text : message.text);

    // A reply we RECEIVE: link.message is the FULL quoted message (the incoming shape carries
    // `message`, the OUTGOING reply `messageId`). A NATIVE Telegram reply when the quoted message
    // is in the link store; a text-quote prefix otherwise (the store is in-memory and bounded).
    let replyParameters: { message_id: number; allow_sending_without_reply: boolean } | undefined;
    if (message.link?.type === 'REPLY') {
      const quotedId = message.link.message?.id;
      const linked = quotedId != null ? messageLinks.getByMax(chatId, quotedId) : undefined;
      if (linked) {
        replyParameters = { message_id: linked.telegramMessageId, allow_sending_without_reply: true };
      } else {
        const quotedText = typeof message.link.message?.text === 'string' ? message.link.message.text : '';
        // Cut by code points: a UTF-16 slice ending inside a surrogate pair gets the whole message refused.
        const snippet = quotedText ? `«${truncateCodePoints(quotedText, 80, '…')}»` : 'сообщение';
        const prefix = `↩️ В ответ на ${snippet}:`;
        text = text ? `${prefix}\n${text}` : prefix;
      }
    }

    const existingLink = message.id != null ? messageLinks.getByMax(chatId, message.id) : undefined;
    if (existingLink) {
      // A repeat push carrying a POLL is a tally update (relayed below), not a text edit — the
      // anchor is then the poll itself, which an edit marker must not overwrite.
      const isPollUpdate = attaches.some((a) => (a as MaxAttachment)._type === 'POLL');
      // A new message already in Telegram: the catch-up above relayed it moments ago — including a
      // poll, whose own push would otherwise post a tally of zero votes.
      const hasVotes = attaches.some((a) => (a as MaxAttachment)._type === 'POLL' && (a as MaxAttachment).state?.result?.some((r) => (r.voteCount ?? 0) > 0));
      if (message.status == null && !hasVotes) return;
      if (text != null && !isPollUpdate) {
        // Telegram never shows its "edited" tag on bot-edited messages, so the marker goes into the
        // text itself, fused with the author prefix in groups ("✏️ 👤 Имя:"). No stacking on
        // repeated edits: MAX sends the full fresh text each time.
        const editedChat = getChats().find((c) => c && typeof c === 'object' && String((c as { id?: unknown }).id) === String(chatId));
        const editAuthorPrefix = await resolveAuthorPrefix(editedChat, message.sender, getMyAccountId(), max, getContactProfiles());
        // Receipt time ≈ edit time (MAX's payload carries no confirmed edit timestamp). Timezone
        // mirrors the client's default, overridable via TZ — the container runs on UTC.
        const editedAt = new Intl.DateTimeFormat('ru-RU', { hour: '2-digit', minute: '2-digit', timeZone: process.env.TZ || 'Europe/Moscow' }).format(new Date());
        let marked = editAuthorPrefix ? `✏️ (${editedAt}) ${editAuthorPrefix}${text}` : `✏️ изменено в ${editedAt}:\n${text}`;
        // Known limitation: an edit only rewrites the ANCHOR. A text relayed as several pieces
        // keeps its later pieces, and an edit over the 4096 limit is cut («…») — the link doesn't
        // record which extra ids are text pieces, so re-splitting isn't possible.
        if (marked.length > TELEGRAM_TEXT_LIMIT) {
          logger.info(`MAX edit of message ${String(message.id)} is ${marked.length} chars — only its first ${TELEGRAM_TEXT_LIMIT} fit into the edited Telegram message`);
          marked = `${truncateUtf16(marked, TELEGRAM_TEXT_LIMIT - 1)}…`;
        }
        // The edit carries the message's current keyboard; an empty one removes buttons MAX dropped.
        const edit = (markup?: InlineMarkup) =>
          bot.telegram.editMessageText(targetGroupId, existingLink.telegramMessageId, undefined, marked, markup ? { reply_markup: markup } : {});
        try {
          await edit(keyboard ?? { inline_keyboard: [] }).catch((err) => {
            if (!isMarkupRefusal(err)) throw err;
            logger.info(`Telegram refused the keyboard of edited MAX message ${String(message.id)} (${telegramErrorText(err)}) — edited without it`);
            return edit();
          });
          logger.info(`MAX -> TG: edit of message ${String(message.id)} in chat ${String(chatId)} applied${keyboard ? ' (with keyboard)' : ''}`);
        } catch (err) {
          await relayEditFallback(chatId, message.id, existingLink, marked, err);
        }
      }
      const updatedPoll = attaches.find((a) => (a as MaxAttachment)._type === 'POLL') as MaxAttachment | undefined;
      if (updatedPoll) {
        const key = `${String(chatId)}:${String(message.id)}`;
        const version = typeof updatedPoll.version === 'number' ? updatedPoll.version : undefined;
        if (version == null || lastRelayedPollVersion.get(key) !== version) {
          if (version != null) rememberPollVersion(key, version);
          await relayPollUpdate(chatId, message.id, existingLink.telegramMessageId, updatedPoll).catch((err) =>
            logger.error('Failed to relay poll update to Telegram', err),
          );
        }
      }
      return;
    }
    // An EDIT of a message we hold no link for (relayed before a restart, evicted) has no Telegram
    // message to rewrite. Post only its fresh text, marked as an edit of an older message and
    // linked like any message; attachments are not re-sent, and the cursor doesn't move (it isn't
    // a new message in the chat's history). No text of its own — nothing worth posting.
    const orphanEdit = message.status === 'EDITED';
    if (orphanEdit) {
      if (!hasOwnText) {
        logger.info(`Skipped an edit of MAX message ${String(message.id)} in chat ${String(chatId)}: no link to it and no text to show`);
        return;
      }
      attaches = [];
    }

    // Nothing to RENDER (no text, only non-rendered CONTROL events): no bare "👤 Имя:" prefix. But
    // such an event can be the FIRST live signal of a group we were just added to, and creating
    // its topic is the ONLY way it appears live (CHAT_UPDATE never creates one) — openTopic above
    // already did that (regression "добавили в группу, а она не появляется" reported live
    // 2026-08-24). The attach types (never the content) are logged so a recurrence is self-diagnosing.
    if (!text && !keyboard && !attaches.some((a) => isRenderableAttach(a as MaxAttachment))) {
      if (attaches.length > 0) {
        const kinds = attaches
          .map((a) => `${(a as MaxAttachment)._type}${(a as { event?: unknown }).event ? `/${String((a as { event?: unknown }).event)}` : ''}${Array.isArray((a as MaxAttachment).userIds) ? '+userIds' : ''}`)
          .join(',');
        logger.info(`Skipped a non-renderable MAX message in chat ${String(chatId)} (attach: ${kinds})`);
      }
      return;
    }

    // A join/leave event becomes ONE actionable message (renderMemberEvent) and consumes the attach.
    // Resolved before the poll branch below, which needs the same author prefix.
    let memberMarkup: InlineMarkup | undefined;
    const memberEvent = await renderMemberEvent(attaches as MaxAttachment[], text, message.sender, getMyAccountId(), max, getContactProfiles());
    if (memberEvent) {
      text = memberEvent.text;
      attaches = [];
      memberMarkup = memberEvent.markup;
    } else {
      // For an attachment-only group message the prefix becomes the text, so the file shows who sent it.
      const senderChat = getChats().find((c) => c && typeof c === 'object' && String((c as { id?: unknown }).id) === String(chatId));
      const authorPrefix = await resolveAuthorPrefix(senderChat, message.sender, getMyAccountId(), max, getContactProfiles());
      if (authorPrefix) text = text ? `${authorPrefix}${text}` : authorPrefix;
    }
    if (orphanEdit) text = `✏️ Изменено (исходное сообщение не найдено):\n${text ?? ''}`;

    const pollAttach = attaches.find((a) => (a as MaxAttachment)._type === 'POLL') as MaxAttachment | undefined;
    if (pollAttach) {
      try {
        await sendToTopic(chatId, topicId, async (topicId) => {
          const options = (pollAttach.answers ?? []).map((a) => a.text || '—');
          const settings = pollAttach.settings ?? 0;
          const anonymous = (settings & 1) !== 0;
          // Whatever the regular path would say around it (a group author, a forward's source, a
          // reply quote, the message's own text) goes first as text, carrying the native reply —
          // sendPoll has no room for it. `sent` tracks every part for discardPartialDelivery.
          const sent: number[] = [];
          let linkIds: ReturnType<typeof buildLinkIds>;
          const noticeIds: number[] = [];
          try {
            const headerIds = text ? await sendTextPieces(bot, targetGroupId, topicId, text, { replyParameters, sent }) : [];
            const pollReply = headerIds.length === 0 && replyParameters ? { reply_parameters: replyParameters } : {};
            let sentPoll: { message_id: number; poll: { id: string } } | undefined;
            try {
              sentPoll = await withFloodRetry(() =>
                bot.telegram.sendPoll(targetGroupId, pollAttach.title || 'Опрос', options, {
                  is_anonymous: anonymous,
                  allows_multiple_answers: (settings & 2) !== 0,
                  message_thread_id: topicId,
                  ...pollReply,
                }),
              );
            } catch (err) {
              // Telegram's poll limits are tighter than MAX's — a refused poll goes out as text (renderPollAsText).
              if (!isPermanentTelegramRefusal(err)) throw err;
              logger.error(`Telegram refused MAX poll ${String(pollAttach.pollId)} as a native poll — relaying it as text`, err);
            }
            if (sentPoll) {
              const pollMessageId = sentPoll.message_id;
              sent.push(pollMessageId);
              logger.info(`Relayed MAX poll "${pollAttach.title}" (pollId=${String(pollAttach.pollId)}) to Telegram topic ${topicId}`);
              // Telegram's poll widget can't take a vote cast on MAX's side, and an anonymous poll
              // doesn't work the other way either (no poll_answer for it) — say so.
              const hint = anonymous
                ? '💡 Голоса с MAX сюда не попадают, а этот опрос анонимный — голоса отсюда тоже не уйдут в MAX. Голосуйте в MAX; ответьте на это сообщение командой /poll, чтобы увидеть актуальный счёт.'
                : '💡 Голоса с MAX сюда не попадают — ответьте на это сообщение командой /poll, чтобы увидеть актуальный счёт.';
              const reminder = await withFloodRetry(() =>
                bot.telegram.sendMessage(targetGroupId, hint, {
                  message_thread_id: topicId,
                  reply_parameters: { message_id: pollMessageId },
                }),
              ).catch((err) => {
                logger.error('Failed to send poll reminder', err);
                return undefined;
              });
              // The poll stays the anchor (tally updates and /poll reply to it); the header is an
              // extra and the reminder a notice.
              linkIds = buildLinkIds([pollMessageId], headerIds);
              if (reminder) noticeIds.push(reminder.message_id);
              if (pollAttach.pollId != null && !anonymous) {
                pollLinks.add(sentPoll.poll.id, {
                  maxChatId: chatId,
                  maxMessageId: message.id,
                  maxPollId: pollAttach.pollId,
                  answerIdByOptionIndex: (pollAttach.answers ?? []).map((a, i) => Number(a.answerId ?? i + 1)),
                });
              }
            } else {
              const pollTextIds = await sendTextPieces(bot, targetGroupId, topicId, renderPollAsText(pollAttach.title, options, settings), {
                ...(headerIds.length === 0 ? { replyParameters } : {}),
                sent,
              });
              linkIds = buildLinkIds(pollTextIds, headerIds);
            }
          } catch (err) {
            if (isRetriedDeliveryFailure(err)) await discardPartialDelivery(bot, targetGroupId, sent);
            throw err;
          }
          if (linkIds && message.id != null) {
            messageLinks.add({ maxChatId: chatId, maxMessageId: message.id, ...linkIds, ...(noticeIds.length > 0 ? { noticeTelegramMessageIds: noticeIds } : {}) });
          }
          await chatSync.advanceCursor(chatId, message.time, 'incoming poll');
          // A fresh Telegram poll starts at zero (no way to pre-seed a vote): a tally already
          // present when this push arrived is reported right away.
          if (linkIds && pollAttach.state?.result?.some((r) => (r.voteCount ?? 0) > 0) && message.id != null) {
            const key = `${String(chatId)}:${String(message.id)}`;
            if (typeof pollAttach.version === 'number') rememberPollVersion(key, pollAttach.version);
            await relayPollUpdate(chatId, message.id, linkIds.telegramMessageId, pollAttach).catch((err) =>
              logger.error('Failed to relay initial poll tally to Telegram', err),
            );
          }
        });
      } catch (err) {
        onLiveDeliveryFailed(chatId, err, 'Relaying a MAX poll to Telegram');
      }
      return;
    }

    try {
      await sendToTopic(chatId, topicId, async (topicId) => {
        // `sent` tracks every part for discardPartialDelivery.
        const sent: number[] = [];
        try {
          const textIds = text
            ? await sendTextPieces(bot, targetGroupId, topicId, text, { replyParameters, replyMarkup: joinMarkups(memberMarkup, keyboard), sent, maxMessageId: message.id })
            : [];
          let attachIds: number[] = [];
          if (attaches.length > 0) {
            // Always CALL sendAttachments, never behind a `??=` on the text id: a forward always
            // produces text, and a short-circuit there silently dropped every forwarded attachment
            // (root-caused live 2026-08-13).
            const downloadCtx: DownloadContext = { max, ...(forwarded ? forwarded.download : { chatId, messageId: message.id }) };
            // The reply goes on the text when there is one; only a media-only reply threads it into the first attachment.
            attachIds = await sendAttachments(bot, targetGroupId, topicId, attaches, downloadCtx, textIds.length > 0 ? undefined : replyParameters, undefined, sent);
          }
          if (keyboard && textIds.length === 0) {
            const reply = attachIds.length === 0 ? replyParameters : undefined;
            attachIds.push(...(await sendKeyboardAlone(bot, targetGroupId, topicId, keyboard, { replyParameters: reply, sent, maxMessageId: message.id })));
          }
          const linkIds = buildLinkIds(textIds, attachIds);
          if (linkIds) {
            messageLinks.add({ maxChatId: chatId, maxMessageId: message.id, ...linkIds });
            lastInAt = Date.now();
            logger.info(`MAX -> TG: message ${String(message.id)} of chat ${String(chatId)} -> topic ${topicId} (${linkTelegramIds(linkIds).length} Telegram message(s))`);
            // Mirror image of rememberOutgoingSend: without it a reconnect's catch-up relays this
            // message a SECOND time. An orphan edit is no new message — it leaves the cursor alone.
            if (!orphanEdit) await chatSync.advanceCursor(chatId, message.time, 'incoming message');
          }
        } catch (err) {
          if (isRetriedDeliveryFailure(err)) await discardPartialDelivery(bot, targetGroupId, sent);
          throw err;
        }
      });
    } catch (err) {
      onLiveDeliveryFailed(chatId, err, 'MAX -> Telegram forward');
    }
  }

  /**
   * A live MAX -> Telegram delivery failed. The message still sits in MAX's history above the
   * chat's cursor — keep it reachable whatever the cause: take the chat out of `caughtUp`, so
   * later live messages stop moving its cursor past it, and the next catch-up run re-delivers it
   * (see ChatCatchUp). Only a transient failure asks for that run right away — a permanent (4xx)
   * refusal would fail the same way on every retry and spin.
   */
  function onLiveDeliveryFailed(chatId: unknown, err: unknown, what: string): void {
    if (err instanceof SyncCancelledError) return; // /reboot or /kill stopped it on purpose
    if (err instanceof ChatBannedError) {
      logger.info(`${what}: MAX chat ${String(chatId)} was banned meanwhile — left alone`);
      return;
    }
    logger.error(`${what} failed`, err);
    chatSync.markDirty(chatId);
    if (!isRetriedDeliveryFailure(err) && !isTransientMaxError(err)) {
      logger.info(`MAX chat ${String(chatId)}: live delivery refused — its cursor stays put until the next catch-up`);
      return;
    }
    logger.info(`MAX chat ${String(chatId)}: live delivery failed transiently — its cursor stays put until a catch-up re-delivers the message`);
    chatSync.requestRetry(`live delivery for MAX chat ${String(chatId)} failed`);
  }

  /**
   * Is the chat behind this topic a 1:1, and what do we call the other side? In a DIALOG topic the
   * group commands (/rename, /invite, …) are meaningless, and /deletegroup ВСЕМ wipes the
   * conversation for the person on the other end — its confirmation must name them.
   */
  function describeTopicChat(maxChatId: string): { isDialog: boolean; name: string } {
    const { chat, otherId, profile } = resolveDialogContact(maxChatId);
    const participants = chat?.participants ? Object.keys(chat.participants).length : undefined;
    // A real MAX GROUP can have two members: trust the declared type, and fall back to the
    // participant count only for a chat not in the cache yet (an unknown 2-person chat counts as
    // a dialog — that only ever adds a warning, never removes one).
    const isDialog = chat?.type === 'DIALOG' || (chat?.type == null && participants === 2);
    const name = isDialog && otherId != null ? resolveContactDisplayName(otherId, profile) : chat?.title || 'этот чат';
    return { isDialog, name };
  }

  /** Refuses a group-only command in a 1:1 topic, explaining why instead of letting MAX answer with a shrug. */
  async function refuseInDialog(maxChatId: string, topicId: number, command: string): Promise<boolean> {
    const { isDialog, name } = describeTopicChat(maxChatId);
    if (!isDialog) return false;
    await bot.telegram.sendMessage(targetGroupId, `⛔ ${command} — команда для групп. Это личный чат с «${name}».`, { message_thread_id: topicId });
    return true;
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
  function buildHelpText(): string {
    const phone = getActivePhone();
    return `🌉 Мост MAX${phone ? ` (${maskPhone(phone)})` : ''} ↔ Telegram

Сообщения, файлы, голосовые, стикеры и опросы синхронизируются в обе стороны автоматически — команды нужны только для управления. Обычная пересылка сообщений (drag-forward) в тему тоже работает сама — прилетит в привязанный MAX-чат с пометкой «↩️ Переслано от/из...». Звонки — только текстовые уведомления (входящий звонит / завершённый / пропущенный), без передачи аудио — для этого нужен WebRTC, вне рамок Bot API-моста.

/info — карточка контакта или чата (просто в теме)
/file — отправить в этот чат MAX большой файл (до 4 ГБ) по ссылке: загружается один раз, мимо лимита Telegram в 20 МБ

Ответом на опрос:
/poll — актуальный счёт (голоса из MAX сами в виджет Telegram не попадают)

Удаление:
Работает как в Telegram: удаление в MAX прилетает в Telegram сразу; удаление в Telegram зеркалится в MAX (с небольшой задержкой). Ещё способы: 👎 на своё сообщение или /delete в ответ на него.

Управление группой:
/leavegroup — выйти из группы (требует подтверждения)
/deletegroup — удалить группу (требует подтверждения)

Чаты:
/ban — заглушить чат (диалог или группу): выберите из списка кнопкой, сообщения перестанут приходить, тема удалится
/unban — вернуть заглушённый чат (тема появится при следующем сообщении от него)

Обслуживание бота:
/panel — 🎛 пульт управления: меню с кнопками (найти контакт, чаты, вход в MAX, пауза MAX, обновление). Он же закреплён в General.
/login — войти в MAX через бота: номер + код из SMS (и пароль, если включён 2FA) — в личке бота. И первая авторизация, и повторная (после сбоя, /kill, смена номера) — через него.
/version — проверить версию, обновить по кнопке (раз в сутки бот сам напомнит, если вышло обновление)
/reboot — удалить ВСЕ темы в этой Telegram-группе и пересинхронизировать всё с нуля из MAX (требует подтверждения, MAX не затрагивается)
/kill — то же самое + отключить мост от MAX и стереть сохранённую сессию (после нужна новая авторизация через /login). Саму сессию в MAX завершите в приложении: Настройки → Устройства. Необратимо, требует подтверждения.

🔒 Команды выполняются только у администраторов группы. Обычные участники могут читать и писать (участвовать в обсуждении), но не командовать ботом.

⚠️ Ограничения:
• Удаление, сделанное в Telegram, мост ловит периодической проверкой (не мгновенно). Надёжнее — 👎 на своё сообщение или /delete в ответ. Но всё это работает только для недавних сообщений: связки теряются при перезапуске моста — такое удали в приложении MAX.
• Голоса за опрос из MAX не отражаются в виджете Telegram — актуальный счёт через /poll в ответ на опрос.
• Голоса в анонимных опросах и в опросах, созданных здесь, в Telegram, в MAX не передаются — голосуйте в MAX.

🐞 Нашли баг или есть вопрос? Пишите: https://t.me/${BUGREPORT_BOT_HANDLE}

💛 Поддержать проект — /donate`;
  }

  bot.command('help', async (ctx) => {
    await bot.telegram.sendMessage(ctx.chat.id, buildHelpText(), { message_thread_id: ctx.message.message_thread_id });
  });

  bot.command('donate', async (ctx) => {
    await bot.telegram.sendMessage(ctx.chat.id, '💛 Спасибо, что пользуетесь мостом! Выберите способ:', {
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

  // In-Telegram MAX login. In a DM the private-chat auth flow already handles /login; this group
  // handler just hands over the deep link into that DM, so the SMS code and 2FA password never
  // touch the group chat.
  bot.command('login', async (ctx) => {
    const username = ctx.botInfo?.username;
    const kb = username
      ? Markup.inlineKeyboard([[Markup.button.url('🔐 Войти в MAX', `https://t.me/${username}?start=login`)]])
      : undefined;
    await ctx.reply(
      '🔐 Вход в MAX — в личке бота: нажмите кнопку ниже или напишите мне в личку /login. Так код из SMS и пароль не попадут в группу.',
      kb,
    );
  });

  bot.command('version', async (ctx) => {
    const status = await checkVersion();
    const { text, replyMarkup } = formatVersionMessage(status);
    await bot.telegram.sendMessage(ctx.chat.id, text, { message_thread_id: ctx.message.message_thread_id, reply_markup: replyMarkup });
  });

  /**
   * An update marker only means "an update is really in flight" while it's FRESH: a SIGKILL, OOM or
   * reboot mid-build skips update.sh's EXIT trap, and update-requested is consumed only by a host
   * watcher that may not exist. A leftover file latched the «Обновить» button permanently ("уже
   * запущено", with no message ever coming) — a marker older than this is abandoned and removed.
   */
  const UPDATE_MARKER_STALE_MS = 30 * 60_000;
  /** The dispatcher ticks once a minute; anything older than this means nothing is watching us. */
  const WATCHER_STALE_MS = 5 * 60_000;
  async function watcherAlive(): Promise<boolean> {
    try {
      const { mtimeMs } = await stat(WATCHER_HEARTBEAT_MARKER);
      return Date.now() - mtimeMs < WATCHER_STALE_MS;
    } catch {
      return false; // never ticked here
    }
  }
  async function markerActive(file: string): Promise<boolean> {
    if (!existsSync(file)) return false;
    try {
      const { mtimeMs } = await stat(file);
      if (Date.now() - mtimeMs < UPDATE_MARKER_STALE_MS) return true;
      await rm(file, { force: true });
      logger.info(`Забытый маркер обновления ${file} (старше ${UPDATE_MARKER_STALE_MS / 60_000} мин) — игнорирую и удаляю`);
      return false;
    } catch (err) {
      logger.error(`Не удалось проверить маркер обновления ${file}`, err);
      return false; // fail OPEN: better a second update attempt than a button wedged forever
    }
  }

  bot.action('tlmx_update', async (ctx) => {
    // A fresh /version still shows a live «Обновить» button mid-update (the container isn't
    // rebuilt yet). update-requested = queued for the host watcher; update-in-progress = update.sh
    // is running. flock in update-watcher.sh is the hard backstop; this is the friendly heads-up.
    if ((await markerActive(UPDATE_REQUESTED_MARKER)) || (await markerActive(UPDATE_IN_PROGRESS_MARKER))) {
      await ctx.answerCbQuery('Обновление уже идёт');
      await ctx.editMessageText('⏳ Обновление уже запущено — дождитесь сообщения о завершении.').catch(() => {});
      return;
    }
    // The marker is consumed only by the host dispatcher (absent when setup.sh ran without root):
    // writing one nobody reads produced a cheerful «⏳ Обновление запрошено» and then nothing.
    if (!(await watcherAlive())) {
      await ctx.answerCbQuery('Автообновление не настроено');
      await ctx
        .editMessageText('⚠️ Автообновление на этом мосту не настроено — запрос некому выполнить.\nОбновите на сервере:  cd <каталог моста> && ./update.sh\n(автообновление ставится запуском ./setup.sh от root)')
        .catch(() => {});
      return;
    }
    await ctx.answerCbQuery('Обновление запрошено');
    try {
      await writeFile(UPDATE_REQUESTED_MARKER, new Date().toISOString(), 'utf8');
      await ctx.editMessageText('⏳ Обновление запрошено — история переписки не затрагивается.');
    } catch (err) {
      logger.error('Failed to write update-requested marker', err);
      await ctx.editMessageText('❌ Не удалось запросить обновление — смотрите логи контейнера.');
    }
  });

  // A CALLBACK button of a MAX bot: the press goes to MAX in the owner's name — admins only (the
  // gate above). The bot's reaction comes back as an ordinary push (a new or edited message).
  bot.action(new RegExp(`^${KEYBOARD_PRESS}(.+)$`), async (ctx) => {
    const button = pressableButton(ctx.match[1] ?? '');
    if (!button) {
      await ctx.answerCbQuery('Кнопка устарела: мост перезапускался. Нажмите её в приложении MAX.').catch(() => {});
      return;
    }
    try {
      if (button.sendsText) {
        const { cid, messageId, time } = await max.sendMessage(button.chatId, button.text, []);
        rememberOutgoingSend(button.chatId, cid, time);
        // The topic shows what went out in the owner's name, the way the history renders own messages.
        const threadId = (ctx.callbackQuery.message as { message_thread_id?: number } | undefined)?.message_thread_id;
        const shown = await bot.telegram.sendMessage(targetGroupId, `🧑 Вы: ${button.text}`, threadId ? { message_thread_id: threadId } : {}).catch(() => undefined);
        if (shown) messageLinks.add({ maxChatId: button.chatId, maxMessageId: messageId, telegramMessageId: shown.message_id });
      } else {
        await max.sendCallback(button.chatId, button.callbackId, button.payload);
      }
      logger.info(`TG -> MAX: button «${button.text}» pressed in chat ${String(button.chatId)}`);
      await ctx.answerCbQuery().catch(() => {});
    } catch (err) {
      logger.error(`Failed to relay a press of «${button.text}» to MAX chat ${String(button.chatId)}`, err);
      await ctx.answerCbQuery(`Не удалось нажать в MAX: ${(err as Error).message}`.slice(0, 190)).catch(() => {});
    }
  });

  // The bot asks for a location or a contact: sent into the topic, either one reaches it through
  // the ordinary relay. A contact goes without MAX's own signature — a bot that checks it may refuse.
  bot.action(KEYBOARD_GEO, async (ctx) => {
    await ctx.answerCbQuery('Отправьте геопозицию в эту тему (скрепка → Геопозиция) — мост передаст её боту.', { show_alert: true }).catch(() => {});
  });
  bot.action(KEYBOARD_CONTACT, async (ctx) => {
    await ctx
      .answerCbQuery('Отправьте контакт в эту тему (скрепка → Контакт) — мост передаст его боту. Подписи MAX у такого контакта нет: бот, который её проверяет, может его не принять.', { show_alert: true })
      .catch(() => {});
  });

  // A MAX button with no Telegram counterpart (see maxKeyboardToTelegram): presses are not relayed.
  bot.action(KEYBOARD_NA, async (ctx) => {
    await ctx.answerCbQuery('Эта кнопка работает только в приложении MAX').catch(() => {});
  });

  bot.action('tlmx_dismiss', async (ctx) => {
    await ctx.answerCbQuery('Ок');
    await ctx.editMessageText('⏰ Отложено — напомню при следующей ежедневной проверке.');
  });

  // /ban — mute a MAX chat: its messages stop being mirrored and its topic is deleted. Persistent,
  // reversible via /unban. (Deleting a topic by hand is auto-healed instead — /ban is the deliberate switch.)
  bot.command('ban', async (ctx) => {
    const active = (await chatMapStore.list()).filter((m) => !m.banned);
    if (active.length === 0) {
      await bot.telegram.sendMessage(ctx.chat.id, 'Нет активных чатов для бана.', { message_thread_id: ctx.message.message_thread_id });
      return;
    }
    const buttons = active.slice(0, 90).map((m) => Markup.button.callback(m.title || `MAX chat ${m.maxChatId}`, `tlmx_ban:${m.maxChatId}`));
    await bot.telegram.sendMessage(ctx.chat.id, '🚫 Кого забанить? Сообщения от выбранного чата приходить перестанут, его тема удалится. Вернуть можно через /unban.', {
      message_thread_id: ctx.message.message_thread_id,
      reply_markup: Markup.inlineKeyboard(buttons, { columns: 1 }).reply_markup,
    });
  });

  bot.action(/^tlmx_ban:(.+)$/, async (ctx) => {
    const maxChatId = ctx.match?.[1];
    if (!maxChatId) return;
    const mapping = await chatMapStore.getByMaxChatId(maxChatId);
    await chatMapStore.setBanned(maxChatId, true);
    // Links first — see MessageLinkStore.removeByChat.
    forgetChatLinks(maxChatId);
    if (mapping) {
      await deleteTopic(mapping.telegramTopicId, '/ban');
    }
    await ctx.answerCbQuery('Забанен');
    await ctx.editMessageText(`🚫 Забанен: ${mapping?.title ?? maxChatId}. Сообщения больше не приходят. Вернуть — /unban.`).catch(() => {});
  });

  // /unban — flips the flag; the topic comes back on the next incoming message from that chat.
  bot.command('unban', async (ctx) => {
    const banned = (await chatMapStore.list()).filter((m) => m.banned);
    if (banned.length === 0) {
      await bot.telegram.sendMessage(ctx.chat.id, 'Забаненных чатов нет.', { message_thread_id: ctx.message.message_thread_id });
      return;
    }
    const buttons = banned.slice(0, 90).map((m) => Markup.button.callback(m.title || `MAX chat ${m.maxChatId}`, `tlmx_unban:${m.maxChatId}`));
    await bot.telegram.sendMessage(ctx.chat.id, '♻️ Кого разбанить?', {
      message_thread_id: ctx.message.message_thread_id,
      reply_markup: Markup.inlineKeyboard(buttons, { columns: 1 }).reply_markup,
    });
  });

  bot.action(/^tlmx_unban:(.+)$/, async (ctx) => {
    const maxChatId = ctx.match?.[1];
    if (!maxChatId) return;
    const mapping = await chatMapStore.getByMaxChatId(maxChatId);
    await chatMapStore.setBanned(maxChatId, false);
    await ctx.answerCbQuery('Разбанен');
    await ctx.editMessageText(`♻️ Разбанен: ${mapping?.title ?? maxChatId}. Тема вернётся при следующем сообщении от него.`).catch(() => {});
  });

  // --- Control panel (src/bridge/panel.ts): a pinned inline-button menu in General. The leaves
  // (help/version/ban/unban) reuse the slash commands' logic; startDialog opens a 1:1 + its topic.
  const startDialog = async (
    recipientUserId: string,
    name: string,
  ): Promise<{ ok: boolean; error?: string; topicName: string; chatLink?: string; existed?: boolean }> => {
    try {
      // Reuse an existing 1:1 (participants exactly {me, contact}) — MAX happily makes a second
      // dialog for the same pair otherwise.
      const myId = String(getMyAccountId());
      const target = String(recipientUserId);
      const existing = getChats().find((c) => {
        const parts = (c as { participants?: Record<string, unknown> } | null)?.participants;
        if (!parts) return false;
        const keys = Object.keys(parts);
        return keys.length === 2 && keys.includes(target) && keys.includes(myId);
      });
      const existed = existing != null;
      // Fresh contact: DON'T create a chat up front — MAX makes a GROUP if we do (the old
      // createDialog CONTROL hack). Map the topic to a "pending:<userId>" sentinel instead; the
      // first outbound message opens the real 1:1 (max.sendToNewDialog) and rewrites the mapping.
      const chatId = existed ? (existing as { id?: unknown }).id : `pending:${recipientUserId}`;
      let finalTopicId: number | undefined;
      await chatSync.runInChat(chatId, async () => {
        const ensured = await ensureTopicForMaxChat(bot, targetGroupId, chatId, chatMapStore, name);
        finalTopicId = ensured.topicId;
        let created = ensured.created;
        // A reused mapping can point to a topic deleted by hand, and startDialog only builds a
        // deep link — it never writes, so nothing would heal it (reported live 2026-08-18). Probe
        // with a no-op rename; gone -> recreate it named after the contact (recreateTopicForChat
        // would reuse the stale fallback title).
        if (!created) {
          try {
            await bot.telegram.editForumTopic(targetGroupId, finalTopicId, { name });
          } catch (err) {
            if (isThreadNotFound(err)) {
              await chatMapStore.remove(chatId);
              finalTopicId = (await ensureTopicForMaxChat(bot, targetGroupId, chatId, chatMapStore, name)).topicId;
              created = true;
              // The fresh mapping has no cursor: the next write refills the empty topic with the whole history first.
              chatSync.markDirty(chatId);
            }
            // Any other error ("topic not modified") means the topic is alive.
          }
        }
        // recipientUserId as the sender hint covers a chat not in cachedChats yet.
        if (created) {
          await sendAutoInfoCard(chatId, recipientUserId, finalTopicId).catch((e) =>
            logger.error('Failed to send contact-info card on startDialog', e),
          );
        }
        // After the liveness probe may have recreated the mapping, so pendingUserId survives on the final entry.
        if (!existed) {
          const pending = await chatMapStore.getByMaxChatId(chatId);
          if (pending) await chatMapStore.upsert({ ...pending, pendingUserId: String(recipientUserId) });
        }
      });
      if (finalTopicId == null) return { ok: false, error: 'идёт /reboot или /kill — подождите', topicName: name };
      // Deep link into the topic (private supergroup form: strip the -100 prefix).
      const chatLink = `https://t.me/c/${targetGroupId.replace(/^-100/, '')}/${finalTopicId}`;
      return { ok: true, topicName: name, chatLink, existed };
    } catch (err) {
      logger.error('Panel startDialog failed', err);
      return { ok: false, error: (err as Error).message, topicName: name };
    }
  };
  wireControlPanel({
    bot,
    targetGroupId,
    max,
    getActivePhone,
    triggerFullResync,
    startDialog,
    pause,
    files: fileShare,
    // Warm-cache name lookup (buildRoster already fetched the profiles); undefined on a miss lets
    // the panel fall back to CONTACT_INFO.
    resolveContactName: (uid) => {
      const id = Number(uid);
      if (Number.isNaN(id)) return undefined;
      const profile = getContactProfiles().get(id);
      return profile ? resolveContactDisplayName(id, profile) : undefined;
    },
    // «📊 Статус» — everything the bridge can see from inside its container (see status.ts).
    getStatus: async (pausedLabel) => {
      const mappings = await chatMapStore.list();
      let update: { updateAvailable: boolean; latest: string | null } | null = null;
      try {
        const v = await checkVersion();
        // checkVersion() never throws — a FAILED check comes back as `latest: null`, which must not
        // render as "актуальная версия".
        const latest = (v.latest as { version?: string } | null)?.version ?? null;
        update = v.latest ? { updateAvailable: v.updateAvailable, latest } : null;
      } catch {
        update = null; // offline / rate-limited — rendered as "не удалось проверить"
      }
      const st = getMaxState();
      return buildStatusText({
        uptimeSec: process.uptime(),
        max: { connected: st.connected, phone: getActivePhone(), lastLoginAt: st.lastLoginAt, paused: pausedLabel },
        chats: { active: mappings.filter((m) => !m.banned).length, banned: mappings.filter((m) => m.banned).length },
        lastInAt,
        lastOutAt,
        ...collectHostStats(`${process.cwd()}/.data`),
        update,
      });
    },
    leaves: {
      sendHelp: (chatId) => bot.telegram.sendMessage(chatId, buildHelpText()).then(() => {}),
      sendVersion: async (chatId) => {
        const { text, replyMarkup } = formatVersionMessage(await checkVersion());
        await bot.telegram.sendMessage(chatId, text, { reply_markup: replyMarkup });
      },
      sendBanList: async (chatId) => {
        const active = (await chatMapStore.list()).filter((m) => !m.banned);
        if (active.length === 0) {
          await bot.telegram.sendMessage(chatId, 'Нет активных чатов для бана.');
          return;
        }
        const buttons = active.slice(0, 90).map((m) => Markup.button.callback(m.title || `MAX chat ${m.maxChatId}`, `tlmx_ban:${m.maxChatId}`));
        await bot.telegram.sendMessage(chatId, '🚫 Кого забанить?', { reply_markup: Markup.inlineKeyboard(buttons, { columns: 1 }).reply_markup });
      },
      sendUnbanList: async (chatId) => {
        const banned = (await chatMapStore.list()).filter((m) => m.banned);
        if (banned.length === 0) {
          await bot.telegram.sendMessage(chatId, 'Забаненных чатов нет.');
          return;
        }
        const buttons = banned.slice(0, 90).map((m) => Markup.button.callback(m.title || `MAX chat ${m.maxChatId}`, `tlmx_unban:${m.maxChatId}`));
        await bot.telegram.sendMessage(chatId, '♻️ Кого разбанить?', { reply_markup: Markup.inlineKeyboard(buttons, { columns: 1 }).reply_markup });
      },
    },
  });

  /** Contact card for the person/group on the other end of this topic — name, phone, country, registration date, and (best-effort) their avatar. */
  // /file in a chat's topic: an upload link right away — a big file then goes up ONCE, straight to
  // the server, instead of into Telegram first and through the link again (bigFiles.ts).
  bot.command('file', async (ctx) => {
    const topicId = ctx.message.message_thread_id;
    const mapping = topicId ? await chatMapStore.getByTopicId(topicId) : undefined;
    if (!topicId || !mapping) {
      await ctx.reply('Команда /file работает в теме чата: напишите её в той теме, куда нужно отправить файл.').catch(() => {});
      return;
    }
    if (mapping.pendingUserId) {
      await ctx.reply('✍️ Сначала отправьте новому контакту текст — так MAX открывает личку. Файл можно будет отправить следующим сообщением.', { message_thread_id: topicId }).catch(() => {});
      return;
    }
    void bigFiles
      .offerUpload({ maxChatId: mapping.maxChatId, topicId, telegramMessageId: ctx.message.message_id })
      .catch((err) => logger.error('/file failed', err));
  });

  bot.command('info', async (ctx) => {
    const topicId = ctx.message.message_thread_id;
    if (!topicId) return;
    const mapping = await chatMapStore.getByTopicId(topicId);
    if (!mapping) return;

    const { chat, otherId, profile } = resolveDialogContact(mapping.maxChatId);
    const count = chat?.participants ? Object.keys(chat.participants).length : undefined;
    const roster = await buildRoster(chat?.participants, chat?.type, max, getMyAccountId(), getContactProfiles());
    await sendContactInfoCard(bot, targetGroupId, topicId, chat?.title || mapping.title || 'Чат', chat?.type, count, otherId, profile, roster);
  });

  // "💬 Открыть личку" on a group's roster card → a button per participant (tlmx_panel:startchat:<uid>).
  // Participants come from the chat of the topic the card lives in — nothing is encoded in the button.
  bot.action('tlmx_roster:open', async (ctx) => {
    const topicId = (ctx.callbackQuery.message as { message_thread_id?: number } | undefined)?.message_thread_id;
    const mapping = topicId != null ? await chatMapStore.getByTopicId(topicId) : undefined;
    const chat = mapping
      ? (getChats().find((c) => c && typeof c === 'object' && String((c as { id?: unknown }).id) === mapping.maxChatId) as
          | { participants?: Record<string, unknown> }
          | undefined)
      : undefined;
    const myId = getMyAccountId();
    const others = chat?.participants
      ? Object.keys(chat.participants)
          .map(Number)
          .filter((id) => !Number.isNaN(id) && id !== myId)
          .slice(0, 50)
      : [];
    if (others.length === 0) {
      await ctx.answerCbQuery('Не вижу участников — обновите /info').catch(() => {});
      return;
    }
    const rows = others.map((id) => [Markup.button.callback(`✍️ ${resolveContactDisplayName(id, getContactProfiles().get(id))}`, `tlmx_panel:startchat:${id}`)]);
    rows.push([Markup.button.callback('◀️ Свернуть', 'tlmx_roster:hide')]);
    await ctx.answerCbQuery().catch(() => {});
    await ctx.editMessageReplyMarkup(Markup.inlineKeyboard(rows).reply_markup).catch((err) => logger.error('Failed to expand roster DM list', err));
  });

  bot.action('tlmx_roster:hide', async (ctx) => {
    await ctx.answerCbQuery().catch(() => {});
    await ctx
      .editMessageReplyMarkup(Markup.inlineKeyboard([[Markup.button.callback('💬 Открыть личку', 'tlmx_roster:open')]]).reply_markup)
      .catch((err) => logger.error('Failed to collapse roster DM list', err));
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
              return resolveContactDisplayName(uid, await resolveProfile(max, uid, 'voter', getContactProfiles()));
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

  /**
   * Re-fetches a poll's message from CHAT_HISTORY and posts its current tally as a reply (joined
   * to the poll's link as a notice). Throws if the poll/mapping can't be found.
   */
  async function postPollResults(maxChatId: unknown, maxMessageId: unknown, telegramMessageId: number): Promise<void> {
    const mapping = await chatMapStore.getByMaxChatId(maxChatId);
    if (!mapping) throw new Error(`No Telegram topic mapped for MAX chat ${String(maxChatId)}`);
    // Paged back (up to 1000 messages): a poll replayed by a backfill is often far older than the newest batch.
    let msg: MaxHistoryMessage | undefined;
    let from = historyStartTime();
    for (let i = 0; i < 10 && !msg; i++) {
      const batch = await max.getChatHistory(maxChatId, from, HISTORY_BATCH_SIZE);
      msg = batch.find((m) => String(m.id) === String(maxMessageId));
      const oldest = Math.min(...batch.map((m) => Number(m.time)));
      if (!(oldest < from)) break;
      from = oldest;
    }
    const pollAttach = (Array.isArray(msg?.attaches) ? msg.attaches : []).find((a) => (a as MaxAttachment)._type === 'POLL') as
      | MaxAttachment
      | undefined;
    if (!pollAttach) throw new Error(`Poll message ${String(maxMessageId)} not found in chat ${String(maxChatId)} history`);
    const text = await formatPollResultsText(pollAttach);
    const sent = await bot.telegram.sendMessage(targetGroupId, text, {
      message_thread_id: mapping.telegramTopicId,
      reply_parameters: { message_id: telegramMessageId },
    });
    messageLinks.addNotice(maxChatId, maxMessageId, sent.message_id);
  }

  /** On-demand poll results. Reply to the poll message with /poll to use it. */
  bot.command('poll', async (ctx) => {
    const topicId = ctx.message.message_thread_id;
    if (!topicId) return;
    // In a forum topic a bare command carries reply_to_message = the topic-root message (id === topicId).
    const replyTo = (ctx.message as { reply_to_message?: { message_id: number } }).reply_to_message;
    if (!replyTo || replyTo.message_id === topicId) {
      await bot.telegram.sendMessage(targetGroupId, 'Ответьте этой командой на сообщение с опросом.', { message_thread_id: topicId });
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
      const { topicId, created } = await ensureTopicForMaxChat(bot, targetGroupId, chatId, chatMapStore, title);
      if (created) chatSync.markCaughtUp(chatId); // a group we just created has no history to catch up
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
    if (await refuseInDialog(mapping.maxChatId, topicId, '/invite')) return;
    // `Number('')` is 0, not NaN — a bare "/invite " (trailing space) sailed past an isNaN check and
    // sent MAX `userIds: [0]`. Require a real positive id.
    const raw = (ctx as unknown as { payload?: string }).payload?.trim() ?? '';
    const userId = Number(raw);
    if (!/^\d+$/.test(raw) || !Number.isSafeInteger(userId) || userId <= 0) {
      await bot.telegram.sendMessage(targetGroupId, 'Использование: /invite <MAX ID> — например, /invite 123456789. ID участника есть в карточке группы.', { message_thread_id: topicId });
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
    if (await refuseInDialog(mapping.maxChatId, topicId, '/kick')) return;
    const rawKick = (ctx as unknown as { payload?: string }).payload?.trim() ?? '';
    const userId = Number(rawKick);
    if (!/^\d+$/.test(rawKick) || !Number.isSafeInteger(userId) || userId <= 0) {
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
    if (await refuseInDialog(mapping.maxChatId, topicId, '/rename')) return;
    const title = (ctx as unknown as { payload?: string }).payload?.trim();
    if (!title) {
      await bot.telegram.sendMessage(targetGroupId, 'Использование: /rename <новое название>', { message_thread_id: topicId });
      return;
    }
    try {
      await max.updateChatInfo(mapping.maxChatId, { title });
      await chatMapStore.setTitle(mapping.maxChatId, topicId, title); // title only — see setTitle
      await bot.telegram.editForumTopic(targetGroupId, topicId, { name: title }).catch(() => undefined);
      // Confirmed live 2026-08-10: MAX sometimes silently keeps the old title despite an OK —
      // so this says what we asked for, not what MAX applied.
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
    if (await refuseInDialog(mapping.maxChatId, topicId, '/setdesc')) return;
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
    if (await refuseInDialog(mapping.maxChatId, topicId, '/leavegroup')) return;
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
    // In a 1:1 topic «удалить для всех» wipes the conversation for the person on the other end —
    // a legitimate MAX feature, but the confirmation must name the human it will hit.
    const target = describeTopicChat(mapping.maxChatId);
    const args = (ctx as unknown as { payload?: string }).payload?.trim().toUpperCase().split(/\s+/) ?? [];
    if (args[0] !== 'УДАЛИТЬ') {
      await bot.telegram.sendMessage(
        targetGroupId,
        target.isDialog
          ? `⚠️ Это личная переписка с «${target.name}», а не группа.\n/deletegroup УДАЛИТЬ — удалить её только у себя.\n/deletegroup УДАЛИТЬ ВСЕМ — удалить её И У «${target.name}» ТОЖЕ. Необратимо для него.`
          : `⚠️ Это удаление группы «${target.name}» на стороне MAX. /deletegroup УДАЛИТЬ — удалить только у себя. /deletegroup УДАЛИТЬ ВСЕМ — удалить для всех участников (необратимо для них тоже).`,
        { message_thread_id: topicId },
      );
      return;
    }
    const forAll = args[1] === 'ВСЕМ';
    const chat = getChats().find((c) => c && typeof c === 'object' && String((c as { id?: unknown }).id) === mapping.maxChatId) as
      | { lastEventTime?: unknown }
      | undefined;
    // `Number(null)` is 0, not NaN — a chat missing from the cache must not send lastEventTime: 0.
    const lastEventTime = Number(chat?.lastEventTime);
    if (!Number.isSafeInteger(lastEventTime) || lastEventTime <= 0) {
      await bot.telegram.sendMessage(targetGroupId, 'Не нашёл lastEventTime этого чата — попробуйте чуть позже (после следующей синхронизации).', {
        message_thread_id: topicId,
      });
      return;
    }
    try {
      await max.deleteChat(mapping.maxChatId, lastEventTime, forAll);
      await bot.telegram.sendMessage(
        targetGroupId,
        target.isDialog
          ? `✅ Переписка с «${target.name}» удалена ${forAll ? 'у обоих' : 'у меня'}.`
          : `✅ Группа удалена ${forAll ? 'для всех' : 'у меня'}.`,
        { message_thread_id: topicId },
      );
    } catch (err) {
      logger.error('Failed to delete chat', err);
      await bot.telegram.sendMessage(targetGroupId, 'Не удалось удалить группу.', { message_thread_id: topicId });
    }
  });

  /**
   * The shared core of /reboot and /kill: stops everything that writes topics, deletes every topic
   * and wipes all local state (chat map, message/poll links, catch-up state). `finish` runs with
   * syncs still held off and calls `resume` once they may run again (else they resume on return).
   * Runs in the background: one topic per ~1.1 s outlasts telegraf's 90 s handlerTimeout at ~80
   * topics, and a timed-out handler stops Telegram polling.
   */
  async function wipeAllTopics(
    command: 'reboot' | 'kill',
    startText: (topicCount: number) => string,
    finish: (resume: () => void) => Promise<void>,
  ): Promise<void> {
    if (wiping) {
      await bot.telegram.sendMessage(targetGroupId, '⏳ Уже идёт /reboot или /kill — дождитесь окончания.').catch(() => {});
      return;
    }
    void (async () => {
      let releaseSync: (() => void) | undefined;
      // Idempotent: /reboot's finish resumes early and the finally resumes again — the second call
      // must not clear `wiping` for a /kill accepted in between.
      let resumed = false;
      // Set once the chat map and the catch-up state are gone (see the catch below).
      let stateWiped = false;
      const resume = (): void => {
        if (resumed) return;
        resumed = true;
        wiping = false;
        releaseSync?.();
      };
      try {
        // Stop everything that writes topics first (a history sync, a topic restore) and hold new
        // syncs off, or the old run keeps refilling the topics being deleted.
        wiping = true;
        releaseSync = await suspendChatSync();
        // Then every chat queue drains: a live push that passed its `wiping` check just before may
        // still be creating its topic, and its mapping would land after the snapshot below.
        await chatSync.drain();
        const mappings = await chatMapStore.list();
        // Only a progress notice: a flood wait or a network blip here must not fail the wipe.
        await withFloodRetry(() => bot.telegram.sendMessage(targetGroupId, startText(mappings.length))).catch((err) =>
          logger.error(`Failed to post the ${command} start notice`, err),
        );
        // Links BEFORE the topics (see MessageLinkStore.removeByChat) — the deletion loop is slow.
        forgetAllLinks();
        for (const mapping of mappings) {
          await deleteTopic(mapping.telegramTopicId, command);
          await sleep(TOPIC_DELETE_DELAY_MS);
        }
        // Again after the loop: the Telegram -> MAX relay keeps running during the wipe and may have
        // linked a message written into a topic not yet deleted. Before the map goes.
        forgetAllLinks();
        await chatMapStore.clear();
        // Every cursor went with the map: no chat is caught up until a resync backfills it.
        chatSync.reset();
        stateWiped = true;
        await finish(resume);
      } catch (err) {
        logger.error(`${command === 'reboot' ? 'Reboot' : 'Kill'} failed`, err);
        if (!stateWiped) {
          // Pushes were dropped while `wiping` was set: with nothing caught up the cursors stay
          // put until the catch-up run requested here fetches them.
          chatSync.reset();
          chatSync.requestRetry(`${command} failed before the wipe was complete`);
        }
        await bot.telegram.sendMessage(targetGroupId, `Не удалось выполнить ${command}.`).catch(() => {});
      } finally {
        resume();
      }
    })();
  }

  /**
   * Nukes every Telegram topic + all local state (wipeAllTopics) and re-runs the full backfill from
   * scratch — for when something's drifted enough that a redeploy won't fix it. MAX's own data is
   * untouched; this only resets OUR view of it.
   */
  bot.command('reboot', async (ctx) => {
    const confirm = (ctx as unknown as { payload?: string }).payload?.trim().toUpperCase();
    if (confirm !== 'ПОДТВЕРДИТЬ') {
      await bot.telegram.sendMessage(
        targetGroupId,
        '⚠️ Это удалит ВСЕ темы и историю в этой Telegram-группе (сообщения в MAX не пострадают) и запустит полную пересинхронизацию с нуля. Подтвердите: /reboot ПОДТВЕРДИТЬ',
      );
      return;
    }
    await wipeAllTopics(
      'reboot',
      (n) => `🔄 Удаляю ${n} тем и запускаю полную пересинхронизацию...`,
      async (resume) => {
        // Wipe done: let syncs run again, then start the fresh one.
        resume();
        triggerFullResync().catch((err) => logger.error('Full resync after /reboot failed', err));
        await bot.telegram.sendMessage(targetGroupId, '✅ Пересинхронизация запущена — темы появятся по мере обработки.');
      },
    );
  });

  /**
   * Beyond everything /reboot wipes, logs the bridge OUT of MAX (killEverything deletes the
   * session file), so a fresh /login is required. MAX exposes no logout/revoke opcode (checked
   * 2026-09-11): only OUR copy of the session is dropped, the token stays valid on MAX's side —
   * the texts point at the app's device list, don't promise a server-side logout.
   */
  bot.command('kill', async (ctx) => {
    const confirm = (ctx as unknown as { payload?: string }).payload?.trim().toUpperCase();
    if (confirm !== 'УНИЧТОЖИТЬ') {
      await bot.telegram.sendMessage(
        targetGroupId,
        '☢️ Это отключит мост от MAX и сотрёт сохранённую ЗДЕСЬ сессию (после потребуется новая авторизация через /login в личке бота), а также ВСЕ темы, историю и связки в этой Telegram-группе. ⚠️ Саму сессию на стороне MAX мост завершить не может — после /kill завершите её в приложении MAX: Настройки → Устройства. Необратимо. Подтвердите: /kill УНИЧТОЖИТЬ',
      );
      return;
    }
    // Syncs stay held off until MAX is logged out: after killEverything a sync has nothing left to recreate.
    await wipeAllTopics(
      'kill',
      (n) => `☢️ Удаляю ${n} тем, разлогиниваю MAX и стираю все данные...`,
      async () => {
        await killEverything();
        await bot.telegram.sendMessage(
          targetGroupId,
          '✅ Готово. Мост отключён от MAX, сохранённая здесь сессия и все данные стёрты. ⚠️ Не забудьте завершить сессию и в приложении MAX (Настройки → Устройства) — мост сделать это не может. Чтобы продолжить — авторизуйтесь заново: /login (в личке бота).',
        );
      },
    );
  });

  /** Reply to a message with /delete to remove it on MAX (and, since we sent it, on Telegram too). */
  bot.command('delete', async (ctx) => {
    const topicId = ctx.message.message_thread_id;
    if (!topicId) {
      // Typed in General — silence here already cost a debugging session (2026-08-14), so say so.
      await bot.telegram.sendMessage(targetGroupId, '/delete работает только внутри темы чата — ответьте им на сообщение, которое нужно удалить.').catch(() => {});
      return;
    }
    // In a forum topic a bare command carries reply_to_message = the topic-root message (id === topicId).
    const replyTo = (ctx.message as { reply_to_message?: { message_id: number } }).reply_to_message;
    if (!replyTo || replyTo.message_id === topicId) {
      logger.info(`/delete in topic ${topicId}: no reply target`);
      await bot.telegram.sendMessage(targetGroupId, 'Ответьте этой командой на сообщение, которое нужно удалить. /delete me — удалить только у себя.', {
        message_thread_id: topicId,
      });
      return;
    }
    const link = messageLinks.getByTelegram(replyTo.message_id);
    if (!link) {
      logger.info(`/delete in topic ${topicId}: no MAX link for Telegram message ${replyTo.message_id} — relayed before the last restart, or its send never completed`);
      await bot.telegram.sendMessage(
        targetGroupId,
        'Не нашёл это сообщение в связке с MAX. Связки живут в памяти: сообщения, пересланные до последнего перезапуска моста, удалить командой нельзя.',
        { message_thread_id: topicId },
      );
      return;
    }
    // A reply to a bot notice is not a reply to the message — see noticeTelegramMessageIds.
    if (isNoticeOf(link, replyTo.message_id)) {
      await bot.telegram.sendMessage(targetGroupId, 'Это служебное сообщение бота — ответьте /delete на само сообщение, которое нужно удалить.', {
        message_thread_id: topicId,
      });
      return;
    }
    const forMe = (ctx as unknown as { payload?: string }).payload?.trim().toLowerCase() === 'me';
    try {
      await max.deleteMessages(link.maxChatId, linkMaxIds(link), forMe);
      logger.info(`/delete: removed MAX message ${String(link.maxMessageId)} in chat ${String(link.maxChatId)} (forMe=${forMe})`);
      // Link forgotten BEFORE the copies vanish (dropLinkedMessage) — or the probe would turn a
      // "/delete me" into a delete for everyone.
      await dropLinkedMessage(link, '/delete', [replyTo.message_id]);
    } catch (err) {
      logger.error('Failed to delete MAX message', err);
      await bot.telegram.sendMessage(targetGroupId, 'Не удалось удалить сообщение.', { message_thread_id: topicId });
    }
  });

  // Outbound bug-report leg: a message the maintainer typed in a bug-report topic goes to
  // that reporter's DM, not to MAX. Registered before the MAX relay below so it consumes
  // those topics first; everything else falls through to the normal relay via next().
  bot.on('message', async (ctx, next) => {
    if (await bugReports.relayTopicReply(ctx)) return;
    return next();
  });

  /**
   * The pieces of a long Telegram text after the first one (see piecesForMax), each recorded on
   * the first piece's link as soon as it is sent — a failure halfway leaves what went out
   * deletable. No reply link on them. Known limit: an edit in Telegram can't be applied to such a message.
   */
  async function sendMorePieces(chatId: unknown, pieces: readonly string[], link: MessageLink): Promise<void> {
    const total = pieces.length + 1;
    for (const [i, piece] of pieces.entries()) {
      let sent;
      try {
        sent = await max.sendMessage(chatId, piece);
      } catch (err) {
        throw new Error(`${(err as Error).message} (в MAX ушло частей: ${i + 1} из ${total})`, { cause: err });
      }
      rememberOutgoingSend(chatId, sent.cid, sent.time);
      if (sent.messageId != null) (link.extraMaxMessageIds ??= []).push(sent.messageId);
    }
    if (total > 1) logger.info(`TG -> MAX: message ${link.telegramMessageId} went to chat ${String(chatId)} as ${total} MAX messages (over ${MAX_TEXT_LIMIT} chars)`);
  }

  bot.on('message', async (ctx) => {
    const topicId = ctx.message.message_thread_id;
    if (!topicId) return;
    const mapping = await chatMapStore.getByTopicId(topicId);
    if (!mapping) return;
    // Forum service messages carry no user content — and the forum_topic_created right after
    // "Начать чат" would trip the pending-dialog first-message hint.
    const svc = ctx.message as unknown as Record<string, unknown>;
    if (svc.forum_topic_created || svc.forum_topic_edited || svc.forum_topic_closed || svc.forum_topic_reopened) return;

    const forwardPrefix = describeForwardOrigin((ctx.message as { forward_origin?: TelegramForwardOrigin }).forward_origin);
    const rawText = (ctx.message as { text?: string; caption?: string }).text;
    const rawCaption = (ctx.message as { caption?: string }).caption ?? '';
    const text = forwardPrefix ? (rawText ? `${forwardPrefix}\n${rawText}` : undefined) : rawText;
    const caption = forwardPrefix ? (rawCaption ? `${forwardPrefix}\n${rawCaption}` : forwardPrefix) : rawCaption;
    // A reply to a mirrored message becomes an outgoing reply link for MSG_SEND. In forum topics
    // reply_to_message can point at the topic-root message with no real reply (id === topicId).
    // Links are in-memory: a reply to something from before the last restart relays without it.
    const replyToMessage = (ctx.message as { reply_to_message?: { message_id: number } }).reply_to_message;
    let replyLink: { messageId: unknown; chatId: unknown } | undefined;
    if (replyToMessage && replyToMessage.message_id !== topicId) {
      const linked = messageLinks.getByTelegram(replyToMessage.message_id);
      if (linked) replyLink = { messageId: linked.maxMessageId, chatId: linked.maxChatId };
    }
    const photo = (ctx.message as { photo?: Array<{ file_id: string }> }).photo;
    const document = (ctx.message as { document?: { file_id: string; file_name?: string } }).document;
    // GIFs — MAX only takes these as FILE. A forwarded GIF arrives as `document` in practice
    // (confirmed live 2026-08-07), but `animation` is the dedicated type — handle both.
    const animation = (ctx.message as { animation?: { file_id: string; file_name?: string } }).animation;
    const video = (ctx.message as { video?: { file_id: string; file_name?: string } }).video;
    const videoNote = (ctx.message as { video_note?: { file_id: string } }).video_note;
    const voice = (ctx.message as { voice?: { file_id: string; duration?: number } }).voice;
    const sticker = (ctx.message as { sticker?: { file_id: string; is_animated?: boolean; is_video?: boolean; thumbnail?: { file_id: string } } }).sticker;
    const poll = (ctx.message as { poll?: { id: string; question: string; options: Array<{ text: string }>; is_anonymous: boolean; allows_multiple_answers: boolean } }).poll;
    const location = (ctx.message as { location?: { latitude: number; longitude: number } }).location;
    const contact = (ctx.message as { contact?: { phone_number: string; first_name: string; last_name?: string } }).contact;
    // A music/audio FILE (mp3 & co — not a voice note): MAX takes it as an ordinary file.
    const audio = (ctx.message as { audio?: { file_id: string; file_name?: string } }).audio;

    // INFO-level on purpose, and BEFORE any branch: silent relay paths already cost two blind
    // debugging sessions (2026-08-14/15).
    const kind =
      location ? 'location' : contact ? 'contact' : poll ? 'poll' : text ? 'text'
      : photo?.length ? 'photo' : video ? 'video' : videoNote ? 'video_note' : document ? 'document'
      : animation ? 'animation' : voice ? 'voice' : audio ? 'audio' : sticker ? 'sticker' : 'unsupported type';
    logger.info(`TG -> MAX: message ${ctx.message.message_id} in topic ${topicId} (${kind}) -> chat ${mapping.maxChatId}`);

    try {
      // PENDING dialog (see ChatMapping.pendingUserId): the FIRST message opens the real 1:1 via
      // max.sendToNewDialog, and the pending mapping is rewritten into a real one. MAX needs
      // non-empty text for a first message; media go in follow-ups once the dialog exists.
      if (mapping.pendingUserId) {
        const hasAttachment = !!(
          photo?.length || document || animation || video || videoNote || voice || audio || sticker || poll || location || contact
        );
        if (!text || hasAttachment) {
          await bot.telegram.sendMessage(
            targetGroupId,
            '✍️ Первое сообщение новому контакту отправьте текстом — так MAX открывает личку. Файлы и медиа шлите следующими сообщениями.',
            { message_thread_id: topicId },
          );
          return;
        }
        const [firstPiece = text, ...morePieces] = piecesForMax(text);
        // Opening the dialog can be rejected by MAX (privacy, an invalid user id): surface the
        // reason IN the topic and keep the pending sentinel intact so the next message retries.
        let opened;
        try {
          opened = await max.sendToNewDialog(mapping.pendingUserId, firstPiece, [], replyLink);
        } catch (err) {
          logger.error(`Failed to open new MAX 1:1 dialog with user ${mapping.pendingUserId}`, err);
          await bot.telegram
            .sendMessage(targetGroupId, `❌ Не удалось открыть личку в MAX: ${(err as Error).message}. Сообщение не отправлено — попробуйте ещё раз.`, {
              message_thread_id: topicId,
            })
            .catch((e) => logger.error('Failed to report pending-dialog open failure to Telegram', e));
          return;
        }
        // Echo guard FIRST, before any disk await: MAX echoes our first message back as a push, and
        // during the chat-map writes below that echo would find no cid to drop it and open a
        // duplicate topic. rememberOutgoingSend below moves the cursor once the real mapping exists.
        outgoingCids.remember(opened.cid);
        const link: MessageLink = { maxChatId: opened.chatId, maxMessageId: opened.messageId, telegramMessageId: ctx.message.message_id, telegramTopicId: topicId, outgoing: true };
        // Inside the new chat's queue: a reply from the contact landing between the two writes
        // would otherwise find no mapping and open a second topic.
        await chatSync.runInChat(opened.chatId, async () => {
          await chatMapStore.remove(mapping.maxChatId); // drop the "pending:<userId>" sentinel entry
          await chatMapStore.upsert({
            maxChatId: opened.chatId,
            telegramTopicId: topicId,
            title: mapping.title,
            createdAt: mapping.createdAt,
          });
          // The dialog was born with this very message — no older history to catch up.
          chatSync.markCaughtUp(opened.chatId);
          messageLinks.add(link);
        });
        rememberOutgoingSend(opened.chatId, opened.cid, opened.time);
        logger.info(
          `Opened new MAX 1:1 dialog ${String(opened.chatId)} with user ${mapping.pendingUserId} (topic ${topicId})`,
        );
        await sendMorePieces(opened.chatId, morePieces, link);
        return;
      }

      if (location) {
        const locationAttach = { _type: 'LOCATION', latitude: location.latitude, longitude: location.longitude, zoom: 14 };
        const { cid, messageId, time } = await max.sendMessage(mapping.maxChatId, null, [locationAttach]);
        rememberOutgoingSend(mapping.maxChatId, cid, time);
        messageLinks.add({ maxChatId: mapping.maxChatId, maxMessageId: messageId, telegramMessageId: ctx.message.message_id, telegramTopicId: topicId, outgoing: true });
        return;
      }

      if (contact) {
        // MAX's vCard-style CONTACT attach is self-contained (phone/name on it), so an arbitrary
        // Telegram contact goes over as a real card, not just text.
        const lastName = contact.last_name ?? '';
        const contactAttach = {
          _type: 'CONTACT',
          firstName: contact.first_name,
          lastName,
          phone: contact.phone_number,
          vcfBody: buildVcard(contact.first_name, lastName, contact.phone_number),
          name: contact.first_name,
        };
        const { cid, messageId, time } = await max.sendMessage(mapping.maxChatId, null, [contactAttach]);
        rememberOutgoingSend(mapping.maxChatId, cid, time);
        messageLinks.add({ maxChatId: mapping.maxChatId, maxMessageId: messageId, telegramMessageId: ctx.message.message_id, telegramTopicId: topicId, outgoing: true });
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
        const { cid, messageId, time } = await max.sendMessage(mapping.maxChatId, null, [pollAttach]);
        rememberOutgoingSend(mapping.maxChatId, cid, time);
        // Linked right away, not after the hint: a catch-up reaching the poll during that extra
        // round trip would find no link and post it again.
        messageLinks.add({ maxChatId: mapping.maxChatId, maxMessageId: messageId, telegramMessageId: ctx.message.message_id, telegramTopicId: topicId, outgoing: true });
        // Votes cast on THIS Telegram poll can't reach MAX: a bot gets poll_answer only for polls
        // it sent itself (and never for anonymous ones) — say so instead of letting counts drift.
        const hint = await bot.telegram
          .sendMessage(
            targetGroupId,
            'ℹ️ Опрос отправлен в MAX. Голоса, поданные здесь, в MAX не попадут — Telegram не сообщает боту о голосах в опросах, созданных участниками. Голосуйте в MAX; актуальный счёт — /poll ответом на опрос.',
            { message_thread_id: topicId, reply_parameters: { message_id: ctx.message.message_id, allow_sending_without_reply: true } },
          )
          .catch((err) => {
            logger.error('Failed to send the poll-votes hint', err);
            return undefined;
          });
        // A notice, not a copy of the poll: a 👎 on it must not delete the poll.
        if (hint) messageLinks.addNotice(mapping.maxChatId, messageId, hint.message_id);
        return;
      }

      if (text) {
        const [firstPiece = text, ...morePieces] = piecesForMax(text);
        const { cid, messageId, time } = await max.sendMessage(mapping.maxChatId, firstPiece, [], replyLink);
        rememberOutgoingSend(mapping.maxChatId, cid, time);
        const link: MessageLink = { maxChatId: mapping.maxChatId, maxMessageId: messageId, telegramMessageId: ctx.message.message_id, telegramTopicId: topicId, outgoing: true };
        messageLinks.add(link);
        await sendMorePieces(mapping.maxChatId, morePieces, link);
        return;
      }

      // Over the Bot API download limit getFile answers «file is too big» — offer an upload link
      // instead (bigFiles.ts). Fire-and-forget: the link can take a minute or two to get ready, and
      // this handler must not hold up the next update meanwhile.
      const fileFields = ctx.message as unknown as Record<string, { file_size?: number; file_name?: string } | undefined>;
      const tooBigKey = ['document', 'video', 'audio', 'animation', 'video_note', 'voice'].find(
        (k) => (fileFields[k]?.file_size ?? 0) > TELEGRAM_BOT_DOWNLOAD_LIMIT,
      );
      if (tooBigKey) {
        const f = fileFields[tooBigKey]!;
        const name = f.file_name ?? (tooBigKey === 'video_note' ? 'video_note.mp4' : tooBigKey === 'voice' ? 'voice.ogg' : 'file');
        void bigFiles
          .offerUpload({ maxChatId: mapping.maxChatId, topicId, telegramMessageId: ctx.message.message_id, caption: caption || undefined, name, size: f.file_size! })
          .catch((err) => logger.error('Offering an upload link failed', err));
        return;
      }

      let attach: Record<string, unknown> | null = null;
      const largestPhoto = photo?.[photo.length - 1];
      if (largestPhoto) {
        attach = await uploadTelegramAttachmentToMax(bot, max, largestPhoto.file_id, 'photo');
      } else if (video) {
        attach = await uploadTelegramAttachmentToMax(bot, max, video.file_id, 'video', video.file_name ?? 'video.mp4');
      } else if (videoNote) {
        // No confirmed MAX-side "round video" flag — may land as a regular rectangular video.
        attach = await uploadTelegramAttachmentToMax(bot, max, videoNote.file_id, 'video', 'video_note.mp4');
      } else if (document) {
        attach = await uploadTelegramAttachmentToMax(bot, max, document.file_id, 'document', document.file_name ?? 'file');
      } else if (animation) {
        attach = await uploadTelegramAttachmentToMax(bot, max, animation.file_id, 'document', animation.file_name ?? 'animation.gif');
      } else if (voice) {
        attach = await uploadTelegramAttachmentToMax(bot, max, voice.file_id, 'voice', 'voice.ogg', voice.duration ?? 0);
      } else if (audio) {
        // No MAX audio-track attach is known — the file pipeline delivers it as a playable file.
        attach = await uploadTelegramAttachmentToMax(bot, max, audio.file_id, 'document', audio.file_name ?? 'audio.mp3');
      } else if (sticker) {
        // No MAX-side sticker-upload opcode. Static webp goes through the PHOTO pipeline (confirmed
        // live 2026-08-13), video stickers (webm) through VIDEO_UPLOAD, animated (tgs/Lottie) are
        // rendered to a WebM first (lottie.ts) — MAX's own animated stickers arrive as VIDEO attaches.
        if (sticker.is_video) {
          attach = await uploadTelegramAttachmentToMax(bot, max, sticker.file_id, 'video', 'sticker.webm');
        } else if (sticker.is_animated) {
          // On a "slim" image without Chromium, the static thumbnail so something still comes through.
          if (canRenderAnimatedStickers()) {
            attach = await uploadTelegramAttachmentToMax(bot, max, sticker.file_id, 'sticker_animated');
          } else if (sticker.thumbnail?.file_id) {
            attach = await uploadTelegramAttachmentToMax(bot, max, sticker.thumbnail.file_id, 'photo');
          }
        } else {
          attach = await uploadTelegramAttachmentToMax(bot, max, sticker.file_id, 'photo');
        }
      }
      if (!attach) {
        // Nothing we know how to forward (a dice, a story, a game, …): say so in the topic — to the
        // sender a silently lost message looks exactly like a delivered one.
        const label = sticker ? 'анимированный стикер' : describeUnrelayableTelegramMessage(ctx.message);
        if (label) {
          logger.info(`TG -> MAX: message ${ctx.message.message_id} (${label}) can't be relayed — told the topic`);
          await bot.telegram
            .sendMessage(targetGroupId, `⚠️ Этот тип сообщения не передаётся в MAX: ${label}.`, {
              message_thread_id: topicId,
              reply_parameters: { message_id: ctx.message.message_id, allow_sending_without_reply: true },
            })
            .catch((e) => logger.error('Failed to report an unrelayable message type to Telegram', e));
        }
        return;
      }

      const { cid, messageId, time } = await max.sendMessage(mapping.maxChatId, caption, [attach], replyLink);
      rememberOutgoingSend(mapping.maxChatId, cid, time);
      messageLinks.add({ maxChatId: mapping.maxChatId, maxMessageId: messageId, telegramMessageId: ctx.message.message_id, telegramTopicId: topicId, outgoing: true });
    } catch (err) {
      logger.error('Telegram -> MAX forward failed', err);
      // A swallowed send is indistinguishable from success to the sender — report it in the topic.
      await bot.telegram
        .sendMessage(targetGroupId, `⚠️ Не удалось отправить в MAX: ${(err as Error).message}`, { message_thread_id: topicId })
        .catch((e) => logger.error('Failed to report TG->MAX forward failure to Telegram', e));
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

  // 👎 is the only one of the user's requested delete-emojis (🗑/❌/👎) that Telegram
  // actually accepts as a reaction — 🗑 and ❌ return REACTION_INVALID (confirmed live
  // 2026-08-15). Reacting 👎 to one of OUR OWN relayed messages means "delete this".
  const DELETE_REACTION_EMOJIS = new Set(['👎']);

  bot.on('message_reaction', async (ctx) => {
    const update = ctx.messageReaction;
    const link = messageLinks.getByTelegram(update.message_id);
    if (!link) return;
    // A bot notice is not the message: no delete, no reaction relayed onto it.
    if (isNoticeOf(link, update.message_id)) return;

    const oldEmojis = new Set(update.old_reaction.filter((r) => r.type === 'emoji').map((r) => r.emoji));
    const newEmojis = update.new_reaction.filter((r) => r.type === 'emoji').map((r) => r.emoji);
    const added = newEmojis.find((e) => !oldEmojis.has(e));

    // 👎 on our OWN message = delete on both sides (forAll — it's ours). On an incoming copy a
    // genuine 👎 still relays as an ordinary reaction below.
    if (added && DELETE_REACTION_EMOJIS.has(added) && link.outgoing) {
      // Same admin gate as /delete (the command middleware never sees reactions). An anonymous
      // admin reacts as the group itself (actor_chat); an unverifiable user is ignored — fail closed.
      const actorChatId = (update as { actor_chat?: { id: number } }).actor_chat?.id;
      let allowed = actorChatId != null && String(actorChatId) === targetGroupId;
      if (!allowed && update.user) {
        try {
          allowed = await isGroupAdmin(update.user.id);
        } catch (err) {
          logger.error('Failed to check admin status for a 👎 delete', err);
        }
      }
      if (!allowed) {
        logger.info(`👎 on Telegram message ${update.message_id} by a non-admin (user ${update.user?.id ?? '?'}) — ignored, nothing deleted`);
        return;
      }
      try {
        await max.deleteMessages(link.maxChatId, linkMaxIds(link), false);
        // Forgets the link before the Telegram copies vanish, so the deletion probe never races in.
        await dropLinkedMessage(link, '👎');
        logger.info(`👎-delete: removed MAX message ${String(link.maxMessageId)} in chat ${String(link.maxChatId)} (forAll)`);
      } catch (err) {
        logger.error('Failed to delete MAX message after 👎 reaction', err);
      }
      return;
    }

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

  // Telegram only tells a bot about votes on NON-anonymous polls the bot itself sent — the MAX
  // polls mirrored into a topic (pollLinks holds exactly those). It can't run the other way:
  // Telegram's poll widget can't take a vote cast on MAX's side (relayPollUpdate posts a tally instead).
  bot.on('poll_answer', async (ctx) => {
    const answer = ctx.pollAnswer;
    const link = pollLinks.getByTelegramPollId(answer.poll_id);
    if (!link) return;
    // The vote goes to MAX in the owner's name — admins only, like the 👎 delete. An anonymous
    // admin votes as the group itself (voter_chat); an unverifiable user is ignored — fail closed.
    const voterChatId = (answer as { voter_chat?: { id: number } }).voter_chat?.id;
    let allowed = voterChatId != null && String(voterChatId) === targetGroupId;
    if (!allowed && answer.user) {
      try {
        allowed = await isGroupAdmin(answer.user.id);
      } catch (err) {
        logger.error('Failed to check admin status for a poll vote', err);
      }
    }
    if (!allowed) {
      logger.info(`Vote in Telegram poll ${answer.poll_id} by a non-admin (user ${answer.user?.id ?? '?'}) — ignored, not relayed to MAX`);
      return;
    }

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

  return { chatSync };
}

/**
 * The LOGIN-time pass over every MAX chat: each gets a Telegram topic (created with its info card
 * when missing) and its catch-up (ChatCatchUp.ensureCaughtUp), one chat after another, each inside
 * the chat's queue. Safe to call on every LOGIN; a chat already caught up by a live event costs
 * nothing. A chat that fails on a transient error stays out of `caughtUp` and asks for a retry run
 * instead of waiting for a LOGIN that may never come while the socket stays up. After the
 * snapshot, mapped chats it did not contain get the same catch-up: the LOGIN snapshot is capped at
 * 50, and a chat born live meanwhile may be missing too — left out, its cursor stayed frozen all
 * session and the next restart re-sent everything. `isCancelled` (/reboot, /kill) is checked
 * before every chat and every message. A topic deleted by hand is NOT looked for here: it comes
 * back, with its history, when the chat's next message arrives (decided 2026-09-29).
 */
export async function syncAllChatsToTelegram(
  chatSync: ChatCatchUp,
  chats: unknown[],
  resolveDisplayName: (chat: unknown) => string,
  isCancelled?: () => boolean,
): Promise<void> {
  const { bot, groupId, chatMapStore } = chatSync.deps;
  // true = keep going; false = the run was cancelled.
  const onChatError = (chatId: unknown, err: unknown): boolean => {
    if (err instanceof SyncCancelledError) {
      logger.info('Chat sync cancelled (/reboot or /kill) — stopping this run');
      return false;
    }
    if (err instanceof ChatBannedError) {
      logger.info(`MAX chat ${String(chatId)} was banned during its catch-up — left alone`);
      return true;
    }
    logger.error(`Failed to sync MAX chat ${String(chatId)} to Telegram`, err);
    if (isRetriedDeliveryFailure(err) || isTransientMaxError(err)) {
      chatSync.requestRetry(`sync of MAX chat ${String(chatId)} hit a transient failure`);
    }
    return true;
  };

  const inSnapshot = new Set<string>();
  for (const chat of chats) {
    if (isCancelled?.()) {
      logger.info('Chat sync cancelled (/reboot or /kill) — stopping this run');
      return;
    }
    if (!chat || typeof chat !== 'object') continue;
    const c = chat as { id?: unknown; status?: string };
    if (c.id == null) continue;
    // CHATS_LIST keeps returning chats the account left/closed (status "CLOSED") — MAX's own client
    // hides those (confirmed live 2026-08-13). Not counted as in the snapshot: a mapped one still
    // gets the second loop's catch-up (the owner may have been re-added meanwhile).
    if (c.status && c.status !== 'ACTIVE') continue;
    const chatId = c.id;
    inSnapshot.add(String(chatId));
    try {
      await chatSync.runInChat(chatId, async () => {
        // Checked again once the queue is ours: a live job of this chat may have held it for a while.
        if (isCancelled?.()) throw new SyncCancelledError();
        // Banned chats (/ban) stay muted through a full resync too — don't recreate their topic.
        if ((await chatMapStore.getByMaxChatId(chatId))?.banned) return;
        const { topicId, created } = await ensureTopicForMaxChat(bot, groupId, chatId, chatMapStore, resolveDisplayName(chat));
        // Same intro card the live path sends on first contact.
        if (created) await chatSync.deps.sendCard(chatId, topicId).catch((err) => logger.error('Failed to send auto contact-info card', err));
        await chatSync.ensureCaughtUp(chatId, isCancelled);
      });
    } catch (err) {
      if (!onChatError(chatId, err)) return;
    }
  }

  // Mapped chats the snapshot did not contain (see above) — their topics exist, so only the
  // cursor-bounded catch-up. A chat already caught up (a live event got there first) needs none.
  let mappings: Awaited<ReturnType<ChatMapStore['list']>> = [];
  try {
    mappings = await chatMapStore.list();
  } catch (err) {
    logger.error('Chat sync: failed to list mapped chats — skipping the ones missing from the chat list', err);
    return;
  }
  for (const mapping of mappings) {
    if (isCancelled?.()) {
      logger.info('Chat sync cancelled (/reboot or /kill) — stopping this run');
      return;
    }
    if (inSnapshot.has(mapping.maxChatId)) continue;
    try {
      // ensureCaughtUp itself skips a banned, pending ("pending:<userId>", no MAX dialog yet) or already caught-up chat.
      logger.info(`MAX chat ${mapping.maxChatId} is mapped but missing from the chat list — checking its history anyway`);
      await chatSync.runInChat(mapping.maxChatId, async () => {
        if (isCancelled?.()) throw new SyncCancelledError();
        await chatSync.ensureCaughtUp(mapping.maxChatId, isCancelled);
      });
    } catch (err) {
      if (!onChatError(mapping.maxChatId, err)) return;
    }
  }
}
