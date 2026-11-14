import { describe, expect, it } from 'vitest';
import { inflateSync } from 'node:zlib';
import { qrPng } from '../src/bridge/qr.js';

describe('qrPng', () => {
  it('writes a valid greyscale PNG with a white quiet zone and black modules', () => {
    const png = qrPng('https://max.ru/:auth/f4f0000000000000000000000000000000000000000000', 4);
    expect(png.subarray(0, 8).toString('hex')).toBe('89504e470d0a1a0a');
    const side = png.readUInt32BE(16);
    expect(png.readUInt32BE(20)).toBe(side);
    expect(png.subarray(12, 16).toString()).toBe('IHDR');
    const idatLen = png.readUInt32BE(33);
    expect(png.subarray(37, 41).toString()).toBe('IDAT');
    const raw = inflateSync(png.subarray(41, 41 + idatLen));
    expect(raw.length).toBe((side + 1) * side);
    expect(raw[1]).toBe(255); // top-left corner: quiet zone
    const finder = 4 * 4 + 1; // first module of the top-left finder pattern, after the 4-module border
    expect(raw[finder * (side + 1) + 1 + finder]).toBe(0);
  });
});
