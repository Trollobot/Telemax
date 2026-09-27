/**
 * Token extraction (max-protocol-full.md §3).
 *
 * auth_token (from START_AUTH) sits under a plain `token` key. login_token
 * (from CHECK_CODE) and session_token (from LOGIN) are both 663-character
 * strings, but which field key holds them has proven unreliable across
 * accounts/builds — the reference doc itself falls back to scanning the raw
 * response for the msgpack str16 marker rather than trusting a field number.
 * We do the equivalent after unpacking: walk the decoded object and return
 * the first string that is exactly 663 characters long AND looks like a token.
 *
 * Length alone is not enough: a LOGIN OK response carries
 * the whole account snapshot (chats with their last messages, messages, contacts,
 * config), and any 663-char string in there — a channel post, a description — was
 * taken for a rotated session token, saved, and bricked the session on the next
 * resume. So the walk skips those snapshot branches, and a candidate must use the
 * bearer-token alphabet only.
 */

const SESSION_TOKEN_LENGTH = 663;

/**
 * RFC 6750 b64token alphabet: base64 and base64url letters, digits, `-._~+/`, trailing `=`
 * padding. The live token's exact alphabet was never captured (tokens are only ever logged
 * masked); anything that is a bearer token fits this, while text (spaces, Cyrillic,
 * punctuation) and URLs (`:`, `?`, `&`, `%`) do not.
 */
const TOKEN_ALPHABET = /^[A-Za-z0-9\-._~+/]+=*$/;

/**
 * Account-snapshot branches of a LOGIN response (keys seen live: profile, chats, messages,
 * contacts, presence, config, time, updates — see MaxClient.login). User content lives
 * here, never the token, so the walk does not descend into them.
 */
const SNAPSHOT_KEYS = new Set(['profile', 'chats', 'messages', 'contacts', 'presence', 'config', 'updates']);

/** True for a string of exactly `length` characters from the token alphabet. */
export function looksLikeToken(value: string, length = SESSION_TOKEN_LENGTH): boolean {
  return value.length === length && TOKEN_ALPHABET.test(value);
}

export function findAuthToken(payload: unknown): string | undefined {
  if (payload && typeof payload === 'object' && !Array.isArray(payload)) {
    const token = (payload as Record<string, unknown>).token;
    if (typeof token === 'string') return token;
  }
  return undefined;
}

export function findLongToken(value: unknown, length = SESSION_TOKEN_LENGTH, seen = new Set<unknown>()): string | undefined {
  if (typeof value === 'string') {
    return looksLikeToken(value, length) ? value : undefined;
  }
  if (!value || typeof value !== 'object') return undefined;
  if (seen.has(value)) return undefined; // guard against cyclic structures
  seen.add(value);

  const entries: Iterable<[unknown, unknown]> =
    value instanceof Map ? value.entries() : Array.isArray(value) ? value.entries() : Object.entries(value as object);

  for (const [key, child] of entries) {
    if (typeof key === 'string' && SNAPSHOT_KEYS.has(key)) continue;
    const found = findLongToken(child, length, seen);
    if (found) return found;
  }
  return undefined;
}

export function describeAuthError(payload: unknown, fallback: string): string {
  if (payload && typeof payload === 'object') {
    const p = payload as Record<string, unknown>;
    const msg = p.localizedMessage ?? p.message ?? p.error;
    if (typeof msg === 'string') return msg;
  }
  return fallback;
}

export interface PasswordChallenge {
  trackId: string;
  /** User-supplied password hint, e.g. a reminder phrase — shown as-is, may be empty/absent. */
  hint?: string;
}

/** Present on CHECK_CODE's response instead of a login token when the account has a password set as a second factor (confirmed live 2026-08-14). */
export function extractPasswordChallenge(payload: unknown): PasswordChallenge | undefined {
  if (!payload || typeof payload !== 'object') return undefined;
  const challenge = (payload as Record<string, unknown>).passwordChallenge;
  if (!challenge || typeof challenge !== 'object') return undefined;
  const trackId = (challenge as Record<string, unknown>).trackId;
  if (typeof trackId !== 'string') return undefined;
  const hint = (challenge as Record<string, unknown>).hint;
  return { trackId, hint: typeof hint === 'string' ? hint : undefined };
}
