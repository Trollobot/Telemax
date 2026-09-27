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
  type MaxAttachment,
  type DownloadContext,
} from './attachments.js';
import { splitTelegramText, truncateCodePoints, truncateUtf16, TELEGRAM_CAPTION_LIMIT, TELEGRAM_TEXT_LIMIT } from './text.js';
import { uploadTelegramAttachmentToMax } from './upload.js';
import { canRenderAnimatedStickers } from './lottie.js';
import { reportBridgeError } from './errorReporter.js';
import { wireControlPanel } from './panel.js';
import { createBugReports, isBugReportInboxEnabled, BUGREPORT_BOT_HANDLE, type BugReports } from './bugReports.js';
import { createMaxAuthFlow, type MaxAuthCallbacks } from './maxAuthFlow.js';
import { createTelemetry } from './telemetry.js';
import { checkVersion, type VersionStatus } from './version.js';
import { buildStatusText, collectHostStats, maskPhone } from './status.js';
import { toTelegramReaction } from '../max/reactions.js';
import { ChatBannedError, StrikeCounter, SyncCancelledError, liveCursorTime } from './catchUp.js';
import { isThreadNotFound, isTransientMaxError, isTransientTelegramError, TransientDownloadError } from './transient.js';
import { createLogger, jsonStringify, redactSecrets } from '../logger.js';

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

/**
 * A human label for Telegram message content the bridge has no MAX equivalent for, so the topic
 * can say it was NOT relayed instead of it vanishing silently (review 2026-09-26, OUTBOUND6).
 * Null for anything else — service updates (pins, joins, …) must stay silent, not draw a warning.
 * Pure + exported for unit testing.
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
 * Decay ladder for the deletion probe — how long to wait between pings for one of
 * our own relayed messages, by its age. Dense right after send (≈90% of deletions
 * land in the first couple of minutes), thinning out over hours, then `null` = stop
 * probing (a message untouched for 6h is almost never deleted, and pinging it forever
 * is pure waste). Pure + exported so the ladder is unit-testable without timers.
 */
export function probeIntervalMs(ageMs: number): number | null {
  if (ageMs < 2 * 60_000) return 15_000;
  if (ageMs < 15 * 60_000) return 60_000;
  if (ageMs < 60 * 60_000) return 5 * 60_000;
  if (ageMs < 6 * 60 * 60_000) return 30 * 60_000;
  return null;
}

/**
 * Classifies a failed empty-`setMessageReaction` probe from its error text. A live
 * message errors `REACTION_EMPTY` (Telegram found it, then rejected the empty set);
 * a deleted one errors `message to react not found`. Returns 'gone' ONLY on the
 * exact not-found shapes — never on 429/network/anything else, because a false
 * 'gone' would irreversibly delete a still-live message on MAX. Confirmed live
 * 2026-08-15. Pure + exported for unit testing.
 */
