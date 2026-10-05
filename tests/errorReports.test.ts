import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// The bridge side of the anonymous error reports (src/bridge/telemetry.ts).

// No disk access: a fixed install id, a fixed free-space answer.
vi.mock('node:fs/promises', async (importOriginal) => ({
  ...(await importOriginal<typeof import('node:fs/promises')>()),
  readFile: vi.fn(async () => 'install-1'),
  statfs: vi.fn(async () => ({ bavail: 2048, bsize: 1048576 })),
}));

import { detectRestartLoop, reportError, scrubError, shouldSendReport } from '../src/bridge/telemetry.js';

const HOUR = 3_600_000;
const MIN = 60_000;

describe('scrubError', () => {
  it('keeps the first line only and cuts it to 300 characters', () => {
    expect(scrubError(new TypeError('x is not a function\n    at secret stack'))).toBe('TypeError: x is not a function');
    expect(scrubError('y'.repeat(400))).toHaveLength(300);
    expect(scrubError(undefined)).toBe('');
  });

  it('removes bot tokens, proxy credentials, quoted input and long numbers', () => {
    const token = '123456789:AAF-abcdefghijklmnopqrstuvwxyz012345';
    expect(scrubError(`request to https://api.telegram.org/bot${token}/sendMessage failed`)).not.toContain('AAF-');
    expect(scrubError('connect ECONNREFUSED socks5://user:hunter2@10.0.0.1:1080')).toBe('connect ECONNREFUSED socks5://#@10.0.0.1:1080');
    expect(scrubError('Unexpected token \'П\', "Привет, Маша" is not valid JSON')).toBe('Unexpected token \'П\', "…" is not valid JSON');
    expect(scrubError('chat -1001234567890 of +79991234567 not found (code 400)')).toBe('chat -# of +# not found (code 400)');
  });
});

describe('shouldSendReport', () => {
  it('sends the same report at most once per 6 hours', () => {
    const sent: { key: string; at: number }[] = [];
    expect(shouldSendReport(sent, 'internal|boom', 0)).toBe(true);
    expect(shouldSendReport(sent, 'internal|boom', 6 * HOUR - 1)).toBe(false);
    expect(shouldSendReport(sent, 'internal|other', 1)).toBe(true);
    expect(shouldSendReport(sent, 'internal|boom', 6 * HOUR)).toBe(true);
  });

  it('sends at most 5 reports per 24 hours', () => {
    const sent: { key: string; at: number }[] = [];
    for (let n = 0; n < 5; n += 1) expect(shouldSendReport(sent, `k${n}`, n)).toBe(true);
    expect(shouldSendReport(sent, 'k5', 10)).toBe(false);
    expect(shouldSendReport(sent, 'k5', 24 * HOUR + 1)).toBe(true); // the first two have aged out
  });
});

describe('detectRestartLoop', () => {
  it('reports the third boot within 10 minutes, once per streak', () => {
    let boots: number[] = [];
    const seen: boolean[] = [];
    for (const at of [0, 2 * MIN, 4 * MIN, 6 * MIN, 8 * MIN, 10 * MIN, 12 * MIN]) {
      const r = detectRestartLoop(boots, at);
      boots = r.boots;
      seen.push(r.loop);
    }
    expect(seen).toEqual([false, false, true, false, false, false, false]);
    expect(boots).toHaveLength(5);
  });

  it('ordinary restarts are no loop, and a new streak after a quiet spell reports again', () => {
    expect(detectRestartLoop([0, 20 * MIN], 40 * MIN).loop).toBe(false);
    expect(detectRestartLoop([0, 11 * MIN], 12 * MIN).loop).toBe(false);
    const quiet = [0, MIN, 2 * MIN, 3 * HOUR, 3 * HOUR + MIN];
    expect(detectRestartLoop(quiet, 3 * HOUR + 2 * MIN).loop).toBe(true);
  });
});

describe('reportError', () => {
  const fetchMock = vi.fn(async (_url: string, _init: RequestInit) => new Response(null, { status: 204 }));
  beforeEach(() => {
    fetchMock.mockClear();
    vi.stubGlobal('fetch', fetchMock);
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
  });

  it('posts the anonymous payload and nothing else', async () => {
    vi.stubEnv('TELEMETRY', '');
    vi.stubEnv('NO_TELEMETRY', '');
    await reportError({ kind: 'internal', step: 'unhandledRejection', error: new Error('boom 12345678\nsecond line') });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(url).toBe('https://zergont-gate.duckdns.org/report');
    const body = JSON.parse(String(init.body)) as Record<string, unknown>;
    expect(Object.keys(body).sort()).toEqual(['error', 'freeMb', 'installId', 'kind', 'memMb', 'node', 'os', 'step', 'version']);
    expect(body).toMatchObject({ installId: 'install-1', kind: 'internal', step: 'unhandledRejection', error: 'Error: boom #', freeMb: 2048, node: process.version });
    expect(String(body.os).startsWith(process.platform)).toBe(true);
    expect(typeof body.memMb).toBe('number');

    // The same error again within 6 hours stays local.
    await reportError({ kind: 'internal', step: 'unhandledRejection', error: new Error('boom 12345678') });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('sends nothing when telemetry is off, and never throws', async () => {
    vi.stubEnv('TELEMETRY', 'off');
    await reportError({ kind: 'fatal', error: 'no start' });
    expect(fetchMock).not.toHaveBeenCalled();

    vi.stubEnv('TELEMETRY', '');
    fetchMock.mockRejectedValueOnce(new Error('network down'));
    await expect(reportError({ kind: 'fatal', error: 'no start' })).resolves.toBeUndefined();
  });
});
