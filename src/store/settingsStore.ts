import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';

/** What the owner chose in Telegram (not .env): kept in .data/settings.json, read synchronously once loaded. */
export interface BridgeSettings {
  /** How many days back a topic filled from scratch reaches; 0 = the whole history. Unset = asked (or the default). */
  historyDays?: number;
}

/**
 * The bridge's own settings — changed from the panel or a question in the group, so they can't
 * live in .env (the container can't rewrite it). Plain JSON, not secret. Same write-then-rename
 * + serialized writes as BroadcastStore. load() once at startup; get() is synchronous after it.
 */
export class SettingsStore {
  private cache: BridgeSettings = {};
  private writeQueue: Promise<void> = Promise.resolve();

  constructor(private readonly filePath: string = path.join(process.cwd(), '.data', 'settings.json')) {}

  async load(): Promise<BridgeSettings> {
    try {
      const parsed = JSON.parse(await readFile(this.filePath, 'utf8')) as unknown;
      this.cache = parsed && typeof parsed === 'object' ? (parsed as BridgeSettings) : {};
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
      this.cache = {};
    }
    return this.cache;
  }

  get(): BridgeSettings {
    return this.cache;
  }

  async set(patch: BridgeSettings): Promise<void> {
    this.cache = { ...this.cache, ...patch };
    const snapshot = this.cache;
    const run = this.writeQueue.then(() => this.writeToDisk(snapshot));
    this.writeQueue = run.catch(() => undefined);
    return run;
  }

  private async writeToDisk(settings: BridgeSettings): Promise<void> {
    await mkdir(path.dirname(this.filePath), { recursive: true });
    const tmpPath = `${this.filePath}.tmp`;
    await writeFile(tmpPath, JSON.stringify(settings, null, 2), 'utf8');
    await rename(tmpPath, this.filePath);
  }
}
