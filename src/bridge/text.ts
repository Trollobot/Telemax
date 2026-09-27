/**
 * Length limits for user text on its way into Telegram.
 *
 * Telegram counts message/caption/topic-name limits in UTF-16 code units, and rejects a string
 * that carries a lone surrogate ("text must be encoded in UTF-8") — so a naive `.slice(0, n)`
 * that lands inside an emoji's surrogate pair loses the whole message, and a text over 4096
 * units is refused outright ("message is too long"). These helpers never split a pair.
 *
 * Pure + exported for unit testing.
 */

/** Bot API limit for a text message (sendMessage / editMessageText). */
export const TELEGRAM_TEXT_LIMIT = 4096;
/** Bot API limit for a media caption (editMessageCaption). */
export const TELEGRAM_CAPTION_LIMIT = 1024;

function isHighSurrogate(code: number): boolean {
  return code >= 0xd800 && code <= 0xdbff;
}

/** At most `maxUnits` UTF-16 code units of `s`, never ending on half of a surrogate pair. */
export function truncateUtf16(s: string, maxUnits: number): string {
  if (s.length <= maxUnits) return s;
  let end = Math.max(0, maxUnits);
  if (end > 0 && isHighSurrogate(s.charCodeAt(end - 1))) end--;
  return s.slice(0, end);
}

/** At most `maxCodePoints` code points of `s` (an emoji counts as one), plus `ellipsis` when something was cut. */
export function truncateCodePoints(s: string, maxCodePoints: number, ellipsis = ''): string {
  const points = Array.from(s);
  if (points.length <= maxCodePoints) return s;
  return points.slice(0, Math.max(0, maxCodePoints)).join('') + ellipsis;
}

/**
 * Splits a text into pieces Telegram accepts (each at most `limit` UTF-16 units). Cuts at the
 * last newline, else the last space, in the second half of a piece — dropping that one
 * separator — and only falls back to a hard cut (surrogate-safe) for a run with neither.
 * Whitespace-only pieces are dropped (Telegram refuses an empty message). A text that already
 * fits comes back as a single piece; an empty/blank text as none.
 */
export function splitTelegramText(text: string, limit = TELEGRAM_TEXT_LIMIT): string[] {
  const out: string[] = [];
  const push = (piece: string): void => {
    if (piece.trim()) out.push(piece);
  };
  const minBoundary = Math.floor(limit / 2);
  let rest = text;
  while (rest.length > limit) {
    // The char right AT `limit` may be the separator itself — the piece before it still fits.
    const window = rest.slice(0, limit + 1);
    let cut = window.lastIndexOf('\n');
    if (cut < minBoundary) cut = window.lastIndexOf(' ');
    if (cut >= minBoundary) {
      push(rest.slice(0, cut));
      rest = rest.slice(cut + 1);
      continue;
    }
    // (A limit under 2 can't hold a surrogate pair — take the pair anyway rather than loop forever.)
    const piece = truncateUtf16(rest, limit) || rest.slice(0, 2);
    push(piece);
    rest = rest.slice(piece.length);
  }
  push(rest);
  return out;
}
