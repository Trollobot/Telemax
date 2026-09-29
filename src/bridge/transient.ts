/**
 * Transient-vs-permanent error classification for the history cursor.
 *
 * A permanent refusal (a 4xx — the message is bad and resending won't help) is "done": log, move
 * the cursor on. An outage (Telegram/proxy unreachable, 5xx, flood limit, MAX socket down
 * mid-download) must stop the chat's backfill WITHOUT moving its cursor — the cursor is the lower
 * bound of every later catch-up, so everything the outage touched would be lost for good.
 *
 * Pure + exported for unit testing (withFloodRetry aside — it lives here so that both sync.ts and
 * telegram/bot.ts can import it without a cycle).
 */
import { createLogger } from '../logger.js';

const logger = createLogger('bridge');

// Socket/DNS-level failures from node (telegraf's node-fetch, the MAX TLS socket) and undici
// (maxFetch — undici wraps them as TypeError('fetch failed') with the code on `cause`).
const NETWORK_CODES = new Set([
  'ETIMEDOUT',
  'ECONNRESET',
  'ECONNREFUSED',
  'ECONNABORTED',
  'EAI_AGAIN',
  'ENOTFOUND',
  'EPIPE',
  'EHOSTUNREACH',
  'ENETUNREACH',
  'ENETDOWN',
  'ERR_SOCKET_CLOSED',
  'ERR_STREAM_DESTROYED',
  'ERR_STREAM_WRITE_AFTER_END',
  'UND_ERR_CONNECT_TIMEOUT',
  'UND_ERR_HEADERS_TIMEOUT',
  'UND_ERR_BODY_TIMEOUT',
  'UND_ERR_SOCKET',
  'UND_ERR_CLOSED',
]);

const NETWORK_MESSAGE =
  /socket hang up|fetch failed|network timeout|socket closed|other side closed|ECONNRESET|ETIMEDOUT|ECONNREFUSED|ECONNABORTED|EAI_AGAIN|ENOTFOUND|EPIPE|EHOSTUNREACH|ENETUNREACH|socks/i;

/**
 * A connectivity failure: no answer came back at all (reset, refused, DNS, timeout, proxy down).
 * node-fetch's FetchError (telegraf's transport — its message carries "request to … failed,
 * reason: …", including an unparseable/truncated body from a dropping proxy), an abort/timeout
 * (AbortSignal.timeout → TimeoutError) and undici's "fetch failed"/"terminated" all count. A plain
 * programming error (TypeError from our own code) does not — misreading a bug as an outage would
 * park the chat's cursor on it.
 */
export function isTransientNetworkError(err: unknown, depth = 0): boolean {
  if (!err || typeof err !== 'object') return false;
  const e = err as { code?: unknown; name?: unknown; message?: unknown; cause?: unknown };
  if (typeof e.code === 'string' && NETWORK_CODES.has(e.code)) return true;
  if (e.name === 'FetchError' || e.name === 'AbortError' || e.name === 'TimeoutError') return true;
  if (typeof e.message === 'string' && (NETWORK_MESSAGE.test(e.message) || e.message === 'terminated')) return true;
  return depth < 3 && e.cause != null && isTransientNetworkError(e.cause, depth + 1);
}

/**
 * A 400 that refuses the BOT, not the message: the bot lost the right to post (or was removed)
 * from the group. Telegram answers most of these as 403, some as 400 with this wording.
 */
const RIGHTS_REFUSAL = /not enough rights|CHAT_WRITE_FORBIDDEN|have no rights|bot was kicked/i;

/**
 * Telegram Bot API failure that is worth retrying later: a 5xx / 429 answer (telegraf's
 * TelegramError carries it on `response.error_code`; its 5xx path fills in the HTTP status), no
 * Telegram answer at all (network/proxy), or a bridge-wide refusal — 403 (bot kicked/blocked) or
 * a 400 about missing rights: once the admin restores the bot, every message it refused can still
 * go out, so it must not count as "done". Every other answered error — 400 bad request, 413 too
 * large — is permanent for that message. 429 is normally absorbed by withFloodRetry; one that
 * outlasts it still means "not now", not "never".
 */
