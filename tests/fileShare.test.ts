import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import os from 'node:os';
import path from 'node:path';
import { Readable } from 'node:stream';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, readdir, rm, utimes, writeFile } from 'node:fs/promises';
import { FileShare, fileShareOptionsFromEnv, safeFileName } from '../src/bridge/fileShare.js';

let dataDir: string;
const opts = { enabled: true, ttlMs: 72 * 3600_000, reserveBytes: 0 };

beforeEach(async () => {
  dataDir = await mkdtemp(path.join(os.tmpdir(), 'tlmx-files-'));
});
afterEach(async () => {
  await rm(dataDir, { recursive: true, force: true });
});

async function fresh(o = opts): Promise<FileShare> {
  const share = new FileShare(dataDir, o);
  await share.init();
  return share;
}
const token = (share: FileShare, t: string) => path.join(share.dir, 'tokens', `${t}.json`);

describe('safeFileName', () => {
  it('keeps a normal name and neutralizes separators, control chars and leading dots', () => {
    expect(safeFileName('Документы.zip')).toBe('Документы.zip');
    expect(safeFileName('../../etc/passwd')).toBe('_.._etc_passwd');
    expect(safeFileName('a\u0000b\nc:d?.txt')).toBe('a_b_c_d_.txt');
    expect(safeFileName('...')).toBe('file');
    expect(safeFileName(undefined)).toBe('file');
  });

  it('cuts a long name but keeps its extension', () => {
    const n = safeFileName(`${'я'.repeat(300)}.tar.gz`);
    expect(n.length).toBe(180);
    expect(n.endsWith('.gz')).toBe(true);
  });
});

describe('fileShareOptionsFromEnv', () => {
  it('is on by default with 3 days and a 1.5 GB reserve', () => {
    expect(fileShareOptionsFromEnv({})).toEqual({ enabled: true, ttlMs: 72 * 3600_000, reserveBytes: 1536 * 1024 * 1024 });
    expect(fileShareOptionsFromEnv({ FILES: 'off', FILES_TTL_HOURS: '24', FILES_RESERVE_MB: '0' })).toEqual({ enabled: false, ttlMs: 24 * 3600_000, reserveBytes: 0 });
  });
});

