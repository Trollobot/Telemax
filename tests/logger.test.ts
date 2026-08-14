import { describe, expect, it } from 'vitest';
import { jsonStringify, redactSecrets } from '../src/logger.js';

describe('redactSecrets', () => {
  it('fully redacts short secrets instead of partially revealing them', () => {
    const out = redactSecrets({ password: 'hunter2hunter2', verifyCode: '123456' }) as Record<string, unknown>;
    expect(out.password).toBe('[redacted]');
    expect(out.verifyCode).toBe('[redacted]');
  });

  it('redacts the CHECK_PASSWORD payload shape (password + trackId)', () => {
    // The exact payload MaxClient.checkPassword() sends — this going to the
    // web-panel packet log unmasked is the leak this suite exists to prevent.
    const out = redactSecrets({ trackId: 'track-12345-abcdef', password: 'секретный пароль' }) as Record<string, unknown>;
    expect(out.password).toBe('[redacted]');
    expect(out.trackId).toBe('[redacted]');
  });

  it('partially reveals only long tokens (first/last 4 chars)', () => {
    const token = 'a'.repeat(300) + 'zzzz';
    const out = redactSecrets({ token }) as Record<string, unknown>;
    expect(out.token).toBe(`aaaa...zzzz (${token.length})`);
  });

  it('masks any 512+ char string regardless of its key — token field names are unreliable', () => {
    const sessionToken = 'x'.repeat(663);
    const out = redactSecrets({ someUnknownWrapperKey: sessionToken }) as Record<string, unknown>;
    expect(out.someUnknownWrapperKey).toBe(`xxxx...xxxx (${sessionToken.length})`);
  });

  it('leaves ordinary payload values alone', () => {
    const payload = { chatId: 42, message: { text: 'привет', cid: 1 } };
    expect(redactSecrets(payload)).toEqual(payload);
  });

  it('recurses into nested objects and arrays', () => {
    const out = redactSecrets({ items: [{ auth: { password: 'p@ssword-long-enough' } }] }) as {
      items: Array<{ auth: { password: string } }>;
    };
    expect(out.items[0]?.auth.password).toBe('[redacted]');
  });

  it('redacts non-string secret values instead of leaking their type contents', () => {
    const out = redactSecrets({ phone: 79991234567n }) as Record<string, unknown>;
    expect(out.phone).toBe('[redacted]');
  });

  it('survives circular structures', () => {
    const obj: Record<string, unknown> = { a: 1 };
    obj.self = obj;
    const out = redactSecrets(obj) as Record<string, unknown>;
    expect(out.a).toBe(1);
    expect(out.self).toBe('[circular]');
  });
});

describe('jsonStringify', () => {
  it('serializes BigInt values instead of throwing', () => {
    expect(jsonStringify({ id: 123n })).toBe('{"id":"123n"}');
  });
});
