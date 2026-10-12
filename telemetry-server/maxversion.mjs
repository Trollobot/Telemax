// Early warning for «Приложение устарело»: MAX refuses logins from a client older than it accepts,
// and the bridge presents itself as MAX desktop with a version baked into src/max/client.ts. On
// 2026-10-12 every new /login broke a day after MAX shipped desktop 26.35.x — this check would have
// said so the day before. Twice a day the server compares MAX's newest desktop package with what
// the bridge presents and tells the maintainer once per new MAX version.
// The decisions live here (pure, unit-tested); server.mjs does the fetching and the posting.

/** MAX's own apt repo — the same pair the desktop installer carries (version + build in the file name). */
export const MAX_PACKAGES_URL = 'https://download.max.ru/linux/deb/dists/stable/main/binary-amd64/Packages';
/** What the bridge presents, read from its source on main (follows every release by itself). */
export const BRIDGE_CLIENT_URL = 'https://raw.githubusercontent.com/Trollobot/Telemax/main/src/max/client.ts';

/** «26.35.1» vs «26.9.0» → numeric, part by part. */
export function compareVersions(a, b) {
  const pa = String(a).split('.').map(Number);
  const pb = String(b).split('.').map(Number);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const d = (pa[i] || 0) - (pb[i] || 0);
    if (d) return d < 0 ? -1 : 1;
  }
  return 0;
}

/** Debian Packages text → [{version, build}] (build from «MAX-<version>.<build>.deb», null if absent). */
export function parsePackages(text) {
  const out = [];
  for (const block of String(text).split(/\r?\n\r?\n/)) {
    const version = /^Version:\s*(\d+\.\d+\.\d+)\s*$/m.exec(block)?.[1];
    if (!version) continue;
    const build = /^Filename:.*?-\d+\.\d+\.\d+\.(\d+)\.deb\s*$/m.exec(block)?.[1];
    out.push({ version, build: build ? Number(build) : null });
  }
  return out;
}

/** The newest package (by version, then build); null for an empty list. */
export function newestPackage(list) {
  return list.reduce((best, p) => {
    if (!best) return p;
    const c = compareVersions(p.version, best.version);
    return c > 0 || (c === 0 && (p.build ?? 0) > (best.build ?? 0)) ? p : best;
  }, null);
}

/** The bridge's DEFAULT_APP_VERSION / DEFAULT_BUILD_NUMBER from src/max/client.ts; null when not found. */
export function parseBridgeDefaults(source) {
  const version = /DEFAULT_APP_VERSION\s*=\s*['"`](\d+\.\d+\.\d+)['"`]/.exec(String(source))?.[1];
  if (!version) return null;
  const build = /DEFAULT_BUILD_NUMBER\s*=\s*(\d+)/.exec(String(source))?.[1];
  return { version, build: build ? Number(build) : null };
}

/** Notify when MAX is ahead of the bridge and this MAX version hasn't been announced yet. */
export function shouldNotify(maxLatest, bridge, lastNotified) {
  if (!maxLatest || !bridge) return false;
  if (compareVersions(maxLatest.version, bridge.version) <= 0) return false;
  return lastNotified !== maxLatest.version;
}

export function formatVersionNotice(maxLatest, bridge) {
  const build = maxLatest.build != null ? ` (сборка ${maxLatest.build})` : '';
  return (
    `🆕 MAX выпустил десктоп ${maxLatest.version}${build}, а мост представляется ${bridge.version}${bridge.build != null ? ` (${bridge.build})` : ''}.\n\n` +
    `Если /login начнёт отвечать «Приложение устарело» — выпустить обновление с этими номерами: DEFAULT_APP_VERSION и DEFAULT_BUILD_NUMBER в src/max/client.ts. ` +
    `Пользователи до релиза могут обойтись .env: MAX_APP_VERSION=${maxLatest.version}${maxLatest.build != null ? `, MAX_BUILD_NUMBER=${maxLatest.build}` : ''}.`
  );
}
