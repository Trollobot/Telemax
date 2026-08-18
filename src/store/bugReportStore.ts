import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';

export interface BugReportMapping {
  /** The reporter's private-chat id (equals their Telegram user id for a DM). */
  reporterChatId: number;
  /** Forum topic in the maintainer's group where this reporter's thread lives. */
  topicId: number;
  username?: string;
  name?: string;
  createdAt: string;
}

/**
 * Persistent reporter <-> topic mapping for the bug-report inbox (prod-only feature,
 * gated by BUGREPORT_INBOX). One forum topic per reporter, so the maintainer replies in
 * the topic and the bot relays it back to that reporter's DM. Plain JSON — not secret.
 * Mirrors ChatMapStore's write-then-rename + serialized-writes approach.
 */
export class BugReportStore {
  private cache: BugReportMapping[] | null = null;
  private writeQueue: Promise<void> = Promise.resolve();
  private pendingLoad: Promise<BugReportMapping[]> | null = null;

  constructor(private readonly filePath: string = path.join(process.cwd(), '.data', 'bug-reports.json')) {}

  async getByReporter(reporterChatId: number): Promise<BugReportMapping | undefined> {
    return (await this.load()).find((m) => m.reporterChatId === reporterChatId);
  }

  async getByTopicId(topicId: number): Promise<BugReportMapping | undefined> {
    return (await this.load()).find((m) => m.topicId === topicId);
  }

  async upsert(mapping: BugReportMapping): Promise<void> {
    const all = await this.load();
    const idx = all.findIndex((m) => m.reporterChatId === mapping.reporterChatId);
    if (idx >= 0) all[idx] = mapping;
    else all.push(mapping);
    this.cache = all;
    await this.persist(all);
  }

  /** Drops a reporter's mapping — used to force a fresh topic when the current one was deleted. */
  async remove(reporterChatId: number): Promise<void> {
    const all = await this.load();
    const filtered = all.filter((m) => m.reporterChatId !== reporterChatId);
    if (filtered.length === all.length) return;
    this.cache = filtered;
    await this.persist(filtered);
  }

  private load(): Promise<BugReportMapping[]> {
    if (this.cache) return Promise.resolve(this.cache);
    this.pendingLoad ??= (async () => {
      try {
        const raw = await readFile(this.filePath, 'utf8');
        this.cache = JSON.parse(raw) as BugReportMapping[];
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

  private persist(mappings: BugReportMapping[]): Promise<void> {
    const run = this.writeQueue.then(() => this.writeToDisk(mappings));
    this.writeQueue = run.catch(() => undefined);
    return run;
  }

  private async writeToDisk(mappings: BugReportMapping[]): Promise<void> {
    await mkdir(path.dirname(this.filePath), { recursive: true });
    const tmpPath = `${this.filePath}.tmp`;
    await writeFile(tmpPath, JSON.stringify(mappings, null, 2), 'utf8');
    await rename(tmpPath, this.filePath);
  }
}
