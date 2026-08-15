/**
 * Reaction-emoji normalization between Telegram and MAX.
 *
 * The two platforms use the same emoji but disagree on *presentation form*:
 * Telegram's Bot API emits certain reactions in their bare (text-presentation)
 * form — heart as "❤" (U+2764), no U+FE0F — while MAX stores/expects the
 * emoji-presentation form ("❤️", U+2764 U+FE0F) and rejects the bare one with
 * `error.message.like.unknown.like`. Confirmed live 2026-08-15: "❤" failed on
 * addReaction, "👍" (which has no text/emoji ambiguity) worked.
 *
 * So this isn't an emoji↔emoji lookup table — it's a variation-selector fix. The
 * only code points that need it are those with Unicode Emoji_Presentation=No that
 * still appear in Telegram's reaction set; adding U+FE0F after them yields MAX's
 * form, and stripping it yields Telegram's. Handles ZWJ sequences (e.g. ❤‍🔥,
 * 🤷‍♂️) too, since it walks code points and fixes each base in place.
 */

/** Base code points from Telegram's reaction set whose default presentation is text, so MAX's emoji form needs a trailing U+FE0F. */
const NEEDS_VARIATION_SELECTOR = new Set<number>([
  0x2764, // ❤ heavy black heart
  0x270d, // ✍ writing hand
  0x2603, // ☃ snowman
  0x1f54a, // 🕊 dove
  0x2642, // ♂ male sign (in 🤷‍♂️)
  0x2640, // ♀ female sign (in 🤷‍♀️)
]);

const FE0F = 0xfe0f;

/** Telegram → MAX: re-add the U+FE0F that Telegram drops, so MAX accepts the reaction. Idempotent — a form that already has it is left unchanged. */
export function toMaxReaction(emoji: string): string {
  const cps = [...emoji].map((c) => c.codePointAt(0) as number);
  let out = '';
  for (let i = 0; i < cps.length; i++) {
    const cp = cps[i] as number;
    out += String.fromCodePoint(cp);
    if (NEEDS_VARIATION_SELECTOR.has(cp) && cps[i + 1] !== FE0F) out += '️';
  }
  return out;
}

/** MAX → Telegram: strip U+FE0F, since Telegram's setMessageReaction wants the bare form for exactly these emoji. */
export function toTelegramReaction(emoji: string): string {
  return emoji.replace(/️/g, '');
}
