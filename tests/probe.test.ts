import { describe, expect, it } from 'vitest';
import { classifyProbeResult, probeIntervalMs } from '../src/bridge/sync.js';

describe('probeIntervalMs (decay ladder)', () => {
  it('pings densely right after send (hot phase)', () => {
    expect(probeIntervalMs(0)).toBe(15_000);
    expect(probeIntervalMs(90_000)).toBe(15_000); // 1.5 min
  });

  it('steps out as the message ages', () => {
    expect(probeIntervalMs(5 * 60_000)).toBe(60_000); // 5 min -> every minute
    expect(probeIntervalMs(30 * 60_000)).toBe(5 * 60_000); // 30 min -> every 5 min
    expect(probeIntervalMs(3 * 60 * 60_000)).toBe(30 * 60_000); // 3 h -> every 30 min
  });

  it('stops probing after 6 hours (cooled off)', () => {
    expect(probeIntervalMs(6 * 60 * 60_000)).toBeNull();
    expect(probeIntervalMs(24 * 60 * 60_000)).toBeNull();
  });

  it('is monotonic — intervals never shrink with age', () => {
    const samples = [0, 60_000, 5 * 60_000, 30 * 60_000, 3 * 60 * 60_000];
    const intervals = samples.map((a) => probeIntervalMs(a) ?? Infinity);
    for (let i = 1; i < intervals.length; i++) expect(intervals[i]).toBeGreaterThanOrEqual(intervals[i - 1]);
  });
});

describe('classifyProbeResult', () => {
  it('reports a live message from REACTION_EMPTY', () => {
    expect(classifyProbeResult('Bad Request: REACTION_EMPTY')).toBe('alive');
    expect(classifyProbeResult('400: bad request: reaction_empty')).toBe('alive');
  });

  it('reports a deleted message only from an exact not-found shape', () => {
    expect(classifyProbeResult('Bad Request: message to react not found')).toBe('gone');
    expect(classifyProbeResult('Bad Request: message not found')).toBe('gone');
    expect(classifyProbeResult('Bad Request: message to delete not found')).toBe('gone');
  });

  it('NEVER reports gone on rate-limit or network errors (would delete a live message)', () => {
    // This is the safety-critical case: a false 'gone' irreversibly deletes on MAX.
    expect(classifyProbeResult('Too Many Requests: retry after 42')).toBe('unknown');
    expect(classifyProbeResult('EFATAL: socket hang up')).toBe('unknown');
    expect(classifyProbeResult('Bad Gateway')).toBe('unknown');
    expect(classifyProbeResult('')).toBe('unknown');
    expect(classifyProbeResult('chat not found')).toBe('unknown'); // whole chat gone != message deleted
  });
});
