/**
 * Scoped trust for MAX's TLS chain. MAX's certificates (*.oneme.ru and its CDN
 * hosts) chain through Russia's state CA (Минцифры "Russian Trusted Root/Sub CA"),
 * which no standard public trust store includes — see certs/README.md for how the
 * chain was verified before being trusted here.
 *
 * This used to be solved with NODE_EXTRA_CA_CERTS in the Dockerfile, which made
 * EVERY TLS connection from the container — Telegram Bot API, GitHub, ifconfig.me —
 * trust that CA too, meaning a MITM holding a Минцифры-issued certificate for
 * api.telegram.org would have been accepted silently. The extra CA is now scoped
 * to the only two places that actually talk to MAX: the raw TCP client
 * (client.ts passes MAX_TLS_CA to tls.connect) and the CDN up/downloads
 * (maxFetch below). Everything else stays on Node's bundled Mozilla roots.
 *
 * The PEMs are built into the code (russianCa.generated.ts, from certs/ by scripts/gen-russian-ca.mjs):
 * read from certs/ at run time, a bridge started from another folder or a copy missing the files
 * could not reach MAX at all (2026-11-22).
 */
import tls from 'node:tls';
import { Agent, fetch as undiciFetch, type buildConnector, type RequestInit, type Response } from 'undici';
import { createLogger } from '../logger.js';
import { RUSSIAN_CA_PEMS } from './russianCa.generated.js';
import { getMaxProxy, openMaxTunnel } from './proxy.js';

const logger = createLogger('max-ca');

/**
 * A connection to MAX refused on its certificate — not a network failure: something answers in
 * MAX's place (an antivirus or ad blocker «checking HTTPS», a VPN, a corporate proxy) or the bridge
 * missed the state CA (a phone, Termux, 2026-11-22 — before the certificates were built in).
 */
export function isCertificateErrorMessage(message: string): boolean {
  return /certificate|issuer|self[- ]signed|\bCERT_|altname/i.test(message);
}

/** What the owner is told when that happens (outage notice, /login, the log). */
export const MAX_CERT_PROBLEM_TEXT =
  'Не удалось проверить сертификат сервера MAX. Обычно так бывает, когда соединение перехватывает антивирус, VPN или блокировщик рекламы с проверкой HTTPS, или адрес MAX подменён (MAX_HOST, DNS).';

/**
 * Node's bundled Mozilla roots + the Russian state chain. The bundled roots must
 * be re-included explicitly: passing `ca` to tls.connect/undici REPLACES the
 * default store rather than extending it.
 */
export const MAX_TLS_CA: string[] = [...tls.rootCertificates, ...RUSSIAN_CA_PEMS.map((c) => c.pem)];

/**
 * undici's connect() through the MAX proxy: a tunnel from the proxy, our own TLS on top — the same
 * trust set and certificate check as a direct connection (see proxy.ts).
 */
function proxyConnector(proxy: string) {
  return (opts: buildConnector.Options, callback: buildConnector.Callback): void => {
    openMaxTunnel(proxy, opts.hostname, Number(opts.port) || 443).then(
      (raw) => {
        const socket = tls.connect({ socket: raw, servername: opts.servername || opts.hostname, ca: MAX_TLS_CA, rejectUnauthorized: true, ALPNProtocols: ['http/1.1'] });
        const onError = (err: Error): void => callback(err, null);
        socket.once('error', onError);
        socket.once('secureConnect', () => {
          socket.removeListener('error', onError);
          callback(null, socket);
        });
      },
      (err: Error) => callback(err, null),
    );
  };
}

// One dispatcher per kind for the proxy in force; a changed proxy (the panel, at run time) gets a
// fresh one, and the old one closes once its requests are done.
const dispatchers = new Map<'normal' | 'big', { proxy: string; agent: Agent }>();

function dispatcherFor(kind: 'normal' | 'big'): Agent {
  const proxy = getMaxProxy();
  const cached = dispatchers.get(kind);
  if (cached?.proxy === proxy) return cached.agent;
  if (cached) void cached.agent.close().catch(() => {});
  // Gigabyte transfers (fileShare.ts): the defaults (5 min to the response headers) are fine for a
  // photo but not for MAX digesting a 4 GB upload; bodyTimeout stays an IDLE limit between chunks.
  const timeouts = kind === 'big' ? { headersTimeout: 30 * 60_000, bodyTimeout: 5 * 60_000 } : {};
  const agent = new Agent({ ...timeouts, connect: proxy ? proxyConnector(proxy) : { ca: MAX_TLS_CA } });
  dispatchers.set(kind, { proxy, agent });
  return agent;
}

/**
 * fetch() for MAX-owned hosts only (upload slots, file/photo/video CDN) — same
 * trust set as the MaxClient socket. Never route Telegram/GitHub/anything else
 * through this: keeping the state CA away from those connections is the point.
 *
 * MUST be undici's own fetch, not the global one: Node's built-in fetch runs on
 * an internal (older) undici, and handing it an Agent from the npm undici v8
 * fails at dispatch time with "invalid onRequestStart method" — the handler
 * interface changed between those majors. Same-version fetch + Agent is the
 * only supported combination. Hit live 2026-08-14: every MAX CDN download died
 * with it while plain-TCP traffic kept working.
 */
export function maxFetch(url: string, init: RequestInit = {}): Promise<Response> {
  return fetchMaxHost(url, init, dispatcherFor('normal'));
}

/**
 * The domains MAX serves files, photos, video and upload slots from (VK group infrastructure). The URLs
 * come out of MAX payloads, so this list — not the payload — decides where the state-CA trust and the
 * request (with a Telegram upload in its body, for upload slots) may go. A host outside it is refused
 * and logged by name: extend the list if a legitimate MAX host shows up there.
 */
