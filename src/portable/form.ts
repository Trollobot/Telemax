import type { IncomingHttpHeaders } from 'node:http';
import { buildTelegramProxyAgent, redactProxyUrl } from '../telegram/proxy.js';

/** What the launcher's page edits — the same keys of .env the bridge reads. */
export interface Settings {
  token: string;
  group: string;
  proxy: string;
  sessionKey: string;
}

export interface FormInput {
  token?: unknown;
  proxy?: unknown;
  group?: unknown;
}

/** In plain words why a proxy address will not do, or null when it will. */
export function proxyProblem(url: string): string | null {
  if (!url) return null;
  if (/^(tg:\/\/proxy|https?:\/\/t\.me\/proxy)/i.test(url) || /[?&]secret=/i.test(url)) {
    return 'Это ссылка на MTProto-прокси для приложения Telegram — бот через такой работать не может. Нужен SOCKS5 или HTTP-прокси: socks5://логин:пароль@адрес:порт';
  }
  if (!/^[a-z][a-z0-9+.-]*:\/\//i.test(url)) return 'Укажите прокси полностью, вместе с видом: socks5://адрес:порт или http://адрес:порт';
  try {
    buildTelegramProxyAgent(url);
    return null;
  } catch {
    return 'Такой вид прокси не поддерживается. Подходят socks5://адрес:порт и http://адрес:порт (логин и пароль — перед адресом: socks5://логин:пароль@адрес:порт)';
  }
}

/**
 * The form's fields against what is saved: an empty token means "the saved one", and the proxy
 * field comes pre-filled with the saved address WITHOUT its password — sent back unchanged, it
 * means the saved one too.
 */
export function resolveForm(input: FormInput, saved: Settings): { token: string; proxy: string; group: string } {
  const str = (v: unknown): string => (typeof v === 'string' ? v.trim() : '');
  const proxy = str(input.proxy);
  return {
    token: str(input.token) || saved.token,
    proxy: proxy && saved.proxy && proxy === redactProxyUrl(saved.proxy) ? saved.proxy : proxy,
    group: str(input.group) || saved.group,
  };
}

/**
 * The page holds the bot token, so only this computer's own browser may talk to it: the socket
 * listens on 127.0.0.1, the Host header must be ours (a site that points its own name at 127.0.0.1
 * fails here), and a change needs a header no other site's page can send without asking first.
 */
export function isAllowedRequest(method: string, headers: IncomingHttpHeaders, port: number): boolean {
  const host = headers.host ?? '';
  if (host !== `127.0.0.1:${port}` && host !== `localhost:${port}`) return false;
  if (method === 'GET') return true;
  return method === 'POST' && headers['x-telemax'] === '1';
}