export function classifyProbeResult(errText: string): 'alive' | 'gone' | 'unknown' {
  const t = errText.toLowerCase();
  if (t.includes('reaction_empty')) return 'alive';
  if (
    t.includes('message to react not found') ||
    t.includes('message not found') ||
    t.includes('message to delete not found') ||
    // A deleted USER message answers MESSAGE_ID_INVALID, not the "not found" shape a
    // bot's own deleted message returns — confirmed live 2026-08-15. Safe as 'gone'
    // here: we only ever probe an id we ourselves recorded, a live one answers
    // REACTION_EMPTY, and a rate-limit answers 429 — so a previously-valid id going
    // invalid means the message was deleted.
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
 * Pre-flight for one outgoing link before the deletion probe may touch it. A 'gone'
 * probe ends in an irreversible forAll delete on MAX, so anything that means "the
 * whole topic went away" rather than "the owner deleted this one message" must stop
 * here (review 2026-09-26):
 *  - no mapping (chat closed, /reboot, /kill) or a banned chat -> 'drop' the link;
 *  - the mapping now points at a different topic than the one the message was
 *    written in (the old topic was deleted and recreated) -> 'drop'.
 * (A topic restore forgets the chat's links before recreating it, so none survives to be probed.)
 * Pure + exported for unit testing.
 */
export function probeLinkGuard(link: { telegramTopicId?: number }, mapping: { telegramTopicId: number; banned?: boolean } | undefined): 'probe' | 'drop' {
  if (!mapping || mapping.banned) return 'drop';
  if (link.telegramTopicId != null && link.telegramTopicId !== mapping.telegramTopicId) return 'drop';
  return 'probe';
}

/** Telegram's flood-control 429 carries how long to wait — honor it instead of failing the send.
 * Capped: an endless 429 (the bot got flagged/limited for real) must eventually surface as an
 * error instead of holding a backfill loop hostage forever. */
const FLOOD_RETRY_MAX_ATTEMPTS = 5;
async function withFloodRetry<T>(fn: () => Promise<T>): Promise<T> {
  for (let attempt = 1; ; attempt++) {
    try {
      return await fn();
    } catch (err) {
      const retryAfter = (err as { response?: { parameters?: { retry_after?: number } } })?.response?.parameters?.retry_after;
      if (!retryAfter || attempt >= FLOOD_RETRY_MAX_ATTEMPTS) throw err;
      logger.info(`Telegram flood control: waiting ${retryAfter}s (attempt ${attempt}/${FLOOD_RETRY_MAX_ATTEMPTS})`);
      await sleep((retryAfter + 1) * 1000);
    }
  }
}
// NOTE: wrap ONE Telegram call, never a function that sends several messages — a retry re-runs
// `fn` from the top, so everything it had already delivered before the 429 would be posted again
// (review 2026-09-26, S2: a whole sendAttachments used to be wrapped and duplicated albums).

/**
 * How a relayed MAX message's Telegram copies are linked: the first text piece (or, with no text,
 * the first attachment) is the anchor edits/replies/reactions use, and EVERY other message it
 * produced — further text pieces of a split long text, every attachment of an album — goes into
 * extraTelegramMessageIds, so deleting the MAX message deletes all of them instead of orphaning
 * the rest of an album (review 2026-09-26, S5). Pure + exported for unit testing.
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

/**
 * Sends a text that may exceed Telegram's 4096-unit limit as consecutive messages (see
 * splitTelegramText), each through withFloodRetry. The reply goes on the first piece and the
 * inline keyboard on the last, so it sits under the whole text. `paceMs` spaces the pieces out
 * (the backfill's per-chat flood pacing). Returns every sent message_id in order; `sent`, when
 * given, gets each id as soon as it is sent — so a caller still knows what went out when a later
 * piece throws (discardPartialDelivery).
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
  } = {},
): Promise<number[]> {
  const pieces = splitTelegramText(text);
  const ids: number[] = [];
  for (let i = 0; i < pieces.length; i++) {
    const piece = pieces[i] as string;
    const sent = await withFloodRetry(() =>
      bot.telegram.sendMessage(groupId, piece, {
        message_thread_id: topicId,
        ...(i === 0 && extra.replyParameters ? { reply_parameters: extra.replyParameters } : {}),
        ...(i === pieces.length - 1 && extra.replyMarkup ? { reply_markup: extra.replyMarkup } : {}),
      }),
    );
    ids.push(sent.message_id);
    extra.sent?.push(sent.message_id);
    if (extra.paceMs) await sleep(extra.paceMs);
  }
  return ids;
}

/** Deletes the bot's own Telegram messages one by one, so one failure doesn't keep the rest. Never throws; `why` names the cause in the error log. */
async function deleteBotMessages(bot: Pick<Telegraf, 'telegram'>, groupId: string, ids: readonly number[], why: string): Promise<void> {
  for (const id of ids) {
    await bot.telegram.deleteMessage(groupId, id).catch((err) => logger.error(`Failed to delete Telegram message ${id} (${why})`, err));
  }
}

/**
 * A MAX message goes out as several Telegram messages (text pieces, then each attachment). When a
 * transient failure hits after some of them went out, the whole message is delivered again later
 * (the next catch-up finds no link for it) — so the parts already posted are deleted here first,
 * or they would show up twice (review 2026-09-26, b5-delivery/b2b-errors). Best effort: an id
 * whose deletion fails too (Telegram still down) is logged and left behind.
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
 * 300 chars, an option over 100, fewer than 2 or more than 10 options; review 2026-09-26,
 * INBOUND-EDGES4). Voting stays on MAX; /poll in reply still shows the live tally.
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
    // MAX server ms timestamp (may arrive as a BigInt) — the same field CHAT_HISTORY returns
    // (client.ts: a history message has the push message's shape). Feeds the history cursor.
    time?: unknown;
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
  // True when WE sent this to MAX (Telegram->MAX, i.e. our own message). Drives
  // both the 👎-delete gesture and the deletion probe: only our own messages get
  // deleted forAll / probed, since MAX->Telegram deletions already arrive natively
  // as a REMOVED push (handleMaxPush) and deleting someone else's message on MAX
  // for everyone isn't ours to do.
  outgoing?: boolean;
  // Epoch ms this link was created — the probe uses it to place the message on the
  // decay ladder (hot right after send, cooling off over hours).
  createdAt?: number;
  // Telegram topic the message was written in (set on outgoing links). The probe drops
  // the link instead of deleting on MAX when the chat's mapping now points at a
  // different topic — the old one (and every message in it) was deleted and recreated.
  telegramTopicId?: number;
  // Bot-written notices about this message (a poll's vote hint or reminder, a tally reply, an edit
  // relayed as a reply): deleted with it and resolvable by getByTelegram (/poll, a native reply), but
  // never the target of a 👎 delete, /delete or a relayed reaction — those used to delete the
  // owner's poll on both sides for a 👎 on the «Опрос отправлен в MAX…» hint (review 2026-09-26,
  // delivery-r2#0).
  noticeTelegramMessageIds?: number[];
}

/** Every Telegram message a link covers: anchor, content extras, notices. Pure + exported for unit testing. */
export function linkTelegramIds(link: Pick<MessageLink, 'telegramMessageId' | 'extraTelegramMessageIds' | 'noticeTelegramMessageIds'>): number[] {
  return [...new Set([link.telegramMessageId, ...(link.extraTelegramMessageIds ?? []), ...(link.noticeTelegramMessageIds ?? [])])];
}

/** Whether `telegramMessageId` is one of the link's bot notices rather than a copy of the message itself (delivery-r2#0). */
export function isNoticeOf(link: Pick<MessageLink, 'noticeTelegramMessageIds'>, telegramMessageId: number): boolean {
  return link.noticeTelegramMessageIds?.includes(telegramMessageId) ?? false;
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

  /**
   * Links a MAX message. A link already stored for the same message is replaced cleanly — its
   * Telegram ids and its place in the eviction order go first. A plain overwrite left the old ids
   * in byTelegram pointing at a dead link and the key twice in `order`, so evicting the first copy
   * dropped the current link early (review 2026-09-26, delivery-r2#4).
   */
  add(link: MessageLink): void {
    if (link.maxMessageId == null) {
      // Dropping silently already cost a debugging session (2026-08-14): without
      // a MAX-side id every later /delete or edit on this message reports "no
      // link" with no trace of why.
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

  /**
   * Adds a bot notice produced later for an already-linked MAX message (a poll's tally reply, an
   * edit relayed as a reply) to its notices, so deleting the MAX message takes it along instead of
   * leaving an orphan reply behind (review 2026-09-26, b5-delivery) — while a 👎 or /delete aimed at
   * it does not delete the message itself (delivery-r2#0). No-op when the link is gone.
   */
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
   * Drops every link of one MAX chat. Called BEFORE its Telegram topic is deleted
   * (/ban, "Чат закрыт", a topic restore): deleting a topic takes all its messages with
   * it, and a surviving outgoing link would then probe 'gone' and get mirror-deleted on
   * MAX forAll — wiping the owner's messages for a topic removal, not a message deletion
   * (review 2026-09-26). Returns how many links were dropped.
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
function isRenderableAttach(att: MaxAttachment): boolean {
  return !(att._type === 'CONTROL' && !['new', 'join', 'leave', 'title'].includes(String((att as { event?: unknown }).event)));
}

type SentMessage = { message_id: number };
type AttachmentSendOpts = { message_thread_id: number; reply_parameters?: { message_id: number; allow_sending_without_reply: boolean } };

/**
 * Sends a MAX message's attachments into a topic, one Telegram message each, and returns EVERY
 * sent message_id in order — the caller links them all (buildLinkIds), so deleting the MAX message
 * removes the whole album, not just its first photo (review 2026-09-26, S5).
 *
 * Each Telegram call is wrapped in withFloodRetry on its own: a 429 retries just that one send
 * (wrapping the whole function re-sent the attachments already delivered — S2). And each
 * attachment degrades on its own: one Telegram refuses for good (a file over the Bot API upload
 * limit, a rejected format) becomes the same text placeholder as a failed download, and the rest
 * still go out — instead of aborting the message and raising the misleading "check the bot's
 * rights" alarm (INBOUND-EDGES1). Only a deleted topic, a transient failure (the caller retries
 * later) or a refused placeholder propagate. `sent`, when given, gets each id as soon as it is
 * sent (see sendTextPieces).
 * `degradeTransient` (the backfill's last try on a message): a transient failure of one attachment
 * degrades to its placeholder too, and the rest of the album still goes out — giving up used to drop
 * the failing attachment and every one after it without a word (review 2026-09-26, delivery-r1#2).
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
    // Chat-lifecycle CONTROL events with no useful rendering (notably `system` — a
    // history-clear/other system marker; a chat deletion is also a `system` event, «Чат закрыт»,
    // which handleMaxPush catches earlier and deletes the topic for) shouldn't be relayed as a
    // "[системное событие: system]" junk message. The meaningful ones (new/join/leave/
    // title) still fall through and render normally.
    if (!isRenderableAttach(att)) continue;
    // Native reply (reply_parameters) applies only to the FIRST message this MAX message
    // produces — subsequent attaches follow it normally.
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
    // The backfill's per-chat pacing (HISTORY_SEND_DELAY_MS), per attachment: an album is
    // several messages in a row, the likeliest thing to trip flood control.
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
    return phone != null
      ? withFloodRetry(() => bot.telegram.sendContact(groupId, `+${String(phone)}`, displayName, opts))
      : withFloodRetry(() => bot.telegram.sendMessage(groupId, `👤 Контакт: ${displayName}`, opts));
  }
  const downloaded = await downloadMaxAttachment(att, downloadCtx);
  // Bot API upload limits: nothing over 50 MB at all, a photo only up to 10 MB (a bigger one
  // still goes through as a file) — see telegramSendKind.
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
      // sendVideoNote is the only way Telegram renders the round "circle" bubble —
      // sendVideo would show the same file as a regular rectangular player instead.
      return await withFloodRetry(() => bot.telegram.sendVideoNote(groupId, source, opts));
    } catch (err) {
      if (!isPermanentTelegramRefusal(err)) throw err;
      logger.error('sendVideoNote failed, falling back to sendVideo', err);
      return withFloodRetry(() => bot.telegram.sendVideo(groupId, source, opts));
    }
  }
  if (kind === 'voice') {
    try {
      // Telegram's voice bubble is picky about codec (wants OGG/OPUS) — MAX's actual
      // encoding is unconfirmed, so fall back to a regular playable audio file rather
      // than losing the message if sendVoice rejects the format.
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
// Safety valve, not an expected ceiling — user's own numbers put 10k messages at
// ~1min of MAX-side fetching; this just stops a pagination bug from looping forever.
const HISTORY_MAX_BATCHES = 2000;
// Telegram's per-chat flood limit is roughly 1 msg/sec — this backfill can dump
// thousands of messages into one chat, so it paces itself instead of relying on
// withFloodRetry alone (retrying after every 429 would still get flagged as abuse).
const HISTORY_SEND_DELAY_MS = 1100;

/**
 * Where fetchFullHistory starts paging: a little AHEAD of the local clock. CHAT_HISTORY only
 * returns messages older than `from`, and the cursor is MAX server time (liveCursorTime): with a
 * host clock running behind MAX's, "now" sat below messages that arrived during the gap — the
 * first page missed them, its oldest message was already at/below the cursor, paging stopped and
 * they were lost (review 2026-09-26, RECOVERY9 slow-clock half). A future `from` is accepted (a
 * fast host clock always sent one); the `time > sinceTime` filter is unaffected.
 * Pure + exported for unit testing.
 */
export const HISTORY_FROM_AHEAD_MS = 15 * 60_000;
export function historyStartTime(now: number = Date.now()): number {
  return now + HISTORY_FROM_AHEAD_MS;
}

/**
 * Walks CHAT_HISTORY backward from "now" (historyStartTime) until it runs dry, deduping by message
 * id (batches can re-include the boundary message) and returning everything in
 * chronological (oldest-first) order, ready to replay into Telegram.
 *
 * `sinceTime`: when set, only messages strictly newer are returned, and pagination
 * stops as soon as a batch's oldest message is already at/before it — turns this
 * from "walk the whole chat" into a cheap "what's new since last time" call, used
 * on every reconnect to catch up on messages missed during the disconnected gap
 * (a live push arriving while we're between TCP sessions is otherwise lost forever —
 * hit live 2026-08-12, a message sent mid-redeploy never reached Telegram).
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
 * Download ids for a forward's attachments. Files live on the ORIGINAL message/chat (the source):
 * FILE_DOWNLOAD/VIDEO_PLAY validate the fileId/videoId against the message+chat it was uploaded in,
 * so the wrapper's own ids get rejected and the attachment silently drops (hit live 2026-08-13).
 * That works when we're in the source chat. But a forward from a chat we're NOT in arrives with
 * link.chatId = 0 (source hidden) and FILE_DOWNLOAD there is denied — so the RECIPIENT chat (the
 * dialog the forward landed in) + the wrapper message id are the fallback: the file is present in
 * our own chat with the forwarder. (Тимур -> Владимир -> нам: докачиваем через наш диалог с
 * Владимиром, не через скрытый чат Тимура.)
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
 * Unwraps a forward we RECEIVE: the wrapper message's own text/attaches are empty — the real
 * content is in link.message (confirmed live 2026-08-13) — so without this it's silently dropped
 * as an empty message. Returns its text with a "↩️ Переслано из «…» (от …):" prefix, its
 * attachments and their download ids (forwardDownloadIds); null when `link` isn't a forward.
 * (Sending a forward FROM us doesn't work yet — MAX's response to our own FORWARD request comes
 * back essentially empty and no message is actually created; still unresolved.)
 * One function for the live path and the history backfill: the backfill's own copy had drifted —
 * no recipient-chat fallback, so a forward from a hidden chat lost its file in restored history
 * (review 2026-09-26, S14b).
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

/** Forces a fresh topic for a chat: drops the stale mapping so ensureTopicForMaxChat recreates it, and returns the new topic id. Reuses the deleted topic's stored title so the recreated one keeps the contact's name/nick instead of the bare "MAX chat <id>" fallback. Used to heal a topic the user deleted in Telegram. */
async function recreateTopicForChat(bot: Telegraf, groupId: string, chatId: unknown, chatMapStore: ChatMapStore): Promise<number> {
  const existing = await chatMapStore.getByMaxChatId(chatId);
  // /ban deleted that topic on purpose — "healing" it recreated the topic with a mapping that no
  // longer carried the ban (review 2026-09-26, cross).
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
 * Replaces six copies of the same fetch-and-cache block (review 2026-09-26, S14a).
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
 * get "🧑 Вы:" EVERYWHERE — including 1:1 backfill and messages sent from the MAX app — so a synced
 * history isn't an undifferentiated stream where our own lines look identical to the contact's. Other
 * people get "👤 Name:" only in GROUP chats (>2 participants); in a 1:1 the topic already IS the
 * contact, so their messages stay unprefixed. Returns '' when the sender can't be determined.
 * `profiles` caches the looked-up names: the live contact cache (handleMaxPush, and the backfill
 * when the caller has it) or the backfill's own per-run map — without one, every group message of
 * a synced history cost its own CONTACT_INFO round trip (review 2026-09-26, S1).
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
 *   notice, the LOGIN sync's pass over the chat, a topic restore, an outgoing send's cursor move —
 *   runs through runInChat: one at a time per chat, in arrival order. Different chats run side by
 *   side. Handled side by side within a chat, a later message delivered first moved the cursor past
 *   an earlier one still uploading, and when that one then failed the catch-up never fetched it
 *   again (review 2026-09-26, delivery-r1#0); in order, a deletion also finds the link of a message
 *   whose delivery was still running (delivery-r1#5).
 * - `caughtUp` holds the chats whose history is known to be in Telegram this MAX session. Before a
 *   job writes into a chat that is not in it, ensureCaughtUp fetches the chat's history from its
 *   cursor and backfills it — what arrived while the bridge was offline, or in the gap of a
 *   reconnect, goes out first and in order (review 2026-09-26, C3), and the live push that follows
 *   finds its message linked and skips it. A chat with no mapping yet (a new contact's first
 *   message) takes the same path from a null cursor. The set is emptied on every new MAX socket
 *   and by /reboot: whatever arrived in the gap has to be caught up again first.
 * - The cursor moves only inside the chat's queue, after a successful delivery, and only for a
 *   chat in `caughtUp` — so it can never jump past a message still waiting for its catch-up. The
 *   outgoing (Telegram -> MAX) path queues its cursor move the same way.
 * - A transient failure (Telegram/proxy down, 5xx, a MAX file not fetchable right now) aborts the
 *   job: the cursor stays before the failed message, the parts of it already posted are deleted,
 *   the chat is left out of `caughtUp`, and a catch-up retry is requested (server/app.ts's
 *   backoff) — the retry re-delivers the message from the cursor (review 2026-09-26,
 *   C12/RECOVERY3/RECOVERY5). A failure pinned on one message that keeps repeating (StrikeCounter:
 *   three strikes spread over at least an hour) degrades it to placeholders on the next try, so
 *   one poisoned message cannot block its chat forever (b2b-errors).
 */
export class ChatCatchUp {
  // Chats whose history is in Telegram this MAX session — see the class note. Only the methods
  // below touch it: the session guard in replay() is the one place a chat joins after a fetch.
  private readonly caughtUp = new Set<string>();
  // Bumped by every reset(): a catch-up that fetched its history under an older session may not
  // mark its chat — that snapshot could not see what arrived in the new socket's gap.
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
   * shell (reported live 2026-08-15). The chat's links go first — they point into the dead topic,
   * and the deletion probe would read them as deleted by the owner and mirror-delete on MAX forAll
   * (review 2026-09-26) — then the topic is recreated with its info card and the chat's full
   * history replayed from the fresh mapping's null cursor. The message that triggered the restore
   * is part of that history, so it is never sent separately. A recreated topic reporting itself
   * gone is not healed again (thread not found propagates). Returns the new topic id, or undefined
   * for a chat closed in MAX meanwhile («Чат закрыт» dropped its mapping — left alone, review
   * 2026-09-27, catchup-r3.2#1); a banned one throws ChatBannedError (recreateTopicForChat).
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
   * socket came while it was fetched or sent: that snapshot could not see the new gap, so the LOGIN
   * pass (or the next live event) fetches again from the cursor, which the backfill advanced per
   * message, so the re-run is cheap.
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
   * Inside the chat's queue, before a live event (a push, a call) is written into the chat: its
   * topic — created on first contact, with its info card — and its catch-up. Returns null when
   * nothing may be written: the chat is banned, or a wipe cancelled it. `deferred` is set when the
   * catch-up failed transiently — a retry is requested, and a message sits in the history above
   * the cursor, so it arrives with the retried catch-up; an event that is not part of the history
   * (a call notice) goes out anyway. Any other catch-up failure is logged and the event is relayed;
   * the chat is not caught up, so its cursor stays put.
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
      const deferred = isRetriedDeliveryFailure(err) || isTransientMaxError(err);
      if (deferred) {
        logger.error(`Catch-up of MAX chat ${String(chatId)} before a live event failed transiently — a message arrives with the retried catch-up`, err);
        this.requestRetry(`catch-up of MAX chat ${String(chatId)} hit a transient failure`);
      } else {
        logger.error(`Catch-up of MAX chat ${String(chatId)} failed — relaying the live event anyway, its cursor stays put`, err);
      }
      return { topicId: first.topicId, deferred };
    }
  }

  /**
   * Replays `messages` (oldest-first) into the chat's topic, pacing sends to stay under Telegram's
   * flood limit, and moves the cursor after every message — sent, skipped (already in Telegram by
   * its link, nothing to render) or refused for good (a 4xx: a placeholder where possible, else
   * logged) — so a restart mid-backfill resumes after the last one instead of replaying the whole
   * chat (hit as a near-miss 2026-08-09). A transient failure throws BEFORE the cursor moves, after
   * deleting the parts already posted (discardPartialDelivery); one pinned on the message itself
   * (its download, an attachment upload — never a text send) counts as a strike (StrikeCounter),
   * past which the next try degrades those parts to placeholders (download: throwOnTransient off;
   * upload: sendAttachments' degradeTransient — giving up used to drop the failing attachment and
   * every one after it without a word, review 2026-09-26, delivery-r1#2). A deleted topic (thread
   * not found) propagates to ensureCaughtUp, which restores it.
   */
  private async backfill(chatId: unknown, topicId: number, messages: MaxHistoryMessage[], cancelled: () => boolean): Promise<void> {
    const { bot, groupId, max, chatMapStore, messageLinks } = this.deps;
    const chats = this.deps.getChats();
    const myAccountId = this.deps.getMyAccountId();
    const profiles = this.deps.getContactProfiles();
    const chat = chats.find((c) => c && typeof c === 'object' && String((c as { id?: unknown }).id) === String(chatId));
    for (const msg of messages) {
      // /reboot or /kill wiped the state this run writes into: stop before the next message
      // instead of refilling topics that were just deleted (review 2026-09-26, C7).
      if (cancelled()) throw new SyncCancelledError();
      // /ban landed mid-run: its topic is gone on purpose — stop here instead of recreating it on
      // "thread not found" and replaying the rest into it (review 2026-09-26, cross). Closed in MAX
      // («Чат закрыт») mid-run: its topic and mapping went on purpose too (review 2026-09-27,
      // catchup-r3.2#1).
      const mapping = await chatMapStore.getByMaxChatId(chatId);
      if (mapping?.banned) throw new ChatBannedError(String(chatId));
      if (!mapping) {
        logger.info(`MAX chat ${String(chatId)} was closed during its backfill — stopping it`);
        return;
      }
      // Already in Telegram: relayed live (either direction) before this catch-up reached it.
      if (msg.id != null && messageLinks.getByMax(chatId, msg.id)) {
        await chatMapStore.advanceHistoryCursor(chatId, msg.time);
        continue;
      }
      const forwarded = await resolveForwardContent(max, chats, msg.link, chatId, msg.id, profiles);
      let text = forwarded ? forwarded.text : msg.text;
      let attaches = forwarded ? forwarded.attaches : Array.isArray(msg.attaches) ? (msg.attaches as MaxAttachment[]) : [];
      // A poll goes out as its text rendering, options included: sendAttachments only knows a
      // «[опрос: …]» placeholder for it, and a live poll that a transient failure discarded came back
      // from the catch-up as just that (review 2026-09-26, delivery-r2#3).
      const pollAttach = attaches.find((a) => a._type === 'POLL');
      if (pollAttach) {
        const pollText = renderPollAsText(pollAttach.title, (pollAttach.answers ?? []).map((a) => a.text || '—'), pollAttach.settings ?? 0);
        text = text ? `${text}\n${pollText}` : pollText;
        attaches = attaches.filter((a) => a !== pollAttach);
      }
      if (!text && !attaches.some((a) => isRenderableAttach(a))) {
        await chatMapStore.advanceHistoryCursor(chatId, msg.time);
        continue;
      }
      // Same join/leave rendering as the live path (see renderMemberEvent), so synced history also
      // says who left / was added — with their MAX ID and a DM button.
      let memberMarkup: InlineMarkup | undefined;
      const memberEvent = await renderMemberEvent(attaches, text, (msg as { sender?: unknown }).sender, myAccountId, max, profiles);
      if (memberEvent) {
        text = memberEvent.text;
        attaches = [];
        memberMarkup = memberEvent.markup;
      } else {
        // Group chats: prefix the author so the topic isn't an anonymous stream (1:1 needs none).
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
          // Split when over Telegram's 4096 limit (INBOUND-EDGES2), each piece paced like any message.
          textIds = await sendTextPieces(bot, groupId, topicId, text, { replyMarkup: memberMarkup, paceMs: HISTORY_SEND_DELAY_MS, sent });
        }
        if (attaches.length > 0) {
          phase = 'attachments';
          const downloadCtx: DownloadContext = {
            max,
            ...(forwarded ? forwarded.download : { chatId, messageId: msg.id }),
            throwOnTransient: !lastTry,
          };
          // withFloodRetry lives INSIDE sendAttachments, around each single send — wrapping the
          // whole call here re-sent the attachments already delivered on a 429 (S2).
          attachIds = await sendAttachments(bot, groupId, topicId, attaches, downloadCtx, undefined, HISTORY_SEND_DELAY_MS, sent, lastTry);
        }
        // One MAX message can become several Telegram messages (text + attachments — confirmed
        // live 2026-08-13 for a forward; a split long text; an album): link them ALL, so a later
        // deletion removes every one instead of orphaning the rest (buildLinkIds).
        const linkIds = buildLinkIds(textIds, attachIds);
        if (linkIds && msg.id != null) messageLinks.add({ maxChatId: chatId, maxMessageId: msg.id, ...linkIds });
        this.strikes.clear(abortKey);
      } catch (err) {
        if (isThreadNotFound(err)) throw err;
        if (isRetriedDeliveryFailure(err)) {
          // On the last try everything pinned on the message has degraded to placeholders already,
          // so a transient error still escaping says Telegram itself is failing: retried like any
          // outage, never given up on (review 2026-09-27, delivery-r3.1#1).
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
 * A group "member event" (CONTROL join/leave) rendered as ONE actionable message: who left / who was
 * added, their MAX ID in the text, and a «✍️ Имя» button per person that opens a 1:1 through the
 * panel's tlmx_panel:startchat:<id> — the same proven path as the roster buttons. Motivation
 * (reported live 2026-09-07): once someone leaves a group they vanish from the roster, and the old
 * rendering — a bare "👤 Имя:" author line + a separate "➖ Участник вышел" label — left no way to
 * reach them from Telegram. Returns undefined when the message isn't such an event (or a join
 * carries no userIds — then the old prefix + label rendering applies; no regression).
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
    // If there's anyone besides us, offer a one-tap "open a DM with a participant" — expands into a
    // button per person (handled by tlmx_roster:open in wireBridge), each reusing the panel's startchat.
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
  /**
   * Cancels the in-flight history sync (server/app.ts's syncAllChatsToTelegram run), waits for it
   * to stop, and holds off new runs until the returned release function is called — /reboot and
   * /kill wrap their wipe in it so the old run can't refill (or recreate) the topics they delete
   * (review 2026-09-26, C7).
   */
  suspendChatSync: () => Promise<() => void>;
  /** MAX auth steps for the in-Telegram /login flow (server/app.ts's maxAuth* functions). */
  auth: MaxAuthCallbacks;
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
}: BridgeOptions): WiredBridge {
  // Bug-report channel: private DMs from outsiders become bug reports. The inbox is only
  // ON where BUGREPORT_INBOX is set (the maintainer's prod bot); everywhere else the flag
  // is unset and outsiders just get a redirect stub to the maintainer's bot. Created before
  // the middlewares so the first one can route private chats into it.
  const bugReportInboxEnabled = isBugReportInboxEnabled();
  const bugReports: BugReports = createBugReports({ bot, targetGroupId, enabled: bugReportInboxEnabled });
  // In-Telegram MAX (re)authorization — a private /login conversation (SMS code + optional 2FA
  // password) — the bridge's only login path, driving server/app.ts's auth steps; runs in DM so code/password stay
  // private, and admin-gated so a stranger can't re-point the bridge at their own MAX account.
  const maxAuth = createMaxAuthFlow({ targetGroupId, auth });

  // Every update Telegraf would otherwise route to a command/action/message
  // handler below passes through here first. /reboot and /kill only gate on
  // typing a confirmation phrase — and that phrase is public (open-source repo,
  // even echoed back in /help) — so without this, anyone who finds the bot on
  // Telegram (a direct DM, or being added to a totally unrelated group) could
  // trigger them, or /newgroup, or anything else. The target group is meant to
  // BE the trust boundary; this is what actually enforces that. poll_answer
  // updates carry no `chat` at all and are separately authorized by their own
  // poll_id lookup (see bot.on('poll_answer') below), so those pass through.
  bot.use(async (ctx, next) => {
    if (ctx.chat && String(ctx.chat.id) !== targetGroupId) {
      // A private DM from an outsider isn't an attack surface — it's a bug report (or a
      // redirect to where reports go). Only non-target GROUPS/channels get the hard reject.
      if (ctx.chat.type === 'private') {
        // The /login auth flow gets first refusal on private updates (it admin-gates internally);
        // anything it doesn't claim falls through to bug reports as before.
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

  // Regular messages/reactions/votes are participation — anyone in the group can do
  // them (adding people to the group for a shared discussion is a legitimate use).
  // But every BOT COMMAND (/kill, /reboot, /login, group management, …) is
  // admin-only: a plain member must not be able to wipe the session, leak the web
  // panel key, or manage MAX groups just by being in the chat. Commands and inline
  // button presses go through here; everything else falls straight through. (The one
  // destructive reaction — 👎-delete — checks isGroupAdmin itself in its handler.)
  bot.use(async (ctx, next) => {
    const text = (ctx.message as { text?: string } | undefined)?.text;
    const isCommand = typeof text === 'string' && text.startsWith('/');
    const isCallback = Boolean(ctx.callbackQuery);
    if (!isCommand && !isCallback) return next();

    const userId = ctx.from?.id;
    if (userId == null) return; // anonymous group post / no sender — fail closed
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
  // and deleted topics are not restored, or the wipe would recreate topics as fast as it deletes
  // them. Nothing is lost: /reboot's resync starts from an empty chat map (full history), /kill logs
  // out of MAX, and a wipe that fails before that point asks for a catch-up run.
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
   * `outgoingCids` and `messageLinks` are both in-memory only, so neither survives a restart —
   * meaning the live-push echo check (handleMaxPush) can't protect a message we just sent
   * Telegram -> MAX if a reconnect/redeploy's catch-up (the cursor-bounded CHAT_HISTORY re-read)
   * runs before any LATER message naturally advances the cursor past it. Without this, that
   * catch-up sees our own just-sent message sitting past the stale cursor and relays it to Telegram
   * a second time — hit live 2026-08-13 testing the sticker relay. So the cursor moves to the sent
   * message's MAX server time after every outgoing send — inside the chat's queue, so it lands
   * after any incoming delivery of that chat still running (which, if it fails, takes the chat out
   * of `caughtUp` first, and the move is then skipped; review 2026-09-26, delivery-r1#0).
   */
  function rememberOutgoingSend(chatId: unknown, cid: number, serverTime: unknown): void {
    outgoingCids.remember(cid);
    lastOutAt = Date.now();
    chatSync.runInChat(chatId, () => chatSync.advanceCursor(chatId, serverTime, 'outgoing send')).catch(() => undefined);
  }

  // Keyed by `${chatId}:${messageId}` -> what we last relayed, so the sticky
  // lastReactedMessageId/lastReaction fields on a CHAT_UPDATE (which repeat
  // across unrelated chat-update pushes) don't re-trigger the same Telegram call.
  // Also doubles as the poll list for reaction *removal* (see below) — keeps the
  // original messageId (BigInt), not just its string form, since MSG_GET_REACTIONS
  // needs the same integer encoding as every other messageId-taking call.
  const lastRelayedReaction = new Map<string, { chatId: unknown; messageId: unknown; emoji: string }>();
  // `${chatId}:${messageId}|${emoji}` pairs Telegram rejected as outside its reaction set
  // (see handleMaxChatUpdate). FIFO-bounded like the other long-lived maps here.
  const rejectedReactions = new Set<string>();
  const REJECTED_REACTIONS_CAP = 200;

  /** Forgets one message's link together with its relayed-reaction entry — once it's deleted on either side nothing should poll or probe it again. */
  function forgetLink(maxChatId: unknown, maxMessageId: unknown): void {
    messageLinks.remove(maxChatId, maxMessageId);
    lastRelayedReaction.delete(`${String(maxChatId)}:${String(maxMessageId)}`);
  }

  /**
   * A linked message is gone (deleted on MAX, or by /delete or 👎): forgets its link, THEN deletes
   * every Telegram message it produced (anchor, extras and notices, plus `alsoIds` — /delete's own target),
   * each on its own so one failure doesn't keep the rest. Forgetting first matters: the deletion
   * probe must never see the copies vanish while the link is still there and mirror-delete on MAX
   * (review 2026-09-26). `why` names the cause in the error log.
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

  // Poll votes arrive as a repeat PUSH_MESSAGE (same messageId, updated attaches[0].state) —
  // same mechanism as text edits, confirmed live 2026-08-10. Telegram's native poll widget has
  // no API for injecting an externally-cast vote, so this dedup gate (by poll `version`) guards
  // a follow-up text message reporting the new tally instead of trying to edit the poll itself.
  // Bounded (FIFO) like every other long-lived map here — the process runs for months.
  const lastRelayedPollVersion = new Map<string, number>();
  const POLL_VERSION_CAP = 500;
  function rememberPollVersion(key: string, version: number): void {
    if (!lastRelayedPollVersion.has(key) && lastRelayedPollVersion.size >= POLL_VERSION_CAP) {
      const oldest = lastRelayedPollVersion.keys().next().value;
      if (oldest !== undefined) lastRelayedPollVersion.delete(oldest);
    }
    lastRelayedPollVersion.set(key, version);
  }

  // MAX sends no live push for reaction removal (see handleMaxChatUpdate below),
  // so this is the only way to notice it — poll each message we know has an
  // active relayed reaction and clear it in Telegram once MAX reports it gone.
  const REACTION_POLL_INTERVAL_MS = 60_000;
  // unref: maintenance timers must not keep the process alive during shutdown.
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
        // REACTION_EMPTY on the clearing call = Telegram found the message but there was
        // no bot reaction to clear — already in the desired state, so stop polling it
        // instead of logging the same error every minute.
        if (classifyProbeResult(telegramErrorText(err)) === 'alive') {
          lastRelayedReaction.delete(key);
          continue;
        }
        logger.error(`Failed to poll MAX reactions for chat ${relayed.chatId} message ${String(relayed.messageId)}`, err);
      }
    }
  }

  /**
   * Deletion probe. Bot API never notifies a bot that a message was deleted, so we
   * poll our OWN relayed messages with an (invisible) setMessageReaction and read the
   * error text: a live message answers REACTION_EMPTY, a deleted one "message to react
   * not found" (classifyProbeResult). A gone message is mirror-deleted on MAX forAll —
   * it's ours — but only after probeLinkGuard and a topic-liveness check rule out that
   * the whole topic went away (ban, chat close, reboot, a topic deleted by hand). Only
   * outgoing messages are watched: MAX->Telegram deletions already arrive as a REMOVED push, and deleting someone else's MAX message for everyone
   * isn't ours to do. The decay ladder (probeIntervalMs) concentrates pings right
   * after send, where ~90% of deletions happen.
   *
   * Shares lastRelayedReaction with the reaction machinery instead of fighting it:
   * if a MAX user reacted to our message, the bot has placed that emoji on the
   * Telegram side, and a bare empty probe would WIPE it. So the probe re-affirms the
   * current relayed reaction ([emoji]) rather than clearing it ([]) — idempotent, so
   * the reaction survives while existence is still checked by the same call.
   */
  const PROBE_TICK_MS = 15_000;
  const PROBE_MAX_PER_TICK = 12; // comfortably under Telegram's ~30 req/s global cap
  const probeLastAt = new Map<string, number>();
  setInterval(() => void runProbeTick(), PROBE_TICK_MS).unref();

  function telegramErrorText(err: unknown): string {
    return String((err as { response?: { description?: string } })?.response?.description ?? (err as Error)?.message ?? '');
  }

  async function probeMessageState(link: MessageLink): Promise<'alive' | 'gone' | 'unknown'> {
    const relayed = lastRelayedReaction.get(`${String(link.maxChatId)}:${String(link.maxMessageId)}`);
    // relayed.emoji is stored in MAX form (it's compared against MAX getReactions in
    // pollReactionRemovals); convert to Telegram's bare form when re-affirming here.
    const reaction = relayed ? [{ type: 'emoji' as const, emoji: toTelegramReaction(relayed.emoji) as TelegramEmoji }] : [];
    try {
      await bot.telegram.setMessageReaction(targetGroupId, link.telegramMessageId, reaction);
      return 'alive'; // ok — the message exists (reaction re-affirmed, or empty no-op accepted)
    } catch (err) {
      const errText = telegramErrorText(err);
      // Telegram rejected the relayed emoji itself (outside its reaction set), which says
      // nothing about the message — retry once with the empty probe before classifying.
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

  /**
   * Is the forum topic still there? Asked only after a message probed 'gone', right
   * before the irreversible forAll delete on MAX: a message that vanished together with
   * its whole topic (deleted by hand in Telegram, raced by a /ban or /reboot) must not
   * take the owner's MAX messages with it. Classified with the same isThreadNotFound
   * that triggers a topic restore (ChatCatchUp.restoreTopic); anything else (429, network) is 'unknown'.
   * NOTE 2026-09-26: that sendChatAction on a deleted topic answers "message thread not
   * found" still needs live confirmation — if it answers ok instead, the check reads
   * 'alive' and we merely degrade to the pre-check behaviour, never worse.
   * Known, accepted side effect: on a live topic this shows «бот печатает…» there for up
   * to ~5 s with no message following — once per owner-side deletion the probe catches.
   * The side-effect-free candidate (editForumTopic with the unchanged name, expecting
   * TOPIC_NOT_MODIFIED) is unconfirmed for deleted topics and would rename back a topic
   * renamed by hand in Telegram if our stored title is stale — so the visible indicator
   * is the deliberate trade-off until one is confirmed live (review 2026-09-26, b1-deletes).
   */
  async function probeTopicState(topicId: number): Promise<'alive' | 'gone' | 'unknown'> {
    try {
      await bot.telegram.sendChatAction(targetGroupId, 'typing', { message_thread_id: topicId });
      return 'alive';
    } catch (err) {
      return isThreadNotFound(telegramErrorText(err)) ? 'gone' : 'unknown';
    }
  }

  async function runProbeTick(): Promise<void> {
    // /reboot or /kill is deleting every topic: each one's messages vanish with it, and a
    // message written into a not-yet-deleted topic during the wipe got a fresh link after the
    // wipe's forgetAllLinks. Nothing here may read that as the owner deleting it (the guard
    // below re-checks per link, since a wipe can start mid-tick) (review 2026-09-26, b1-deletes).
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
    // Entries whose link was evicted from the bounded MessageLinkStore (or removed by a
    // delete) would otherwise sit in probeLastAt forever — prune them each tick.
    for (const key of probeLastAt.keys()) {
      if (!liveKeys.has(key)) probeLastAt.delete(key);
    }
    // Guard against the chat state (mapping, ban, a running wipe) BEFORE and again AFTER the
    // probe: a 'gone' probe deletes on MAX forAll, and a /ban, "Чат закрыт", topic restore,
    // /reboot or /kill can land while the probe call is in flight.
    const guard = async (link: MessageLink): Promise<{ verdict: 'probe' | 'skip' | 'drop'; topicId?: number }> => {
      if (wiping) return { verdict: 'skip' };
      const mapping = await chatMapStore.getByMaxChatId(link.maxChatId);
      return { verdict: probeLinkGuard(link, mapping), topicId: mapping?.telegramTopicId };
    };
    for (const link of due.slice(0, PROBE_MAX_PER_TICK)) {
      const key = `${String(link.maxChatId)}:${String(link.maxMessageId)}`;
      // Already dropped (a forgetChatLinks below, a concurrent /ban, /delete, 👎, a REMOVED
      // push) — checked here and again right before the forAll delete below.
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
      const topicState = await probeTopicState(after.topicId);
      if (topicState === 'gone') {
        // The whole topic went away, not this one message — forget the chat's links so
        // none of them ever reaches the forAll delete below; the topic restore brings
        // the topic back on the next incoming message.
        forgetChatLinks(link.maxChatId);
        logger.info(`probe: Telegram message ${link.telegramMessageId} gone together with topic ${after.topicId} — dropped the chat's links, nothing deleted on MAX`);
        continue;
      }
      if (topicState === 'unknown') continue; // 429/network — keep the link, retry on the ladder
      // Forgotten while the probe calls were in flight (/delete, 👎, a REMOVED push — each forgets
      // the link BEFORE deleting the Telegram copies, which is exactly what the probe then saw
      // vanish): that deletion is already handled — a forAll here would turn a «/delete me» into
      // a delete for everyone (review 2026-09-26, b1-deletes).
      if (messageLinks.getByMax(link.maxChatId, link.maxMessageId) !== link) continue;
      try {
        await max.deleteMessages(link.maxChatId, [link.maxMessageId], false); // forAll — it's ours
        forgetLink(link.maxChatId, link.maxMessageId);
        probeLastAt.delete(key);
        // Its bot notices (a poll's vote hint, tally replies) would stay as replies to nothing
        // (review 2026-09-27, delivery-r3.1#3).
        await deleteBotMessages(bot, targetGroupId, link.noticeTelegramMessageIds ?? [], 'probe-delete notices');
        logger.info(`probe-delete: Telegram message ${link.telegramMessageId} gone -> removed MAX message ${String(link.maxMessageId)} (forAll)`);
      } catch (err) {
        logger.error(`Probe saw Telegram message ${link.telegramMessageId} deleted but failed to mirror-delete on MAX`, err);
      }
      await sleep(200); // space out consecutive mirror-deletes
    }
  }

  // Checked roughly once a day, at a jittered offset rather than a fixed clock
  // time — spreads GitHub API calls out and means a restart doesn't permanently
  // pin the check to the exact minute the container happened to boot.
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

  // A new MAX socket means a gap: whatever arrived while no session was up has to be caught
  // up (ChatCatchUp) before a live message may move any chat's cursor again.
  // 'connected' too, not just 'disconnected': a manual reconnect (session refresh, resume
  // retry) tears the old socket down without emitting 'disconnected' (client.ts teardownSocket).
  max.on('disconnected', () => chatSync.reset());
  max.on('connected', () => chatSync.reset());

  max.on('message', (event: MaxMessageEvent) => {
    if (event.opcode === OPCODES.PUSH_MESSAGE) {
      // handleMaxPush's own try/catch only wraps its final send step — anything
      // thrown earlier (e.g. in forward-sender resolution) was an unhandled
      // rejection that silently vanished. Confirmed live 2026-08-13 while
      // debugging a forwarded FILE attachment that never reached Telegram.
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
      // Deliberate diagnostic, not dead code. Tested live 2026-08-08: never fired for a real
      // reaction from another user — CHAT_UPDATE (handleMaxChatUpdate) is what's actually wired
      // up. Kept so that if it turns out to be conditional (e.g. group chats, a different client
      // version) its payload shape shows up in the normal logs: hence `info`, not `debug` (which
      // the default LOG_LEVEL=info drops); it costs nothing while the opcode never arrives.
      // redactSecrets: an unknown payload shape may carry anything — never log it raw.
      logger.info(`${formatOpcode(event.opcode)} payload:`, jsonStringify(redactSecrets(event.payload)));
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
    const rawChat = (payload as { chat?: unknown } | null)?.chat;
    const chat = rawChat as { id?: unknown; lastReactedMessageId?: unknown; lastReaction?: string } | undefined;
    if (!chat || chat.id == null) return;

    // Not a reaction update → a chat state change (creation/rename/members). If we have a
    // topic for it and this event's full chat object (which carries title/participants)
    // resolves to a real name, rename the topic — fixes freshly-created groups/dialogs
    // that got the "MAX chat <id>" fallback because the chat wasn't yet in cachedChats
    // when their topic was created (the CONTROL 'new' push creates the topic first).
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
      // Telegram only accepts a fixed emoji set (TelegramEmoji); MAX's is presumably wider,
      // so an unsupported one will reject at the API call — caught below, not fatal.
      await bot.telegram.setMessageReaction(targetGroupId, link.telegramMessageId, [
        { type: 'emoji', emoji: toTelegramReaction(chat.lastReaction) as TelegramEmoji },
      ]);
      // Recorded only once Telegram accepted it: the deletion probe re-affirms this exact
      // emoji and pollReactionRemovals clears it, so a rejected (unsupported) emoji must
      // not be remembered — and a transient failure must not mute the next retry.
      lastRelayedReaction.set(key, { chatId: chat.id, messageId: chat.lastReactedMessageId, emoji: chat.lastReaction });
    } catch (err) {
      // lastReaction is sticky across unrelated CHAT_UPDATEs, so an emoji Telegram refuses
      // outright would otherwise be retried (and logged) on every one of them.
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

  /**
   * Reports a poll's new tally as a reply, since Telegram's native poll widget can't be updated with
   * a vote it didn't itself receive. The tally message joins the poll's link as a notice (addNotice), so deleting
   * the poll in MAX takes it along instead of leaving an orphan reply (review 2026-09-26,
   * INBOUND-EDGES4/b5-delivery). Returns its message_id.
   */
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
   * Deliberate fallback + diagnostic for NOTIF_MSG_DELETE — not dead code, though never once
   * observed live (2026-08-13 testing showed deletions actually arrive as a repeat PUSH_MESSAGE
   * with status:"REMOVED" — see handleMaxPush, the real path). Kept in case this opcode does fire
   * in some other scenario (e.g. group chats). Its payload shape is unconfirmed: the field names
   * are a best guess mirroring MSG_DELETE's own request shape, and any other shape is logged
   * (redacted, at info so it shows in default logs) so a real one can be wired up from the log.
   */
  async function handleMaxMessageDelete(payload: unknown): Promise<void> {
    const p = payload as { chatId?: unknown; messageIds?: unknown[] } | null;
    if (p?.chatId == null || !Array.isArray(p.messageIds)) {
      // redactSecrets: an unrecognized shape may carry anything — never log it raw.
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
   * Real-time "phone is ringing" notification — actually placing/joining the call needs WebRTC, out
   * of scope for a Bot API bridge, so this is notification-only.
   * Delivered like a push (the chat's queue, its topic opened and caught up first): a call can be
   * a new contact's first sign of life, and the topic it used to open on its own skipped the
   * catch-up bookkeeping — the chat's cursor then stayed null all session and the next restart
   * replayed everything relayed since — as well as the info card and the /reboot-/kill wipe and
   * /ban checks (review 2026-09-26, catchup-r1#2).
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
   * Renames a topic stuck on a fallback title («MAX chat <id>») the moment the contact's
   * profile becomes known — the auto-card's CONTACT_INFO fetch is exactly that moment.
   * Closes the race where a fresh dialog's CHAT_UPDATE arrives BEFORE the profile is
   * cached: the retro-rename in handleMaxChatUpdate then resolves a fallback name and
   * correctly skips, and no later trigger fires if the contact doesn't write again
   * (seen live on prod 2026-09-22: topic stayed «MAX chat 484245649» while the pinned
   * card already showed the person's name).
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
      // A 1:1 created via createDialog comes back typed CHAT, not DIALOG (a 2-participant
      // chat with no title is a dialog). Render it as a contact card, not a generic group
      // card — fetching the contact profile if it isn't cached yet, so the card shows the
      // person's name/phone instead of "MAX chat <id>" / "Тип: CHAT".
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
   * Runs `send` against the chat's topic — inside the chat's queue, after openTopic. If that topic
   * was deleted out from under us (the user removed it in Telegram), recreates it and restores the
   * full chat history into the fresh topic instead of re-sending just this one message — without
   * this, deleting a topic silently black-holes every future message from that MAX contact
   * (reported live 2026-08-15). Any other delivery failure is reported to the group (throttled,
   * 'tg-deliver') and rethrown.
   */
  async function sendToTopic(chatId: unknown, topicId: number, send: (topicId: number) => Promise<void>): Promise<void> {
    try {
      await send(topicId);
    } catch (err) {
      if (!isThreadNotFound(err)) {
        // A real delivery failure (bot lost its rights, Telegram unreachable, …) —
        // tell the operator, throttled so a stuck chat can't spam the group.
        reportBridgeError(
          'tg-deliver',
          `⚠️ Не удаётся доставить сообщение в Telegram: ${(err as Error).message}. Проверьте права бота и связь с Telegram.`,
        );
        throw err;
      }
      // Don't re-send `send` here: the triggering message is already part of the
      // history the restore replays, so a separate send would duplicate it.
      await chatSync.restoreTopic(chatId);
    }
  }

  /**
   * A MAX edit that could not be applied to the anchor in place. Only logging it lost the edit
   * silently — every caption added to a 1:1 photo (its anchor is the photo: "there is no text in the
   * message to edit"), and any edit hit by a Telegram hiccup (review 2026-09-26, delivery-r1#9). A
   * media anchor gets the text as its caption when it fits; otherwise the edit goes out as a reply to
   * the anchor, joined to the message's link as a notice (addNotice) so a deletion in MAX takes it along. The
   * same text again ("message is not modified") needs nothing, and an outgoing link's copy is the
   * owner's own Telegram message — nothing the bot could edit or should answer.
   */
  async function relayEditFallback(chatId: unknown, maxMessageId: unknown, link: MessageLink, marked: string, err: unknown): Promise<void> {
    const errText = telegramErrorText(err);
    if (/message is not modified/i.test(errText)) return;
    // The owner deleted the copy in Telegram: bringing the content back as a reply would undo that
    // (review 2026-09-27, delivery-r3.1#4).
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
    // message sent from Telegram comes as a REMOVED repeat push carrying the same cid, and dropping
    // it here left the Telegram copy (and its link) behind for good (review 2026-09-26,
    // delivery-r1#4). An EDITED repeat stays dropped — that copy is the owner's own Telegram
    // message, which the bot cannot edit, and our own Telegram-side edits come back that way too.
    if (message.cid != null && outgoingCids.has(message.cid) && message.status !== 'REMOVED') return;
    // Banned chat (/ban): drop everything for it — no mirror, no topic recreate.
    const banCheck = await chatMapStore.getByMaxChatId(chatId);
    if (banCheck?.banned) return;

    let text = message.text;
    let attaches = Array.isArray(message.attaches) ? message.attaches : [];
    // Chat deletion: MAX signals it as a PUSH_MESSAGE carrying a CONTROL attach with
    // event:"system" and message "Чат закрыт" (confirmed live 2026-08-17 — NOT a
    // CHAT_UPDATE status:CLOSED as first assumed). Mirror it: delete the Telegram topic
    // and drop the mapping. Other "system" events (e.g. a history clear) carry different
    // text and fall through to the relay-skip in sendAttachments.
    const controlAttach = (attaches as Array<{ _type?: string; event?: string; message?: string; shortMessage?: string }>).find(
      (a) => a?._type === 'CONTROL',
    );
    if (controlAttach?.event === 'system' && /закрыт/i.test(String(controlAttach.message ?? controlAttach.shortMessage ?? ''))) {
      if (banCheck) {
        // Links first: the topic deletion takes every message with it, and the deletion
        // probe must not read that as the owner deleting them (review 2026-09-26).
        forgetChatLinks(chatId);
        await bot.telegram
          .deleteForumTopic(targetGroupId, banCheck.telegramTopicId)
          .catch((err) => logger.error('Failed to delete Telegram topic on MAX chat deletion', err));
        await chatMapStore.remove(chatId);
        logger.info(`MAX chat ${String(chatId)} deleted ("Чат закрыт") — removed Telegram topic ${banCheck.telegramTopicId}`);
      }
      return;
    }
    // Edits AND deletions both arrive as a repeat PUSH_MESSAGE carrying the SAME
    // message.id — not separate opcodes. Distinguished only by `status`: "EDITED"
    // vs "REMOVED" (undefined/absent means a genuinely new message). Confirmed by
    // the user's own protocol docs 2026-08-13 — NOTIF_MSG_DELETE (handleMaxMessageDelete
    // below) is apparently not how MAX actually signals a deletion; kept as a
    // fallback in case it fires in some other scenario, but this is the real path.
    if (message.status === 'REMOVED') {
      if (message.id == null || !banCheck) return;
      // The chat is caught up first: a message relayed by that catch-up moments ago (it arrived
      // while the bridge was offline) has its link by now, so the deletion finds it. A deletion
      // for a message we hold no link for (relayed before a restart, evicted) has nothing to delete.
      await chatSync.ensureCaughtUp(chatId).catch((err) => onLiveDeliveryFailed(chatId, err, 'Catch-up before a MAX deletion'));
      const link = messageLinks.getByMax(chatId, message.id);
      // Dead link: nothing may poll its reactions or probe it any more — dropLinkedMessage
      // forgets it before the Telegram copies go, so the deletion probe can't re-delete on MAX.
      if (link) await dropLinkedMessage(link, `MAX deletion of message ${String(message.id)}`);
      return;
    }
    // Everything below writes into the chat's topic: open it (created on first contact, with its
    // info card) and catch the chat up first (ChatCatchUp) — so a message that arrived while the
    // bridge was offline goes out before this one, and this one, if that catch-up already relayed
    // it, is found linked below and not sent twice.
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

    // A forward we RECEIVE: its real content, sender prefix and download ids (the source
    // message/chat, with our dialog with the forwarder as the fallback) — resolveForwardContent.
    const forwarded = await resolveForwardContent(max, getChats(), message.link, chatId, message.id, getContactProfiles());
    if (forwarded) {
      text = forwarded.text;
      attaches = forwarded.attaches;
    }
    // Whether the message has text of its own, before any forward/reply prefix: an orphan edit
    // without it has nothing worth posting (delivery-r1#3, see below).
    const hasOwnText = Boolean(forwarded ? message.link?.message?.text : message.text);

    // A reply we RECEIVE: link.type==='REPLY', link.message is the FULL quoted message
    // (its id is link.message.id — the incoming shape carries `message`, unlike the
    // OUTGOING reply which carries `messageId`). Prefer a NATIVE Telegram reply (a jump
    // to the original) by resolving the quoted MAX message to its Telegram id via the
    // link store; fall back to a text-quote prefix only when it isn't there (the store is
    // in-memory, lost on restart / bounded to the last 500).
    let replyParameters: { message_id: number; allow_sending_without_reply: boolean } | undefined;
    if (message.link?.type === 'REPLY') {
      const quotedId = message.link.message?.id;
      const linked = quotedId != null ? messageLinks.getByMax(chatId, quotedId) : undefined;
      if (linked) {
        replyParameters = { message_id: linked.telegramMessageId, allow_sending_without_reply: true };
      } else {
        const quotedText = typeof message.link.message?.text === 'string' ? message.link.message.text : '';
        // Cut by code points: a UTF-16 slice could end inside an emoji's surrogate pair, and
        // Telegram refuses the whole message over the lone half (review 2026-09-26, INBOUND-EDGES5).
        const snippet = quotedText ? `«${truncateCodePoints(quotedText, 80, '…')}»` : 'сообщение';
        const prefix = `↩️ В ответ на ${snippet}:`;
        text = text ? `${prefix}\n${text}` : prefix;
      }
    }

    const existingLink = message.id != null ? messageLinks.getByMax(chatId, message.id) : undefined;
    if (existingLink) {
      // A repeat push carrying a POLL is a tally update (relayed below), not a text edit — and the
      // link's anchor is then the poll itself or its text rendering (INBOUND-EDGES4), which an
      // edit marker must not overwrite.
      const isPollUpdate = attaches.some((a) => (a as MaxAttachment)._type === 'POLL');
      // A new message already in Telegram: the catch-up above relayed it moments ago — including a
      // poll (as its text rendering), whose own push would otherwise post a tally of zero votes.
      const hasVotes = attaches.some((a) => (a as MaxAttachment)._type === 'POLL' && (a as MaxAttachment).state?.result?.some((r) => (r.voteCount ?? 0) > 0));
      if (message.status == null && !hasVotes) return;
      if (text != null && !isPollUpdate) {
        // Telegram never shows its own "edited" tag on bot-edited messages (deliberate
        // Bot API behavior — bots edit constantly for live UIs), so mark the edit in the
        // text itself. Group messages get the marker fused with the author prefix
        // ("✏️ 👤 Имя:"), which the plain-relay path adds much further down and this
        // early-return branch used to LOSE entirely — an edited group message silently
        // dropped its author line. 1:1 gets an explicit "✏️ изменено: ". No stacking on
        // repeated edits: MAX sends the full fresh text each time, we rebuild from it.
        const editedChat = getChats().find((c) => c && typeof c === 'object' && String((c as { id?: unknown }).id) === String(chatId));
        const editAuthorPrefix = await resolveAuthorPrefix(editedChat, message.sender, getMyAccountId(), max, getContactProfiles());
        // Receipt time ≈ edit time (edit pushes arrive live); MAX's own payload carries no
        // confirmed edit-timestamp field. Timezone mirrors the client's default (Europe/Moscow),
        // overridable via TZ — the container itself runs on UTC, which would look wrong.
        const editedAt = new Intl.DateTimeFormat('ru-RU', { hour: '2-digit', minute: '2-digit', timeZone: process.env.TZ || 'Europe/Moscow' }).format(new Date());
        let marked = editAuthorPrefix ? `✏️ (${editedAt}) ${editAuthorPrefix}${text}` : `✏️ изменено в ${editedAt}:\n${text}`;
        // Known limitation (review 2026-09-26, INBOUND-EDGES2): an edit only rewrites the ANCHOR
        // message. A long text relayed as several pieces keeps its later pieces as they were, and
        // an edited text over Telegram's 4096 limit is cut to fit (marked with «…») — the link
        // doesn't record which extra ids are text pieces and which are attachments, so re-splitting
        // the edit across them isn't possible.
        if (marked.length > TELEGRAM_TEXT_LIMIT) {
          logger.info(`MAX edit of message ${String(message.id)} is ${marked.length} chars — only its first ${TELEGRAM_TEXT_LIMIT} fit into the edited Telegram message`);
          marked = `${truncateUtf16(marked, TELEGRAM_TEXT_LIMIT - 1)}…`;
        }
        try {
          await bot.telegram.editMessageText(targetGroupId, existingLink.telegramMessageId, undefined, marked);
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
    // An EDIT of a message we hold no link for (relayed before a restart, evicted from the
    // 500-link store) has no Telegram message to rewrite. Falling through relayed it as if it
    // were NEW — unmarked, attachments downloaded and posted again, a poll re-created on every
    // vote (review 2026-09-26, INBOUND-EDGES3). Post only its fresh text, marked as an edit of an
    // older message, linked like any message (later edits and deletions then find it); attachments
    // are not re-sent, and it doesn't move the history cursor (it isn't a new message in the
    // chat's history). No text of its own — nothing worth posting: a forward or reply prefix
    // alone used to go out as a stub with no content (review 2026-09-26, delivery-r1#3).
    const orphanEdit = message.status === 'EDITED';
    if (orphanEdit) {
      if (!hasOwnText) {
        logger.info(`Skipped an edit of MAX message ${String(message.id)} in chat ${String(chatId)}: no link to it and no text to show`);
        return;
      }
      attaches = [];
    }

    // Nothing to RENDER — no text AND every attach is a non-rendered CONTROL/service event.
    // Don't fall through to the author prefix below (it would post a bare "👤 Имя:" — the 0.4.6
    // fix). BUT a service event can be the FIRST live signal of a chat we were just added to,
    // and creating its topic is the ONLY way a group appears live: CHAT_UPDATE never creates a
    // topic (handleMaxChatUpdate returns early when there's no mapping), so without this the
    // group stays invisible until a reconnect's full resync runs. Before 0.4.6 the relay path
    // created the topic as a side effect of this same push; 0.4.6's early return killed that
    // (regression: "добавили в группу, а она не появляется" — reported live 2026-08-24). openTopic
    // above has created it (empty — nothing posted inside, no bare prefix). Log the attach types
    // (never the content) so a recurrence is self-diagnosing.
    if (!text && !attaches.some((a) => isRenderableAttach(a as MaxAttachment))) {
      if (attaches.length > 0) {
        const kinds = attaches
          .map((a) => `${(a as MaxAttachment)._type}${(a as { event?: unknown }).event ? `/${String((a as { event?: unknown }).event)}` : ''}${Array.isArray((a as MaxAttachment).userIds) ? '+userIds' : ''}`)
          .join(',');
        logger.info(`Skipped a non-renderable MAX message in chat ${String(chatId)} (attach: ${kinds})`);
      }
      return;
    }

    // A join/leave event becomes ONE actionable message (who + MAX ID + a «✍️» button to DM them) and
    // consumes the attach, so the bare "➖ Участник вышел" label isn't posted as a second bubble.
    // Resolved before the poll branch below, which needs the same author prefix (a group poll
    // used to arrive with no word of who created it — review 2026-09-26, INBOUND-EDGES4).
    let memberMarkup: InlineMarkup | undefined;
    const memberEvent = await renderMemberEvent(attaches as MaxAttachment[], text, message.sender, getMyAccountId(), max, getContactProfiles());
    if (memberEvent) {
      text = memberEvent.text;
      attaches = [];
      memberMarkup = memberEvent.markup;
    } else {
      // Group chats: prefix the author so the topic isn't an anonymous stream (1:1 needs none). For an
      // attachment-only group message the prefix becomes the text, so the file still shows who sent it.
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
          // Whatever the regular path would say around it — a group author, a forward's source, a
          // reply quote, the message's own text — goes first as text, carrying the native reply;
          // sendPoll itself has no room for any of it (review 2026-09-26, INBOUND-EDGES4).
          // Every part as it goes out (header, poll, text fallback): a transient failure anywhere
          // deletes them again, since the catch-up re-delivers the whole message
          // (discardPartialDelivery). The header and the fallback used to sit outside that cleanup
          // and stayed behind as unlinked duplicates (review 2026-09-26, delivery-r1#1).
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
              // Telegram's poll limits are tighter than MAX's (question ≤300, options 2–10 of ≤100
              // chars): a refused poll used to vanish whole. Render it as text instead.
              if (!isPermanentTelegramRefusal(err)) throw err;
              logger.error(`Telegram refused MAX poll ${String(pollAttach.pollId)} as a native poll — relaying it as text`, err);
            }
            if (sentPoll) {
              const pollMessageId = sentPoll.message_id;
              sent.push(pollMessageId);
              logger.info(`Relayed MAX poll "${pollAttach.title}" (pollId=${String(pollAttach.pollId)}) to Telegram topic ${topicId}`);
              // MAX sends no push for votes, and Telegram's native poll widget has no API for
              // injecting one cast on MAX's side — so it will never reflect those on its own. An
              // anonymous poll doesn't work the other way either: Telegram sends a bot no
              // poll_answer for it, so votes cast here never reach MAX (OUTBOUND8) — say so.
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
              // The poll stays the anchor (poll updates and /poll reply to it); the header is an extra
              // and the reminder a notice (delivery-r2#0), so a deletion in MAX takes them along
              // instead of orphaning them.
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
          // Advance the backfill cursor so a reconnect's catch-up doesn't re-post this poll.
          await chatSync.advanceCursor(chatId, message.time, 'incoming poll');
          // A freshly created Telegram poll always starts at zero — there's no Bot API
          // way to pre-seed a vote — so if the creator (or anyone) already voted by the
          // time this push arrived (e.g. a client that auto-votes the creator's pick),
          // that tally is otherwise invisible on the Telegram side. Report it right away.
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
        // A text over Telegram's 4096 limit goes out as several messages instead of being refused
        // whole (review 2026-09-26, INBOUND-EDGES2).
        // Every part as it goes out: a transient failure halfway deletes them again, since the
        // catch-up re-delivers the whole message (discardPartialDelivery).
        const sent: number[] = [];
        try {
          const textIds = text ? await sendTextPieces(bot, targetGroupId, topicId, text, { replyParameters, replyMarkup: memberMarkup, sent }) : [];
          let attachIds: number[] = [];
          if (attaches.length > 0) {
            // NOT `telegramMessageId ??= await sendAttachments(...)` — `??=` short-circuits
            // and never even CALLS sendAttachments when telegramMessageId is already set,
            // which it always is for a forward (the "↩️ Переслано из..." prefix always
            // produces text, even when the original was attachment-only). That silently
            // dropped every forwarded attachment with no error anywhere (root-caused live
            // 2026-08-13 after the catch-up path — which calls sendAttachments
            // unconditionally — kept delivering the same messages fine).
            const downloadCtx: DownloadContext = { max, ...(forwarded ? forwarded.download : { chatId, messageId: message.id }) };
            // The reply goes on the text message when there is one; only a media-only reply
            // threads reply_parameters into the first attachment.
            attachIds = await sendAttachments(bot, targetGroupId, topicId, attaches, downloadCtx, textIds.length > 0 ? undefined : replyParameters, undefined, sent);
          }
          // One MAX message can become several Telegram messages (text + attachments — confirmed
          // live 2026-08-13 for a forward; a split long text; an album): link them ALL, so a later
          // deletion removes every one instead of orphaning the rest (buildLinkIds).
          const linkIds = buildLinkIds(textIds, attachIds);
          if (linkIds) {
            messageLinks.add({ maxChatId: chatId, maxMessageId: message.id, ...linkIds });
            lastInAt = Date.now();
            // Advance the backfill cursor for this live incoming message. Without it, a MAX
            // reconnect's catch-up re-reads the message (it sits past the stale cursor) and
            // relays it to Telegram a SECOND time — the mirror image of the rememberOutgoingSend
            // fix for the Telegram -> MAX direction (advanceCursor has the caught-up gate).
            // An orphan edit is no new message in the history — it leaves the cursor alone.
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
   * A live MAX -> Telegram delivery failed. On a transient failure (Telegram/proxy unreachable,
   * 5xx, flood limit, the MAX socket gone mid-restore) the message still sits in MAX's history
   * above the chat's cursor — keep it reachable: take the chat out of `caughtUp`, so later live
   * messages that DO get through stop moving its cursor past it, and ask for a catch-up run, which
   * re-delivers it once Telegram answers again (it probes first and backs off, so an outage
   * doesn't spin). Before this the next delivered message moved the cursor past everything lost
   * in the outage (review 2026-09-26, RECOVERY5). A permanent (4xx) refusal would fail the same
   * way on every retry — logged only. A chat banned meanwhile is left alone.
   */
  function onLiveDeliveryFailed(chatId: unknown, err: unknown, what: string): void {
    if (err instanceof SyncCancelledError) return; // /reboot or /kill stopped it on purpose
    if (err instanceof ChatBannedError) {
      logger.info(`${what}: MAX chat ${String(chatId)} was banned meanwhile — left alone`);
      return;
    }
    logger.error(`${what} failed`, err);
    if (!isRetriedDeliveryFailure(err) && !isTransientMaxError(err)) return;
    chatSync.markDirty(chatId);
    logger.info(`MAX chat ${String(chatId)}: live delivery failed transiently — its cursor stays put until a catch-up re-delivers the message`);
    chatSync.requestRetry(`live delivery for MAX chat ${String(chatId)} failed`);
  }

  /**
   * Is the chat behind this topic a 1:1, and what do we call the other side? The MAX group commands
   * below never asked: in a DIALOG topic /rename, /setdesc, /invite, /kick and /leavegroup are
   * meaningless (the user just got an opaque MAX error), and /deletegroup ВСЕМ — whose confirmation
   * talks about «группу» and «участников» — actually wipes the conversation for the person on the
   * other end. Falls back to "not a dialog" when the chat isn't in the cache yet: that only ever
   * loosens a guard on a genuine group, never tightens one into deleting someone's history.
   */
  function describeTopicChat(maxChatId: string): { isDialog: boolean; name: string } {
    const { chat, otherId, profile } = resolveDialogContact(maxChatId);
    const participants = chat?.participants ? Object.keys(chat.participants).length : undefined;
    // A real MAX GROUP can legitimately have two members; treating every 2-participant chat as a 1:1
    // made /invite, /kick, /rename, /setdesc and /leavegroup refuse in it forever, and made
    // /deletegroup call it «личная переписка». Trust the declared type; fall back to the participant
    // count only when the chat isn't in the cache yet (conservative: an unknown 2-person chat is
    // treated as a dialog, which only ever adds a warning, never removes one).
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
   * An update marker only means "an update is really in flight" while it's FRESH. update.sh clears
   * update-in-progress in an EXIT trap, but a SIGKILL, an OOM or a reboot mid-build skips the trap;
   * and update-requested is only ever consumed by the host watcher — which doesn't exist at all on an
   * install set up without root, or belongs to a different bridge on a multi-instance host. In both
   * cases the leftover file latched the «Обновить» button permanently: every later press answered
   * "Обновление уже запущено — дождитесь сообщения о завершении", and no message was ever coming.
   * Nothing in the codebase deleted either marker, so the only cure was `rm` over SSH. A marker older
   * than the window below is treated as abandoned and removed, so the next press works.
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
    // Guard against re-triggering while one is already in flight: a fresh /version
    // still shows a live "Обновить" button even mid-update (the container hasn't been
    // rebuilt yet, so it still looks out-of-date). update-requested = queued but not
    // yet picked up by the host watcher; update-in-progress = update.sh is running.
    // flock in update-watcher.sh is the hard backstop; this is the friendly heads-up.
    // Age-checked, not just existence-checked: see markerActive — a stale marker used to make
    // this button answer "уже запущено" forever, with the message it promises never arriving.
    if ((await markerActive(UPDATE_REQUESTED_MARKER)) || (await markerActive(UPDATE_IN_PROGRESS_MARKER))) {
      await ctx.answerCbQuery('Обновление уже идёт');
      await ctx.editMessageText('⏳ Обновление уже запущено — дождитесь сообщения о завершении.').catch(() => {});
      return;
    }
    // Is anything on the host actually going to pick this up? The marker is consumed only by the
    // update dispatcher, which doesn't exist when setup.sh ran without root — and before 0.6.4 a
    // second bridge on the same host had no updater either. Writing a marker nobody reads produced a
    // cheerful «⏳ Обновление запрошено» and then nothing, forever.
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

  bot.action('tlmx_dismiss', async (ctx) => {
    await ctx.answerCbQuery('Ок');
    await ctx.editMessageText('⏰ Отложено — напомню при следующей ежедневной проверке.');
  });

  // /ban — mute a MAX chat: pick it from a button list, and its incoming messages
  // stop being mirrored (its topic is deleted). Persistent (survives restart) and
  // reversible via /unban. Distinct from just deleting a topic by hand, which is now
  // auto-healed instead — /ban is the deliberate "I don't want this contact" switch.
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
    // Links first: deleting the topic deletes our messages in it, and the deletion probe
    // would otherwise mirror-delete them on MAX forAll (review 2026-09-26).
    forgetChatLinks(maxChatId);
    if (mapping) {
      await bot.telegram.deleteForumTopic(targetGroupId, mapping.telegramTopicId).catch((err) => logger.error('Failed to delete topic on ban', err));
    }
    await ctx.answerCbQuery('Забанен');
    await ctx.editMessageText(`🚫 Забанен: ${mapping?.title ?? maxChatId}. Сообщения больше не приходят. Вернуть — /unban.`).catch(() => {});
  });

  // /unban — reverse a ban. Just flips the flag; the topic comes back on the next
  // incoming message from that chat (the recreate-on-thread-not-found path handles it).
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

  // --- Control panel (src/bridge/panel.ts): a pinned inline-button menu in the group's
  // General topic. The reused leaves (help/version/ban/unban) delegate to
  // the same logic the slash commands use; startDialog creates a MAX dialog + its topic.
  const startDialog = async (
    recipientUserId: string,
    name: string,
  ): Promise<{ ok: boolean; error?: string; topicName: string; chatLink?: string; existed?: boolean }> => {
    try {
      // Reuse an existing 1:1 dialog with this contact instead of creating a duplicate —
      // MAX happily makes a second dialog for the same pair otherwise. A dialog is the
      // chat whose participants are exactly {me, contact}.
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
      // createDialog CONTROL hack was exactly this bug). Instead map the topic to a
      // "pending:<userId>" sentinel; the first outbound message opens the real 1:1 dialog via
      // max.sendToNewDialog and rewrites the mapping (see the pending branch in the relay below).
      // This mirrors the app's "Открыть чат" — the dialog only exists once you send. An existing
      // 1:1 is reused by its real id as before.
      const chatId = existed ? (existing as { id?: unknown }).id : `pending:${recipientUserId}`;
      // Inside the chat's queue, like every other writer of its topic (ChatCatchUp).
      let finalTopicId: number | undefined;
      await chatSync.runInChat(chatId, async () => {
        const ensured = await ensureTopicForMaxChat(bot, targetGroupId, chatId, chatMapStore, name);
        finalTopicId = ensured.topicId;
        let created = ensured.created;
        // A reused mapping can point to a topic the operator deleted in Telegram. The relay
        // path self-heals on the next message (the isThreadNotFound catch in sendToTopic),
        // but startDialog only builds a deep link and never writes to the topic — so without
        // this it hands back a dead link and never recreates (reported live 2026-08-18: find
        // contact -> start chat -> delete the topic in TG -> find again -> "Открыть чат" led
        // nowhere). Probe with a no-op rename: topic alive -> harmless; gone -> recreate it
        // named after the contact. recreateTopicForChat would reuse the stale mapping's
        // fallback title ("CHAT -<id>"), so recreate explicitly with `name`.
        if (!created) {
          try {
            await bot.telegram.editForumTopic(targetGroupId, finalTopicId, { name });
          } catch (err) {
            if (isThreadNotFound(err)) {
              await chatMapStore.remove(chatId);
              finalTopicId = (await ensureTopicForMaxChat(bot, targetGroupId, chatId, chatMapStore, name)).topicId;
              created = true;
              // The fresh mapping has no cursor: the next write into the empty topic refills it with the whole history first.
              chatSync.markDirty(chatId);
            }
            // Any other error (e.g. Telegram "topic not modified" when the name is unchanged)
            // just means the topic is alive — keep the existing id.
          }
        }
        // Freshly created or recreated -> give it the pinned contact-info card. A createDialog
        // 1:1 comes back typed CHAT (not DIALOG), which sendAutoInfoCard now renders as a
        // proper contact card; passing recipientUserId as the sender hint covers the case
        // where the new chat isn't in cachedChats yet.
        if (created) {
          await sendAutoInfoCard(chatId, recipientUserId, finalTopicId).catch((e) =>
            logger.error('Failed to send contact-info card on startDialog', e),
          );
        }
        // Fresh contact: flag the mapping as a pending dialog so the first outbound message opens the
        // real 1:1 via max.sendToNewDialog. Done here (after the liveness probe may have recreated the
        // mapping) so pendingUserId survives on the final entry.
        if (!existed) {
          const pending = await chatMapStore.getByMaxChatId(chatId);
          if (pending) await chatMapStore.upsert({ ...pending, pendingUserId: String(recipientUserId) });
        }
      });
      if (finalTopicId == null) return { ok: false, error: 'идёт /reboot или /kill — подождите', topicName: name };
      // Deep link that opens the topic in the user's Telegram (private supergroup form:
      // strip the -100 prefix). The bot can't force-switch the client, but this is one tap.
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
    // Warm-cache name lookup for the group-roster "Открыть личку" button — buildRoster already
    // fetched every participant's profile, so this resolves instantly with no MAX round-trip
    // (undefined on a genuine miss, which lets the panel fall back to a CONTACT_INFO lookup).
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
        // checkVersion() never throws — every fetcher catches internally and a FAILED check comes back
        // as `latest: null`. Passing that through rendered the reassuring "Обновление: актуальная
        // версия" while nothing had actually been checked (and made the catch below dead code).
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

  // "💬 Открыть личку" on a group's roster card → expands into a button per participant. Each reuses
  // the panel's tlmx_panel:startchat:<uid> (which opens/reuses the 1:1 via startDialog). Participants
  // are derived from the chat of the topic the card lives in — nothing is encoded in the button.
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
   * Re-fetches a poll's message from CHAT_HISTORY and posts its current tally as a reply. Throws if
   * the poll/mapping can't be found — callers decide whether that's worth surfacing. The reply joins
   * the poll's link as a notice (addNotice) like relayPollUpdate's, so deleting the poll in MAX takes it along
   * instead of leaving an orphan (review 2026-09-26, delivery-r1#8).
   */
  async function postPollResults(maxChatId: unknown, maxMessageId: unknown, telegramMessageId: number): Promise<void> {
    const mapping = await chatMapStore.getByMaxChatId(maxChatId);
    if (!mapping) throw new Error(`No Telegram topic mapped for MAX chat ${String(maxChatId)}`);
    // Paged back (up to 1000 messages): a poll replayed by a backfill is often far older than the
    // newest batch, and its text tells the owner to /poll it (review 2026-09-27, delivery-r3.3#2).
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
    const replyTo = (ctx.message as { reply_to_message?: { message_id: number } }).reply_to_message;
    if (!replyTo) {
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
    // The command is NAMED for groups, but nothing stopped it running in a 1:1 topic — where
    // «удалить для всех участников» quietly means "wipe this conversation for the person I'm
    // talking to". Deleting a dialog for both sides is a legitimate messenger feature (MAX has it),
    // so it stays available — but the confirmation must name the human it will hit.
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
    // `Number(null)` is 0, not NaN — a chat missing from the cache slipped through the isNaN check
    // and sent MAX lastEventTime: 0.
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
   * The shared core of /reboot and /kill: stops everything that writes topics, deletes every
   * topic and wipes all local MAX<->Telegram state (the persisted chat map, the in-memory
   * message/poll links, the catch-up state). `startText` is the progress notice for N topics.
   * `finish` runs afterwards with syncs still held off; it calls `resume` once they may run again
   * (/reboot, right before its resync) — otherwise they resume when it returns. A failure
   * anywhere is logged and reported to the group as «Не удалось выполнить <command>.».
   * Only one wipe at a time: a second confirmation while one runs would interleave two deletion
   * loops, so it just gets a "wait" notice.
   * The wipe runs in the background: one topic per ~1.1 s outlasts telegraf's 90 s
   * handlerTimeout at ~80 topics, and a timed-out handler used to stop Telegram polling
   * (review 2026-09-26, C2). Progress and the result still go to the group.
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
      // Idempotent: /reboot's finish resumes early and the finally below resumes again — the
      // second call must not clear `wiping` for a /kill accepted in between (review 2026-09-26, b8-cleanup).
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
        // Stop everything that writes topics first — a history sync still walking its old chat
        // snapshot, a topic restore — and hold new syncs off until the wipe is done. Otherwise the
        // old run kept refilling the topics being deleted (and /reboot's resync collapsed into
        // it, leaving the chats it had already passed without topics; /kill's came back, cards
        // and all, after the «стёрто» confirmation) (review 2026-09-26, C7).
        wiping = true;
        releaseSync = await suspendChatSync();
        // Then every chat queue drains: jobs not yet started return at once on `wiping`, a running
        // backfill (a restore, a push's catch-up) stops at its next message. A live push that passed
        // its `wiping` check just before may still be creating its topic: its mapping would land
        // after the snapshot below and clear() would orphan the topic (review 2026-09-27, catchup-r3.1#0).
        await chatSync.drain();
        const mappings = await chatMapStore.list();
        // Only a progress notice: a flood wait or a network blip here must not fail the wipe.
        await withFloodRetry(() => bot.telegram.sendMessage(targetGroupId, startText(mappings.length))).catch((err) =>
          logger.error(`Failed to post the ${command} start notice`, err),
        );
        // Links BEFORE the topics: the deletion loop is slow (one topic per ~1.1s) and the
        // deletion probe would read each vanished topic's messages as deleted by the owner
        // and mirror-delete them on MAX forAll (review 2026-09-26).
        forgetAllLinks();
        for (const mapping of mappings) {
          await withFloodRetry(() => bot.telegram.deleteForumTopic(targetGroupId, mapping.telegramTopicId)).catch((err) => {
            logger.error(`Failed to delete Telegram topic ${mapping.telegramTopicId} during ${command}`, err);
          });
          await sleep(HISTORY_SEND_DELAY_MS);
        }
        // Again after the loop: a message written into a topic not yet deleted got a fresh link
        // meanwhile (the Telegram -> MAX relay keeps running during the wipe). Before the map goes,
        // so no probe ever sees such a link with its mapping still in place.
        forgetAllLinks();
        await chatMapStore.clear();
        // Every cursor went with the map: no chat is caught up until a resync backfills it (ChatCatchUp).
        chatSync.reset();
        stateWiped = true;
        await finish(resume);
      } catch (err) {
        logger.error(`${command === 'reboot' ? 'Reboot' : 'Kill'} failed`, err);
        if (!stateWiped) {
          // Pushes were dropped while `wiping` was set (handleMaxPush, calls, restores), and the
          // chats they belong to were still caught up: their next live message moved the cursor
          // past the dropped ones — lost for good. With nothing caught up the cursors stay put
          // until the catch-up run requested here (it starts once the hold is released) fetches
          // them (review 2026-09-26, catchup-r2#1).
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
   * Beyond everything /reboot wipes, this also logs the bridge OUT of MAX: deletes
   * the encrypted session file (server/app.ts's killEverything), so a fresh SMS
   * login (/login in the bot's DM) is required before the bridge can do anything again.
   * MAX exposes no logout/revoke opcode (checked 2026-09-11), so this can only drop OUR
   * copy of the session and disconnect — the session token itself stays valid on MAX's
   * side until it expires. The texts below say so and point at the app's device list;
   * don't promise a server-side logout. The process keeps running so /login can
   * re-authenticate.
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
    // Syncs stay held off until MAX is logged out: after killEverything the chat list is empty
    // and MAX is disconnected, so a sync has nothing left to recreate.
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
      // Typed in General — there's no mapped MAX chat to delete from, and silence
      // here already cost a debugging session (2026-08-14), so say so.
      await bot.telegram.sendMessage(targetGroupId, '/delete работает только внутри темы чата — ответьте им на сообщение, которое нужно удалить.').catch(() => {});
      return;
    }
    const replyTo = (ctx.message as { reply_to_message?: { message_id: number } }).reply_to_message;
    if (!replyTo) {
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
    // A reply to a bot notice (a poll hint, a tally, an edit relayed as a reply) is not a reply to
    // the message: deleting the MAX message for it wiped a poll the owner only meant to declutter
    // (review 2026-09-26, delivery-r2#0).
    if (isNoticeOf(link, replyTo.message_id)) {
      await bot.telegram.sendMessage(targetGroupId, 'Это служебное сообщение бота — ответьте /delete на само сообщение, которое нужно удалить.', {
        message_thread_id: topicId,
      });
      return;
    }
    const forMe = (ctx as unknown as { payload?: string }).payload?.trim().toLowerCase() === 'me';
    try {
      await max.deleteMessages(link.maxChatId, [link.maxMessageId], forMe);
      logger.info(`/delete: removed MAX message ${String(link.maxMessageId)} in chat ${String(link.maxChatId)} (forMe=${forMe})`);
      // The link is forgotten BEFORE the Telegram copies vanish (dropLinkedMessage): otherwise
      // the deletion probe sees them gone and mirror-deletes on MAX forAll — turning "/delete me"
      // into a delete for everyone (review 2026-09-26). Every Telegram copy goes, like the 👎 path.
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

  bot.on('message', async (ctx) => {
    const topicId = ctx.message.message_thread_id;
    if (!topicId) return;
    const mapping = await chatMapStore.getByTopicId(topicId);
    if (!mapping) return;
    // Forum service messages (topic created/edited/closed/reopened) carry no user content — ignore
    // them so they don't relay to MAX or trip the pending-dialog first-message handling (the
    // forum_topic_created that fires right after "Начать чат" was tripping a spurious hint).
    const svc = ctx.message as unknown as Record<string, unknown>;
    if (svc.forum_topic_created || svc.forum_topic_edited || svc.forum_topic_closed || svc.forum_topic_reopened) return;

    const forwardPrefix = describeForwardOrigin((ctx.message as { forward_origin?: TelegramForwardOrigin }).forward_origin);
    const rawText = (ctx.message as { text?: string; caption?: string }).text;
    const rawCaption = (ctx.message as { caption?: string }).caption ?? '';
    const text = forwardPrefix ? (rawText ? `${forwardPrefix}\n${rawText}` : undefined) : rawText;
    const caption = forwardPrefix ? (rawCaption ? `${forwardPrefix}\n${rawCaption}` : forwardPrefix) : rawCaption;
    // Native reply relay: a genuine reply to a mirrored message → resolve its MAX
    // message via the link store and pass an outgoing reply link ({messageId, chatId})
    // to MSG_SEND. In forum topics reply_to_message can point at the topic-root message
    // with no real reply, so ignore that (id === topicId). Links are in-memory, so a
    // reply to something from before the last restart just relays without the link.
    const replyToMessage = (ctx.message as { reply_to_message?: { message_id: number } }).reply_to_message;
    let replyLink: { messageId: unknown; chatId: unknown } | undefined;
    if (replyToMessage && replyToMessage.message_id !== topicId) {
      const linked = messageLinks.getByTelegram(replyToMessage.message_id);
      if (linked) replyLink = { messageId: linked.maxMessageId, chatId: linked.maxChatId };
    }
    const photo = (ctx.message as { photo?: Array<{ file_id: string }> }).photo;
    const document = (ctx.message as { document?: { file_id: string; file_name?: string } }).document;
    // GIFs — MAX only takes these as FILE. Telegram represents a forwarded GIF as `document`
    // in practice (confirmed live 2026-08-07), but `animation` is the dedicated type, so handle both.
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

    // INFO-level on purpose, and BEFORE any branch: silent relay paths already
    // cost two blind debugging sessions (2026-08-14/15). The text branch returns
    // long before the attach branches, so this can't live further down.
    const kind =
      location ? 'location' : contact ? 'contact' : poll ? 'poll' : text ? 'text'
      : photo?.length ? 'photo' : video ? 'video' : videoNote ? 'video_note' : document ? 'document'
      : animation ? 'animation' : voice ? 'voice' : audio ? 'audio' : sticker ? 'sticker' : 'unsupported type';
    logger.info(`TG -> MAX: message ${ctx.message.message_id} in topic ${topicId} (${kind}) -> chat ${mapping.maxChatId}`);

    try {
      // PENDING dialog: the panel's "Начать чат" mapped this topic to a FRESH contact with no MAX
      // dialog yet. The FIRST message opens the real 1:1 via MSG_SEND{userId} (max.sendToNewDialog),
      // which returns the real positive chatId — we then rewrite the pending mapping into a real one.
      // MAX needs non-empty text for a first message; media/files go in follow-ups once it exists.
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
        // Opening the dialog can be rejected by MAX (privacy, an invalid/unreachable user id, a
        // session hiccup). The generic catch below only logs — so a failure here used to leave the
        // sender staring at a silent topic ("написал — тишина"). Surface the reason IN the topic and
        // keep the pending sentinel intact so the next message just retries.
        let opened;
        try {
          opened = await max.sendToNewDialog(mapping.pendingUserId, text, [], replyLink);
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
        // while the two chat-map writes below are on disk that echo would find no cid to drop it —
        // and, with the pending mapping already gone, open a duplicate «MAX chat <id>» topic with
        // our own message in it (review 2026-09-26, C8). rememberOutgoingSend below repeats this
        // (a no-op for the cid) and moves the cursor once the real mapping exists.
        outgoingCids.remember(opened.cid);
        // Inside the new chat's queue: a reply from the contact landing between the two writes
        // below would otherwise find no mapping and open a second topic, which the upsert then
        // overwrote.
        await chatSync.runInChat(opened.chatId, async () => {
          await chatMapStore.remove(mapping.maxChatId); // drop the "pending:<userId>" sentinel entry
          await chatMapStore.upsert({
            maxChatId: opened.chatId,
            telegramTopicId: topicId,
            title: mapping.title,
            createdAt: mapping.createdAt,
          });
          // The dialog was born with this very message — no older history to catch up (ChatCatchUp).
          chatSync.markCaughtUp(opened.chatId);
          messageLinks.add({
            maxChatId: opened.chatId,
            maxMessageId: opened.messageId,
            telegramMessageId: ctx.message.message_id,
            telegramTopicId: topicId,
            outgoing: true,
          });
        });
        rememberOutgoingSend(opened.chatId, opened.cid, opened.time);
        logger.info(
          `Opened new MAX 1:1 dialog ${String(opened.chatId)} with user ${mapping.pendingUserId} (topic ${topicId})`,
        );
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
        // Linked right away, not after the hint below: a catch-up reaching the poll during that extra
        // round trip found no link and posted it again (review 2026-09-27, delivery-r3.1#2).
        messageLinks.add({ maxChatId: mapping.maxChatId, maxMessageId: messageId, telegramMessageId: ctx.message.message_id, telegramTopicId: topicId, outgoing: true });
        // Votes cast on THIS Telegram poll can't reach MAX: Telegram sends a bot poll_answer only
        // for polls the bot itself sent, and this one was sent by a group member (anonymous polls
        // never produce one at all). Its pollLinks entry was dead code; say it in the topic instead
        // of letting the vote counts silently drift apart (review 2026-09-26, OUTBOUND8).
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
        // A notice, not a copy of the poll: a 👎 on it must not delete the poll (delivery-r2#0).
        if (hint) messageLinks.addNotice(mapping.maxChatId, messageId, hint.message_id);
        return;
      }

      if (text) {
        const { cid, messageId, time } = await max.sendMessage(mapping.maxChatId, text, [], replyLink);
        rememberOutgoingSend(mapping.maxChatId, cid, time);
        messageLinks.add({ maxChatId: mapping.maxChatId, maxMessageId: messageId, telegramMessageId: ctx.message.message_id, telegramTopicId: topicId, outgoing: true });
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
      } else if (audio) {
        // No MAX audio-track attach is known — the file pipeline delivers it as a playable file.
        attach = await uploadTelegramAttachmentToMax(bot, max, audio.file_id, 'document', audio.file_name ?? 'audio.mp3');
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
          // Animated .tgs needs a headless-Chromium render (see lottie.ts). On a "slim" image without
          // Chromium, fall back to the sticker's static thumbnail so something still comes through.
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
        // Nothing we know how to forward (a dice, a story, a game, an animated sticker on the slim
        // image with no thumbnail, …). This used to return silently — to the sender a lost message
        // looks exactly like a delivered one (review 2026-09-26, OUTBOUND6). Say so in the topic;
        // unknown non-content updates stay a log line (describeUnrelayableTelegramMessage).
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
      // Don't fail silently — a swallowed send is indistinguishable from success to the sender.
      // Report the reason into the same topic (best-effort; never throw out of the handler).
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
    // A bot notice about the message (a poll hint, a tally, …) is not the message: no delete, no
    // reaction relayed onto it (review 2026-09-26, delivery-r2#0).
    if (isNoticeOf(link, update.message_id)) return;

    const oldEmojis = new Set(update.old_reaction.filter((r) => r.type === 'emoji').map((r) => r.emoji));
    const newEmojis = update.new_reaction.filter((r) => r.type === 'emoji').map((r) => r.emoji);
    const added = newEmojis.find((e) => !oldEmojis.has(e));

    // 👎 on our OWN message = delete on both sides (forAll — it's ours to remove).
    // Scoped to outgoing only: on an incoming (MAX-origin) copy a genuine 👎 still
    // relays as an ordinary reaction below instead of deleting anything.
    if (added && DELETE_REACTION_EMOJIS.has(added) && link.outgoing) {
      // Irreversible forAll delete — same admin gate as /delete (the command middleware
      // never sees reactions). An anonymous admin reacts as the group itself (actor_chat);
      // anyone else, or an unverifiable user, is ignored — fail closed (review 2026-09-26).
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
        await max.deleteMessages(link.maxChatId, [link.maxMessageId], false);
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

  // Telegram only tells a bot about votes on NON-anonymous polls the bot itself sent —
  // i.e. MAX polls this bridge mirrored into a topic (pollLinks holds exactly those). A poll
  // a group member creates in a topic, and any anonymous poll, never produces a poll_answer:
  // the bridge says so in the topic instead (review 2026-09-26, OUTBOUND8).
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

  return { chatSync };
}

/**
 * The LOGIN-time pass over every MAX chat: each gets a Telegram topic (created with its info card
 * when missing, so Telegram isn't empty on first contact) and its catch-up
 * (ChatCatchUp.ensureCaughtUp — the history since its cursor, all of it for a fresh topic), one
 * chat after another, each inside the chat's queue. A cursor-filtered CHAT_HISTORY, not a push, so
 * it also recovers messages that arrived during the gap between disconnect and reconnect (a live
 * push is otherwise lost forever if it arrives while we're offline — hit live 2026-08-12,
 * mid-redeploy). Safe to call on every LOGIN (fresh auth or a reconnect's resumed session); a
 * chat already caught up by a live event costs nothing. A chat that fails on a transient error
 * stays out of `caughtUp` and asks for a retry run (server/app.ts's backoff) instead of waiting for
 * the next LOGIN, which may never come while the MAX socket stays up (review 2026-09-26, C12).
 * After the snapshot, mapped chats it did not contain get the same catch-up: a CHATS_LIST
 * failure leaves only the LOGIN snapshot (capped at 50, known to omit chats), and a chat born
 * live meanwhile may not be in it either — left out, such a chat's cursor stayed frozen all
 * session and the next restart re-sent everything it relayed (review 2026-09-26, b2a-cursor).
 * `isCancelled` (/reboot, /kill) is checked before every chat and every message; once it says so
 * the run stops where it is (review 2026-09-26, C7).
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
    // CHATS_LIST keeps returning chats the account left/closed (status "CLOSED") —
    // MAX's own client hides those, so mirror that instead of creating a Telegram
    // topic for an abandoned test group every full resync (confirmed live 2026-08-13).
    // Not counted as in the snapshot: a mapped one still gets the second loop's catch-up, or its
    // live messages (the owner re-added meanwhile) never moved its cursor (catchup-r3.3#1).
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
        // Same intro card the live path sends on first contact — this bulk path used to skip it.
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
