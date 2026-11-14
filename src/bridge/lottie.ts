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
import { createRequire } from 'node:module';
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
// Node's own module resolution, so it works both from the esbuild bundle (dist/server.mjs, where
// import.meta.url is the bundle) and from source under tsx (`npm run dev`, where it is this file):
// a path relative to import.meta.url only matched the bundle's location. lottie-web declares no
// "exports", so its build file is resolvable by subpath. Resolved lazily with the file read.
const requireFromHere = createRequire(import.meta.url);

let lottieScriptCache: string | null = null;
function getLottieScript(): string {
  // The light canvas build has no expression engine: the full build eval()s JavaScript embedded in the
  // animation JSON (Lottie "expressions"), i.e. a sticker could run code in our Chromium. Telegram's
  // .tgs spec forbids expressions anyway, so nothing a real sticker uses is lost.
  lottieScriptCache ??= readFileSync(requireFromHere.resolve('lottie-web/build/player/lottie_light_canvas.min.js'), 'utf8');
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
  // From the sticker file itself: numbers within reason only — a string would land unescaped in the
  // page's style attribute, a huge number would ask Chromium for gigabytes.
  const dim = (v: unknown): number => (typeof v === 'number' && Number.isFinite(v) && v > 0 && v <= 2048 ? Math.round(v) : 512);
  const width = dim(lottieJson.w);
  const height = dim(lottieJson.h);
  const nativeFr = lottieJson.fr || 60;
  const ip = lottieJson.ip ?? 0;
  const op = lottieJson.op ?? ip + nativeFr * 3;
  // Cap capture framerate at 30fps — halves the screenshot count for a typical
  // 60fps sticker with no visible smoothness loss on a small chat bubble.
  const targetFr = Math.min(nativeFr, 30);
  const frameStep = nativeFr / targetFr;
  const outputFrameCount = Math.max(1, Math.min(300, Math.round((op - ip) / frameStep)));

  // A .tgs is just a JSON file an arbitrary sender put in a chat, and it lands INSIDE a <script>
  // block. JSON.stringify escapes quotes but NOT '<', so a string value containing "</script>" ends
  // the block and everything after it becomes markup — arbitrary JS in a Chromium that sits next to
  // the bot token and the MAX session. Escaping '<' as \\u003c is the standard fix: still valid JSON
  // to the parser, impossible to break out of.
  const serializeForScript = (data: unknown): string => JSON.stringify(data).replace(/</g, '\\u003c');
  const html = `<!doctype html><html><body style="margin:0;background:transparent;overflow:hidden">
<div id="a" style="width:${width}px;height:${height}px"></div>
<script>${getLottieScript()}</script>
<script>
  window.__anim = lottie.loadAnimation({
    container: document.getElementById('a'),
    renderer: 'canvas',
    loop: false,
    autoplay: false,
    animationData: ${serializeForScript(lottieJson)},
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
    // The page needs nothing from the network (lottie-web is inlined, image assets of a sticker are
    // data: URLs). Chromium runs --no-sandbox, so give a hostile sticker no way out: every request
    // except data: is refused — no reaching the internet, the LAN or the Docker host from here.
    await page.setRequestInterception(true);
    page.on('request', (req) => {
      if (req.url().startsWith('data:')) req.continue().catch(() => {});
      else req.abort().catch(() => {});
    });
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

