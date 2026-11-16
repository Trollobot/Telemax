import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { gzipSync } from 'node:zlib';
import { canRenderAnimatedStickers, renderTgsToWebm } from '../src/bridge/lottie.js';

// Real rendering in headless Chromium: runs only where Chromium is installed (the STICKERS=full image),
// skipped everywhere else. In the full image:
//   docker run --rm -v "$PWD":/src -w /src <full image> npx vitest run tests/lottie.test.ts
// (with the repo's dev dependencies installed in ./node_modules).

const keyframe = (t: number, s: number[]) => ({ t, s, i: { x: [0.5], y: [0.5] }, o: { x: [0.5], y: [0.5] } });

/** A one-second 64×64 sticker: a square moving across and turning. `expression` goes on its rotation. */
function sticker(expression?: string): Buffer {
  const rotation = { a: 1, k: [keyframe(0, [0]), keyframe(30, [90])], ...(expression ? { x: expression } : {}) };
  return gzipSync(
    JSON.stringify({
      v: '5.5.2', fr: 30, ip: 0, op: 30, w: 64, h: 64,
      layers: [{
        ddd: 0, ty: 4, ind: 1, sr: 1, ao: 0, bm: 0, ip: 0, op: 30, st: 0,
        ks: { o: { a: 0, k: 100 }, r: rotation, p: { a: 1, k: [keyframe(0, [16, 32, 0]), keyframe(30, [48, 32, 0])] }, a: { a: 0, k: [0, 0, 0] }, s: { a: 0, k: [100, 100, 100] } },
        shapes: [{ ty: 'rc', p: { a: 0, k: [0, 0] }, s: { a: 0, k: [16, 16] }, r: { a: 0, k: 0 } }, { ty: 'fl', c: { a: 0, k: [1, 0, 0, 1] }, o: { a: 0, k: 100 } }],
      }],
    }),
  );
}

const EBML_MAGIC = '1a45dfa3'; // every WebM starts with it

describe.skipIf(!canRenderAnimatedStickers())('renderTgsToWebm (real Chromium)', () => {
  const hits: string[] = [];
  let server: http.Server;
  let base = '';

  beforeAll(async () => {
    server = http.createServer((req, res) => {
      hits.push(req.url ?? '');
      res.end('ok');
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });

  afterAll(() => new Promise<void>((resolve) => server.close(() => resolve())));

  it('renders an ordinary animated sticker to a WebM', async () => {
    const webm = await renderTgsToWebm(sticker());
    expect(webm.subarray(0, 4).toString('hex')).toBe(EBML_MAGIC);
    expect(webm.length).toBeGreaterThan(500);
  }, 60_000);

  it('runs no JavaScript from the sticker and lets the page reach no network', async () => {
    // lottie-web's own expression "sandbox" only shadows window/fetch/…; the Function constructor
    // gets the real global back. With the full lottie build this reaches the server below.
    const escape = [
      "var g = [].constructor.constructor('return globalThis')();",
      `g.fetch('${base}/fetch').catch(function () {});`,
      `new g.Image().src = '${base}/img';`,
      '$bm_rt = value;',
    ].join(' ');
    const webm = await renderTgsToWebm(sticker(escape));
    expect(webm.subarray(0, 4).toString('hex')).toBe(EBML_MAGIC);
    await new Promise((resolve) => setTimeout(resolve, 500)); // let any stray request arrive
    expect(hits).toEqual([]);
  }, 60_000);
});
