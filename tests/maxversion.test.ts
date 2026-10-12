import { describe, expect, it } from 'vitest';
import { compareVersions, formatVersionNotice, newestPackage, parseBridgeDefaults, parsePackages, shouldNotify } from '../telemetry-server/maxversion.mjs';

// The telemetry server's early warning for «Приложение устарело» (telemetry-server/maxversion.mjs).

// The shape of MAX's apt repo Packages file on 2026-10-12 (trimmed).
const PACKAGES = [
  'Package: max',
  'Version: 26.35.1',
  'Architecture: amd64',
  'Filename: pool/main/m/max/MAX-26.35.1.80662.deb',
  'Size: 311163278',
  '',
  'Package: max',
  'Version: 26.35.0',
  'Filename: pool/main/m/max/MAX-26.35.0.80520.deb',
  '',
  'Package: max',
  'Version: 26.9.0',
  'Filename: pool/main/m/max/MAX-26.9.0.70001.deb',
  '',
].join('\n');

describe('MAX desktop version watch', () => {
  it('compares versions numerically', () => {
    expect(compareVersions('26.35.1', '26.9.0')).toBe(1);
    expect(compareVersions('26.24.0', '26.35.1')).toBe(-1);
    expect(compareVersions('26.35.1', '26.35.1')).toBe(0);
  });

  it('reads the repo and picks the newest package with its build', () => {
    const list = parsePackages(PACKAGES);
    expect(list).toHaveLength(3);
    expect(newestPackage(list)).toEqual({ version: '26.35.1', build: 80662 });
    expect(newestPackage([])).toBeNull();
    expect(parsePackages('garbage\n\nVersion: x')).toEqual([]);
  });

  it('reads what the bridge presents from its source', () => {
    const src = "const DEFAULT_APP_VERSION = '26.35.1';\nconst DEFAULT_BUILD_NUMBER = 80662;";
    expect(parseBridgeDefaults(src)).toEqual({ version: '26.35.1', build: 80662 });
    expect(parseBridgeDefaults('nothing here')).toBeNull();
  });

  it('notifies once per newer MAX version, never when the bridge is current', () => {
    const bridge = { version: '26.35.1', build: 80662 };
    expect(shouldNotify({ version: '26.35.1', build: 80662 }, bridge, null)).toBe(false);
    expect(shouldNotify({ version: '26.36.0', build: 81000 }, bridge, null)).toBe(true);
    expect(shouldNotify({ version: '26.36.0', build: 81000 }, bridge, '26.36.0')).toBe(false);
    expect(shouldNotify({ version: '26.37.0', build: 81500 }, bridge, '26.36.0')).toBe(true);
    expect(shouldNotify(null, bridge, null)).toBe(false);
    expect(shouldNotify({ version: '26.36.0', build: 1 }, null, null)).toBe(false);
  });

  it('tells the maintainer the exact numbers to use', () => {
    const text = formatVersionNotice({ version: '26.36.0', build: 81000 }, { version: '26.35.1', build: 80662 });
    expect(text).toContain('26.36.0 (сборка 81000)');
    expect(text).toContain('MAX_APP_VERSION=26.36.0, MAX_BUILD_NUMBER=81000');
    expect(text).toContain('DEFAULT_APP_VERSION');
  });
});
