import { describe, expect, it } from 'vitest';
import {
  HOUR_MS,
  acceptReport,
  dueIn,
  formatNotice,
  listReports,
  normalizeError,
  recordReport,
  sanitizeReport,
  scheduleNotice,
  signatureOf,
  type NoticeState,
  type Report,
  type SignatureEntry,
} from '../telemetry-server/reports.mjs';

// The maintainer server's report logic (telemetry-server/reports.mjs).

const report = (over: Partial<Report> = {}): Report => ({ installId: 'a', kind: 'update', version: '1.2.0', ...over });

describe('report signature', () => {
  it('errors differing only in numbers, ids and paths share one signature', () => {
    const a = report({ step: 'сборка образа', error: 'ENOSPC: no space left, write /var/lib/docker/overlay2/3fa9c1d2e4b5/x.tmp (pid 4312)' });
    const b = report({ step: 'сборка образа', error: 'ENOSPC: no space left,  write /mnt/data/docker/overlay2/9b8c7d6e5f40/x.tmp (pid 17)' });
    expect(signatureOf(a)).toBe(signatureOf(b));
    expect(signatureOf(a)).toBe('update|сборка образа|enospc: no space left, write x.tmp (pid #)');
  });

  it('collapses uuids and windows paths, keeps words, and is bounded', () => {
    expect(normalizeError('Job 1b9d6bcd-bbfd-4b2d-9b5d-ab8dfbbd4bed failed at C:\\Users\\me\\app\\dist\\server.mjs:120:7')).toBe(
      'job # failed at server.mjs:#:#',
    );
    expect(normalizeError('Feedback Deadline')).toBe('feedback deadline');
    expect(normalizeError('x'.repeat(500))).toHaveLength(160);
  });

  it('a different kind or step is a different signature', () => {
    expect(signatureOf(report({ kind: 'fatal', error: 'boom' }))).not.toBe(signatureOf(report({ kind: 'internal', error: 'boom' })));
    expect(signatureOf(report({ step: 'a', error: 'boom' }))).not.toBe(signatureOf(report({ step: 'b', error: 'boom' })));
  });
});

describe('sanitizeReport', () => {
  it('truncates strings and drops what is not a report', () => {
    const r = sanitizeReport({ installId: 'a', kind: 'k'.repeat(100), error: 'e'.repeat(1000), os: 'o'.repeat(100), freeMb: '12', memMb: 512.4 });
    expect(r?.kind).toHaveLength(60);
    expect(r?.error).toHaveLength(300);
    expect(r?.os).toHaveLength(60);
    expect(r?.freeMb).toBeUndefined();
    expect(r?.memMb).toBe(512);
    expect(r?.version).toBe('unknown');
    expect(sanitizeReport({ kind: 'x' })).toBeNull();
    expect(sanitizeReport({ installId: 'a' })).toBeNull();
    expect(sanitizeReport({ installId: 5, kind: 'x' })).toBeNull();
    expect(sanitizeReport(null)).toBeNull();
  });
});

describe('acceptReport', () => {
  it('drops a report from an install that never pinged', () => {
    const recent = new Map<string, number[]>();
    expect(acceptReport(report({ installId: 'stranger' }), { a: {} }, recent, 0)).toBe(false);
    expect(acceptReport(report({ installId: 'constructor' }), { a: {} }, recent, 0)).toBe(false);
    expect(acceptReport(report(), { a: {} }, recent, 0)).toBe(true);
  });

  it('accepts 10 reports per install per rolling 24 h and drops the 11th', () => {
    const recent = new Map<string, number[]>();
    for (let n = 0; n < 10; n += 1) expect(acceptReport(report(), { a: {} }, recent, n * 1000)).toBe(true);
    expect(acceptReport(report(), { a: {} }, recent, 11_000)).toBe(false);
    expect(acceptReport(report({ installId: 'b' }), { a: {}, b: {} }, recent, 11_000)).toBe(true); // budgets are per install
    expect(acceptReport(report(), { a: {} }, recent, 24 * HOUR_MS + 500)).toBe(true); // the first one has aged out
  });
});

