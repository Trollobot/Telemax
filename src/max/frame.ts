import { zstdDecompressSync } from 'node:zlib';
import * as lz4 from 'lz4js';
import { DIR, PROTOCOL_VERSION } from './opcodes.js';

/**
 * Frame layout (max-protocol-full.md §1.1):
 *   ver(1) cmd(1) seq(2 BE) opcode(2 BE) packed_len(4 BE) payload(N)
 * packed_len top byte is the compression flag, low 3 bytes are the payload length.
 */
export const FRAME_HEADER_SIZE = 10;

export interface FrameHeader {
  ver: number;
  cmd: number;
  seq: number;
  opcode: number;
  flags: number;
  payloadLength: number;
}

export function readFrameHeader(buf: Buffer): FrameHeader {
  if (buf.length < FRAME_HEADER_SIZE) {
    throw new RangeError(`Buffer too short for a frame header: ${buf.length} bytes`);
  }
  const ver = buf.readUInt8(0);
  if (ver !== PROTOCOL_VERSION) {
    throw new Error(`Unexpected protocol version byte: 0x${ver.toString(16)}`);
  }
  const cmd = buf.readUInt8(1);
  const seq = buf.readUInt16BE(2);
  const opcode = buf.readUInt16BE(4);
  const packedLen = buf.readUInt32BE(6);
  const flags = (packedLen >>> 24) & 0xff;
  const payloadLength = packedLen & 0x00ffffff;
  return { ver, cmd, seq, opcode, flags, payloadLength };
}

export function encodeFrame(seq: number, opcode: number, payload: Buffer): Buffer {
  const header = Buffer.alloc(FRAME_HEADER_SIZE);
  header.writeUInt8(PROTOCOL_VERSION, 0);
  header.writeUInt8(DIR.TX, 1);
  header.writeUInt16BE(seq & 0xffff, 2);
  header.writeUInt16BE(opcode, 4);
  // Outgoing frames are never compressed, so the flag byte stays 0.
  header.writeUInt32BE(payload.length & 0x00ffffff, 6);
  return Buffer.concat([header, payload]);
}

/**
 * Largest payload a frame may decompress to. Real frames stay well under 1 MB; the cap is what stops
 * a hostile or intercepted server from sending a 16 MB frame that expands to gigabytes (zstd) or
 * spins the event loop for minutes (LZ4) — either would take the whole bridge down.
 */
export const MAX_DECOMPRESSED_BYTES = 32 * 1024 * 1024;

/**
 * Exact decompressed size of an LZ4 block, read from its sequence headers without copying anything —
 * O(input), so a block of 0xFF length bytes costs a scan, not billions of copy iterations. Throws
 * past `limit` or on a malformed block. LZ4 blocks don't self-describe their size, and lz4js needs
 * a pre-sized output buffer: this gives it one of the right size.
 */
export function lz4BlockSize(block: Uint8Array, limit = MAX_DECOMPRESSED_BYTES): number {
  let i = 0;
  let total = 0;
  const readLength = (base: number): number => {
    let len = base;
    if (base === 15) {
      let b: number;
      do {
        if (i >= block.length) throw new Error('LZ4 block truncated in a length field');
        b = block[i++]!;
        len += b;
        if (len > limit) throw new Error(`LZ4 block expands past ${limit} bytes`);
      } while (b === 255);
    }
    return len;
  };
  while (i < block.length) {
    const token = block[i++]!;
    const literals = readLength(token >> 4);
    i += literals;
    total += literals;
    if (i > block.length) throw new Error('LZ4 block truncated in its literals');
    if (i === block.length) break; // the last sequence has literals only
    if (i + 2 > block.length) throw new Error('LZ4 block truncated in an offset');
    i += 2;
    total += readLength(token & 0x0f) + 4;
    if (total > limit) throw new Error(`LZ4 block expands past ${limit} bytes`);
  }
  if (total > limit) throw new Error(`LZ4 block expands past ${limit} bytes`);
  return total;
}

/**
 * Decompress a frame payload per the flag byte (max-protocol-full.md §1.3):
 * 0 = none, 1-127 = LZ4 block, 0xFF = Zstd. Both are capped at MAX_DECOMPRESSED_BYTES.
 */
export function decompressPayload(payload: Buffer, flags: number): Buffer {
  if (flags === 0) return payload;
  if (flags === 0xff) {
    try {
      return zstdDecompressSync(payload, { maxOutputLength: MAX_DECOMPRESSED_BYTES });
    } catch (err) {
      if (err instanceof RangeError) throw new Error(`Zstd frame expands past ${MAX_DECOMPRESSED_BYTES} bytes`);
      throw err;
    }
  }
  if (flags >= 1 && flags <= 127) {
    const out = Buffer.alloc(lz4BlockSize(payload));
    const written = lz4.decompressBlock(payload, out, 0, payload.length, 0);
    return out.subarray(0, written);
  }
  throw new Error(`Unknown compression flag: ${flags}`);
}
