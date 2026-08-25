/**
 * Telegram -> MAX attachment upload. Protocol details (opcodes, upload-slot
 * shapes, Content-Range requirement, the empirical 3s processing delay for
 * FILE, the video-ready signal) supplied by the user from their own
 * reverse-engineering on 2026-08-07 — not in max-protocol-full.md.
 */
import { gzipSync } from 'node:zlib';
import https from 'node:https';
import type { Agent } from 'node:http';
import type { Telegraf } from 'telegraf';
// undici's own FormData, not the global one: maxFetch runs on undici's fetch, and
// the npm package's types are nominally incompatible with @types/node's bundled
// undici-types copy behind the global — same class at runtime either way.
import { FormData } from 'undici';
import type { MaxClient } from '../max/client.js';
import { maxFetch } from '../max/ca.js';
import { getTelegramProxyAgent } from '../telegram/proxy.js';
import { renderTgsToWebm } from './lottie.js';

async function fetchTelegramFile(bot: Telegraf, fileId: string): Promise<Buffer> {
  // getFileLink is a Bot API call — it already goes through Telegraf's (possibly
  // proxied) client. Only the download of the returned api.telegram.org/file/… URL
  // bypasses Telegraf, so it's the one spot that needs the proxy applied by hand.
  const link = await bot.telegram.getFileLink(fileId);
  const agent = getTelegramProxyAgent();
  if (!agent) {
    // Bounded like the proxied branch below (its https.get carries timeout: 30_000) —
    // a hung CDN response must not stall the relay handler forever.
    const res = await fetch(link.toString(), { signal: AbortSignal.timeout(120_000) });
    if (!res.ok) throw new Error(`Failed to download Telegram file: ${res.status}`);
    return Buffer.from(await res.arrayBuffer());
  }
  // Native fetch (undici) can't take an http.Agent, so when a proxy is configured we
  // pull the file through node's https with the same agent Telegraf uses.
  return downloadViaAgent(link.toString(), agent);
}

function downloadViaAgent(url: string, agent: Agent): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const req = https.get(url, { agent, timeout: 30_000 }, (res) => {
      if (res.statusCode && res.statusCode >= 400) {
        res.resume();
        reject(new Error(`Failed to download Telegram file: ${res.statusCode}`));
        return;
      }
      const chunks: Buffer[] = [];
      res.on('data', (c) => chunks.push(c as Buffer));
      res.on('end', () => resolve(Buffer.concat(chunks)));
      res.on('error', reject);
    });
    req.on('timeout', () => req.destroy(new Error('Telegram file download timed out')));
    req.on('error', reject);
  });
}

/**
 * MAX's upload endpoint URL-DECODES the value after `filename=` and reads it as
 * UTF-8 — nothing else works. Established empirically across three live rounds
 * (2026-08-15):
 *   - quoted/RFC 5987 forms: no parsing at all, the boilerplate got glued into
 *     the stored name (`"file"_ filename__UTF-8__Доплаты.xlsx`) — but crucially
 *     the percent-encoded part came back as readable Cyrillic WITH spaces, which
 *     is what gave the decoding behavior away;
 *   - raw UTF-8 bytes (latin1-smuggled past undici's ByteString check): stored
 *     as Latin-1 mojibake (`ÐÐ_Ñ_Ð²...`).
 * Percent-encoding is also plain ASCII, so undici's header validation is happy
 * without any tricks. encodeURIComponent leaves `(1)`-style parens intact and
 * MAX decodes %20 back to spaces — ASCII names round-trip unchanged.
 */
function contentDispositionFor(filename: string): string {
  const clean = filename.replace(/[\r\n"\\]/g, '_');
  return `attachment; filename=${encodeURIComponent(clean)}`;
}

async function uploadPhotoToMax(max: MaxClient, buffer: Buffer): Promise<{ _type: 'PHOTO'; photoToken: string }> {
  const { url } = await max.requestPhotoUpload();
  const form = new FormData();
  form.append('file', new Blob([buffer], { type: 'image/jpeg' }), 'photo.jpg');
  const res = await maxFetch(url, {
    method: 'POST',
    headers: {
      'User-Agent': 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36',
      Accept: '*/*',
    },
    body: form,
  });
  if (!res.ok) {
    const bodyText = await res.text().catch(() => '<unreadable>');
    throw new Error(`Photo upload POST failed: ${res.status} ${res.statusText} — ${bodyText}`);
  }
  const body = (await res.json()) as { photos?: Record<string, { token: string }> };
  const first = body.photos ? Object.values(body.photos)[0] : undefined;
  if (!first) throw new Error('Photo upload response had no photos');
  return { _type: 'PHOTO', photoToken: first.token };
}

async function uploadFileToMax(max: MaxClient, buffer: Buffer, filename: string): Promise<{ _type: 'FILE'; fileId: unknown }> {
  const slot = await max.requestFileUpload();
  const res = await maxFetch(slot.url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/octet-stream',
      'Content-Range': `bytes 0-${buffer.length - 1}/${buffer.length}`,
      'Content-Length': String(buffer.length),
      'Content-Disposition': contentDispositionFor(filename),
    },
    body: buffer,
  });
  if (!res.ok) {
    const bodyText = await res.text().catch(() => '<unreadable>');
    throw new Error(`File upload POST failed: ${res.status} ${res.statusText} — ${bodyText}`);
  }
  // Empirically observed: MAX needs a moment to finish processing the upload
  // server-side before the resulting fileId is valid to reference in MSG_SEND.
  await new Promise((resolve) => setTimeout(resolve, 3000));
  return { _type: 'FILE', fileId: slot.fileId };
}

