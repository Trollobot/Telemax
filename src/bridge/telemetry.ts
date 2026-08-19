import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { getAppVersion } from './version.js';
import { createLogger } from '../logger.js';

const logger = createLogger('telemetry');

// Anonymous install counter. Once a day (piggybacked on the version-check tick) each install
// sends a random per-install UUID + its version to the project's endpoint, so live installs
// can be counted. NO phone numbers, NO IPs stored, NO personal data — just a random id and a
// version string. On by default; opt out with TELEMETRY=off (documented in the README, not in
// the bot's /help). The endpoint is a DDNS hostname, not a hardcoded IP, so it can move.
const TELEMETRY_URL = 'http://zergont-gate.duckdns.org:3100/ping';
const INSTALL_ID_FILE = path.join(process.cwd(), '.data', 'install-id');
const PING_TIMEOUT_MS = 8000;

function isDisabled(): boolean {
  return /^(off|0|false|no)$/i.test(process.env.TELEMETRY ?? '') || /^(1|true|yes|on)$/i.test(process.env.NO_TELEMETRY ?? '');
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
    if (isDisabled()) return;
    try {
      const installId = await getInstallId();
      const version = getAppVersion();
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), PING_TIMEOUT_MS);
      await fetch(TELEMETRY_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ installId, version, ts: Date.now() }),
        signal: controller.signal,
      }).finally(() => clearTimeout(timeout));
    } catch (err) {
      // Best-effort by design — telemetry must never affect the bridge. INFO, not ERROR.
      logger.info(`telemetry ping skipped: ${(err as Error).message}`);
    }
  }
  return { ping };
}
