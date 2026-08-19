import { readFileSync } from 'node:fs';
import path from 'node:path';
import { createLogger } from '../logger.js';

const logger = createLogger('version');

const REPO = 'Trollobot/Telemax';
const GITHUB_API_TIMEOUT_MS = 8000;

export interface LatestVersionInfo {
  /** Git tag on GitHub, e.g. "v0.3.2". */
  tag: string;
  /** Semver without the leading v, e.g. "0.3.2". */
  version: string;
}

export interface VersionStatus {
  /** The release this build is running, from package.json (baked into the image). "unknown" if unreadable. */
  current: string;
  latest: LatestVersionInfo | null;
  updateAvailable: boolean;
  /** First lines of every commit between the running version's tag and the latest tag, newest-first. Empty if not applicable or the compare fetch failed. */
  changelog: string[];
}

let cachedVersion: string | null = null;
/** The release version this build reports — read from package.json, which is baked into the
 * runtime image (the Dockerfile COPYs it). Works for EVERY build regardless of GIT_COMMIT, so a
 * plain `docker compose up --build` (not via setup.sh) still gets update checks and a real
 * version instead of "dev". */
export function getAppVersion(): string {
  if (cachedVersion) return cachedVersion;
  try {
    const pkg = JSON.parse(readFileSync(path.join(process.cwd(), 'package.json'), 'utf8')) as { version?: unknown };
    cachedVersion = typeof pkg.version === 'string' && pkg.version ? pkg.version : 'unknown';
  } catch (err) {
    logger.error('Failed to read version from package.json', err);
    cachedVersion = 'unknown';
  }
  return cachedVersion;
}

/** The commit this container was built from — still baked via GIT_COMMIT when setup.sh passes
 * it; kept for diagnostics only, no longer used for the update check. `null` for builds without it. */
export function getCurrentCommit(): string | null {
  const commit = process.env.GIT_COMMIT;
  return commit && commit !== 'unknown' ? commit : null;
}

export function shortSha(sha: string): string {
  return sha.slice(0, 7);
}

/** Parses "v0.3.1" / "0.3.1" into [0,3,1]; null if it isn't a plain X.Y.Z (pre-release suffixes ignored). */
function parseSemver(raw: string): [number, number, number] | null {
  const m = /^v?(\d+)\.(\d+)\.(\d+)/.exec(raw.trim());
  if (!m) return null;
  return [Number(m[1]), Number(m[2]), Number(m[3])];
}

function cmpSemver(a: [number, number, number], b: [number, number, number]): number {
  return a[0] - b[0] || a[1] - b[1] || a[2] - b[2];
}

/** Highest semver tag published on GitHub. Uses /tags (a plain `git push --tags` is enough — no
 * GitHub "Release" object required) and sorts by semver ourselves, since /tags isn't ordered. */
async function fetchLatestTag(): Promise<LatestVersionInfo | null> {
  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), GITHUB_API_TIMEOUT_MS);
    const res = await fetch(`https://api.github.com/repos/${REPO}/tags?per_page=100`, {
      headers: { Accept: 'application/vnd.github+json' },
      signal: controller.signal,
    }).finally(() => clearTimeout(timeout));
    if (!res.ok) {
      logger.error(`GitHub tags API returned ${res.status} ${res.statusText}`);
      return null;
    }
    const payload = (await res.json()) as Array<{ name?: string }>;
    let best: { tag: string; v: [number, number, number] } | null = null;
    for (const t of payload) {
      if (typeof t.name !== 'string') continue;
      const v = parseSemver(t.name);
      if (v && (!best || cmpSemver(v, best.v) > 0)) best = { tag: t.name, v };
    }
    return best ? { tag: best.tag, version: best.v.join('.') } : null;
  } catch (err) {
    logger.error('Failed to fetch tags from GitHub', err);
    return null;
  }
}

/** First-line messages of the commits between two refs (newest-first) via the compare API — the
 * "what's new". Best-effort: [] on any failure (e.g. the running version has no matching tag). */
async function fetchChangelog(base: string, head: string): Promise<string[]> {
  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), GITHUB_API_TIMEOUT_MS);
    const res = await fetch(`https://api.github.com/repos/${REPO}/compare/${base}...${head}`, {
      headers: { Accept: 'application/vnd.github+json' },
      signal: controller.signal,
    }).finally(() => clearTimeout(timeout));
    if (!res.ok) {
      logger.error(`GitHub compare API returned ${res.status} ${res.statusText}`);
      return [];
    }
    const payload = (await res.json()) as { commits?: Array<{ commit?: { message?: string } }> };
    // compare returns oldest-first; reverse so the newest change reads first.
    return (payload.commits ?? [])
      .map((c) => (c.commit?.message ?? '').split('\n')[0] ?? '')
      .filter(Boolean)
      .reverse();
  } catch (err) {
    logger.error('Failed to fetch changelog from GitHub', err);
    return [];
  }
}

/** Compares the running release (package.json version) against the highest tag on GitHub.
 * Release/tag-based, so it works for every build — including images built without GIT_COMMIT.
 * `updateAvailable` is only true when the latest tag is strictly newer, never a false positive. */
export async function checkVersion(): Promise<VersionStatus> {
  const current = getAppVersion();
  const latest = await fetchLatestTag();
  const currentSemver = parseSemver(current);
  const latestSemver = latest ? parseSemver(latest.version) : null;
  const updateAvailable = latestSemver != null && currentSemver != null && cmpSemver(latestSemver, currentSemver) > 0;
  const changelog = updateAvailable && latest ? await fetchChangelog(`v${current}`, latest.tag) : [];
  return { current, latest, updateAvailable, changelog };
}