describe('recordReport', () => {
  it('aggregates by signature: count, installs, versions, the first error as the sample', () => {
    const sigs: Record<string, SignatureEntry> = {};
    const first = recordReport(sigs, report({ error: 'pid 1 died', os: 'Ubuntu 22.04', freeMb: 900 }), 1000);
    const second = recordReport(sigs, report({ installId: 'b', version: '1.2.1', error: 'pid 22 died', os: 'Debian 12' }), 2000);
    expect(first.isNew).toBe(true);
    expect(second).toEqual({ sig: first.sig, isNew: false });
    expect(sigs[first.sig]).toMatchObject({
      sample: 'pid 1 died',
      count: 2,
      firstSeen: 1000,
      lastSeen: 2000,
      installs: { a: 1000, b: 2000 },
      versions: { '1.2.0': 1, '1.2.1': 1 },
      env: { os: 'Debian 12', freeMb: 900 },
    });
    expect(listReports(sigs, 30, 3000)).toMatchObject([{ kind: 'update', count: 2, installs: 2, sample: 'pid 1 died' }]);
    expect(listReports(sigs, 1, 2000 + 2 * 24 * HOUR_MS)).toEqual([]);
  });
});

describe('scheduleNotice', () => {
  it('announces the first signature at once, queues the next new ones for an hour and folds them into one message', () => {
    const state: NoticeState = { queue: [] };
    const t0 = 1_000_000_000;
    expect(scheduleNotice(state, 'A', t0)).toEqual(['A']);
    expect(dueIn(state, t0)).toBeNull();
    expect(scheduleNotice(state, 'B', t0 + 60_000)).toEqual([]);
    expect(scheduleNotice(state, 'C', t0 + 120_000)).toEqual([]);
    expect(scheduleNotice(state, 'B', t0 + 130_000)).toEqual([]); // not queued twice
    expect(dueIn(state, t0 + 120_000)).toBe(HOUR_MS - 120_000);
    expect(scheduleNotice(state, null, t0 + HOUR_MS - 1)).toEqual([]);
    expect(scheduleNotice(state, null, t0 + HOUR_MS)).toEqual(['B', 'C']);
    expect(scheduleNotice(state, null, t0 + HOUR_MS + 1)).toEqual([]);
  });

  it('a known signature never notifies again — only a new one reaches the scheduler', () => {
    const sigs: Record<string, SignatureEntry> = {};
    const state: NoticeState = { queue: [] };
    const sent: string[][] = [];
    for (const [at, error] of [[0, 'boom 1'], [5 * HOUR_MS, 'boom 2'], [9 * HOUR_MS, 'boom 3']] as const) {
      const { sig, isNew } = recordReport(sigs, report({ error }), at);
      if (isNew) sent.push(scheduleNotice(state, sig, at + 10 * HOUR_MS));
    }
    expect(sent).toEqual([['update||boom #']]);
  });
});

describe('formatNotice', () => {
  it('describes the first signature, counts the rest and carries no install id', () => {
    const sigs: Record<string, SignatureEntry> = {};
    const a = recordReport(sigs, report({ installId: 'secret-install', step: 'сборка образа', error: 'failed to solve', toVersion: 'v1.2.1', os: 'Ubuntu 22.04', freeMb: 300, memMb: 150 }), 1);
    const b = recordReport(sigs, report({ installId: 'secret-install', kind: 'fatal', error: 'other' }), 2);
    const text = formatNotice([sigs[a.sig]!, sigs[b.sig]!]);
    expect(text).toContain('update · шаг «сборка образа»');
    expect(text).toContain('failed to solve');
    expect(text).toContain('1.2.0 → v1.2.1');
    expect(text).toContain('диск 300 МБ, память 150 МБ');
    expect(text).toContain('Ubuntu 22.04');
    expect(text).toContain('и ещё 1 новых');
    expect(text).not.toContain('secret-install');
  });
});
