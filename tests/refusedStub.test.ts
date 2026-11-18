import { describe, expect, it } from 'vitest';
import { refusedStubText } from '../src/bridge/sync.js';

describe('refusedStubText', () => {
  it("names the MAX time and Telegram's reason", () => {
    const text = refusedStubText(Date.UTC(2026, 10, 14, 9, 30), { description: 'Bad Request: message is too long\nmore' }, 'UTC');
    expect(text).toContain('14.11.2026');
    expect(text).toContain('Bad Request: message is too long');
    expect(text).not.toContain('more');
  });
});