describe('FileShare', () => {
  it('a stored file gets a download token, the active marker, and survives a restart', async () => {
    const share = await fresh();
    const f = await share.storeStream(Readable.from([Buffer.from('hello')]), 'a.txt', 5);
    expect(await readFile(path.join(share.dir, 'items', f.id, 'a.txt'), 'utf8')).toBe('hello');
    const t = JSON.parse(await readFile(token(share, f.token), 'utf8'));
    expect(t).toMatchObject({ v: 1, kind: 'download', name: 'a.txt', size: 5, path: `items/${f.id}/a.txt` });
    expect(existsSync(path.join(share.dir, 'active'))).toBe(true);
    const again = await fresh();
    expect(again.list().map((x) => x.id)).toEqual([f.id]);
  });

  it('renew issues a new token and a new TTL; remove deletes the file and closes the marker', async () => {
    const share = await fresh();
    const f = await share.storeStream(Readable.from([Buffer.from('x')]), 'x.bin', 1);
    const oldToken = f.token;
    const renewed = await share.renew(f.id);
    expect(renewed?.token).not.toBe(oldToken);
    expect(existsSync(token(share, oldToken))).toBe(false);
    expect(existsSync(token(share, renewed!.token))).toBe(true);
    expect(await share.remove(f.id)).toBe(true);
    expect(existsSync(path.join(share.dir, 'items', f.id))).toBe(false);
    expect(existsSync(path.join(share.dir, 'active'))).toBe(false);
  });

  it('a stream that runs past its declared size is refused and leaves nothing behind', async () => {
    const share = await fresh();
    const big = Buffer.alloc(3 * 1024 * 1024, 1);
    await expect(share.storeStream(Readable.from([big]), 'lie.bin', 10)).rejects.toThrow(/declared/);
    expect(await readdir(path.join(share.dir, 'items'))).toEqual([]);
  });

  it('sweep deletes expired files with their tokens', async () => {
    const share = await fresh({ ...opts, ttlMs: 1 });
    const f = await share.storeStream(Readable.from([Buffer.from('x')]), 'old.bin', 1);
    await new Promise((r) => setTimeout(r, 5));
    await share.sweep();
    expect(share.list()).toEqual([]);
    expect(existsSync(token(share, f.token))).toBe(false);
    expect(existsSync(path.join(share.dir, 'items', f.id))).toBe(false);
  });

  it('an upload ticket hands the finished upload to the handler once', async () => {
    const share = await fresh();
    const ticket = await share.createUploadTicket({ maxChatId: '5', topicId: 7, telegramMessageId: 9, name: 'big.zip', expectedSize: 3 });
    expect(JSON.parse(await readFile(token(share, ticket.token), 'utf8'))).toMatchObject({ kind: 'upload', name: 'big.zip', expectedSize: 3 });
    const seen: Array<[string, number, string]> = [];
    share.onUpload(async (t, filePath, size, name) => {
      seen.push([t.token, size, name]);
      expect(await readFile(filePath, 'utf8')).toBe('abc');
      await share.dropTicket(t.token);
    });
    await share.pollUploads(); // nothing uploaded yet
    const dir = path.join(share.dir, 'incoming', ticket.token);
    await mkdir(dir, { recursive: true });
    await writeFile(path.join(dir, 'other.zip'), 'abc');
    await writeFile(path.join(dir, 'done.json'), JSON.stringify({ name: 'other.zip', file: 'other.zip', size: 3 }));
    await share.pollUploads();
    await share.pollUploads();
    expect(seen).toEqual([[ticket.token, 3, 'other.zip']]);
    expect(share.pendingUploads()).toBe(0);
    expect(existsSync(dir)).toBe(false);
  });

  it('adoptUpload keeps a too-big upload as a stored file with a link', async () => {
    const share = await fresh();
    const ticket = await share.createUploadTicket({ maxChatId: '5', topicId: 7, telegramMessageId: 9, name: 'huge.iso', expectedSize: 2 });
    const dir = path.join(share.dir, 'incoming', ticket.token);
    await mkdir(dir, { recursive: true });
    await writeFile(path.join(dir, 'huge.iso'), 'zz');
    const f = await share.adoptUpload(ticket, path.join(dir, 'huge.iso'), 2, 'huge.iso');
    expect(f.direction).toBe('tg2max');
    expect(await readFile(path.join(share.dir, 'items', f.id, 'huge.iso'), 'utf8')).toBe('zz');
    expect(share.pendingUploads()).toBe(0);
  });

  it('roomFor counts the reserve', async () => {
    const share = await fresh({ ...opts, reserveBytes: Number.MAX_SAFE_INTEGER });
    expect((await share.roomFor(1)).fits).toBe(false);
    expect((await (await fresh()).roomFor(1)).fits).toBe(true);
  });
});

