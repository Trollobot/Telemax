import type { Agent } from 'node:http';
import path from 'node:path';
import { mkdir, readFile, writeFile, rm } from 'node:fs/promises';
import { HttpsProxyAgent } from 'https-proxy-agent';
import { SocksProxyAgent } from 'socks-proxy-agent';
import { createLogger } from '../logger.js';

const logger = createLogger('proxy');

// Panel-set override, re-read on the next start. Lives in the same ./data volume as
// the MAX session so it survives container recreation and takes precedence over the
// TELEGRAM_PROXY env var without anyone having to edit .env by hand.
const PROXY_FILE = path.join(process.cwd(), '.data', 'proxy');

/** The proxy URL with any `user:pass@` stripped — safe to log or show in the panel. */
export function redactProxyUrl(proxyUrl: string): string {
  try {
    const u = new URL(proxyUrl);
    if (u.username || u.password) {
      u.username = '';
      u.password = '';
    }
    return u.toString();
  } catch {
    return '(invalid)';
  }
}

/**
 * Builds the http.Agent that tunnels Telegram traffic through the given proxy.
 * Accepts `http(s)://` and `socks(4|5|5h)://` URLs, optionally with `user:pass@`.
 * Returns undefined for an empty string (go direct). Throws on a malformed or
 * unsupported URL so a typo fails loudly at startup instead of silently going direct.
 *
 * The same agent is fed both to Telegraf (all Bot API calls, incl. the getUpdates
 * long-poll) and to the raw file-download fetch in the upload path — so every byte
 * to/from Telegram shares one route, while MAX keeps its own direct dispatcher.
 */
export function buildTelegramProxyAgent(proxyUrl: string): Agent | undefined {
  const url = proxyUrl.trim();
  if (!url) return undefined;
  let scheme: string;
  try {
    scheme = new URL(url).protocol.replace(/:$/, '').toLowerCase();
  } catch {
    throw new Error(`TELEGRAM_PROXY is not a valid URL (${redactProxyUrl(url)})`);
  }
  // Both agents subclass http.Agent at runtime; the cast just bridges the nominal gap
  // between the library's Agent type and node:http's.
  if (scheme.startsWith('socks')) {
    return new SocksProxyAgent(url) as unknown as Agent;
  }
  if (scheme === 'http' || scheme === 'https') {
    return new HttpsProxyAgent(url) as unknown as Agent;
  }
  throw new Error(`TELEGRAM_PROXY has an unsupported scheme "${scheme}" — use http://, https:// or socks5://`);
}

/** The panel-set override from ./data, or '' if none is saved. */
export async function readPersistedProxy(): Promise<string> {
  try {
    return (await readFile(PROXY_FILE, 'utf8')).trim();
  } catch {
    return '';
  }
}

/** Persists (or clears, on empty) the panel-set proxy override. Applied on next start. */
export async function writePersistedProxy(proxyUrl: string): Promise<void> {
  const clean = proxyUrl.trim();
  if (!clean) {
    await rm(PROXY_FILE, { force: true });
    return;
  }
  await mkdir(path.dirname(PROXY_FILE), { recursive: true });
  await writeFile(PROXY_FILE, clean, 'utf8');
}

/**
 * The effective proxy URL: the panel-set override in ./data wins over the
 * TELEGRAM_PROXY env var, so a change made in the panel survives restarts and takes
 * precedence without touching .env. Empty string means go direct.
 */
export async function resolveTelegramProxy(): Promise<string> {
  const persisted = await readPersistedProxy();
  return persisted || (process.env.TELEGRAM_PROXY ?? '').trim();
}

// Built once at startup (initTelegramProxy) and shared everywhere via the getters
// below. The panel changes the proxy by writing the ./data file and restarting the
// process (compose's `restart: unless-stopped` brings it straight back), never by
// hot-swapping this — Telegraf binds its agent at construction time.
let agentSingleton: Agent | undefined;
let resolvedUrl = '';

export async function initTelegramProxy(): Promise<void> {
  resolvedUrl = await resolveTelegramProxy();
  agentSingleton = buildTelegramProxyAgent(resolvedUrl);
  if (agentSingleton) logger.info(`Telegram идёт через прокси ${redactProxyUrl(resolvedUrl)}`);
}

export function getTelegramProxyAgent(): Agent | undefined {
  return agentSingleton;
}

export function getResolvedProxyUrl(): string {
  return resolvedUrl;
}
