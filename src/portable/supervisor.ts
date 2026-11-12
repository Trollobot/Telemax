import { fork, type ChildProcess, type ForkOptions } from 'node:child_process';
import { appendFileSync, mkdirSync, readFileSync, renameSync, statSync } from 'node:fs';
import path from 'node:path';
import type { BridgeStatus } from '../bridge/statusFile.js';
import { isHung, restartDelayMs, type ProcessState } from './health.js';

/** The bridge's output: the last lines in memory for the page, all of it in a file that is cut at 5 MB (one older copy kept). */
export class LogSink {
  private readonly lines: string[] = [];
  private partial = '';
  private static readonly KEEP = 400;
  private static readonly MAX_BYTES = 5 * 1024 * 1024;

  constructor(readonly file: string) {
    mkdirSync(path.dirname(file), { recursive: true });
  }

  /** A chunk of the bridge's stdout/stderr — may end mid-line. */
  write(chunk: string): void {
    const parts = (this.partial + chunk).split(/\r?\n/);
    this.partial = parts.pop() ?? '';
    for (const line of parts) this.push(line);
  }

  /** A line of the launcher's own. */
  note(text: string): void {
    this.push(`[${new Date().toISOString()}] INFO launcher: ${text}`);
  }

  tail(count = LogSink.KEEP): string[] {
    return this.lines.slice(-count);
  }

  private push(line: string): void {
    this.lines.push(line);
    if (this.lines.length > LogSink.KEEP) this.lines.splice(0, this.lines.length - LogSink.KEEP);
    try {
      try {
        if (statSync(this.file).size > LogSink.MAX_BYTES) renameSync(this.file, `${this.file}.1`);
      } catch {
        // no file yet
      }
      appendFileSync(this.file, `${line}\n`, 'utf8');
    } catch {
      // a full disk must not take the launcher down — the line stays in memory
    }
  }
}

export interface SupervisorOptions {
  /** The bridge bundle (dist/server.mjs). */
  entry: string;
  /** The portable folder: .env, .data, certs and VERSION are looked up here by the bridge. */
  cwd: string;
  statusFile: string;
  log: LogSink;
}

/** A bridge that ran this long before stopping did not fail at startup: its next crash counts from one. */
const STABLE_RUN_MS = 2 * 60_000;
const STOP_GRACE_MS = 8_000;

/**
 * Docker's part of the job on a PC: starts the bridge, starts it again when it exits (at once after
 * a restart asked from the panel, with a growing pause after a crash) and replaces one that stopped
 * writing its status file.
 */
export class Supervisor {
  private child: ChildProcess | null = null;
  private startedAt: number | null = null;
  private failures = 0;
  private nextStartAt: number | null = null;
  private startTimer: NodeJS.Timeout | null = null;
  /** Whether the bridge is meant to be running at all (false until configured, and while stopping). */
  private wanted = false;

  constructor(private readonly opts: SupervisorOptions) {}

  get running(): boolean {
    return this.child != null;
  }

  processState(configured: boolean): ProcessState {
    return { configured, running: this.running, startedAt: this.startedAt, failures: this.failures, nextStartAt: this.nextStartAt };
  }

  readStatus(): BridgeStatus | null {
    try {
      return JSON.parse(readFileSync(this.opts.statusFile, 'utf8')) as BridgeStatus;
    } catch {
      return null;
    }
  }

  start(): void {
    this.wanted = true;
    if (this.child || this.startTimer) return;
    this.spawn();
  }

  /** Asks the bridge to stop cleanly, then makes sure it is gone. */
  async stop(): Promise<void> {
    this.wanted = false;
    if (this.startTimer) clearTimeout(this.startTimer);
    this.startTimer = null;
    this.nextStartAt = null;
    const child = this.child;
    if (!child) return;
    await new Promise<void>((resolve) => {
      const force = setTimeout(() => child.kill(), STOP_GRACE_MS);
      child.once('exit', () => {
        clearTimeout(force);
        resolve();
      });
      try {
        child.send('shutdown');
      } catch {
        child.kill();
      }
    });
  }

  async restart(): Promise<void> {
    await this.stop();
    this.failures = 0;
    this.start();
  }

  /** Called on a timer: a running bridge with no fresh status is killed; its exit brings the next one. */
  tick(now = Date.now()): void {
    if (!this.child || !isHung(this.processState(true), this.readStatus(), now)) return;
    this.opts.log.note('the bridge stopped reporting its status — restarting it');
    this.child.kill();
  }

  private spawn(): void {
    this.startTimer = null;
    this.nextStartAt = null;
    if (!this.wanted) return;
    const { entry, cwd, statusFile, log } = this.opts;
    // windowsHide: no console window of its own on Windows (spawn takes it; fork's typings leave it out).
    const options: ForkOptions & { windowsHide: boolean } = {
      cwd,
      env: { ...process.env, NODE_ENV: 'production', TELEMAX_PORTABLE: '1', TELEMAX_STATUS_FILE: statusFile },
      stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
      windowsHide: true,
    };
    const child = fork(entry, [], options);
    this.child = child;
    this.startedAt = Date.now();
    log.note(`bridge started (pid ${child.pid})`);
    child.stdout?.setEncoding('utf8').on('data', (c: string) => log.write(c));
    child.stderr?.setEncoding('utf8').on('data', (c: string) => log.write(c));
    child.once('error', (err) => log.note(`bridge process error: ${err.message}`));
    child.once('exit', (code, signal) => {
      const ranFor = Date.now() - (this.startedAt ?? Date.now());
      this.child = null;
      this.startedAt = null;
      log.note(`bridge exited (code ${code ?? 'none'}${signal ? `, ${signal}` : ''}) after ${Math.round(ranFor / 1000)} s`);
      if (!this.wanted) return;
      // Exit code 0 is a restart the bridge asked for itself (the panel's «Перезапустить мост»).
      if (code === 0) this.failures = 0;
      else this.failures = ranFor >= STABLE_RUN_MS ? 1 : this.failures + 1;
      const delay = code === 0 ? 1_000 : restartDelayMs(this.failures);
      this.nextStartAt = Date.now() + delay;
      this.startTimer = setTimeout(() => this.spawn(), delay);
    });
  }
}
