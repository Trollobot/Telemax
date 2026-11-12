import { mkdir, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { createLogger } from '../logger.js';

const logger = createLogger('status-file');

/**
 * The portable build's window into the bridge (src/portable): where TELEMAX_STATUS_FILE is set, the
 * bridge writes its connection state there every few seconds. The launcher next to it reads the file
 * for the tray icon and the status page, and takes a file that stopped changing for a hung bridge.
 * Nothing writes it anywhere else — a Docker bridge has no reader, and still listens on no port.
 */
export interface BridgeStatus {
  /** When this was written — the launcher's heartbeat. */
  at: number;
  pid: number;
  version: string;
  max: {
    /** MaxSessionState: 'loggedIn' relays; 'ready' = connected but nobody logged in; the rest = on the way or down. */
    state: string;
    /** Masked (+7999***9999) — the file is plain text on disk. Empty before the first login. */
    phone: string;
    lastLoginAt: number | null;
    /** Since when MAX has been unreachable; null while it is up or was never up. */
    downSince: number | null;
    pausedUntil: number | null;
  };
  telegram: {
    /** Token and group are both set — without them the bot is never started. */
    configured: boolean;
    ok: boolean;
    /** Since when it has been in this state. */
    since: number;
    /** Why the last launch failed (a wrong token, no route) — absent while ok. */
    error?: string;
    /** Redacted proxy URL, when Telegram goes through one. */
    proxy?: string;
  };
}

export const STATUS_WRITE_INTERVAL_MS = 5_000;

/** Starts the periodic write; a no-op (returns false) where TELEMAX_STATUS_FILE is not set. */
export function startStatusFile(collect: () => BridgeStatus, env: NodeJS.ProcessEnv = process.env): boolean {
  const file = env.TELEMAX_STATUS_FILE?.trim();
  if (!file) return false;
  const tmp = `${file}.tmp`;
  let writing = false;
  const write = async (): Promise<void> => {
    if (writing) return; // a slow disk: skip a beat rather than race two renames on one tmp path
    writing = true;
    try {
      await mkdir(path.dirname(file), { recursive: true });
      await writeFile(tmp, JSON.stringify(collect()), 'utf8');
      await rename(tmp, file);
    } catch (err) {
      logger.debug('Failed to write the status file', err);
    } finally {
      writing = false;
    }
  };
  void write();
  setInterval(() => void write(), STATUS_WRITE_INTERVAL_MS).unref();
  return true;
}
