import * as lz4 from 'lz4js';
import { decompress as zstdDecompress } from 'fzstd';
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

// Frames observed so far are well under 1 MB; this just needs to comfortably
// bound the worst case since lz4js's block decompressor requires a
// pre-sized output buffer (LZ4 blocks don't self-describe their size).
const LZ4_OUTPUT_HEADROOM = 8 * 1024 * 1024;

/**
 * Decompress a frame payload per the flag byte (max-protocol-full.md §1.3):
 * 0 = none, 1-127 = LZ4 block, 0xFF = Zstd.
 */
export function decompressPayload(payload: Buffer, flags: number): Buffer {
  if (flags === 0) return payload;
  if (flags === 0xff) return Buffer.from(zstdDecompress(payload));
  if (flags >= 1 && flags <= 127) {
    const out = Buffer.alloc(LZ4_OUTPUT_HEADROOM);
    const written = lz4.decompressBlock(payload, out, 0, payload.length, 0);
    return out.subarray(0, written);
  }
  throw new Error(`Unknown compression flag: ${flags}`);
}
