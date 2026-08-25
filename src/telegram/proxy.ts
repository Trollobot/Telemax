import type { Agent } from 'node:http';
import { HttpsProxyAgent } from 'https-proxy-agent';
import { SocksProxyAgent } from 'socks-proxy-agent';
import { createLogger } from '../logger.js';

const logger = createLogger('proxy');

/** The proxy URL with any `user:pass@` stripped — safe to log or show in chat. */
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

// Built once at startup (initTelegramProxy) and shared everywhere via the getter
// below. TELEGRAM_PROXY in .env is the single source of truth: Telegraf binds its
// agent at construction time, so changing the proxy means editing .env and
// recreating the container — setup.sh's settings menu does both (see README,
// «Изменение настроек после установки»).
let agentSingleton: Agent | undefined;

export function initTelegramProxy(): void {
  const url = (process.env.TELEGRAM_PROXY ?? '').trim();
  agentSingleton = buildTelegramProxyAgent(url);
  if (agentSingleton) logger.info(`Telegram идёт через прокси ${redactProxyUrl(url)}`);
}

export function getTelegramProxyAgent(): Agent | undefined {
  return agentSingleton;
}
