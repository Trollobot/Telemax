/**
 * MAX <-> Telegram attachment handling.
 *
 * PHOTO and STICKER carry a ready-to-use URL right in the push (max-protocol-full.md
 * §1.6). FILE and VIDEO deliberately do not — both are gated behind a two-step
 * exchange (undocumented in max-protocol-full.md, supplied by the user from their
 * own reverse-engineering on 2026-08-07):
 *   FILE:  FILE_DOWNLOAD  (0x58) {chatId, messageId, fileId}  -> {url}
 *   VIDEO: VIDEO_PLAY     (0x53) {chatId, messageId, videoId} -> {MP4_240, EXTERNAL, ...}
 * VIDEO has its own id namespace — videoId is NOT a fileId, and FILE_DOWNLOAD
 * rejects it with "file not found". Pick any `MP4_*` key from the VIDEO_PLAY
 * response; there's no guarantee which qualities exist for a given video.
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
  // `videoType: 1` is a round video message ("кружочек") — Telegram needs a dedicated
  // API call (sendVideoNote) to render it as a circle instead of a regular rectangle;
  // `0` is an ordinary video. Confirmed live 2026-08-13 (both examples were square,
  // width===height, but only videoType told them apart).
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
  // AUDIO (voice message) — unlike FILE/VIDEO, carries a ready-to-use `url` right in
  // the attach, same as PHOTO/STICKER — no FILE_DOWNLOAD-style exchange needed.
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
  // For a forward whose source chat we can't access (link.chatId comes back as 0), the file
  // is still reachable via the chat the forward LANDED in — our dialog with the forwarder.
  // FILE_DOWNLOAD/VIDEO_PLAY retry with these when the primary (source) ids are denied.
  fallbackChatId?: unknown;
  fallbackMessageId?: unknown;
  // Throw TransientDownloadError instead of returning null when the download failed for a
  // reason that may pass (MAX socket down or timed out, CDN 5xx/network). Set by the history
  // backfill, which must not advance its cursor past a file it could not fetch — the live path
  // leaves it unset and keeps the text placeholder (review 2026-09-26, RECOVERY3).
  throwOnTransient?: boolean;
}

// Generous — covers a large video on a slow CDN — but finite: a hung download must
// not stall the relay handler forever (nothing else here bounds it).
const DOWNLOAD_TIMEOUT_MS = 120_000;
// Bot API upload limits (multipart, the only way this bridge uploads): 50 MB for any file, 10 MB
// for a photo. Anything bigger is refused with 413, so it was never deliverable anyway.
export const TELEGRAM_UPLOAD_LIMIT_BYTES = 50 * 1024 * 1024;
export const TELEGRAM_PHOTO_LIMIT_BYTES = 10 * 1024 * 1024;
// A response was buffered whole with no ceiling, so ONE oversized incoming file could exhaust the
// container's memory and take the bridge down (and it would keep happening on every retry). The cap
// is Telegram's own upload limit: a bigger file could only fail on upload, so it gets the text
// placeholder instead (the cap used to be 100 MB, and a 50–100 MB file aborted its whole message —
// review 2026-09-26, INBOUND-EDGES1).
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

// Every URL that reaches this helper is a MAX-owned host (photo/sticker/file/video
// CDN) — hence maxFetch, which trusts the Russian state chain those certs use.
// Null for a permanent failure (4xx, over the size cap); throws TransientDownloadError for one
// that may pass (5xx, network, timeout) — downloadMaxAttachment decides what the caller sees.
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

/** Runs a chat-scoped download (FILE_DOWNLOAD / VIDEO_PLAY) against the primary ids; if that
 * is denied and the context carries fallback ids (a forward's recipient chat), retries there.
 * Returns null when every attempt fails for good; throws TransientDownloadError when the MAX
 * socket was down or timed out (no point trying the fallback ids over the same dead socket). */
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

  // Animated stickers (`stickerType: 'LOTTIE'`) carry a `lottieUrl` pointing at a
  // gzip-compressed Lottie JSON that's already structurally a valid Telegram `.tgs`
  // (512x512 canvas, 60fps, ~2.5s, pure vector shape/precomp layers, even carries
  // Telegram's own `tgs:1` marker — inspected live 2026-08-13). First attempt at
  // sending it via sendSticker showed a broken "Unknown Track" placeholder — root
  // cause turned out to be `downloadUrl`'s fetch() transparently auto-decompressing
  // the gzip Content-Encoding (standard fetch behavior), so what we forwarded to
  // Telegram as a `.tgs` was actually plain decompressed JSON, not a real gzip
  // file. Re-gzipping the already-decompressed buffer here fixes that.
  if (att._type === 'STICKER' && att.lottieUrl) {
    try {
      const buffer = await downloadUrl(att.lottieUrl);
      if (buffer) return { buffer: gzipSync(buffer), filename: `sticker_${String(att.stickerId ?? Date.now())}.tgs`, kind: 'sticker' };
    } catch (err) {
      // The static preview below is still a sticker — only a transient failure with no
      // preview to fall back on is worth reporting as such.
      if (!att.url) throw err;
    }
  }

  if (att._type === 'STICKER' && att.url) {
    const buffer = await downloadUrl(att.url);
    if (!buffer) return null;
    // Confirmed live 2026-08-13: this preview URL serves image/png regardless of
    // sticker type, so it renders properly through the PHOTO pipeline.
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
    // A literal quote in a MAX-side filename breaks telegraf's multipart Content-Disposition —
    // Telegram's server drops the connection mid-response and sendDocument dies with "invalid
    // json response body" (hit live 2026-08-15 with names an earlier upload bug had quoted).
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
    // Highest resolution first, stepping down while a quality is refused — typically for being
    // over Telegram's 50 MB upload limit (downloadUrl's cap), where a lower one still fits.
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
