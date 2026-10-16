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
import { randomBytes } from 'node:crypto';
import type { InlineKeyboardButton, InlineKeyboardMarkup } from 'telegraf/types';
import type { MaxClient } from '../max/client.js';
import { maxFetch } from '../max/ca.js';
import { createLogger, jsonStringify, redactSecrets } from '../logger.js';
import { truncateUtf16 } from './text.js';
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
  // INLINE_KEYBOARD — a bot message's buttons: rows of {type, text, url|payload|…} (see maxKeyboardToTelegram).
  keyboard?: unknown;
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
  // Throw TransientDownloadError instead of a DownloadMissError when the download failed for a
  // reason that may pass (MAX socket down, CDN 5xx/network). Set by the backfill, which must not
  // advance its cursor past a file it could not fetch (it tries again on its next run); the live
  // path tries again itself (LIVE_RETRY_DELAYS_MS), then posts the placeholder.
  throwOnTransient?: boolean;
  /** The live path's pauses between tries — injectable for tests. */
  retryDelaysMs?: readonly number[];
}

/** Live: pauses before the 2nd and 3rd try of a download that failed transiently — a CDN hiccup lasts seconds (a user report on 1.3.7: «то фото, то заглушка», one try only). */
const LIVE_RETRY_DELAYS_MS = [2000, 5000];
/** …and no new try once this long has gone by since the first: the chat's queue waits for it. */
const LIVE_RETRY_BUDGET_MS = 60_000;

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

/**
 * An attachment the bridge could not have — refused for good by the CDN (a 4xx), over the size cap,
 * no link to fetch it by, or (live) an outage that outlasted the try. `why` goes into its
 * placeholder (placeholderText): a bare «[фото]» left the owner guessing (a user report on 1.3.7).
 */
export class DownloadMissError extends Error {
  constructor(
    readonly why: string,
    cause?: unknown,
  ) {
    super(why, { cause });
    this.name = 'DownloadMissError';
  }
}

export const NO_LINK_WHY = 'не скачалось: MAX не дал ссылку';
export const TOO_BIG_WHY = `больше ${TELEGRAM_UPLOAD_LIMIT_BYTES / 1048576} МБ — столько бот в Telegram не загрузит`;

/** The placeholder of an attachment that did not go to Telegram: what it was, and why when known. Pure + exported for unit testing. */
export function placeholderText(att: MaxAttachment, why?: string): string {
  const what = describeAttachment(att);
  return why ? `${what} — ${why}. Откройте в MAX.` : what;
}

/** A network failure in a word for the owner («таймаут», «обрыв связи», …) — '' when not recognised. Pure + exported for unit testing. */
export function networkFailureName(err: unknown, depth = 0): string {
  if (!err || typeof err !== 'object') return '';
  const e = err as { code?: unknown; name?: unknown; message?: unknown; cause?: unknown };
  const code = typeof e.code === 'string' ? e.code : '';
  if (/TIMEOUT|ETIMEDOUT/.test(code) || e.name === 'TimeoutError' || e.name === 'AbortError') return 'таймаут';
  if (code === 'ECONNRESET' || code === 'UND_ERR_SOCKET' || code === 'UND_ERR_CLOSED' || code === 'EPIPE' || e.message === 'terminated') return 'обрыв связи';
  if (code === 'ENOTFOUND' || code === 'EAI_AGAIN') return 'не найден адрес сервера';
  if (code === 'ECONNREFUSED') return 'соединение отклонено';
  if (code === 'EHOSTUNREACH' || code === 'ENETUNREACH' || code === 'ENETDOWN') return 'сервер недоступен';
  if (/CERT|SELF_SIGNED|UNABLE_TO_VERIFY/.test(code) || (typeof e.message === 'string' && /certificate/i.test(e.message))) return 'сертификат сервера не принят';
  return depth < 3 && e.cause != null ? networkFailureName(e.cause, depth + 1) : '';
}

