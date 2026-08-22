/**
 * Renders a Telegram animated sticker (.tgs — gzip-compressed Lottie JSON) to a
 * WebM video. MAX has no confirmed way to accept a native animated sticker upload
 * (no equivalent of STICKER_UPLOAD found from the receiving side, and uploading the
 * raw .tgs as a FILE just lands as a static file attachment). But MAX's own
 * animated stickers arrive as VIDEO attaches that autoplay in the chat feed — per
 * the user's own testing 2026-08-13 — so rendering the Lottie to a short WebM and
 * sending it through the existing (proven) VIDEO_UPLOAD pipeline gets the same
 * "plays right in the feed" result without needing MAX's real sticker format.
 *
 * Rendering uses a headless Chromium (via puppeteer-core, pointed at the system
 * `chromium` package rather than downloading its own copy) running lottie-web's
 * canvas renderer, stepping frame-by-frame for accuracy, then stitching the PNG
 * sequence into a VP9 WebM with ffmpeg.
 */
import { gunzipSync } from 'node:zlib';
import { spawn } from 'node:child_process';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { existsSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import puppeteer from 'puppeteer-core';
import { createLogger } from '../logger.js';

const logger = createLogger('lottie');

const CHROMIUM_PATH = process.env.CHROMIUM_PATH || '/usr/bin/chromium';

/**
 * Whether this image can render animated (.tgs) stickers to video. The "slim" build (STICKERS=slim,
 * see Dockerfile) omits Chromium+ffmpeg to save ~1.4 GB; there, animated stickers relay as their
 * static thumbnail instead. Presence of the Chromium binary IS the signal — no separate flag needed.
 */
export function canRenderAnimatedStickers(): boolean {
  return existsSync(CHROMIUM_PATH);
}
// esbuild bundles this whole module into dist/server.mjs — import.meta.url at
// runtime points at THAT file's location (/app/dist/server.mjs), not this
// source file's, so the relative path has to be resolved from there.
const LOTTIE_WEB_PATH = new URL('../node_modules/lottie-web/build/player/lottie.min.js', import.meta.url);

let lottieScriptCache: string | null = null;
function getLottieScript(): string {
  lottieScriptCache ??= readFileSync(LOTTIE_WEB_PATH, 'utf8');
  return lottieScriptCache;
}

interface LottieJson {
  fr?: number;
  ip?: number;
  op?: number;
  w?: number;
  h?: number;
}

function parseLottieJson(buffer: Buffer): LottieJson {
  // fetch() may have already transparently decompressed the gzip Content-Encoding
  // (same quirk hit on the MAX -> Telegram sticker path 2026-08-13) — try raw JSON
  // first, fall back to gunzip, rather than guessing from magic bytes.
  try {
    return JSON.parse(buffer.toString('utf8'));
  } catch {
    return JSON.parse(gunzipSync(buffer).toString('utf8'));
  }
}

function runFfmpeg(args: string[]): Promise<void> {
  return new Promise((resolve, reject) => {
    const proc = spawn('ffmpeg', args);
    let stderr = '';
    proc.stderr.on('data', (d) => {
      stderr += d.toString();
    });
    proc.on('error', reject);
    proc.on('close', (code) => {
      if (code === 0) resolve();
      else reject(new Error(`ffmpeg exited ${code}: ${stderr.slice(-2000)}`));
    });
  });
}

/** Renders a .tgs buffer (raw or gzip-compressed) to a short WebM (VP9) video buffer. */
export async function renderTgsToWebm(tgsBuffer: Buffer): Promise<Buffer> {
  const lottieJson = parseLottieJson(tgsBuffer);
  const width = lottieJson.w || 512;
  const height = lottieJson.h || 512;
  const nativeFr = lottieJson.fr || 60;
  const ip = lottieJson.ip ?? 0;
  const op = lottieJson.op ?? ip + nativeFr * 3;
  // Cap capture framerate at 30fps — halves the screenshot count for a typical
  // 60fps sticker with no visible smoothness loss on a small chat bubble.
  const targetFr = Math.min(nativeFr, 30);
  const frameStep = nativeFr / targetFr;
  const outputFrameCount = Math.max(1, Math.min(300, Math.round((op - ip) / frameStep)));

  const html = `<!doctype html><html><body style="margin:0;background:transparent;overflow:hidden">
<div id="a" style="width:${width}px;height:${height}px"></div>
<script>${getLottieScript()}</script>
<script>
  window.__anim = lottie.loadAnimation({
    container: document.getElementById('a'),
    renderer: 'canvas',
    loop: false,
    autoplay: false,
    animationData: ${JSON.stringify(lottieJson)},
  });
  window.__ready = new Promise((resolve) => {
    if (window.__anim.isLoaded) resolve(true);
    else window.__anim.addEventListener('DOMLoaded', () => resolve(true));
  });
</script>
</body></html>`;

  const tmpDir = await mkdtemp(path.join(tmpdir(), 'tgs-'));
  let browser: Awaited<ReturnType<typeof puppeteer.launch>> | undefined;
  try {
    browser = await puppeteer.launch({
      executablePath: CHROMIUM_PATH,
      headless: true,
      args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-gpu'],
    });
    const page = await browser.newPage();
    await page.setViewport({ width, height, deviceScaleFactor: 1 });
    await page.setContent(html, { waitUntil: 'load' });
    await page.waitForFunction('window.__ready', { timeout: 15_000 });

    for (let i = 0; i < outputFrameCount; i++) {
      const nativeFrame = ip + i * frameStep;
      await page.evaluate((frame: number) => {
        // Runs inside the browser page, not this Node process — `globalThis` (not
        // `window`) avoids needing the "dom" lib in this project's server tsconfig.
        (globalThis as unknown as { __anim: { goToAndStop: (f: number, isFrame: boolean) => void } }).__anim.goToAndStop(frame, true);
      }, nativeFrame);
      await page.screenshot({ path: path.join(tmpDir, `f${String(i).padStart(5, '0')}.png`) as `${string}.png` });
    }
    await browser.close();
    browser = undefined;

    const outputPath = path.join(tmpDir, 'out.webm');
    await runFfmpeg([
      '-y',
      '-framerate',
      String(targetFr),
      '-i',
      path.join(tmpDir, 'f%05d.png'),
      '-c:v',
      'libvpx-vp9',
      '-pix_fmt',
      'yuva420p',
      '-b:v',
      '0',
      '-crf',
      '32',
      outputPath,
    ]);
    return await readFile(outputPath);
  } finally {
    if (browser) await browser.close().catch((err) => logger.error('Failed to close Chromium after error', err));
    await rm(tmpDir, { recursive: true, force: true }).catch((err) => logger.error('Failed to clean up tgs render temp dir', err));
  }
}

