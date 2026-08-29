import { readFileSync } from 'node:fs';
import path from 'node:path';
import { createLogger } from '../logger.js';

const logger = createLogger('version');

const REPO = 'Trollobot/Telemax';
const GITHUB_API_TIMEOUT_MS = 8000;
/** Self-hosted fallback mirror, used only when GitHub's API is unreachable/blocked (e.g. the
 * account gets flagged, or GitHub is filtered on the install's network). Overridable via env so
 * the mirror can move without a code change. Serves `/latest.json` (version manifest) and
 * `/Telemax.git` (a read-only git mirror that update.sh falls back to). */
const MIRROR_BASE_URL = (process.env.MIRROR_BASE_URL || 'https://zergont-gate.duckdns.org').replace(/\/+$/, '');

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

/**
 * Parses CHANGELOG.md (the file, not git history — commits are technical and never
 * shown to users) into a version -> notes map. Sections start with `## X.Y.Z` (an
 * optional `v` prefix and anything after the version — a dash, a date — is ignored);
 * notes are the section's `- ` bullet lines. Exported for tests.
 */
export function parseChangelogMd(text: string): Record<string, string[]> {
  const map: Record<string, string[]> = {};
  let current: string | null = null;
  for (const line of text.split('\n')) {
    const header = /^##\s+v?(\d+\.\d+\.\d+)\b/.exec(line);
    if (header) {
      current = header[1] as string;
      map[current] ??= [];
      continue;
    }
    if (current && line.startsWith('- ')) {
      const note = line.slice(2).trim();
      if (note) map[current]!.push(note);
    }
  }
  return map;
}

/** CHANGELOG.md as published at `tag` on GitHub — the user-facing "what's new" source
 * (replaces the old compare-API commit-subject list, which leaked technical commits).
 * Best-effort: {} on any failure (older tags predate the file). */
async function fetchChangelogFromGitHub(tag: string): Promise<Record<string, string[]>> {
  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), GITHUB_API_TIMEOUT_MS);
    const res = await fetch(`https://raw.githubusercontent.com/${REPO}/${tag}/CHANGELOG.md`, {
      signal: controller.signal,
    }).finally(() => clearTimeout(timeout));
    if (!res.ok) {
      logger.error(`GitHub raw CHANGELOG.md returned ${res.status} ${res.statusText}`);
      return {};
    }
    return parseChangelogMd(await res.text());
  } catch (err) {
    logger.error('Failed to fetch CHANGELOG.md from GitHub', err);
    return {};
  }
}

/** Latest version from the self-hosted mirror's `/latest.json`, used only as a fallback when
 * GitHub's tags API can't be reached. `changelog` is the newest release's notes; `changelogs` maps
 * version -> notes for the last several releases so an install several versions behind can still be
 * shown EVERY skipped version's changes (the GitHub compare API does this dynamically, but the
 * mirror is static — hence the per-version map that checkVersion assembles against `current`). */
async function fetchLatestFromMirror(): Promise<
  (LatestVersionInfo & { changelog: string[]; changelogs: Record<string, string[]> }) | null
> {
  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), GITHUB_API_TIMEOUT_MS);
    const res = await fetch(`${MIRROR_BASE_URL}/latest.json`, { signal: controller.signal }).finally(() =>
      clearTimeout(timeout),
    );
    if (!res.ok) {
      logger.error(`Mirror /latest.json returned ${res.status} ${res.statusText}`);
      return null;
    }
    const payload = (await res.json()) as { tag?: unknown; version?: unknown; changelog?: unknown; changelogs?: unknown };
    if (typeof payload.tag !== 'string' || typeof payload.version !== 'string') return null;
    const v = parseSemver(payload.version);
    if (!v) return null;
    const changelog = Array.isArray(payload.changelog)
      ? payload.changelog.filter((x): x is string => typeof x === 'string')
      : [];
    const changelogs: Record<string, string[]> = {};
    if (payload.changelogs && typeof payload.changelogs === 'object') {
      for (const [ver, notes] of Object.entries(payload.changelogs as Record<string, unknown>)) {
        if (Array.isArray(notes)) changelogs[ver] = notes.filter((x): x is string => typeof x === 'string');
      }
    }
    return { tag: payload.tag, version: v.join('.'), changelog, changelogs };
  } catch (err) {
    logger.error('Failed to fetch latest from mirror', err);
    return null;
  }
}

/** Flattens a per-version changelog map into a single newest-first list of every release
 * strictly newer than `current` — so a multi-version jump shows all skipped versions' notes, not
 * just the latest. Shared by the GitHub (CHANGELOG.md) and mirror (latest.json) paths. Falls back
 * to `fallback` (the newest release's notes) when the map has nothing newer. Exported for tests. */
export function assembleChangelog(
  changelogs: Record<string, string[]>,
  current: string,
  fallback: string[],
): string[] {
  const currentSemver = parseSemver(current);
  const versions = Object.keys(changelogs)
    .map((ver) => ({ ver, semver: parseSemver(ver) }))
    .filter((x): x is { ver: string; semver: [number, number, number] } => x.semver != null)
    .filter((x) => currentSemver == null || cmpSemver(x.semver, currentSemver) > 0)
    .sort((a, b) => cmpSemver(b.semver, a.semver)); // newest first
  if (versions.length === 0) return fallback;
  return versions.flatMap((x) => [`v${x.ver}`, ...(changelogs[x.ver] ?? [])]);
}

/** Compares the running release (package.json version) against the highest tag on GitHub, falling
 * back to the self-hosted mirror when GitHub is unreachable. Release/tag-based, so it works for
 * every build — including images built without GIT_COMMIT. `updateAvailable` is only true when the
 * latest known version is strictly newer, never a false positive. */
export async function checkVersion(): Promise<VersionStatus> {
  const current = getAppVersion();
  const currentSemver = parseSemver(current);

  // Primary source: GitHub tags (+ CHANGELOG.md at the latest tag for the notes).
  const ghLatest = await fetchLatestTag();
  if (ghLatest) {
    const latestSemver = parseSemver(ghLatest.version);
    const updateAvailable = latestSemver != null && currentSemver != null && cmpSemver(latestSemver, currentSemver) > 0;
    const changelog = updateAvailable ? assembleChangelog(await fetchChangelogFromGitHub(ghLatest.tag), current, []) : [];
    return { current, latest: ghLatest, updateAvailable, changelog };
  }

  // Fallback: self-hosted mirror (GitHub blocked/down/flagged).
  const mirror = await fetchLatestFromMirror();
  if (mirror) {
    logger.info(`GitHub unreachable — using mirror for version check (latest ${mirror.tag})`);
    const latestSemver = parseSemver(mirror.version);
    const updateAvailable = latestSemver != null && currentSemver != null && cmpSemver(latestSemver, currentSemver) > 0;
    return {
      current,
      latest: { tag: mirror.tag, version: mirror.version },
      updateAvailable,
      // Cumulative: every version between `current` and latest, so a multi-version jump isn't
      // reduced to just the newest release's notes.
      changelog: updateAvailable ? assembleChangelog(mirror.changelogs, current, mirror.changelog) : [],
    };
  }

  return { current, latest: null, updateAvailable: false, changelog: [] };
}