export const MAX_HOST_SUFFIXES = ['oneme.ru', 'max.ru', 'okcdn.ru', 'mycdn.me', 'vkuser.net', 'userapi.com', 'vk.com', 'vk.me', 'ok.ru'];

/**
 * MAX_HOST_SUFFIXES_EXTRA: more domains for MAX_HOST_SUFFIXES, comma-separated (e.g. a new CDN domain
 * MAX starts using before a release lists it — the refusal in the log names it). Exported for tests.
 */
export function extraMaxHostSuffixes(env: NodeJS.ProcessEnv = process.env): string[] {
  return (env.MAX_HOST_SUFFIXES_EXTRA ?? '')
    .split(',')
    .map((s) => s.trim().toLowerCase().replace(/^\.+/, ''))
    .filter((s) => /^[a-z0-9-]+(\.[a-z0-9-]+)+$/.test(s));
}

export function isMaxHost(url: string, env: NodeJS.ProcessEnv = process.env): boolean {
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    return false;
  }
  if (u.protocol !== 'https:') return false;
  const host = u.hostname.toLowerCase();
  return [...MAX_HOST_SUFFIXES, ...extraMaxHostSuffixes(env)].some((s) => host === s || host.endsWith(`.${s}`));
}

/**
 * MAX_HOST_CHECK: `enforce` refuses a URL outside MAX_HOST_SUFFIXES. Until the list has been checked
 * against the hosts MAX really serves files from, the default only says so in the log and fetches as
 * before — a missing domain must not cost every install its photos and files (the photo outage of
 * October 2026 was exactly that kind of surprise). Exported for tests.
 */
export function maxHostCheckMode(env: NodeJS.ProcessEnv = process.env): 'warn' | 'enforce' {
  return (env.MAX_HOST_CHECK ?? '').trim().toLowerCase() === 'enforce' ? 'enforce' : 'warn';
}

/** Hosts already named in the log in warn mode — one line per host, not one per file. */
const warnedHosts = new Set<string>();

const MAX_REDIRECTS = 5;
/** The statuses fetch follows; any other 3xx (300, 304…) is an answer, not a redirect. */
const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);

/** fetch through a MAX dispatcher, following redirects by hand so every hop is checked against MAX_HOST_SUFFIXES. */
async function fetchMaxHost(url: string, init: RequestInit, dispatcher: Agent): Promise<Response> {
  let current = url;
  let request: RequestInit = init;
  for (let hop = 0; ; hop++) {
    if (!isMaxHost(current)) {
      let host = '[unparseable]';
      try {
        host = new URL(current).host;
      } catch {
        // keep the placeholder
      }
      if (maxHostCheckMode() === 'enforce') {
        logger.warn(`Refused a non-MAX URL (host ${host}${hop ? `, after ${hop} redirect(s)` : ''}) — not fetched with MAX's trust. If MAX really serves files from there: MAX_HOST_SUFFIXES_EXTRA`);
        throw new Error(`not a MAX host: ${host}`);
      }
      if (!warnedHosts.has(host)) {
        warnedHosts.add(host);
        logger.warn(`A MAX file URL outside the known MAX hosts (host ${host}${hop ? `, after ${hop} redirect(s)` : ''}) — fetched as before; MAX_HOST_CHECK=enforce refuses such hosts`);
      }
    }
    const res = await undiciFetch(current, { ...request, dispatcher, redirect: 'manual' });
    const location = REDIRECT_STATUSES.has(res.status) ? res.headers.get('location') : null;
    if (!location) return res;
    if (hop >= MAX_REDIRECTS) throw new Error('too many redirects from a MAX host');
    await res.body?.cancel().catch(() => {});
    current = new URL(location, current).toString();
    // What fetch itself does: 303 always, and 301/302 after a POST, go on as a plain GET — the body
    // is not sent a second time. 307/308 repeat the request as it was.
    const method = (request.method ?? 'GET').toUpperCase();
    if (res.status === 303 ? method !== 'GET' && method !== 'HEAD' : (res.status === 301 || res.status === 302) && method === 'POST') {
      const headers = new Headers(request.headers as ConstructorParameters<typeof Headers>[0]);
      for (const h of ['content-type', 'content-length', 'content-encoding', 'content-language', 'content-location']) headers.delete(h);
      request = { ...request, method: 'GET', body: undefined, headers: [...headers.entries()] };
    }
  }
}


/** maxFetch for streamed multi-gigabyte up/downloads — same trust set, longer timeouts. */
export function maxFetchBig(url: string, init: RequestInit = {}): Promise<Response> {
  return fetchMaxHost(url, init, dispatcherFor('big'));
}

/**
 * Whether MAX answers through `proxy`: a tunnel to MAX's server and a full TLS handshake with MAX's
 * certificate checked — what the panel and setup do before a proxy is saved. Rejects with why not.
 */
export async function checkMaxThroughProxy(proxy: string, host = 'api2.oneme.ru', timeoutMs = 15_000): Promise<void> {
  const raw = await openMaxTunnel(proxy, host, 443, timeoutMs);
  await new Promise<void>((resolve, reject) => {
    const socket = tls.connect({ socket: raw, servername: host, ca: MAX_TLS_CA, rejectUnauthorized: true });
    const timer = setTimeout(() => socket.destroy(new Error(`no TLS answer from MAX in ${Math.round(timeoutMs / 1000)}s`)), timeoutMs);
    socket.once('secureConnect', () => {
      clearTimeout(timer);
      socket.destroy();
      resolve();
    });
    socket.once('error', (err) => {
      clearTimeout(timer);
      reject(err);
    });
  });
}
