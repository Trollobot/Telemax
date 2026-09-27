/**
 * MAX <-> Telegram attachment handling.
 *
 * PHOTO and STICKER carry a ready-to-use URL right in the push (max-protocol-full.md §1.6). FILE
 * and VIDEO are gated behind a two-step exchange (reverse-engineered 2026-08-07):
 *   FILE:  FILE_DOWNLOAD  (0x58) {chatId, messageId, fileId}  -> {url}
 *   VIDEO: VIDEO_PLAY     (0x53) {chatId, messageId, videoId} -> {MP4_240, EXTERNAL, ...}
 * VIDEO has its own id namespace — FILE_DOWNLOAD rejects a videoId with "file not found". No
 * guarantee which `MP4_*` qualities exist for a given video.
 */
import { gzipSync } from 'node:zlib';
import type { MaxClient } from '../max/client.js';
import { maxFetch } from '../max/ca.js';
import { createLogger } from '../logger.js';
import { isTransientHttpStatus, isTransientMaxError, isTransientNetworkError, TransientDownloadError } from './transient.js';

const logger = createLogger('attachments');

export interface MaxAttachment {
  _type?: string;
  baseUrl?: string;
  photoToken?: string;
  photoId?: unknown;
  url?: string;
  lottieUrl?: string;
  stickerId?: unknown;
  fileId?: unknown; // arrives as BigInt (msgpack int64) — pass through as-is, never coerce to Number
  name?: string;
  size?: number;
  token?: string;
  videoId?: unknown;
  // `videoType: 1` is a round video message ("кружочек", Telegram's sendVideoNote); `0` an
  // ordinary video. Confirmed live 2026-08-13 — only videoType tells them apart, not the dimensions.
  videoType?: number;
  // POLL
  title?: string;
  answers?: Array<{ text?: string; answerId?: unknown; count?: number }>;
  settings?: number;
  pollId?: unknown;
  state?: {
    total?: number;
    result?: Array<{
      answerId?: unknown;
      voteCount?: number;
      rate?: number;
      votes?: Array<{ userId?: unknown; timestamp?: unknown }>;
    }>;
    voterPreviewIds?: unknown[];
  };
  version?: number;
  // CALL — a missed/finished call arrives as a regular message with this attach;
  // an in-progress ring is the separate NOTIF_CALL_START push (see bridge/sync.ts).
  duration?: number;
  conversationId?: string;
  contactIds?: unknown[];
  // CONTROL — chat-lifecycle system events (group created/renamed/member added, etc).
  event?: string;
  chatType?: string;
  userIds?: unknown[];
  // AUDIO (voice message) — carries a ready-to-use `url` like PHOTO/STICKER.
  audioId?: unknown;
  wave?: unknown;
  // LOCATION — a shared point on the map, no download step at all.
  latitude?: number;
  longitude?: number;
  zoom?: number;
  // CONTACT — two distinct shapes seen live: a reference to an existing MAX user
  // (`contactId`, no phone — needs its own CONTACT_INFO lookup) and a self-contained
  // vCard-style card (`phone`/`lastName`/`vcfBody` right on the attach, no contactId).
  contactId?: unknown;
  firstName?: string;
  lastName?: string;
  phone?: unknown;
  vcfBody?: string;
}

export interface DownloadedAttachment {
  buffer: Buffer;
  filename: string;
  kind: 'photo' | 'document' | 'video' | 'video_note' | 'voice' | 'sticker';
}

export interface DownloadContext {
  max: MaxClient;
  chatId: unknown;
  messageId: unknown;
  // Retried with these when the primary (source) ids are denied — see sync.ts forwardDownloadIds.
  fallbackChatId?: unknown;
  fallbackMessageId?: unknown;
  // Throw TransientDownloadError instead of returning null when the download failed for a reason
  // that may pass (MAX socket down, CDN 5xx/network). Set by the backfill, which must not advance
  // its cursor past a file it could not fetch; the live path keeps the text placeholder.
  throwOnTransient?: boolean;
}

// Generous (a large video on a slow CDN) but finite: a hung download must not stall the relay forever.
const DOWNLOAD_TIMEOUT_MS = 120_000;
// Bot API upload limits (multipart): 50 MB for any file, 10 MB for a photo — bigger is refused with 413.
export const TELEGRAM_UPLOAD_LIMIT_BYTES = 50 * 1024 * 1024;
export const TELEGRAM_PHOTO_LIMIT_BYTES = 10 * 1024 * 1024;
// A response is buffered whole, so an unbounded download could exhaust the container's memory.
// A file over Telegram's upload limit could only fail on upload anyway — it gets the placeholder.
const MAX_DOWNLOAD_BYTES = TELEGRAM_UPLOAD_LIMIT_BYTES;

/**
 * How a downloaded attachment of `bytes` can go to Telegram: its own kind when it fits, 'document'
 * for a photo over sendPhoto's 10 MB limit (still under the 50 MB file limit), null when it is over
 * the 50 MB limit altogether (the caller posts the placeholder). Pure + exported for unit testing.
 */
