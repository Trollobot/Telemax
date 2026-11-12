import { describe, expect, it } from 'vitest';
import { isSafeEnvValue, readEnvValues, setEnvValues } from '../src/portable/envFile.js';
import { isAllowedRequest, proxyProblem, resolveForm } from '../src/portable/form.js';
import { buildHealth, explainTelegramError, HEARTBEAT_STALE_MS, isHung, restartDelayMs, STARTUP_GRACE_MS, type ProcessState } from '../src/portable/health.js';
import { groupsFromUpdates } from '../src/portable/telegramApi.js';
import type { BridgeStatus } from '../src/bridge/statusFile.js';

describe('.env edited by the launcher', () => {
  const text = '# Настройки\nMAX_SESSION_KEY=abc\n\n# прокси\nTELEGRAM_PROXY="socks5://old:1080"\nHISTORY_LIMIT=300\n';

  it('reads values the way dotenv does: quotes off, comments ignored', () => {
    expect(readEnvValues(text)).toEqual({ MAX_SESSION_KEY: 'abc', TELEGRAM_PROXY: 'socks5://old:1080', HISTORY_LIMIT: '300' });
    expect(readEnvValues('# TELEGRAM_BOT_TOKEN=1:x\r\nA = b \r\n')).toEqual({ A: 'b' });
  });

  it('replaces a key in place, appends a new one, removes one — and leaves every other line alone', () => {
    const next = setEnvValues(text, { TELEGRAM_PROXY: null, TELEGRAM_BOT_TOKEN: '1:tok', MAX_SESSION_KEY: 'abc' });
    expect(next).toBe('# Настройки\nMAX_SESSION_KEY=abc\n\n# прокси\nHISTORY_LIMIT=300\nTELEGRAM_BOT_TOKEN=1:tok\n');
    expect(setEnvValues('', { A: '1' })).toBe('A=1\n');
    expect(setEnvValues('A=1\r\nB=2\r\n', { B: '3' })).toBe('A=1\r\nB=3\r\n');
  });

  it('refuses a value that would not read back as written', () => {
    expect(isSafeEnvValue('socks5://user:p%40ss@10.0.0.1:1080')).toBe(true);
    expect(() => setEnvValues('', { A: 'two words' })).toThrow(/пробелов/);
    expect(() => setEnvValues('', { A: 'x\nB=1' })).toThrow();
    expect(() => setEnvValues('', { A: 'x#y' })).toThrow();
  });
});

describe('the settings form', () => {
  const saved = { token: '1:saved', group: '-1001', proxy: 'socks5://user:secret@10.0.0.1:1080', sessionKey: 'k' };

  it('an empty token and the pre-filled passwordless proxy both mean "as saved"', () => {
    expect(resolveForm({ token: '', proxy: 'socks5://10.0.0.1:1080', group: '' }, saved)).toEqual({ token: '1:saved', proxy: saved.proxy, group: '-1001' });
    expect(resolveForm({ token: ' 2:new ', proxy: '', group: '-1002' }, saved)).toEqual({ token: '2:new', proxy: '', group: '-1002' });
    expect(resolveForm({ proxy: 'http://other:3128' }, saved).proxy).toBe('http://other:3128');
  });

  it('says in plain words why a proxy address will not do', () => {
    expect(proxyProblem('')).toBeNull();
    expect(proxyProblem('socks5://user:pass@10.0.0.1:1080')).toBeNull();
    expect(proxyProblem('http://proxy:3128')).toBeNull();
    expect(proxyProblem('tg://proxy?server=1.2.3.4&port=443&secret=ee')).toMatch(/MTProto/);
    expect(proxyProblem('https://t.me/proxy?server=1.2.3.4&port=443&secret=ee')).toMatch(/MTProto/);
    expect(proxyProblem('10.0.0.1:1080')).toMatch(/вместе с видом/);
    expect(proxyProblem('ftp://proxy:21')).toMatch(/не поддерживается/);
  });

  it('lets in only this computer talking to this port, and a change only with the page’s own header', () => {
    expect(isAllowedRequest('GET', { host: '127.0.0.1:8377' }, 8377)).toBe(true);
    expect(isAllowedRequest('GET', { host: 'localhost:8377' }, 8377)).toBe(true);
    expect(isAllowedRequest('GET', { host: 'evil.example:8377' }, 8377)).toBe(false);
    expect(isAllowedRequest('GET', { host: '127.0.0.1:9999' }, 8377)).toBe(false);
    expect(isAllowedRequest('POST', { host: '127.0.0.1:8377' }, 8377)).toBe(false);
    expect(isAllowedRequest('POST', { host: '127.0.0.1:8377', 'x-telemax': '1' }, 8377)).toBe(true);
    expect(isAllowedRequest('PUT', { host: '127.0.0.1:8377', 'x-telemax': '1' }, 8377)).toBe(false);
  });
});