// Every URL here is a MAX-owned CDN host — hence maxFetch, which trusts the Russian state chain.
// Throws DownloadMissError for a permanent failure (4xx, over the size cap, an error that is no
// outage) and TransientDownloadError for one that may pass (5xx, network, timeout).
async function downloadUrl(url: string): Promise<Buffer> {
  try {
    const res = await maxFetch(url, { signal: AbortSignal.timeout(DOWNLOAD_TIMEOUT_MS) });
    if (!res.ok) {
      logger.error(`downloadUrl got non-OK response ${res.status} ${res.statusText} for ${url}`);
      if (isTransientHttpStatus(res.status)) {
        throw new TransientDownloadError(`MAX CDN answered ${res.status}`, undefined, `не скачалось: сервер MAX ответил ошибкой ${res.status}`);
      }
      throw new DownloadMissError(`не скачалось: сервер MAX отказал (${res.status})`);
    }
    const declared = Number(res.headers.get('content-length') ?? '');
    if (Number.isFinite(declared) && declared > MAX_DOWNLOAD_BYTES) {
      logger.error(`downloadUrl refused ${declared} bytes (limit ${MAX_DOWNLOAD_BYTES}) for ${url}`);
      throw new DownloadMissError(TOO_BIG_WHY);
    }
    const buf = Buffer.from(await res.arrayBuffer());
    // Header can lie or be absent — check what actually arrived too.
    if (buf.byteLength > MAX_DOWNLOAD_BYTES) {
      logger.error(`downloadUrl got ${buf.byteLength} bytes, over the ${MAX_DOWNLOAD_BYTES} limit, for ${url}`);
      throw new DownloadMissError(TOO_BIG_WHY);
    }
    return buf;
  } catch (err) {
    if (err instanceof TransientDownloadError || err instanceof DownloadMissError) throw err;
    logger.error(`downloadUrl threw for ${url}`, err);
    const name = networkFailureName(err);
    if (isTransientNetworkError(err)) {
      throw new TransientDownloadError(`MAX CDN download failed: ${(err as Error).message}`, err, `не скачалось: сервер MAX не ответил${name ? ` (${name})` : ''}`);
    }
    throw new DownloadMissError(`не скачалось: ${name || truncateUtf16(String((err as Error)?.message ?? err), 80)}`, err);
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
 * The CDN URL of a MAX FILE attach (FILE_DOWNLOAD with the forward fallback) — for the big-file
 * path, which streams it to disk itself. Null when MAX refuses for good; TransientDownloadError
 * when the socket was down.
 */
export async function getMaxFileUrl(att: MaxAttachment, ctx: DownloadContext): Promise<string | null> {
  if (att._type !== 'FILE' || att.fileId == null) return null;
  const fileId = att.fileId;
  return withDownloadFallback(ctx, `FILE_DOWNLOAD fileId ${String(fileId)}`, (chatId, messageId) => ctx.max.getFileDownloadUrl(chatId, messageId, fileId));
}

/**
 * Downloads a MAX attachment for re-upload to Telegram. Null means "nothing to fetch" (a kind the
 * bridge does not download) — the caller posts describeAttachment()'s placeholder. DownloadMissError
 * means it could not be had: the caller posts placeholderText with its `why`. A transient failure
 * (see TransientDownloadError) is tried again (LIVE_RETRY_DELAYS_MS) and then becomes a
 * DownloadMissError too — unless ctx.throwOnTransient is set: then it is thrown at once so the
 * backfill can stop without moving its cursor past the file.
 */
export async function downloadMaxAttachment(att: MaxAttachment, ctx: DownloadContext): Promise<DownloadedAttachment | null> {
  const delays = ctx.retryDelaysMs ?? LIVE_RETRY_DELAYS_MS;
  const startedAt = Date.now();
  for (let tries = 1; ; tries++) {
    try {
      return await downloadAttachmentOrThrow(att, ctx);
    } catch (err) {
      if (!(err instanceof TransientDownloadError) || ctx.throwOnTransient) throw err;
      const pause = delays[tries - 1];
      if (pause != null && Date.now() - startedAt + pause < LIVE_RETRY_BUDGET_MS) {
        logger.info(`Transient failure downloading a MAX ${att._type ?? 'attachment'} (try ${tries}: ${err.message}) — trying again in ${pause / 1000} s`);
        await new Promise((resolve) => setTimeout(resolve, pause));
        continue;
      }
      logger.error(`Transient failure downloading a MAX ${att._type ?? 'attachment'} after ${tries} tries — sending the placeholder instead`, err);
      throw new DownloadMissError(tries > 1 ? `${err.why}, попыток: ${tries}` : err.why, err);
    }
  }
}

/**
 * An image's real format from its first bytes — MAX takes JPG, PNG, GIF, TIFF, BMP and HEIC (its
 * upload docs), Telegram's sendPhoto refuses some of them, and a HEIC named `.jpg` opens nowhere.
 * 'jpg' when nothing matches. Pure + exported for unit testing.
 */
export function imageExtension(buf: Uint8Array): string {
  const ascii = (from: number, to: number) => String.fromCharCode(...buf.subarray(from, to));
  if (buf[0] === 0x89 && ascii(1, 4) === 'PNG') return 'png';
  if (ascii(0, 4) === 'GIF8') return 'gif';
  if (ascii(0, 4) === 'RIFF' && ascii(8, 12) === 'WEBP') return 'webp';
  if (ascii(0, 2) === 'BM') return 'bmp';
  if (ascii(0, 4) === 'II*\0' || ascii(0, 4) === 'MM\0*') return 'tiff';
  if (ascii(4, 8) === 'ftyp') {
    const brand = ascii(8, 12);
    if (brand === 'avif' || brand === 'avis') return 'avif';
    if (['heic', 'heix', 'hevc', 'hevx', 'heim', 'heis', 'mif1', 'msf1'].includes(brand)) return 'heic';
  }
  return 'jpg';
}

/**
 * An image's pixel size from its header — JPEG (SOF segment), PNG, GIF, BMP, WebP (VP8, VP8L, VP8X)
 * — without decoding it; null when unknown or truncated. Pure + exported for unit testing.
 */
export function imageSize(buf: Uint8Array): { width: number; height: number } | null {
  const ascii = (from: number, to: number) => String.fromCharCode(...buf.subarray(from, to));
  const u16be = (i: number) => (buf[i]! << 8) | buf[i + 1]!;
  const u16le = (i: number) => buf[i]! | (buf[i + 1]! << 8);
  const u24le = (i: number) => buf[i]! | (buf[i + 1]! << 8) | (buf[i + 2]! << 16);
  const u32be = (i: number) => ((buf[i]! << 24) >>> 0) + (buf[i + 1]! << 16) + (buf[i + 2]! << 8) + buf[i + 3]!;
  const ok = (width: number, height: number) => (width > 0 && height > 0 ? { width, height } : null);
  if (buf.length >= 24 && buf[0] === 0x89 && ascii(1, 4) === 'PNG') return ok(u32be(16), u32be(20));
  if (buf.length >= 10 && ascii(0, 4) === 'GIF8') return ok(u16le(6), u16le(8));
  if (buf.length >= 26 && ascii(0, 2) === 'BM') {
    const view = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
    return ok(Math.abs(view.getInt32(18, true)), Math.abs(view.getInt32(22, true)));
  }
  if (buf.length >= 16 && ascii(0, 4) === 'RIFF' && ascii(8, 12) === 'WEBP') {
    const chunk = ascii(12, 16);
    if (chunk === 'VP8 ' && buf.length >= 30 && buf[23] === 0x9d && buf[24] === 0x01 && buf[25] === 0x2a) return ok(u16le(26) & 0x3fff, u16le(28) & 0x3fff);
    if (chunk === 'VP8L' && buf.length >= 25 && buf[20] === 0x2f) {
      const [b1, b2, b3, b4] = [buf[21]!, buf[22]!, buf[23]!, buf[24]!];
      return ok(1 + (b1 | ((b2 & 0x3f) << 8)), 1 + (((b2 & 0xc0) >> 6) | (b3 << 2) | ((b4 & 0x0f) << 10)));
    }
    if (chunk === 'VP8X' && buf.length >= 30) return ok(1 + u24le(24), 1 + u24le(27));
    return null;
  }
  if (buf.length >= 4 && buf[0] === 0xff && buf[1] === 0xd8) {
    let i = 2;
    while (i + 9 < buf.length) {
      if (buf[i] !== 0xff) return null;
      const marker = buf[i + 1]!;
      if (marker === 0xff) {
        i += 1; // fill byte
        continue;
      }
      // SOF0–SOF15, except DHT (C4), JPG (C8), DAC (CC): height then width.
      if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) return ok(u16be(i + 7), u16be(i + 5));
      i += 2 + u16be(i + 2);
    }
  }
  return null;
}

/**
 * Whether a picture survives as a Telegram photo. sendPhoto's documented limits are w+h ≤ 10 000
 * and a ratio ≤ 20 — yet a 1810×44 MAX picture (41:1) was ACCEPTED and shrunk to a blurry,
 * unzoomable ~1280×31 strip (live 2026-10-13). So: within those limits, and its short side still
 * ≥ 64 px once Telegram brings the long side down to 1280. Pure + exported for unit testing.
 */
export function fitsTelegramPhoto({ width, height }: { width: number; height: number }): boolean {
  const long = Math.max(width, height);
  const short = Math.min(width, height);
  if (width + height > 10_000 || long / short > 20) return false;
  return long <= 1280 || (short * 1280) / long >= 64;
}

/** Image formats Telegram doesn't take as a photo — they go as a file straight away instead of a doomed sendPhoto. A safety net: MAX serves its photos as its own WebP/JPEG copies (a HEIC came as WebP, live 2026-10-13). */
export const PHOTO_AS_FILE = new Set(['heic', 'tiff', 'avif']);

/**
 * The ways to fetch a MAX photo, in order. MAX web's first: baseUrl as it is — its «original», the
 * photo at the size MAX declares (the token is kept apart, never in the URL) — or `url` for a photo
 * without baseUrl. Last, the bridge's own way since the start, baseUrl with the token appended: the
 * CDN began refusing it with a 400 for every photo (a phone screenshot first, a user report on 1.3.8;
 * all of them on test, 2026-10-16). Pure + exported for unit testing.
 */
export function photoUrls(att: Pick<MaxAttachment, 'baseUrl' | 'photoToken' | 'url'>): { how: string; url: string }[] {
  const all = [
    { how: 'baseUrl', url: att.baseUrl },
    { how: 'url', url: att.url },
    { how: 'baseUrl+token', url: att.baseUrl && att.photoToken ? att.baseUrl + att.photoToken : undefined },
  ];
  return all.filter((v, i): v is { how: string; url: string } => !!v.url && all.findIndex((w) => w.url === v.url) === i);
}

/** A photo by the first of photoUrls that the CDN gives — the next one tried only after a refusal (an outage is no reason to). */
async function downloadPhoto(att: MaxAttachment): Promise<Buffer> {
  let miss: DownloadMissError | undefined;
  for (const { how, url } of photoUrls(att)) {
    try {
      const buffer = await downloadUrl(url);
      if (miss) logger.info(`MAX photo ${String(att.photoId ?? '?')}: «${how}» worked after «${miss.why}»`);
      return buffer;
    } catch (err) {
      if (!(err instanceof DownloadMissError)) throw err;
      miss = err;
    }
  }
  throw miss ?? new DownloadMissError(NO_LINK_WHY);
}

async function downloadAttachmentOrThrow(att: MaxAttachment, ctx: DownloadContext): Promise<DownloadedAttachment | null> {
  if (att._type === 'PHOTO' && (att.baseUrl || att.url)) {
    const buffer = await downloadPhoto(att);
    return { buffer, filename: `photo_${String(att.photoId ?? Date.now())}.${imageExtension(buffer)}`, kind: 'photo' };
  }

  // Animated stickers carry a `lottieUrl`: gzip-compressed Lottie JSON that is already a valid
  // Telegram `.tgs` (inspected live 2026-08-13). fetch() transparently un-gzips it, so it must be
  // re-gzipped — plain JSON sent as `.tgs` shows a broken "Unknown Track" placeholder.
  if (att._type === 'STICKER' && att.lottieUrl) {
    try {
      const buffer = await downloadUrl(att.lottieUrl);
      return { buffer: gzipSync(buffer), filename: `sticker_${String(att.stickerId ?? Date.now())}.tgs`, kind: 'sticker' };
    } catch (err) {
      // The static preview below is still a sticker — only with no preview is the failure worth reporting.
      if (!att.url) throw err;
    }
  }

  if (att._type === 'STICKER' && att.url) {
    const buffer = await downloadUrl(att.url);
    // Confirmed live 2026-08-13: the preview URL serves image/png regardless of sticker type.
    return { buffer, filename: `sticker_${String(att.stickerId ?? Date.now())}.png`, kind: 'photo' };
  }

  if (att._type === 'FILE' && att.fileId != null) {
    const fileId = att.fileId;
    const url = await withDownloadFallback(ctx, `FILE_DOWNLOAD fileId ${String(fileId)}`, (chatId, messageId) =>
      ctx.max.getFileDownloadUrl(chatId, messageId, fileId),
    );
    if (!url) throw new DownloadMissError(NO_LINK_WHY);
    const buffer = await downloadUrl(url);
    // A literal quote in a filename breaks telegraf's multipart Content-Disposition — sendDocument
    // dies with "invalid json response body" (hit live 2026-08-15).
    const safeName = (att.name ?? `file_${Date.now()}`).replace(/[\r\n"\\]/g, '_');
    return { buffer, filename: safeName, kind: 'document' };
  }

  if (att._type === 'AUDIO' && att.url) {
    const buffer = await downloadUrl(att.url);
    return { buffer, filename: `voice_${String(att.audioId ?? Date.now())}.ogg`, kind: 'voice' };
  }

  if (att._type === 'VIDEO' && att.videoId != null) {
    const videoId = att.videoId;
    const urls = await withDownloadFallback(ctx, `VIDEO_PLAY videoId ${String(videoId)}`, (chatId, messageId) =>
      ctx.max.getVideoPlayUrls(chatId, messageId, videoId),
    );
    if (!urls) throw new DownloadMissError(NO_LINK_WHY);
    // Highest resolution first, stepping down while a quality is over the size cap.
    const mp4Keys = Object.keys(urls)
      .filter((k) => k.startsWith('MP4_') && urls[k])
      .sort((a, b) => Number(b.slice(4)) - Number(a.slice(4)));
    let miss: DownloadMissError | undefined;
    for (const mp4Key of mp4Keys) {
      try {
        const buffer = await downloadUrl(urls[mp4Key] as string);
        return { buffer, filename: `video_${String(videoId)}.mp4`, kind: att.videoType === 1 ? 'video_note' : 'video' };
      } catch (err) {
        if (!(err instanceof DownloadMissError)) throw err;
        miss = err;
        logger.info(`VIDEO ${String(videoId)}: ${mp4Key} not usable — trying a lower quality`);
      }
    }
    throw miss ?? new DownloadMissError(NO_LINK_WHY);
  }

  // A photo, file, voice or video with nothing to fetch it by (MAX left the link out).
  if (att._type === 'PHOTO' || att._type === 'FILE' || att._type === 'AUDIO' || att._type === 'VIDEO') throw new DownloadMissError(NO_LINK_WHY);
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
          // The same event opens a channel's history (seen live 2026-10-13) — no «Группа» there.
          return '🆕 Чат создан';
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
      logUnknownAttachment(att);
      return `[вложение${att._type ? ': ' + att._type : ''}]`;
  }
}

// One line per unknown `_type` per process — enough to learn its shape without flooding the log.
const loggedUnknownTypes = new Set<string>();

function logUnknownAttachment(att: MaxAttachment): void {
  const type = String(att._type);
  if (loggedUnknownTypes.has(type) || loggedUnknownTypes.size >= 50) return;
  loggedUnknownTypes.add(type);
  logger.info(`Unknown MAX attachment type ${type}: ${jsonStringify(redactSecrets(att)).slice(0, 1500)}`);
}

// Same idea for a keyboard: the whole attach, once per button type the bridge does not relay yet —
// CALLBACK, MESSAGE & co. are known from the Bot API docs only, never seen in this protocol.
function logUnknownButton(type: unknown, att: unknown): void {
  const key = `button:${String(type)}`;
  if (loggedUnknownTypes.has(key) || loggedUnknownTypes.size >= 50) return;
  loggedUnknownTypes.add(key);
  logger.info(`MAX keyboard with an unrelayed button type ${String(type)}: ${jsonStringify(redactSecrets(att)).slice(0, 3000)}`);
}

/**
 * A CALLBACK button of a MAX bot shown in Telegram. Telegram's callback_data holds 64 bytes, a MAX
 * callbackId alone is ~110 chars, so the button carries a random key into this bounded in-memory
 * map. Random, not a counter: after a restart the keys of buttons already sitting in Telegram must
 * not land on a DIFFERENT new button. A key that is gone answers «кнопка устарела».
 * Shape seen live 2026-10-05 (GigaChat): {type:'CALLBACK', text, payload:'<json string>', intent},
 * one callbackId per keyboard — `payload` is what tells the bot which button was pressed.
 */
export interface PressableButton {
  chatId: unknown;
  callbackId: string;
  payload?: string;
  text: string;
  /** A MESSAGE button: the press sends `text` to the bot instead of a callback. */
  sendsText?: boolean;
}
export const KEYBOARD_PRESS = 'tlmx_kb:';
// A Telegram inline button in a group cannot ask for a location or a contact, but the bridge
// already relays both when they are sent into the topic — so these two only say how.
// Type names per the MAX Bot API docs (LINK, CLIPBOARD and CALLBACK matched them live).
export const KEYBOARD_GEO = 'tlmx_kb_geo';
export const KEYBOARD_CONTACT = 'tlmx_kb_contact';
const PRESSABLE_CAP = 2000;
const pressable = new Map<string, PressableButton>();

function registerButton(button: PressableButton): string {
  const key = randomBytes(9).toString('base64url');
  pressable.set(key, button);
  if (pressable.size > PRESSABLE_CAP) pressable.delete(pressable.keys().next().value as string);
  return KEYBOARD_PRESS + key;
}

/** The button behind a `tlmx_kb:<key>` press, or undefined when the bridge restarted since (or it was evicted). */
export function pressableButton(key: string): PressableButton | undefined {
  return pressable.get(key);
}

/**
 * The public deep link of a MAX mini-app button: `https://max.ru/<bot>?startapp=<payload>` (MAX
 * docs, dev.max.ru/docs/webapps/introduction). Live shape 2026-10-06: {type:'OPEN_APP', text,
 * webApp:'maxnotifications_bot', contactId, payload}. MAX drops a payload over 512 chars or with
 * anything but [A-Za-z0-9_-], so such a payload is left out (the app opens on its start screen).
 * The payload is per-account — fine, the button only ever reaches the account it was sent to.
 */
export function miniAppLink(b: Record<string, unknown> | null | undefined): string | undefined {
  const app = typeof b?.webApp === 'string' ? b.webApp : '';
  if (!/^[A-Za-z0-9_]{1,64}$/.test(app)) return undefined;
  const payload = typeof b?.payload === 'string' ? b.payload : '';
  const start = /^[A-Za-z0-9_-]{1,512}$/.test(payload) ? `=${payload}` : '';
  return `https://max.ru/${app}?startapp${start}`;
}

/** callback_data of a MAX button with no Telegram counterpart (yet): pressing it only shows a hint. */
export const KEYBOARD_NA = 'tlmx_kb_na';

/**
 * A MAX INLINE_KEYBOARD attach as a Telegram inline keyboard, layout kept: LINK and CLIPBOARD map
 * to their Telegram twins, every other button (or one Telegram would refuse) becomes a
 * KEYBOARD_NA callback button. Clamped to Telegram's limits — 8 per row, 100 in total, 64 UTF-16
 * units of text. Undefined when nothing usable is left; never throws on a malformed attach.
 */
export function maxKeyboardToTelegram(att: unknown, chatId?: unknown): InlineKeyboardMarkup | undefined {
  const rows = (att as { keyboard?: { buttons?: unknown } } | null | undefined)?.keyboard?.buttons;
  if (!Array.isArray(rows)) return undefined;
  const str = (v: unknown): string => (typeof v === 'string' ? v : '');
  const callbackId = str((att as { callbackId?: unknown }).callbackId);
  const out: InlineKeyboardButton[][] = [];
  let left = 100;
  for (const row of rows) {
    if (!Array.isArray(row)) continue;
    const buttons: InlineKeyboardButton[] = [];
    for (const b of row as Array<Record<string, unknown> | null | undefined>) {
      if (buttons.length >= 8 || left <= 0) break;
      const text = truncateUtf16(str(b?.text), 64);
      if (!text.trim()) continue;
      const url = str(b?.url);
      const payload = str(b?.payload);
      if (b?.type === 'LINK' && /^(https?|tg):\/\/./i.test(url) && url.length <= 2048) {
        buttons.push({ text, url });
      } else if (b?.type === 'CLIPBOARD' && payload && payload.length <= 256) {
        // CopyTextButton (Bot API 7.11) is newer than telegraf's typings.
        buttons.push({ text, copy_text: { text: payload } } as unknown as InlineKeyboardButton);
      } else if (chatId != null && b?.type === 'CALLBACK' && callbackId) {
        buttons.push({ text, callback_data: registerButton({ chatId, callbackId, payload: payload || undefined, text }) });
      } else if (chatId != null && b?.type === 'MESSAGE') {
        // Pressing it in MAX sends the button's text to the bot as the user's own message.
        buttons.push({ text, callback_data: registerButton({ chatId, callbackId: '', text, sendsText: true }) });
      } else if (b?.type === 'OPEN_APP' && miniAppLink(b)) {
        // A mini-app can't run inside Telegram, but its public deep link opens it in MAX.
        buttons.push({ text, url: miniAppLink(b)! });
      } else if (b?.type === 'REQUEST_GEO_LOCATION') {
        buttons.push({ text, callback_data: KEYBOARD_GEO });
      } else if (b?.type === 'REQUEST_CONTACT') {
        buttons.push({ text, callback_data: KEYBOARD_CONTACT });
      } else {
        buttons.push({ text, callback_data: KEYBOARD_NA });
        logUnknownButton(b?.type, att);
      }
      left--;
    }
    if (buttons.length > 0) out.push(buttons);
  }
  return out.length > 0 ? { inline_keyboard: out } : undefined;
}

/**
 * MAX's own link preview — a SHARE attach: url, title, description, host, image (seen live
 * 2026-10-13 in a channel post) — goes as text, not as a «[вложение: SHARE]» placeholder: Telegram
 * draws its own preview from a link in the text. A link the text already has → dropped; otherwise
 * «🔗 title\nurl» is added. Pure + exported for unit testing.
 */
export function absorbShares<T extends { _type?: string }>(text: string | undefined, attaches: readonly T[]): { text: string | undefined; attaches: T[] } {
  if (!attaches.some((a) => a._type === 'SHARE')) return { text, attaches: [...attaches] };
  let out = text;
  for (const a of attaches) {
    if (a._type !== 'SHARE') continue;
    const s = a as unknown as { url?: unknown; title?: unknown };
    const url = typeof s.url === 'string' ? s.url.trim() : '';
    if (!url) continue;
    const bare = url.replace(/^https?:\/\//i, '').replace(/\/+$/, '').toLowerCase();
    if (out?.toLowerCase().includes(bare)) continue;
    const line = typeof s.title === 'string' && s.title.trim() ? `🔗 ${s.title.trim()}\n${url}` : `🔗 ${url}`;
    out = out ? `${out}\n\n${line}` : line;
  }
  return { text: out, attaches: attaches.filter((a) => a._type !== 'SHARE') };
}

/** Splits a message's attaches into its keyboard (the first usable one) and everything else. */
export function takeKeyboard<T>(attaches: readonly T[], chatId?: unknown): { attaches: T[]; keyboard: InlineKeyboardMarkup | undefined } {
  const isKeyboard = (a: T): boolean => (a as { _type?: unknown } | null)?._type === 'INLINE_KEYBOARD';
  let keyboard: InlineKeyboardMarkup | undefined;
  for (const a of attaches) if (isKeyboard(a)) keyboard ??= maxKeyboardToTelegram(a, chatId);
  return { attaches: attaches.filter((a) => !isKeyboard(a)), keyboard };
}