export function isTransientTelegramError(err: unknown): boolean {
  const response = (err as { response?: unknown } | null | undefined)?.response;
  if (response && typeof response === 'object' && (response as { error_code?: unknown }).error_code != null) {
    const { error_code, description } = response as { error_code?: unknown; description?: unknown };
    const code = Number(error_code);
    if (code === 429 || code >= 500 || code === 403) return true;
    return code === 400 && typeof description === 'string' && RIGHTS_REFUSAL.test(description);
  }
  return isTransientNetworkError(err);
}

/**
 * MaxClient request failure that says nothing about the request itself: the socket is gone
 * (disconnect()/reconnect → "send called while not connected", "connection lost" for a request
 * cut off in flight, a write/reset on a dead socket)
 * or no answer arrived in time. A DIR.ERR answer from MAX (access denied, file not found) is a
 * real refusal — permanent.
 */
export function isTransientMaxError(err: unknown): boolean {
  const msg = err instanceof Error ? err.message : typeof err === 'string' ? err : '';
  if (/MaxClient\.send called while not connected|MaxClient connection lost|Timed out waiting for /.test(msg)) return true;
  return isTransientNetworkError(err);
}

/** HTTP status of a MAX CDN download worth retrying later (server trouble, rate limit, timeout). */
export function isTransientHttpStatus(status: number): boolean {
  return status >= 500 || status === 408 || status === 429;
}

/**
 * A MAX attachment could not be downloaded for a transient reason (see isTransientMaxError /
 * isTransientHttpStatus / isTransientNetworkError). Thrown by downloadMaxAttachment only when the
 * caller opted in with DownloadContext.throwOnTransient (the backfill); the live path keeps its
 * text placeholder instead.
 */
export class TransientDownloadError extends Error {
  constructor(message: string, cause?: unknown) {
    super(message, { cause });
    this.name = 'TransientDownloadError';
  }
}

/** Telegram's flood-control 429 carries how long to wait — honor it instead of failing the send.
 * Capped: an endless 429 (the bot got flagged/limited for real) must eventually surface as an
 * error instead of holding a backfill loop hostage forever. */
const FLOOD_RETRY_MAX_ATTEMPTS = 5;
export async function withFloodRetry<T>(fn: () => Promise<T>): Promise<T> {
  for (let attempt = 1; ; attempt++) {
    try {
      return await fn();
    } catch (err) {
      const retryAfter = (err as { response?: { parameters?: { retry_after?: number } } })?.response?.parameters?.retry_after;
      if (!retryAfter || attempt >= FLOOD_RETRY_MAX_ATTEMPTS) throw err;
      logger.info(`Telegram flood control: waiting ${retryAfter}s (attempt ${attempt}/${FLOOD_RETRY_MAX_ATTEMPTS})`);
      await new Promise((resolve) => setTimeout(resolve, (retryAfter + 1) * 1000));
    }
  }
}
// NOTE: wrap ONE Telegram call, never a function that sends several — a retry re-runs `fn` from
// the top and posts again everything delivered before the 429 (a wrapped sendAttachments duplicated albums).

/** Telegram's error when you touch a forum topic that's since been deleted. The exact
 * code depends on the method: sendMessage/sendPhoto to a dead thread answer "message
 * thread not found", while editForumTopic answers TOPIC_ID_INVALID (seen live 2026-08-18
 * from startDialog's liveness probe). Both mean the same thing — the topic is gone.
 * Shared by the topic self-heal and deletion probe (sync.ts) and the bug-report inbox (bugReports.ts). */
export function isThreadNotFound(err: unknown): boolean {
  const msg = err instanceof Error ? err.message : String(err);
  return /message thread not found|thread not found|TOPIC_DELETED|TOPIC_ID_INVALID/i.test(msg);
}
