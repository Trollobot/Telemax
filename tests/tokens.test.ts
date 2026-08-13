import { describe, expect, it } from 'vitest';
import { describeAuthError, findAuthToken, findLongToken } from '../src/max/tokens.js';

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
    const payload = { chats: [{ id: 1 }, { session: { value: token663 } }] };
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
