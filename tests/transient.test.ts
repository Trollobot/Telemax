import { describe, expect, it } from 'vitest';
import {
  isTransientHttpStatus,
  isTransientMaxError,
  isTransientNetworkError,
  isTransientTelegramError,
  TransientDownloadError,
} from '../src/bridge/transient.js';
import { downloadMaxAttachment, type DownloadContext } from '../src/bridge/attachments.js';
import { MaxConnectionLostError, type MaxClient } from '../src/max/client.js';

/** The shape telegraf's TelegramError has: an answered API error. */
function telegramError(code: number, description = 'x'): Error {
  return Object.assign(new Error(`${code}: ${description}`), { response: { ok: false, error_code: code, description } });
}

function withCode(message: string, code: string, name = 'Error'): Error {
  return Object.assign(new Error(message), { code, name });
}

describe('isTransientTelegramError', () => {
  it('treats 5xx and an outlasting 429 as transient', () => {
    expect(isTransientTelegramError(telegramError(500))).toBe(true);
    expect(isTransientTelegramError(telegramError(502, 'Bad Gateway'))).toBe(true);
    expect(isTransientTelegramError(telegramError(429, 'Too Many Requests: retry after 5'))).toBe(true);
  });

  it('treats an answered 4xx about THIS message as permanent', () => {
    expect(isTransientTelegramError(telegramError(400, 'Bad Request: message thread not found'))).toBe(false);
    expect(isTransientTelegramError(telegramError(400, 'Bad Request: message is too long'))).toBe(false);
    expect(isTransientTelegramError(telegramError(413, 'Request Entity Too Large'))).toBe(false);
  });

  it('treats a bridge-wide refusal (bot kicked, blocked, no rights) as transient', () => {
    // Once the admin restores the bot, every refused message can still go out — the cursor must not pass them.
    expect(isTransientTelegramError(telegramError(403, 'Forbidden: bot was kicked from the supergroup chat'))).toBe(true);
    expect(isTransientTelegramError(telegramError(403, 'Forbidden: bot was blocked by the user'))).toBe(true);
    expect(isTransientTelegramError(telegramError(400, 'Bad Request: not enough rights to send text messages to the chat'))).toBe(true);
    expect(isTransientTelegramError(telegramError(400, 'Bad Request: CHAT_WRITE_FORBIDDEN'))).toBe(true);
    expect(isTransientTelegramError(telegramError(400, 'Bad Request: have no rights to send a message'))).toBe(true);
    expect(isTransientTelegramError(telegramError(400, 'Bad Request: bot was kicked from the supergroup chat'))).toBe(true);
  });

  it('treats a missing answer (network, proxy, timeout) as transient', () => {
    // node-fetch (telegraf's transport)
    expect(isTransientTelegramError(withCode('request to https://api.telegram.org/bot[REDACTED]/sendMessage failed, reason: socket hang up', 'ECONNRESET', 'FetchError'))).toBe(true);
    expect(isTransientTelegramError(Object.assign(new Error('invalid json response body at … reason: Unexpected end of JSON input'), { name: 'FetchError', type: 'invalid-json' }))).toBe(true);
    for (const code of ['ETIMEDOUT', 'ECONNRESET', 'ECONNREFUSED', 'EAI_AGAIN', 'ENOTFOUND', 'EPIPE']) {
      expect(isTransientTelegramError(withCode(`connect ${code}`, code))).toBe(true);
    }
    expect(isTransientTelegramError(new Error('socket hang up'))).toBe(true);
    expect(isTransientTelegramError(Object.assign(new Error('The operation was aborted'), { name: 'AbortError' }))).toBe(true);
  });

  it('does not mistake a plain bug for an outage', () => {
    expect(isTransientTelegramError(new TypeError("Cannot read properties of undefined (reading 'message_id')"))).toBe(false);
    expect(isTransientTelegramError(undefined)).toBe(false);
    expect(isTransientTelegramError('boom')).toBe(false);
  });
});

describe('isTransientNetworkError', () => {
  it("follows undici's cause chain (fetch failed / terminated)", () => {
    expect(isTransientNetworkError(new TypeError('fetch failed', { cause: withCode('connect ECONNREFUSED', 'ECONNREFUSED') }))).toBe(true);
    expect(isTransientNetworkError(new TypeError('terminated', { cause: withCode('other side closed', 'UND_ERR_SOCKET') }))).toBe(true);
    expect(isTransientNetworkError(new TypeError('x', { cause: withCode('Connect Timeout Error', 'UND_ERR_CONNECT_TIMEOUT') }))).toBe(true);
    expect(isTransientNetworkError(Object.assign(new Error('The operation was aborted due to timeout'), { name: 'TimeoutError' }))).toBe(true);
    expect(isTransientNetworkError(new TypeError('x', { cause: new Error('something else') }))).toBe(false);
  });
});

describe('isTransientMaxError', () => {
  it('flags a dead or silent MAX socket', () => {
    expect(isTransientMaxError(new Error('MaxClient.send called while not connected'))).toBe(true);
    expect(isTransientMaxError(new Error('Timed out waiting for FILE_DOWNLOAD (0x58)'))).toBe(true);
    expect(isTransientMaxError(withCode('write EPIPE', 'EPIPE'))).toBe(true);
    // A request cut off by a lost socket (review 2026-09-26, M3).
    expect(isTransientMaxError(new MaxConnectionLostError('0x0040 [MSG_SEND]', new Error('socket closed')))).toBe(true);
  });

  it('flags MAX rate limiting — it left two topics empty after /reboot (live 2026-10-04)', () => {
    expect(isTransientMaxError(new Error('Слишком много запросов'))).toBe(true);
    expect(isTransientMaxError(new Error('too.many.requests'))).toBe(true);
  });

  it('keeps a real MAX refusal permanent', () => {
    expect(isTransientMaxError(new Error('FILE_DOWNLOAD did not return a url: file not found'))).toBe(false);
    expect(isTransientMaxError(new Error('VIDEO_PLAY did not return any playback urls: access denied'))).toBe(false);
  });
});

describe('isTransientHttpStatus', () => {
  it('retries server trouble, not refusals', () => {
    expect([500, 502, 503, 504, 408, 429].map(isTransientHttpStatus)).toEqual([true, true, true, true, true, true]);
    expect([400, 401, 403, 404, 410].map(isTransientHttpStatus)).toEqual([false, false, false, false, false]);
  });
});

describe('downloadMaxAttachment transient reporting', () => {
  const file = { _type: 'FILE', fileId: 7n, name: 'a.pdf' } as const;
  function ctx(err: Error, throwOnTransient?: boolean): DownloadContext {
    const max = { getFileDownloadUrl: async () => Promise.reject(err) } as unknown as MaxClient;
    return { max, chatId: 1, messageId: 2, throwOnTransient };
  }

  it('throws TransientDownloadError for a dead MAX socket only when the caller opted in (backfill)', async () => {
    const down = new Error('MaxClient.send called while not connected');
    await expect(downloadMaxAttachment(file, ctx(down, true))).rejects.toBeInstanceOf(TransientDownloadError);
    // Live path: placeholder as before.
    await expect(downloadMaxAttachment(file, ctx(down))).resolves.toBeNull();
  });

  it('returns null for a permanent MAX refusal either way', async () => {
    const denied = new Error('FILE_DOWNLOAD did not return a url: file not found');
    await expect(downloadMaxAttachment(file, ctx(denied, true))).resolves.toBeNull();
    await expect(downloadMaxAttachment(file, ctx(denied))).resolves.toBeNull();
  });
});
