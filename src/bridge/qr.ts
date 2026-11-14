import { crc32, deflateSync } from 'node:zlib';
import { encode } from 'uqr';

/**
 * A QR code for `text` as a black-on-white greyscale PNG, ready for Telegram's sendPhoto. uqr does the
 * QR encoding (no dependencies of its own); the PNG is written here with node:zlib — one IHDR, one
 * IDAT, no filters — instead of pulling in an image library for a single picture.
 */
export function qrPng(text: string, scale = 8): Buffer {
  const { data, size } = encode(text, { ecc: 'M', border: 4 });
  const side = size * scale;
  const raw = Buffer.alloc((side + 1) * side, 255); // one filter byte (0 = none) per row, 255 = white
  for (let y = 0; y < side; y++) {
    const row = y * (side + 1);
    raw[row] = 0;
    for (let x = 0; x < side; x++) {
      if (data[Math.floor(y / scale)]?.[Math.floor(x / scale)]) raw[row + 1 + x] = 0;
    }
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(side, 0);
  ihdr.writeUInt32BE(side, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 0; // colour type: greyscale (compression, filter, interlace stay 0)
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw)),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

function chunk(type: string, body: Buffer): Buffer {
  const head = Buffer.alloc(8);
  head.writeUInt32BE(body.length, 0);
  head.write(type, 4, 'ascii');
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(Buffer.concat([head.subarray(4), body])) >>> 0, 0);
  return Buffer.concat([head, body, crc]);
}