describe('finding the group', () => {
  it('collects groups from messages and from the bot being added, once each, and nothing private', () => {
    const updates = [
      { message: { chat: { id: -1001, type: 'supergroup', title: 'Мост' } } },
      { my_chat_member: { chat: { id: -1001, type: 'supergroup', title: 'Мост' } } },
      { my_chat_member: { chat: { id: -55, type: 'group', title: 'Старая' } } },
      { message: { chat: { id: 42, type: 'private' } } },
      { poll_answer: {} },
    ];
    expect(groupsFromUpdates(updates)).toEqual([
      { id: '-1001', title: 'Мост' },
      { id: '-55', title: 'Старая' },
    ]);
  });
});

describe('connection state for the tray icon and the page', () => {
  const now = 1_000_000_000;
  const running: ProcessState = { configured: true, running: true, startedAt: now - 10 * 60_000, failures: 0, nextStartAt: null };
  const status = (over: { max?: Partial<BridgeStatus['max']>; telegram?: Partial<BridgeStatus['telegram']>; at?: number } = {}): BridgeStatus => ({
    at: over.at ?? now - 2_000,
    pid: 1,
    version: '1.4.0',
    max: { state: 'loggedIn', phone: '+7999***9999', lastLoginAt: now - 60_000, downSince: null, pausedUntil: null, ...over.max },
    telegram: { configured: true, ok: true, since: now - 60_000, ...over.telegram },
  });

  it('green when the bridge relays', () => {
    const h = buildHealth(running, status(), now);
    expect(h.level).toBe('ok');
    expect(h.summary).toBe('Telemax: всё работает');
    expect(h.lines.map((l) => l.name)).toEqual(['Мост', 'MAX', 'Telegram']);
    expect(h.lines[1]?.text).toBe('подключён · +7999***9999');
  });

  it('asks for the setup before anything is configured, and for /login once it is', () => {
    expect(buildHealth({ ...running, configured: false, running: false }, null, now)).toMatchObject({ level: 'warn', summary: 'Telemax: нужна настройка' });
    const h = buildHealth(running, status({ max: { state: 'ready', phone: '' } }), now);
    expect(h.level).toBe('warn');
    expect(h.lines[1]?.text).toMatch(/\/login/);
  });

  it('a short loss of MAX is yellow, a lasting one red', () => {
    expect(buildHealth(running, status({ max: { state: 'connecting', downSince: now - 20_000 } }), now).level).toBe('warn');
    const h = buildHealth(running, status({ max: { state: 'resumeRetry', downSince: now - 5 * 60_000 } }), now);
    expect(h.level).toBe('bad');
    expect(h.summary).toBe('Telemax — MAX: нет связи 5 мин — мост переподключается сам');
  });

  it('Telegram down names the proxy and the reason', () => {
    const h = buildHealth(running, status({ telegram: { ok: false, since: now - 3 * 60_000, error: 'connect ECONNREFUSED 10.0.0.1:1080', proxy: 'socks5://10.0.0.1:1080' } }), now);
    expect(h.level).toBe('bad');
    expect(h.lines[2]?.text).toBe('нет связи 3 мин через прокси socks5://10.0.0.1:1080: соединение отклонено — прокси не отвечает по этому адресу');
    expect(explainTelegramError('401: Unauthorized')).toMatch(/токен/);
    expect(explainTelegramError('409: Conflict: terminated by other getUpdates request')).toMatch(/другой мост/);
  });

  it('a bridge that stopped writing its status is hung — after its startup grace only', () => {
    const stale = status({ at: now - HEARTBEAT_STALE_MS - 1 });
    expect(buildHealth(running, stale, now)).toMatchObject({ level: 'bad', summary: 'Telemax: мост не отвечает' });
    expect(isHung(running, stale, now)).toBe(true);
    expect(isHung(running, status(), now)).toBe(false);
    const fresh: ProcessState = { ...running, startedAt: now - STARTUP_GRACE_MS + 5_000 };
    expect(isHung(fresh, null, now)).toBe(false);
    expect(buildHealth(fresh, null, now).lines[0]?.text).toBe('запускается…');
    // A status file left by the previous process does not count for the new one.
    expect(isHung({ ...running, startedAt: now - 2 * 60_000 }, status({ at: now - 5 * 60_000 }), now)).toBe(true);
  });

  it('a crashed bridge says when it starts again; the pause grows with each crash in a row', () => {
    const h = buildHealth({ configured: true, running: false, startedAt: null, failures: 3, nextStartAt: now + 15_000 }, null, now);
    expect(h.level).toBe('bad');
    expect(h.lines[0]?.text).toBe('остановился (сбоев подряд: 3), перезапуск через 15 с');
    expect([1, 2, 3, 4, 5, 9].map(restartDelayMs)).toEqual([2_000, 5_000, 15_000, 30_000, 60_000, 60_000]);
  });
});
