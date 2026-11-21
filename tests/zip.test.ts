import { describe, expect, it } from 'vitest';
import { crc32, inflateRawSync } from 'node:zlib';
import { zipSingleFile } from '../src/bridge/zip.js';
import { MaxUploadRefusedError, uploadRefusalTitle } from '../src/bridge/upload.js';
import { sendFailureText } from '../src/bridge/sync.js';
import { humanError } from '../src/bridge/bigFiles.js';

/** Reads the one entry back the way an unzipper does: via the end record and the central directory. */
function readBack(zip: Buffer): { name: string; data: Buffer; flags: number } {
  const end = zip.length - 22;
  expect(zip.readUInt32LE(end)).toBe(0x06054b50);
  expect(zip.readUInt16LE(end + 10)).toBe(1);
  const cd = zip.readUInt32LE(end + 16);
  expect(zip.readUInt32LE(cd)).toBe(0x02014b50);
  const method = zip.readUInt16LE(cd + 10);
  const crc = zip.readUInt32LE(cd + 16);
  const csize = zip.readUInt32LE(cd + 20);
  const size = zip.readUInt32LE(cd + 24);
  const nameLen = zip.readUInt16LE(cd + 28);
  const local = zip.readUInt32LE(cd + 42);
  expect(zip.readUInt32LE(local)).toBe(0x04034b50);
  const name = zip.subarray(cd + 46, cd + 46 + nameLen).toString('utf8');
  const start = local + 30 + zip.readUInt16LE(local + 26) + zip.readUInt16LE(local + 28);
  const raw = zip.subarray(start, start + csize);
  const data = method === 8 ? inflateRawSync(raw) : Buffer.from(raw);
  expect(data.length).toBe(size);
  expect(crc32(data) >>> 0).toBe(crc);
  return { name, data, flags: zip.readUInt16LE(cd + 8) };
}

describe('zipSingleFile', () => {
  it('packs one file that reads back byte for byte, a Cyrillic name included', () => {
    const html = Buffer.from('<!doctype html><title>МРТ</title>' + 'x'.repeat(5000));
    const out = readBack(zipSingleFile('МРТ разбор.html', html, new Date(2026, 10, 21, 22, 19, 4)));
    expect(out.name).toBe('МРТ разбор.html');
    expect(out.data.equals(html)).toBe(true);
    expect(out.flags & 0x0800).toBe(0x0800); // UTF-8 name
  });

  it('stores incompressible data as it is', () => {
    const random = Buffer.from(Array.from({ length: 4096 }, (_, i) => (i * 7919 + 13) % 251));
    const noise = Buffer.concat([random, Buffer.from(crypto.getRandomValues(new Uint8Array(4096)))]);
    expect(readBack(zipSingleFile('a.bin', noise)).data.equals(noise)).toBe(true);
    expect(readBack(zipSingleFile('empty.txt', Buffer.alloc(0))).data.length).toBe(0);
  });
});

describe('MAX refusing an upload', () => {
  const page =
    '<!doctype html><html lang="en"><head><title>HTTP Status 415 – Unsupported Media Type</title><style type="text/css">body {font-family:Tahoma}</style></head><body><h1>HTTP Status 415</h1></body></html>';

  it('keeps the page title, not the page', () => {
    expect(uploadRefusalTitle(page)).toBe('HTTP Status 415 – Unsupported Media Type');
    expect(uploadRefusalTitle('plain   text\nanswer')).toBe('plain text answer');
    expect(new MaxUploadRefusedError(415, 'File', page).message).toBe('File upload POST failed: 415 HTTP Status 415 – Unsupported Media Type');
  });

  it('tells the sender in plain words', () => {
    expect(sendFailureText(new MaxUploadRefusedError(415, 'File', page))).toMatch(/MAX не принимает файлы такого типа/);
    expect(sendFailureText(new MaxUploadRefusedError(500, 'File', '<title>Internal</title>'))).toBe('⚠️ Не отправлено: MAX не принял файл (500 Internal).');
    expect(humanError(new MaxUploadRefusedError(415, 'File', page))).toMatch(/упакуйте его в архив/);
  });
});
