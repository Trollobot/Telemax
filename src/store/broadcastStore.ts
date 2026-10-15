import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';

/** One «трансляция»: new messages of a MAX chat copied into a Telegram group or channel (bridge/broadcast.ts). */
export interface Broadcast {
  /** Random id — names the broadcast in buttons (tlmx_bc:stop:<id>). */
  id: string;
  maxChatId: string;
  /** The group or channel the copies go to. */
  targetChatId: number;
  targetTitle: string;
  targetType: 'group' | 'channel';
  /** Epoch ms it was switched on. */
  since: number;
  /** MAX time (ms) of the last message copied — a replayed history (/reboot, a restored topic) and
   * a catch-up that relays a message twice stay at or below it and are not copied again. */
  cursor: number;
  /** «📌»: every message copied there gets pinned, silently — easy to find in a busy group (asked for 2026-10-15). */
  pin?: boolean;
}

/**
 * Persistent list of broadcasts, any number per MAX chat and per target. Plain JSON in
 * .data/broadcasts.json — not secret. Same write-then-rename + serialized writes as BugReportStore.
 */
export class BroadcastStore {
  private cache: Broadcast[] | null = null;
  private writeQueue: Promise<void> = Promise.resolve();
  private pendingLoad: Promise<Broadcast[]> | null = null;

  constructor(private readonly filePath: string = path.join(process.cwd(), '.data', 'broadcasts.json')) {}

  async all(): Promise<Broadcast[]> {
    return [...(await this.load())];
  }

  async forChat(maxChatId: string): Promise<Broadcast[]> {
    return (await this.load()).filter((b) => b.maxChatId === maxChatId);
  }

  async get(id: string): Promise<Broadcast | undefined> {
    return (await this.load()).find((b) => b.id === id);
  }

  /** True when `chatId` receives at least one broadcast — the bridge then leaves that chat's updates alone. */
  async isTarget(chatId: number): Promise<boolean> {
    return (await this.load()).some((b) => b.targetChatId === chatId);
  }

  async add(b: Broadcast): Promise<void> {
    const all = await this.load();
    all.push(b);
    await this.persist(all);
  }

  async remove(id: string): Promise<Broadcast | undefined> {
    const all = await this.load();
    const gone = all.find((b) => b.id === id);
    if (!gone) return undefined;
    this.cache = all.filter((b) => b.id !== id);
    await this.persist(this.cache);
    return gone;
  }

  /** Switches «📌» on or off; the broadcast, or undefined when it is gone. */
  async setPin(id: string, on: boolean): Promise<Broadcast | undefined> {
    const b = (await this.load()).find((x) => x.id === id);
    if (!b) return undefined;
    if (on) b.pin = true;
    else delete b.pin;
    await this.persist(this.cache!);
    return b;
  }

  /** Moves the broadcast's cursor forward (never back) to `time`. */
  async advance(id: string, time: number): Promise<void> {
    const b = (await this.load()).find((x) => x.id === id);
    if (!b || time <= b.cursor) return;
    b.cursor = time;
    await this.persist(this.cache!);
  }

  private load(): Promise<Broadcast[]> {
    if (this.cache) return Promise.resolve(this.cache);
    this.pendingLoad ??= (async () => {
      try {
        const raw = await readFile(this.filePath, 'utf8');
        this.cache = JSON.parse(raw) as Broadcast[];
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code === 'ENOENT') this.cache = [];
        else throw err;
      }
      return this.cache;
    })().finally(() => {
      this.pendingLoad = null;
    });
    return this.pendingLoad;
  }

  private persist(list: Broadcast[]): Promise<void> {
    const run = this.writeQueue.then(() => this.writeToDisk(list));
    this.writeQueue = run.catch(() => undefined);
    return run;
  }

  private async writeToDisk(list: Broadcast[]): Promise<void> {
    await mkdir(path.dirname(this.filePath), { recursive: true });
    const tmpPath = `${this.filePath}.tmp`;
    await writeFile(tmpPath, JSON.stringify(list, null, 2), 'utf8');
    await rename(tmpPath, this.filePath);
  }
}
