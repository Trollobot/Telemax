import { describe, expect, it } from 'vitest';
import * as lz4 from 'lz4js';
import { pack } from 'msgpackr';
import { decompressPayload, encodeFrame, FRAME_HEADER_SIZE, readFrameHeader } from '../src/max/frame.js';
import { decodeFramePayload, pickObject } from '../src/max/msgpack.js';
import { OPCODES, DIR, PROTOCOL_VERSION } from '../src/max/opcodes.js';

describe('encodeFrame / readFrameHeader', () => {
  it('round-trips seq, opcode and payload length', () => {
    const payload = Buffer.from('hello');
    const frame = encodeFrame(42, OPCODES.MSG_SEND, payload);
    const header = readFrameHeader(frame);

    expect(header.ver).toBe(PROTOCOL_VERSION);
    expect(header.cmd).toBe(DIR.TX);
    expect(header.seq).toBe(42);
    expect(header.opcode).toBe(OPCODES.MSG_SEND);
    expect(header.flags).toBe(0);
    expect(header.payloadLength).toBe(payload.length);
    expect(frame.subarray(FRAME_HEADER_SIZE)).toEqual(payload);
  });

  it('wraps seq past 16 bits', () => {
    const frame = encodeFrame(0x10001, OPCODES.PING, Buffer.alloc(0));
    const header = readFrameHeader(frame);
    expect(header.seq).toBe(1);
  });

  it('throws on a bad protocol version byte', () => {
    const bad = Buffer.alloc(FRAME_HEADER_SIZE);
    bad.writeUInt8(0x99, 0);
    expect(() => readFrameHeader(bad)).toThrow(/version/i);
  });

  it('throws on a short buffer', () => {
    expect(() => readFrameHeader(Buffer.alloc(4))).toThrow(RangeError);
  });
});

describe('decompressPayload', () => {
  it('passes flags=0 through unchanged', () => {
    const payload = Buffer.from('raw bytes');
    expect(decompressPayload(payload, 0)).toEqual(payload);
  });

  it('decompresses an LZ4 block for flags in 1-127', () => {
    const original = Buffer.from('x'.repeat(500) + 'the quick brown fox jumps over the lazy dog'.repeat(20));
    const compressed = Buffer.alloc(lz4.compressBound(original.length));
    const hashTable = new Int32Array(1 << 16);
    const compressedLength = lz4.compressBlock(original, compressed, 0, original.length, hashTable);
    const block = compressed.subarray(0, compressedLength);

    const result = decompressPayload(block, 2);
    expect(result.equals(original)).toBe(true);
  });

  it('throws on an unknown flag byte', () => {
    expect(() => decompressPayload(Buffer.alloc(4), 200)).toThrow(/unknown compression flag/i);
  });
});

describe('decodeFramePayload + pickObject', () => {
  it('decodes a single packed object', () => {
    const buf = pack({ token: 'abc' });
    const items = decodeFramePayload(buf);
    expect(pickObject(items)).toEqual({ token: 'abc' });
  });

  it('returns [] for an empty buffer', () => {
    expect(decodeFramePayload(Buffer.alloc(0))).toEqual([]);
  });

  it('picks the first object among concatenated top-level values', () => {
    const buf = Buffer.concat([pack('ignored-string'), pack({ chatId: 1 })]);
    const items = decodeFramePayload(buf);
    expect(pickObject(items)).toEqual({ chatId: 1 });
  });
});
