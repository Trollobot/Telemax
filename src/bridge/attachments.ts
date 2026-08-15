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
}

// Every URL that reaches this helper is a MAX-owned host (photo/sticker/file/video
// CDN) — hence maxFetch, which trusts the Russian state chain those certs use.
async function downloadUrl(url: string): Promise<Buffer | null> {
  try {
    const res = await maxFetch(url);
    if (!res.ok) {
      logger.error(`downloadUrl got non-OK response ${res.status} ${res.statusText} for ${url}`);
      return null;
    }
    return Buffer.from(await res.arrayBuffer());
  } catch (err) {
    logger.error(`downloadUrl threw for ${url}`, err);
    return null;
  }
}

export async function downloadMaxAttachment(att: MaxAttachment, ctx: DownloadContext): Promise<DownloadedAttachment | null> {
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
    const buffer = await downloadUrl(att.lottieUrl);
    if (buffer) return { buffer: gzipSync(buffer), filename: `sticker_${String(att.stickerId ?? Date.now())}.tgs`, kind: 'sticker' };
  }

  if (att._type === 'STICKER' && att.url) {
    const buffer = await downloadUrl(att.url);
    if (!buffer) return null;
    // Confirmed live 2026-08-13: this preview URL serves image/png regardless of
    // sticker type, so it renders properly through the PHOTO pipeline.
    return { buffer, filename: `sticker_${String(att.stickerId ?? Date.now())}.png`, kind: 'photo' };
  }

  if (att._type === 'FILE' && att.fileId != null) {
    try {
      const url = await ctx.max.getFileDownloadUrl(ctx.chatId, ctx.messageId, att.fileId);
      const buffer = await downloadUrl(url);
      if (!buffer) return null;
      // A literal quote in a MAX-side filename breaks telegraf's multipart
      // Content-Disposition — Telegram's server drops the connection mid-response
      // and sendDocument dies with "invalid json response body" (hit live
      // 2026-08-15 with names an earlier upload bug had quoted).
      const safeName = (att.name ?? `file_${Date.now()}`).replace(/[\r\n"\\]/g, '_');
      return { buffer, filename: safeName, kind: 'document' };
    } catch (err) {
      logger.error(`FILE_DOWNLOAD failed for fileId ${String(att.fileId)} (chatId=${String(ctx.chatId)}, messageId=${String(ctx.messageId)})`, err);
      return null;
    }
  }

  if (att._type === 'AUDIO' && att.url) {
    const buffer = await downloadUrl(att.url);
    if (!buffer) return null;
    return { buffer, filename: `voice_${String(att.audioId ?? Date.now())}.ogg`, kind: 'voice' };
  }

  if (att._type === 'VIDEO' && att.videoId != null) {
    try {
      const urls = await ctx.max.getVideoPlayUrls(ctx.chatId, ctx.messageId, att.videoId);
      const mp4Key = Object.keys(urls)
        .filter((k) => k.startsWith('MP4_'))
        .sort((a, b) => Number(b.slice(4)) - Number(a.slice(4)))[0]; // highest resolution first
      const url = mp4Key ? urls[mp4Key] : undefined;
      if (!url) return null;
      const buffer = await downloadUrl(url);
      if (!buffer) return null;
      return { buffer, filename: `video_${String(att.videoId)}.mp4`, kind: att.videoType === 1 ? 'video_note' : 'video' };
    } catch (err) {
      logger.error(`VIDEO_PLAY failed for videoId ${String(att.videoId)} (chatId=${String(ctx.chatId)}, messageId=${String(ctx.messageId)})`, err);
      return null;
    }
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
