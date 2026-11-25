/**
 * A proxy for everything that talks to MAX — the TCP client and the CDN up/downloads (GitHub #23:
 * a bridge on a VPS abroad, MAX unreachable from there for hours or days). Only a TUNNEL is taken
 * from the proxy: the TLS on top of it is still ours, with MAX_TLS_CA and rejectUnauthorized, so a
 * proxy cannot stand in for MAX's servers.
 *
 * The setting comes from the Telegram panel (saved in .data, see settings.ts) or MAX_PROXY in .env —
 * the panel's wins — and can change while the bridge runs: the client picks it up on its next
 * connect, the HTTP dispatchers are rebuilt on the next request.
 */
import { EventEmitter } from 'node:events';
import { mkdir, readFile, rename, unlink, writeFile } from 'node:fs/promises';
import path from 'node:path';
import type net from 'node:net';
import { HttpsProxyAgent } from 'https-proxy-agent';
import { SocksProxyAgent } from 'socks-proxy-agent';
import { redactProxyUrl } from '../telegram/proxy.js';

/** The proxy did not let us through to MAX (refused, unreachable, wrong password, timed out). */
export class MaxProxyError extends Error {
  constructor(proxyUrl: string, cause: unknown) {
    const why = cause instanceof Error ? cause.message : String(cause);
    super(`MAX proxy ${redactProxyUrl(proxyUrl)} failed: ${why}`, { cause });
    this.name = 'MaxProxyError';
  }
}

/** What the owner is told when the proxy for MAX does not work. */
export const MAX_PROXY_PROBLEM_TEXT = 'Прокси для MAX не отвечает или не пускает к MAX — проверьте его адрес, логин и пароль: /panel → ⚙️ Система → 🌐 Прокси для MAX.';

/** Null for a usable proxy URL (socks4/5, http/https), else why not — in words for the panel and setup. Exported for tests. */
export function proxyUrlProblem(raw: string): string | null {
  let u: URL;
  try {
    u = new URL(raw.trim());
  } catch {
    return 'это не адрес прокси — нужен вид socks5://логин:пароль@адрес:порт';
  }
  const scheme = u.protocol.replace(/:$/, '').toLowerCase();
  if (!/^(socks[45]h?|https?)$/.test(scheme)) return `«${scheme}://» не подходит — нужен socks5:// или http://`;
  if (!u.hostname) return 'в адресе нет сервера прокси';
  if (!u.port) return 'в адресе нет порта (…:1080 в конце)';
  return null;
}

let fromPanel: string | null = null;

/** The panel's setting (null: none — then MAX_PROXY from .env counts; '' : explicitly direct). */
export function setMaxProxyOverride(url: string | null): void {
  fromPanel = url == null ? null : url.trim();
}

/** The proxy in force: the panel's setting, else MAX_PROXY; '' means direct. */
export function getMaxProxy(env: NodeJS.ProcessEnv = process.env): string {
  return fromPanel ?? (env.MAX_PROXY ?? '').trim();
}

/** Where the setting in force came from — shown by the panel. */
export function maxProxySource(env: NodeJS.ProcessEnv = process.env): 'panel' | 'env' | 'none' {
  if (fromPanel != null) return fromPanel ? 'panel' : 'none';
  return (env.MAX_PROXY ?? '').trim() ? 'env' : 'none';
}

const TUNNEL_TIMEOUT_MS = 15_000;

/**
 * A plain TCP stream to host:port through `proxyUrl` — TLS is the caller's to put on top. Rejects
 * with MaxProxyError when the proxy does not get us there.
 */
export async function openMaxTunnel(proxyUrl: string, host: string, port: number, timeoutMs = TUNNEL_TIMEOUT_MS): Promise<net.Socket> {
  const scheme = new URL(proxyUrl).protocol.replace(/:$/, '').toLowerCase();
  const agent = scheme.startsWith('socks') ? new SocksProxyAgent(proxyUrl, { timeout: timeoutMs }) : new HttpsProxyAgent(proxyUrl);
  // agent-base's connect() wants the http.ClientRequest it serves; only its events and destroy() are touched.
  const req = Object.assign(new EventEmitter(), { destroy() {} });
  let timer: NodeJS.Timeout | undefined;
  let timedOut = false;
  try {
    const opened = (agent as unknown as { connect(r: unknown, o: object): Promise<net.Socket> }).connect(req, { host, port, secureEndpoint: false });
    // A tunnel that arrives after the timeout must not linger open.
    opened.then(
      (late) => {
        if (timedOut) late.destroy();
      },
      () => {},
    );
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(() => {
        timedOut = true;
        reject(new Error(`no tunnel in ${Math.round(timeoutMs / 1000)}s`));
      }, timeoutMs);
    });
    const socket = await Promise.race([opened, timeout]);
    // socks-proxy-agent leaves its connect timeout on the socket as an IDLE timeout that destroys it:
    // an open MAX connection is quiet for up to a minute between PINGs, and it was cut every ~15 s
    // (test, 2026-11-25). The tunnel is up — from here the client's own PING watches it.
    socket.setTimeout(0);
    socket.removeAllListeners('timeout');
    return socket;
  } catch (err) {
    throw new MaxProxyError(proxyUrl, err);
  } finally {
    clearTimeout(timer);
  }
}

// --- The panel's setting, kept in .data (0600: it may hold the proxy's password) --------------

const OVERRIDE_FILE = path.join(process.cwd(), '.data', 'max-proxy');

/** Reads the panel's proxy (if one was set) into effect. At startup, before the first connect. */
export async function loadMaxProxyOverride(file = OVERRIDE_FILE): Promise<void> {
  try {
    setMaxProxyOverride((await readFile(file, 'utf8')).trim() || null);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
    setMaxProxyOverride(null);
  }
}

/** Saves the panel's proxy (null: none — MAX_PROXY from .env, if any, counts again) and puts it into effect. */
export async function saveMaxProxyOverride(url: string | null, file = OVERRIDE_FILE): Promise<void> {
  if (url) {
    await mkdir(path.dirname(file), { recursive: true });
    const tmp = `${file}.tmp`;
    await writeFile(tmp, `${url.trim()}\n`, { mode: 0o600 });
    await rename(tmp, file);
  } else {
    await unlink(file).catch((err: NodeJS.ErrnoException) => {
      if (err.code !== 'ENOENT') throw err;
    });
  }
  setMaxProxyOverride(url);
}