/**
 * Voice notes go through the SAME upload opcode as video (0x52, `type: 2`), not
 * FILE_UPLOAD — confirmed live by the user 2026-08-13 after two earlier guesses
 * (FILE_UPLOAD+sleep, then FILE_UPLOAD+VOICE_READY-wait) both failed. Two other
 * details matter and are easy to get wrong by copying uploadFileToMax's headers:
 * plain `application/octet-stream` (not the real audio mime type — that guess
 * also failed), and `Content-Range` WITHOUT the `bytes ` prefix every other
 * upload here uses. `audioId` in the resulting attach is the same id as the
 * upload slot's `videoId` — MAX just names it differently depending on the
 * attach type it ends up in.
 */
async function uploadVoiceToMax(max: MaxClient, buffer: Buffer, filename: string, duration: number): Promise<{ _type: 'AUDIO'; audioId: unknown; token: string; duration: number }> {
  const slot = await max.requestVoiceUploadSlot();
  const readyPromise = max.waitForAudioReady(); // start listening before the POST so the push can't arrive unheard
  const res = await maxFetch(slot.url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/octet-stream',
      'Content-Range': `0-${buffer.length - 1}/${buffer.length}`,
      'Content-Length': String(buffer.length),
      'Content-Disposition': contentDispositionFor(filename),
    },
    body: buffer,
  });
  if (!res.ok) {
    const bodyText = await res.text().catch(() => '<unreadable>');
    throw new Error(`Voice upload POST failed: ${res.status} ${res.statusText} — ${bodyText}`);
  }
  await readyPromise;
  return { _type: 'AUDIO', audioId: slot.videoId, token: slot.token, duration };
}

async function uploadVideoToMax(
  max: MaxClient,
  buffer: Buffer,
  filename: string,
  contentType = 'video/mp4',
): Promise<{ _type: 'VIDEO'; videoId: unknown; token: string }> {
  const slot = await max.requestVideoUpload();
  const readyPromise = max.waitForVideoReady(); // start listening before the POST so the push can't arrive unheard
  const res = await maxFetch(slot.url, {
    method: 'POST',
    headers: {
      'Content-Type': contentType,
      'Content-Range': `bytes 0-${buffer.length - 1}/${buffer.length}`,
      'Content-Length': String(buffer.length),
      'Content-Disposition': contentDispositionFor(filename),
    },
    body: buffer,
  });
  if (!res.ok) {
    const bodyText = await res.text().catch(() => '<unreadable>');
    throw new Error(`Video upload POST failed: ${res.status} ${res.statusText} — ${bodyText}`);
  }
  await readyPromise;
  return { _type: 'VIDEO', videoId: slot.videoId, token: slot.token };
}

export type UploadKind = 'photo' | 'document' | 'video' | 'voice' | 'sticker_animated';

/** Downloads a Telegram attachment and uploads it to MAX, returning the attach object for MSG_SEND. `duration` (seconds) is only used for 'voice'. */
export async function uploadTelegramAttachmentToMax(
  bot: Telegraf,
  max: MaxClient,
  telegramFileId: string,
  kind: UploadKind,
  filename = 'file',
  duration = 0,
): Promise<Record<string, unknown>> {
  const buffer = await fetchTelegramFile(bot, telegramFileId);

  if (kind === 'sticker_animated') {
    // No confirmed native MAX sticker-upload opcode — render the Lottie to a short
    // WebM and send it through the ordinary (proven) video pipeline instead. MAX's
    // own animated stickers arrive as autoplaying VIDEO attaches, so this gets the
    // same "plays in the feed" result without needing MAX's real sticker format.
    const webm = await renderTgsToWebm(buffer);
    return uploadVideoToMax(max, webm, 'sticker.webm', 'video/webm');
  }

  let uploadBuffer = buffer;
  if (filename.endsWith('.tgs') && !(buffer[0] === 0x1f && buffer[1] === 0x8b)) {
    // A .tgs sticker is itself gzip-compressed Lottie JSON, but Telegram's CDN may or
    // may not additionally mark the HTTP response Content-Encoding: gzip — if it does,
    // fetch() silently auto-decompresses it, leaving us with raw JSON under a `.tgs`
    // name instead of a real gzip file (same bug hit on the MAX -> Telegram direction
    // 2026-08-13, where MAX's CDN does set that header). Detect via the gzip magic
    // bytes rather than assuming either way, and re-gzip only when they're missing.
    uploadBuffer = gzipSync(buffer);
  }
  if (kind === 'photo') return uploadPhotoToMax(max, uploadBuffer);
  if (kind === 'video') return uploadVideoToMax(max, uploadBuffer, filename);
  if (kind === 'voice') return uploadVoiceToMax(max, uploadBuffer, filename, duration);
  return uploadFileToMax(max, uploadBuffer, filename);
}
