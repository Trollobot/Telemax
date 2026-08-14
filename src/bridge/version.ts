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

/** Compares the running commit against origin/main's tip. `updateAvailable` is only ever true when both sides are actually known — a network hiccup or a build without GIT_COMMIT just silently reports no update, never a false positive. */
export async function checkVersion(): Promise<VersionStatus> {
  const current = getCurrentCommit();
  const latest = await fetchLatestMainCommit();
  const updateAvailable = current != null && latest != null && current !== latest.sha;
  return { current, latest, updateAvailable };
}
