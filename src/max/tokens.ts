/**
 * Token extraction (max-protocol-full.md §3).
 *
 * auth_token (from START_AUTH) sits under a plain `token` key. login_token
 * (from CHECK_CODE) and session_token (from LOGIN) are both 663-character
 * strings, but which field key holds them has proven unreliable across
 * accounts/builds — the reference doc itself falls back to scanning the raw
 * response for the msgpack str16 marker rather than trusting a field number.
 * We do the equivalent after unpacking: walk the decoded object and return
 * whichever string is exactly 663 characters long.
 */

const SESSION_TOKEN_LENGTH = 663;

export function findAuthToken(payload: unknown): string | undefined {
  if (payload && typeof payload === 'object' && !Array.isArray(payload)) {
    const token = (payload as Record<string, unknown>).token;
    if (typeof token === 'string') return token;
  }
  return undefined;
}

export function findLongToken(value: unknown, length = SESSION_TOKEN_LENGTH, seen = new Set<unknown>()): string | undefined {
  if (typeof value === 'string') {
    return value.length === length ? value : undefined;
  }
  if (!value || typeof value !== 'object') return undefined;
  if (seen.has(value)) return undefined; // guard against cyclic structures
  seen.add(value);

  const children: Iterable<unknown> =
    value instanceof Map ? value.values() : Array.isArray(value) ? value : Object.values(value as object);

  for (const child of children) {
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
