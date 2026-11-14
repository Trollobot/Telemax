import { describe, expect, it } from 'vitest';
import { readCapped } from '../src/bridge/attachments.js';

const stream = (chunks: number[], onCancel?: () => void) =>
  new ReadableStream<Uint8Array>({
    start(c) {
      for (const n of chunks) c.enqueue(new Uint8Array(n).fill(1));
      c.close();
    },
    cancel: onCancel,
  });

describe('readCapped', () => {
  it('returns the whole body under the limit', async () => {
    expect((await readCapped(stream([3, 4]), 10))?.length).toBe(7);
    expect((await readCapped(null, 10))?.length).toBe(0);
  });
  it('stops and cancels as soon as the body passes the limit', async () => {
    let cancelled = false;
    expect(await readCapped(stream([6, 6, 6], () => (cancelled = true)), 10)).toBeNull();
    expect(cancelled).toBe(true);
  });
});
