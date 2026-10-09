import { readFile, writeFile, mkdir, statfs } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import os from 'node:os';
import path from 'node:path';
import { getAppVersion } from './version.js';
import { parseEnvBool } from '../env.js';
import { createLogger, redactSecrets } from '../logger.js';

const logger = createLogger('telemetry');

// Anonymous install counter. Once a day (piggybacked on the version-check tick) each install
// sends a random per-install UUID + its version to the project's endpoint, so live installs
// can be counted. NO phone numbers, NO IPs stored, NO personal data — just a random id and a
// version string. On by default; opt out with TELEMETRY=off (documented in the README, not in
// the bot's /help). The endpoint is a DDNS hostname, not a hardcoded IP, so it can move.
const TELEMETRY_URL = 'https://zergont-gate.duckdns.org/ping';
const DATA_DIR = path.join(process.cwd(), '.data');
const INSTALL_ID_FILE = path.join(DATA_DIR, 'install-id');
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

// --- Anonymous error reports ---------------------------------------------------------------------
// The maintainer cannot see a user's server, and «cat update.log» is beyond most users — so a
// failure is reported the same anonymous way the ping is, and TELEMETRY=off silences both.
const REPORT_URL = 'https://zergont-gate.duckdns.org/report';
const BOOTS_FILE = path.join(DATA_DIR, 'boots.json');
const DAY_MS = 24 * 60 * 60 * 1000;
const SAME_REPORT_COOLDOWN_MS = 6 * 60 * 60 * 1000;
const MAX_REPORTS_PER_DAY = 5;
const LOOP_WINDOW_MS = 10 * 60 * 1000;
const LOOP_BOOTS = 3;
const KEPT_BOOTS = 5;

export interface ErrorReport {
  kind: 'internal' | 'session-rejected' | 'restart-loop' | 'fatal';
  step?: string;
  error?: unknown;
}

/**
 * What leaves the machine as `error`: the FIRST line only, with everything that could identify the
 * user removed — a bot token or proxy password inside a URL, quoted input (a JSON parse error quotes
 * the text it choked on), long digit runs (phone numbers, chat and user ids).
 */
export function scrubError(error: unknown): string {
  const raw = error instanceof Error ? `${error.name}: ${error.message}` : String(error ?? '');
  return String(redactSecrets(raw.split('\n')[0] ?? ''))
    .replace(/\d+:[\w-]{30,}/g, '#')
    .replace(/\/\/[^/\s@]+@/g, '//#@')
    .replace(/"[^"]*"/g, '"…"')
    // A file-system error quotes its path — with the user's file name — in single quotes.
    .replace(/'[^']*'/g, "'…'")
    .replace(/\d{7,}/g, '#')
    .slice(0, 300);
}

/** Client-side budget: the same report at most once per 6 h, 5 reports per 24 h. `sent` is updated. */
export function shouldSendReport(sent: { key: string; at: number }[], key: string, now: number): boolean {
  const fresh = sent.filter((s) => now - s.at < DAY_MS);
  sent.splice(0, sent.length, ...fresh);
  if (sent.length >= MAX_REPORTS_PER_DAY || sent.some((s) => s.key === key && now - s.at < SAME_REPORT_COOLDOWN_MS)) return false;
  sent.push({ key, at: now });
  return true;
}

const inLoop = (boots: number[], at: number): boolean => boots.filter((t) => at - t <= LOOP_WINDOW_MS).length >= LOOP_BOOTS;

/**
 * Adds this boot to the kept ones and says whether a restart loop STARTED with it: 3+ boots within
 * 10 minutes, and the previous boot was not already inside such a streak (one report per streak).
 */
export function detectRestartLoop(previous: number[], now: number): { boots: number[]; loop: boolean } {
  const boots = [...previous, now].slice(-KEPT_BOOTS);
  const last = previous.at(-1);
  return { boots, loop: inLoop(boots, now) && !(last !== undefined && inLoop(previous, last)) };
}

const sentReports: { key: string; at: number }[] = [];

/**
 * Sends an anonymous error report. Best-effort: never throws, no-op when telemetry is off.
 * RULE: pass ONLY an error (its message) — never message text, chat titles, ids of chats or users,
 * or the phone number. Nothing else is read from the bridge's state: the payload is the install id,
 * the version, kind/step, the scrubbed first line of the error and the host's OS / Node / free
 * memory / free disk.
 */
export async function reportError(report: ErrorReport): Promise<void> {
  if (isTelemetryDisabled()) return;
  try {
    const error = report.error === undefined ? undefined : scrubError(report.error);
    if (!shouldSendReport(sentReports, `${report.kind}|${error ?? ''}`, Date.now())) return;
    const freeMb = await statfs(DATA_DIR).then(
      (s) => Math.round((s.bavail * s.bsize) / 1048576),
      () => undefined,
    );
    await fetch(REPORT_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        installId: await getInstallId(),
        version: getAppVersion(),
        kind: report.kind,
        step: report.step,
        error,
        os: `${process.platform} ${os.release()}`,
        node: process.version,
        memMb: Math.round(os.freemem() / 1048576),
        freeMb,
      }),
      signal: AbortSignal.timeout(PING_TIMEOUT_MS),
    });
  } catch (err) {
    logger.info(`error report skipped: ${(err as Error).message}`);
  }
}

/** Records this boot in .data/boots.json and reports a restart loop when one has just started. */
export async function noteBoot(): Promise<void> {
  if (isTelemetryDisabled()) return;
  try {
    const saved: unknown = await readFile(BOOTS_FILE, 'utf8').then(JSON.parse, () => []);
    const previous = Array.isArray(saved) ? saved.filter((t): t is number => typeof t === 'number') : [];
    const { boots, loop } = detectRestartLoop(previous, Date.now());
    await mkdir(DATA_DIR, { recursive: true });
    await writeFile(BOOTS_FILE, JSON.stringify(boots), 'utf8');
    if (loop) await reportError({ kind: 'restart-loop' });
  } catch (err) {
    logger.info(`boot not recorded: ${(err as Error).message}`);
  }
}
