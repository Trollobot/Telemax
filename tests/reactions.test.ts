import { describe, expect, it } from 'vitest';
import { toMaxReaction, toTelegramReaction } from '../src/max/reactions.js';

describe('toMaxReaction (Telegram -> MAX: add variation selector)', () => {
  it('adds U+FE0F to a bare heart', () => {
    expect(toMaxReaction('❤')).toBe('❤️'); // ❤ -> ❤️
  });

  it('leaves emoji that need no variation selector untouched', () => {
    expect(toMaxReaction('👍')).toBe('👍');
    expect(toMaxReaction('🔥')).toBe('🔥');
    expect(toMaxReaction('🎉')).toBe('🎉');
  });

  it('is idempotent — a heart that already has the selector is unchanged', () => {
    expect(toMaxReaction('❤️')).toBe('❤️');
  });

  it('fixes the base inside a ZWJ sequence (heart on fire)', () => {
    // ❤‍🔥 = 2764 200D 1F525 (bare heart) -> 2764 FE0F 200D 1F525
    expect(toMaxReaction('❤‍\u{1F525}')).toBe('❤️‍\u{1F525}');
  });

  it('fixes the male sign inside a shrug sequence', () => {
    // 🤷‍♂ = 1F937 200D 2642 -> ...2642 FE0F
    expect(toMaxReaction('\u{1F937}‍♂')).toBe('\u{1F937}‍♂️');
  });
});

describe('toTelegramReaction (MAX -> Telegram: strip variation selector)', () => {
  it('strips U+FE0F from a heart', () => {
    expect(toTelegramReaction('❤️')).toBe('❤');
  });

  it('leaves a bare heart unchanged', () => {
    expect(toTelegramReaction('❤')).toBe('❤');
  });

  it('leaves selector-free emoji untouched', () => {
    expect(toTelegramReaction('👍')).toBe('👍');
  });

  it('round-trips: TG -> MAX -> TG returns the original bare form', () => {
    for (const e of ['❤', '👍', '🔥', '✍', '☃']) {
      expect(toTelegramReaction(toMaxReaction(e))).toBe(e);
    }
  });
});
