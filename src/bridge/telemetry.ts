import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { getAppVersion } from './version.js';
import { parseEnvBool } from '../env.js';
import { createLogger } from '../logger.js';

const logger = createLogger('telemetry');

// Anonymous install counter. Once a day (piggybacked on the version-check tick) each install
// sends a random per-install UUID + its version to the project's endpoint, so live installs
// can be counted. NO phone numbers, NO IPs stored, NO personal data — just a random id and a
// version string. On by default; opt out with TELEMETRY=off (documented in the README, not in
// the bot's /help). The endpoint is a DDNS hostname, not a hardcoded IP, so it can move.
const TELEMETRY_URL = 'https://zergont-gate.duckdns.org/ping';
const INSTALL_ID_FILE = path.join(process.cwd(), '.data', 'install-id');
const PING_TIMEOUT_MS = 8000;

/** Opted out: TELEMETRY set to off/0/false/no, or NO_TELEMETRY to 1/true/yes/on (parseEnvBool). Anything
 * else — unset, or a value outside both sets — leaves the default: on. Exported for tests. */
export function isTelemetryDisabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return parseEnvBool(env.TELEMETRY) === false || parseEnvBool(env.NO_TELEMETRY) === true;
}

let cachedId: string | null = null;
async function getInstallId(): Promise<string> {
  if (cachedId) return cachedId;
  try {
    const existing = (await readFile(INSTALL_ID_FILE, 'utf8')).trim();
    if (existing) {
      cachedId = existing;
      return existing;
    }
  } catch {
    // not created yet — fall through and generate one
  }
  const id = randomUUID();
  await mkdir(path.dirname(INSTALL_ID_FILE), { recursive: true }).catch(() => {});
  await writeFile(INSTALL_ID_FILE, id, 'utf8').catch((err) => logger.error('Failed to persist install id', err));
  cachedId = id;
  return id;
}

export interface Telemetry {
  ping: () => Promise<void>;
}

export function createTelemetry(): Telemetry {
  async function ping(): Promise<void> {
    if (isTelemetryDisabled()) return;
    try {
      const installId = await getInstallId();
      const version = getAppVersion();
      await fetch(TELEMETRY_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ installId, version, ts: Date.now() }),
        signal: AbortSignal.timeout(PING_TIMEOUT_MS),
      });
    } catch (err) {
      // Best-effort by design — telemetry must never affect the bridge. INFO, not ERROR.
      logger.info(`telemetry ping skipped: ${(err as Error).message}`);
    }
  }
  return { ping };
}