export function telegramSendKind(kind: DownloadedAttachment['kind'], bytes: number): DownloadedAttachment['kind'] | null {
  if (bytes > TELEGRAM_UPLOAD_LIMIT_BYTES) return null;
  if (kind === 'photo' && bytes > TELEGRAM_PHOTO_LIMIT_BYTES) return 'document';
  return kind;
}

// Every URL here is a MAX-owned CDN host — hence maxFetch, which trusts the Russian state chain.
// Null for a permanent failure (4xx, over the size cap); throws TransientDownloadError for one
// that may pass (5xx, network, timeout).
async function downloadUrl(url: string): Promise<Buffer | null> {
  try {
    const res = await maxFetch(url, { signal: AbortSignal.timeout(DOWNLOAD_TIMEOUT_MS) });
    if (!res.ok) {
      logger.error(`downloadUrl got non-OK response ${res.status} ${res.statusText} for ${url}`);
      if (isTransientHttpStatus(res.status)) throw new TransientDownloadError(`MAX CDN answered ${res.status}`);
      return null;
    }
    const declared = Number(res.headers.get('content-length') ?? '');
    if (Number.isFinite(declared) && declared > MAX_DOWNLOAD_BYTES) {
      logger.error(`downloadUrl refused ${declared} bytes (limit ${MAX_DOWNLOAD_BYTES}) for ${url}`);
      return null;
    }
    const buf = Buffer.from(await res.arrayBuffer());
    // Header can lie or be absent — check what actually arrived too.
    if (buf.byteLength > MAX_DOWNLOAD_BYTES) {
      logger.error(`downloadUrl got ${buf.byteLength} bytes, over the ${MAX_DOWNLOAD_BYTES} limit, for ${url}`);
      return null;
    }
    return buf;
  } catch (err) {
    if (err instanceof TransientDownloadError) throw err;
    logger.error(`downloadUrl threw for ${url}`, err);
    if (isTransientNetworkError(err)) throw new TransientDownloadError(`MAX CDN download failed: ${(err as Error).message}`, err);
    return null;
  }
}

/** Runs a chat-scoped download (FILE_DOWNLOAD / VIDEO_PLAY) against the primary ids, retrying with
 * the fallback ids (a forward's recipient chat) when denied. Null when every attempt fails for good;
 * throws TransientDownloadError when the MAX socket was down (no point retrying over the same dead socket). */
async function withDownloadFallback<T>(
  ctx: DownloadContext,
  label: string,
  attempt: (chatId: unknown, messageId: unknown) => Promise<T>,
): Promise<T | null> {
  try {
    return await attempt(ctx.chatId, ctx.messageId);
  } catch (primaryErr) {
    if (isTransientMaxError(primaryErr)) {
      logger.error(`${label} failed transiently (chatId=${String(ctx.chatId)}, messageId=${String(ctx.messageId)})`, primaryErr);
      throw new TransientDownloadError(`${label}: ${(primaryErr as Error).message}`, primaryErr);
    }
    const hasFallback =
      ctx.fallbackChatId != null &&
      (String(ctx.fallbackChatId) !== String(ctx.chatId) || String(ctx.fallbackMessageId) !== String(ctx.messageId));
    if (!hasFallback) {
      logger.error(`${label} failed (chatId=${String(ctx.chatId)}, messageId=${String(ctx.messageId)})`, primaryErr);
      return null;
    }
    logger.info(
      `${label} denied on source chat ${String(ctx.chatId)} — retrying via recipient chat ${String(ctx.fallbackChatId)} (msg ${String(ctx.fallbackMessageId)})`,
    );
    try {
      const out = await attempt(ctx.fallbackChatId, ctx.fallbackMessageId);
      logger.info(`${label} succeeded via recipient chat ${String(ctx.fallbackChatId)}`);
      return out;
    } catch (fallbackErr) {
      logger.error(
        `${label} failed on both source (chatId=${String(ctx.chatId)}) and recipient (chatId=${String(ctx.fallbackChatId)})`,
        fallbackErr,
      );
      if (isTransientMaxError(fallbackErr)) throw new TransientDownloadError(`${label}: ${(fallbackErr as Error).message}`, fallbackErr);
      return null;
    }
  }
}

/**
 * Downloads a MAX attachment for re-upload to Telegram. Null means "no file to send" — the caller
 * posts describeAttachment()'s placeholder. A transient failure (see TransientDownloadError) is
 * also null unless ctx.throwOnTransient is set, in which case it is thrown so the backfill can stop
 * without moving its cursor past the file.
 */
export async function downloadMaxAttachment(att: MaxAttachment, ctx: DownloadContext): Promise<DownloadedAttachment | null> {
  try {
    return await downloadAttachmentOrThrow(att, ctx);
  } catch (err) {
    if (!(err instanceof TransientDownloadError) || ctx.throwOnTransient) throw err;
    logger.error(`Transient failure downloading a MAX ${att._type ?? 'attachment'} — sending the placeholder instead`, err);
    return null;
  }
}