describe('FileShare.ensureService', () => {
  const heartbeat = async (ageMs = 0) => {
    const p = path.join(dataDir, 'watcher-heartbeat');
    await writeFile(p, 'x');
    const t = (Date.now() - ageMs) / 1000;
    await utimes(p, t, t);
  };
  const service = async (share: FileShare, state: string, url = '', ageSec = 0) =>
    writeFile(path.join(share.dir, 'service.json'), JSON.stringify({ state, url, at: Math.floor(Date.now() / 1000) - ageSec, detail: '' }));

  it('returns the url once the host reports the service up', async () => {
    const share = await fresh();
    await heartbeat();
    await service(share, 'up', 'https://1.2.3.4/');
    expect(await share.ensureService(1000)).toEqual({ ok: true, url: 'https://1.2.3.4' });
  });

  it('explains busy ports right away', async () => {
    const share = await fresh();
    await heartbeat();
    await service(share, 'ports-busy');
    const r = await share.ensureService(1000);
    expect(r.ok).toBe(false);
    expect(!r.ok && r.reason).toMatch(/80\/443/);
  });

  it('says so when no host dispatcher serves this install', async () => {
    const share = await fresh();
    const r = await share.ensureService(1000);
    expect(!r.ok && r.reason).toMatch(/автообновление/);
  });

  it('ignores a stale "up" and is off when disabled', async () => {
    const share = await fresh();
    await heartbeat();
    await service(share, 'up', 'https://1.2.3.4', 600);
    expect((await share.ensureService(10)).ok).toBe(false);
    expect((await (await fresh({ ...opts, enabled: false })).ensureService(10)).ok).toBe(false);
  });
});

describe('FileShare sweep vs a file being saved', () => {
  it('leaves a file that is still being written alone (live 2026-10-09: a 2.7 GB ISO was deleted mid-download)', async () => {
    const share = new FileShare(dataDir, opts);
    await share.init();
    const body = new Readable({ read() {} });
    const saving = share.storeStream(body, 'big.iso', 6);
    body.push(Buffer.from('abc'));
    await new Promise((r) => setTimeout(r, 20));
    expect(share.inProgress()).toEqual([{ name: 'big.iso', size: 6, written: 3 }]);
    await share.sweep();
    body.push(Buffer.from('def'));
    body.push(null);
    const f = await saving;
    expect(await readFile(path.join(share.dir, 'items', f.id, 'big.iso'), 'utf8')).toBe('abcdef');
    expect(share.inProgress()).toEqual([]);
  });
});

describe('big-file errors', () => {
  it('turn file-system and network errors into plain words, keep MAX answers as they are', async () => {
    const { humanError } = await import('../src/bridge/bigFiles.js');
    expect(humanError(new Error("ENOENT: no such file or directory, rename '/app/.data/files/items/x/a.iso.part' -> '/app/.data/files/items/x/a.iso'"))).toBe(
      'внутренняя ошибка моста, подробности — в его логе',
    );
    expect(humanError(new Error('ENOSPC: no space left on device, write'))).toBe('на сервере кончилось место');
    expect(humanError(new Error('Вложение в процессе обработки'))).toBe('Вложение в процессе обработки');
  });

  it('never put a file name into an anonymous report', async () => {
    const { scrubError } = await import('../src/bridge/telemetry.js');
    const s = scrubError(new Error("ENOENT: no such file or directory, rename '/app/.data/files/items/x/Паспорт.pdf.part' -> '/app/.data/files/items/x/Паспорт.pdf'"));
    expect(s).not.toContain('Паспорт');
    expect(s).toContain('ENOENT');
  });
});

describe('the panel store («📤 Загрузить файл»)', () => {
  it('keeps the upload as a 📦 file with a link, with no MAX limit and nowhere to send it', async () => {
    const share = new FileShare(dataDir, opts);
    await share.init();
    const ticket = await share.createUploadTicket({ purpose: 'store', maxChatId: '', topicId: 0, telegramMessageId: 1, name: '', expectedSize: 0 });
    const tokenBody = JSON.parse(await readFile(path.join(share.dir, 'tokens', `${ticket.token}.json`), 'utf8'));
    expect(tokenBody).toMatchObject({ kind: 'upload', purpose: 'store' });
    expect(tokenBody.maxFileBytes).toBeUndefined();
    const dir = path.join(share.dir, 'incoming', ticket.token);
    await mkdir(dir, { recursive: true });
    await writeFile(path.join(dir, 'photos.zip'), 'zz');
    const f = await share.adoptUpload(ticket, path.join(dir, 'photos.zip'), 2, 'photos.zip');
    expect(f.direction).toBe('stored');
    expect(f.target).toBeUndefined();
  });
});
