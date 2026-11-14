import { describe, expect, it } from 'vitest';
import { isMaxHost } from '../src/max/ca.js';

describe('isMaxHost', () => {
  it('accepts https on MAX/VK hosts and their subdomains', () => {
    for (const u of ['https://i.oneme.ru/i?r=x', 'https://vd12.okcdn.ru/video', 'https://fu.oneme.ru:443/upload', 'https://max.ru/x']) expect(isMaxHost(u)).toBe(true);
  });

  it('refuses plain http, look-alike hosts, LAN/IP addresses and junk', () => {
    for (const u of ['http://i.oneme.ru/i', 'https://oneme.ru.evil.com/', 'https://evilokcdn.ru/', 'https://192.168.1.1/', 'https://localhost/', 'file:///etc/passwd', 'nonsense']) {
      expect(isMaxHost(u)).toBe(false);
    }
  });
});
