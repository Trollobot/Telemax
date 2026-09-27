import { describe, expect, it } from 'vitest';
import { describeAuthError, findAuthToken, findLongToken, looksLikeToken } from '../src/max/tokens.js';

describe('findAuthToken', () => {
  it('reads a plain token field', () => {
    expect(findAuthToken({ token: 'abc123' })).toBe('abc123');
  });

  it('returns undefined when absent', () => {
    expect(findAuthToken({ other: 1 })).toBeUndefined();
    expect(findAuthToken(null)).toBeUndefined();
    expect(findAuthToken('str')).toBeUndefined();
  });
});

describe('findLongToken', () => {
  const token663 = 'a'.repeat(663);

  it('finds a matching string nested in a plain object', () => {
    expect(findLongToken({ 87: token663, other: 'short' })).toBe(token663);
  });

  it('finds a matching string nested in a Map', () => {
    const map = new Map<unknown, unknown>([
      [111, token663],
      [1, 'short'],
    ]);
    expect(findLongToken(map)).toBe(token663);
  });

  it('finds a matching string nested inside arrays and deeper objects', () => {
    const payload = { attrs: [{ id: 1 }, { session: { value: token663 } }] };
    expect(findLongToken(payload)).toBe(token663);
  });

  it('returns undefined when no string of that length exists', () => {
    expect(findLongToken({ token: 'too-short' })).toBeUndefined();
  });

  it('does not infinite-loop on cyclic structures', () => {
    const obj: Record<string, unknown> = { token: 'short' };
    obj.self = obj;
    expect(findLongToken(obj)).toBeUndefined();
  });

  // Review 2026-09-26, M5: a LOGIN OK response carries the account snapshot, and any 663-char
  // string in it used to be taken for a rotated token — saved, then rejected on the next resume.
  const post = ('Канал: новости дня, подробности по ссылке. ').repeat(20).slice(0, 663);

  it('never picks a 663-char channel post from the LOGIN snapshot', () => {
    expect(post).toHaveLength(663);
    const payload = {
      profile: { id: 1 },
      chats: [{ id: -100, lastMessage: { text: post } }],
      messages: { '-100': [{ text: post }] },
      time: 1,
    };
    expect(findLongToken(payload)).toBeUndefined();
  });

  it('rejects a 663-char text anywhere, even outside the snapshot branches', () => {
    expect(findLongToken({ description: post })).toBeUndefined();
    expect(findLongToken({ note: 'word '.repeat(133).slice(0, 663) })).toBeUndefined();
  });

  it('skips token-shaped strings inside snapshot branches and finds the real one', () => {
    const decoy = 'Z'.repeat(663);
    const real = 'An_' + 'b-9'.repeat(220);
    expect(real).toHaveLength(663);
    const payload = { chats: [{ lastMessage: { attaches: [{ previewData: decoy }] } }], token: real };
    expect(findLongToken(payload)).toBe(real);
  });

  it('skips snapshot keys inside a Map too', () => {
    const map = new Map<unknown, unknown>([['chats', [token663]]]);
    expect(findLongToken(map)).toBeUndefined();
  });
});

describe('looksLikeToken', () => {
  it('accepts base64 and base64url tokens of the exact length', () => {
    expect(looksLikeToken('A'.repeat(661) + '==')).toBe(true);
    expect(looksLikeToken('aZ09-_.~+/'.repeat(66) + 'abc')).toBe(true);
  });

  it('rejects the wrong length', () => {
    expect(looksLikeToken('a'.repeat(662))).toBe(false);
    expect(looksLikeToken('a'.repeat(664))).toBe(false);
  });

  it('rejects spaces, Cyrillic, URLs and punctuation outside the alphabet', () => {
    expect(looksLikeToken('a'.repeat(331) + ' ' + 'a'.repeat(331))).toBe(false);
    expect(looksLikeToken('ж'.repeat(663))).toBe(false);
    expect(looksLikeToken(('https://i.oneme.ru/i?r=' + 'x'.repeat(700)).slice(0, 663))).toBe(false);
    expect(looksLikeToken('a'.repeat(662) + '!')).toBe(false);
    expect(looksLikeToken('a'.repeat(330) + '=' + 'a'.repeat(332))).toBe(false); // '=' only as trailing padding
  });
});

describe('describeAuthError', () => {
  it('prefers localizedMessage, then message, then error', () => {
    expect(describeAuthError({ localizedMessage: 'a', message: 'b', error: 'c' }, 'fallback')).toBe('a');
    expect(describeAuthError({ message: 'b', error: 'c' }, 'fallback')).toBe('b');
    expect(describeAuthError({ error: 'c' }, 'fallback')).toBe('c');
  });

  it('falls back when nothing usable is present', () => {
    expect(describeAuthError(null, 'fallback')).toBe('fallback');
    expect(describeAuthError({}, 'fallback')).toBe('fallback');
  });
});