async function downloadAttachmentOrThrow(att: MaxAttachment, ctx: DownloadContext): Promise<DownloadedAttachment | null> {
  if (att._type === 'PHOTO' && att.baseUrl && att.photoToken) {
    const buffer = await downloadUrl(att.baseUrl + att.photoToken);
    if (!buffer) return null;
    return { buffer, filename: `photo_${String(att.photoId ?? Date.now())}.jpg`, kind: 'photo' };
  }

  // Animated stickers carry a `lottieUrl`: gzip-compressed Lottie JSON that is already a valid
  // Telegram `.tgs` (inspected live 2026-08-13). fetch() transparently un-gzips it, so it must be
  // re-gzipped — plain JSON sent as `.tgs` shows a broken "Unknown Track" placeholder.
  if (att._type === 'STICKER' && att.lottieUrl) {
    try {
      const buffer = await downloadUrl(att.lottieUrl);
      if (buffer) return { buffer: gzipSync(buffer), filename: `sticker_${String(att.stickerId ?? Date.now())}.tgs`, kind: 'sticker' };
    } catch (err) {
      // The static preview below is still a sticker — only with no preview is a transient failure worth reporting.
      if (!att.url) throw err;
    }
  }

  if (att._type === 'STICKER' && att.url) {
    const buffer = await downloadUrl(att.url);
    if (!buffer) return null;
    // Confirmed live 2026-08-13: the preview URL serves image/png regardless of sticker type.
    return { buffer, filename: `sticker_${String(att.stickerId ?? Date.now())}.png`, kind: 'photo' };
  }

  if (att._type === 'FILE' && att.fileId != null) {
    const fileId = att.fileId;
    const url = await withDownloadFallback(ctx, `FILE_DOWNLOAD fileId ${String(fileId)}`, (chatId, messageId) =>
      ctx.max.getFileDownloadUrl(chatId, messageId, fileId),
    );
    if (!url) return null;
    const buffer = await downloadUrl(url);
    if (!buffer) return null;
    // A literal quote in a filename breaks telegraf's multipart Content-Disposition — sendDocument
    // dies with "invalid json response body" (hit live 2026-08-15).
    const safeName = (att.name ?? `file_${Date.now()}`).replace(/[\r\n"\\]/g, '_');
    return { buffer, filename: safeName, kind: 'document' };
  }

  if (att._type === 'AUDIO' && att.url) {
    const buffer = await downloadUrl(att.url);
    if (!buffer) return null;
    return { buffer, filename: `voice_${String(att.audioId ?? Date.now())}.ogg`, kind: 'voice' };
  }

  if (att._type === 'VIDEO' && att.videoId != null) {
    const videoId = att.videoId;
    const urls = await withDownloadFallback(ctx, `VIDEO_PLAY videoId ${String(videoId)}`, (chatId, messageId) =>
      ctx.max.getVideoPlayUrls(chatId, messageId, videoId),
    );
    if (!urls) return null;
    // Highest resolution first, stepping down while a quality is over the size cap.
    const mp4Keys = Object.keys(urls)
      .filter((k) => k.startsWith('MP4_') && urls[k])
      .sort((a, b) => Number(b.slice(4)) - Number(a.slice(4)));
    for (const mp4Key of mp4Keys) {
      const buffer = await downloadUrl(urls[mp4Key] as string);
      if (buffer) return { buffer, filename: `video_${String(videoId)}.mp4`, kind: att.videoType === 1 ? 'video_note' : 'video' };
      logger.info(`VIDEO ${String(videoId)}: ${mp4Key} not usable — trying a lower quality`);
    }
    return null;
  }

  return null;
}

export function describeAttachment(att: MaxAttachment): string {
  switch (att._type) {
    case 'PHOTO':
      return '[фото]';
    case 'STICKER':
      return '[стикер]';
    case 'FILE':
      return att.name ? `[файл: ${att.name}]` : '[файл]';
    case 'VIDEO':
      return '[видео]';
    case 'AUDIO':
      return '🎤 [голосовое]';
    case 'LOCATION':
      return '📍 [геолокация]';
    case 'CONTACT':
      return `👤 [контакт: ${att.firstName ?? att.name ?? '?'}]`;
    case 'POLL':
      return att.title ? `[опрос: ${att.title}]` : '[опрос]';
    case 'CALL':
      return att.duration ? `☎️ Звонок (${att.duration}с)` : '☎️ Пропущенный звонок';
    case 'CONTROL':
      switch (att.event) {
        case 'new':
          return '🆕 Группа создана';
        case 'join':
          return '➕ Участник добавлен';
        case 'leave':
          return '➖ Участник вышел';
        case 'title':
          return '✏️ Название изменено';
        default:
          return `[системное событие${att.event ? ': ' + att.event : ''}]`;
      }
    default:
      return `[вложение${att._type ? ': ' + att._type : ''}]`;
  }
}
