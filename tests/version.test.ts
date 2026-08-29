import { describe, expect, it } from 'vitest';
import { parseChangelogMd, assembleChangelog } from '../src/bridge/version.js';

const SAMPLE = `# Changelog

Пояснительный текст — не пункт и не раздел.

## 0.4.10 — 2026-08-29

- Пометка правок из MAX
- README: команда установки с зеркала

## v0.4.9 — 2026-08-25

- Безопасность и надёжность
Просто строка без дефиса — игнорируется.

## 0.4.8
- Фикс «Открыть личку»
-
`;

describe('parseChangelogMd', () => {
  it('splits sections by ## version headers and collects bullet lines', () => {
    const map = parseChangelogMd(SAMPLE);
    expect(map['0.4.10']).toEqual(['Пометка правок из MAX', 'README: команда установки с зеркала']);
    expect(map['0.4.8']).toEqual(['Фикс «Открыть личку»']);
  });

  it('accepts an optional v prefix and ignores everything after the version in the header', () => {
    expect(parseChangelogMd(SAMPLE)['0.4.9']).toEqual(['Безопасность и надёжность']);
  });

  it('ignores prose lines, empty bullets, and text outside sections', () => {
    const map = parseChangelogMd(SAMPLE);
    // "0.4.1" must not be created by the "0.4.10" header (version match is exact, not prefix)
    expect(map['0.4.1']).toBeUndefined();
    expect(Object.keys(map).sort()).toEqual(['0.4.10', '0.4.8', '0.4.9']);
  });

  it('returns an empty map for a file with no version sections', () => {
    expect(parseChangelogMd('# Changelog\n\nпусто')).toEqual({});
  });
});

describe('assembleChangelog', () => {
  const map = {
    '0.4.10': ['новое в 10'],
    '0.4.9': ['новое в 9'],
    '0.4.8': ['новое в 8'],
  };

  it('keeps only versions strictly newer than current, newest first, with version headers', () => {
    expect(assembleChangelog(map, '0.4.8', [])).toEqual(['v0.4.10', 'новое в 10', 'v0.4.9', 'новое в 9']);
  });

  it('returns the fallback when nothing is newer than current', () => {
    expect(assembleChangelog(map, '0.4.10', ['fallback'])).toEqual(['fallback']);
  });

  it('treats an unparseable current version as "show everything"', () => {
    const out = assembleChangelog(map, 'dev', []);
    expect(out[0]).toBe('v0.4.10');
    expect(out).toContain('новое в 8');
  });
});
