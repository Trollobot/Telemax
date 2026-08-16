import { describe, expect, it } from 'vitest';
import { buildTelegramProxyAgent, redactProxyUrl } from '../src/telegram/proxy.js';

describe('buildTelegramProxyAgent', () => {
  it('returns undefined when no proxy is configured', () => {
    expect(buildTelegramProxyAgent('')).toBeUndefined();
    expect(buildTelegramProxyAgent('   ')).toBeUndefined();
  });

  it('builds a SOCKS agent for socks schemes', () => {
    const agent = buildTelegramProxyAgent('socks5://user:pass@10.0.0.1:1080');
    expect(agent).toBeDefined();
    expect(agent?.constructor.name).toMatch(/Socks/i);
  });

  it('builds an HTTP(S) agent for http/https schemes', () => {
    expect(buildTelegramProxyAgent('http://proxy:3128')?.constructor.name).toMatch(/Https/);
    expect(buildTelegramProxyAgent('https://proxy:3128')?.constructor.name).toMatch(/Https/);
  });

  it('throws on an unsupported scheme so a typo fails loudly', () => {
    expect(() => buildTelegramProxyAgent('ftp://proxy:21')).toThrow(/unsupported scheme/);
  });

  it('throws on a malformed URL', () => {
    expect(() => buildTelegramProxyAgent('not a url')).toThrow(/valid URL/);
  });
});

describe('redactProxyUrl', () => {
  it('strips credentials from the logged form', () => {
    const red = redactProxyUrl('socks5://user:secret@10.0.0.1:1080');
    expect(red).not.toContain('secret');
    expect(red).not.toContain('user');
    expect(red).toContain('10.0.0.1:1080');
  });

  it('leaves a credential-free URL usable', () => {
    expect(redactProxyUrl('http://proxy:3128')).toContain('proxy:3128');
  });

  it('returns a placeholder for garbage', () => {
    expect(redactProxyUrl('not a url')).toBe('(invalid)');
  });
});
