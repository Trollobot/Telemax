import { createLogger } from '../logger.js';

const logger = createLogger('version');

const REPO = 'Trollobot/Telemax';
const GITHUB_API_TIMEOUT_MS = 8000;

export interface LatestCommitInfo {
  sha: string;
  message: string;
  date: string;
}

export interface VersionStatus {
  current: string | null;
  latest: LatestCommitInfo | null;
  updateAvailable: boolean;
  /** First lines of every commit between the running version and latest, newest-first. Empty if not applicable or the compare fetch failed. */
  changelog: string[];
}

/** The commit this running container was built from — baked in at build time via the GIT_COMMIT docker-compose build arg, since the runtime image has no .git of its own. `null` for images built without it (e.g. local `npm run build`). */
export function getCurrentCommit(): string | null {
  const commit = process.env.GIT_COMMIT;
  return commit && commit !== 'unknown' ? commit : null;
}

export function shortSha(sha: string): string {
  return sha.slice(0, 7);
}

async function fetchLatestMainCommit(): Promise<LatestCommitInfo | null> {
  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), GITHUB_API_TIMEOUT_MS);
    const res = await fetch(`https://api.github.com/repos/${REPO}/commits/main`, {
      headers: { Accept: 'application/vnd.github+json' },
      signal: controller.signal,
    }).finally(() => clearTimeout(timeout));
    if (!res.ok) {
      logger.error(`GitHub commits API returned ${res.status} ${res.statusText}`);
      return null;
    }
    const payload = (await res.json()) as { sha?: string; commit?: { message?: string; author?: { date?: string } } };
    if (!payload.sha) return null;
    return {
      sha: payload.sha,
      message: (payload.commit?.message ?? '').split('\n')[0] ?? '',
      date: payload.commit?.author?.date ?? '',
    };
  } catch (err) {
    logger.error('Failed to fetch latest commit from GitHub', err);
    return null;
  }
}

/** First-line messages of the commits between `base` and `head` (newest-first) via GitHub's compare API — the "what's new" for an update prompt. Best-effort: returns [] on any failure. */
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

/** Compares the running commit against origin/main's tip. `updateAvailable` is only ever true when both sides are actually known — a network hiccup or a build without GIT_COMMIT just silently reports no update, never a false positive. */
export async function checkVersion(): Promise<VersionStatus> {
  const current = getCurrentCommit();
  const latest = await fetchLatestMainCommit();
  const updateAvailable = current != null && latest != null && current !== latest.sha;
  const changelog = updateAvailable && current && latest ? await fetchChangelog(current, latest.sha) : [];
  return { current, latest, updateAvailable, changelog };
}
