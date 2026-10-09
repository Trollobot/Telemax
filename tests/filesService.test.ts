import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import os from 'node:os';
import path from 'node:path';
import { spawn, type ChildProcess } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';

// files-service/server.mjs as the host runs it: its own process, bridges' file dirs under a root.
let root: string;
let proc: ChildProcess;
let base: string;
const bridge = () => path.join(root, '1');

async function tokenFile(name: string, body: Record<string, unknown>) {
  await writeFile(path.join(bridge(), 'tokens', `${name}.json`), JSON.stringify({ v: 1, ...body }));
}

beforeAll(async () => {
  root = await mkdtemp(path.join(os.tmpdir(), 'tlmx-srv-'));
  await mkdir(path.join(bridge(), 'tokens'), { recursive: true });
  await mkdir(path.join(bridge(), 'items', 'id1'), { recursive: true });
  await writeFile(path.join(bridge(), 'items', 'id1', 'отчёт.txt'), '0123456789');
  const later = Date.now() + 3600_000;
  await tokenFile('dddddddddddddddddddddd', { kind: 'download', name: 'отчёт.txt', size: 10, path: 'items/id1/отчёт.txt', expiresAt: later });
  await tokenFile('eeeeeeeeeeeeeeeeeeeeee', { kind: 'download', name: 'x', size: 1, path: 'items/id1/отчёт.txt', expiresAt: Date.now() - 1 });
  await tokenFile('tttttttttttttttttttttt', { kind: 'download', name: 'x', size: 1, path: '../../../etc/hosts', expiresAt: later });
  await tokenFile('uuuuuuuuuuuuuuuuuuuuuu', { kind: 'upload', name: 'big.zip', expectedSize: 5, expiresAt: later, reserveBytes: 0 });
  await tokenFile('rrrrrrrrrrrrrrrrrrrrrr', { kind: 'upload', name: 'big.zip', expectedSize: 5, expiresAt: later, reserveBytes: Number.MAX_SAFE_INTEGER });
  const port = 18000 + Math.floor(Math.random() * 2000);
  base = `http://127.0.0.1:${port}`;
  proc = spawn(process.execPath, [path.join('files-service', 'server.mjs')], { env: { ...process.env, FILES_ROOT: root, PORT: String(port) }, stdio: ['ignore', 'pipe', 'pipe'] });
  await new Promise<void>((resolve, reject) => {
    const t = setTimeout(() => reject(new Error('server did not start')), 10_000);
    proc.stdout!.on('data', (d) => String(d).includes('files service') && (clearTimeout(t), resolve()));
  });
});

afterAll(async () => {
  proc?.kill();
  await rm(root, { recursive: true, force: true });
});

describe('files service', () => {
  it('answers health and hides everything without a token', async () => {
    expect(await (await fetch(`${base}/health`)).text()).toBe('ok');
    expect((await fetch(`${base}/`)).status).toBe(404);
    expect((await fetch(`${base}/f/short`)).status).toBe(404);
    expect((await fetch(`${base}/f/eeeeeeeeeeeeeeeeeeeeee`)).status).toBe(404); // expired
  });

  it('shows a page first, then the file with its name and Range support', async () => {
    const pageRes = await fetch(`${base}/f/dddddddddddddddddddddd`);
    expect(pageRes.status).toBe(200);
    expect(pageRes.headers.get('x-robots-tag')).toMatch(/noindex/);
    expect(await pageRes.text()).toContain('href="dddddddddddddddddddddd/file"');
    const slash = await fetch(`${base}/f/dddddddddddddddddddddd/`, { redirect: 'manual' });
    expect(slash.status).toBe(301);
    expect(slash.headers.get('location')).toBe('../dddddddddddddddddddddd');
    const file = await fetch(`${base}/f/dddddddddddddddddddddd/file`);
    expect(await file.text()).toBe('0123456789');
    expect(file.headers.get('content-disposition')).toContain(`filename*=UTF-8''${encodeURIComponent('отчёт.txt')}`);
    const part = await fetch(`${base}/f/dddddddddddddddddddddd/file`, { headers: { Range: 'bytes=4-6' } });
    expect(part.status).toBe(206);
    expect(await part.text()).toBe('456');
    expect(part.headers.get('content-range')).toBe('bytes 4-6/10');
  });

  it('never serves a path outside the bridge directory', async () => {
    expect((await fetch(`${base}/f/tttttttttttttttttttttt/file`)).status).toBe(404);
  });

  it('takes one upload per link and refuses a second', async () => {
    expect(await (await fetch(`${base}/f/uuuuuuuuuuuuuuuuuuuuuu`)).text()).toContain('type="file"');
    const put = (body: string) =>
      fetch(`${base}/f/uuuuuuuuuuuuuuuuuuuuuu/upload`, { method: 'PUT', body, headers: { 'X-File-Name': encodeURIComponent('../архив.zip') } });
    const first = await put('hello');
    expect(first.status).toBe(200);
    const dir = path.join(bridge(), 'incoming', 'uuuuuuuuuuuuuuuuuuuuuu');
    const done = JSON.parse(await readFile(path.join(dir, 'done.json'), 'utf8'));
    expect(done).toMatchObject({ name: '_архив.zip', size: 5 });
    expect(await readFile(path.join(dir, done.file), 'utf8')).toBe('hello');
    expect((await put('again')).status).toBe(410);
    expect(existsSync(path.join(dir, '.lock'))).toBe(false);
  });

  it('refuses an upload that would eat the reserve', async () => {
    const r = await fetch(`${base}/f/rrrrrrrrrrrrrrrrrrrrrr/upload`, { method: 'PUT', body: 'hello' });
    expect(r.status).toBe(507);
  });
});
