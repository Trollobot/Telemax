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
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';
import tls from 'node:tls';
import { Agent, fetch as undiciFetch, type RequestInit, type Response } from 'undici';
import { createLogger } from '../logger.js';

const logger = createLogger('max-ca');

function loadRussianCaChain(): string[] {
  const pems: string[] = [];
  for (const file of ['russian_trusted_root_ca.crt', 'russian_trusted_sub_ca.crt']) {
    try {
      pems.push(readFileSync(path.join(process.cwd(), 'certs', file), 'utf8'));
    } catch (err) {
      // Verification stays ON either way — connections to MAX will just fail
      // against the bundled roots, which is the safe direction to fail in.
      logger.error(`Missing certs/${file} — TLS to MAX will likely fail ("unable to get local issuer certificate")`, err);
    }
  }
  return pems;
}

/**
 * Node's bundled Mozilla roots + the Russian state chain. The bundled roots must
 * be re-included explicitly: passing `ca` to tls.connect/undici REPLACES the
 * default store rather than extending it.
 */
export const MAX_TLS_CA: string[] = [...tls.rootCertificates, ...loadRussianCaChain()];

const maxDispatcher = new Agent({ connect: { ca: MAX_TLS_CA } });

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
  return fetchMaxHost(url, init, maxDispatcher);
}

/**
 * The domains MAX serves files, photos, video and upload slots from (VK group infrastructure). The URLs
 * come out of MAX payloads, so this list — not the payload — decides where the state-CA trust and the
 * request (with a Telegram upload in its body, for upload slots) may go. A host outside it is refused
 * and logged by name: extend the list if a legitimate MAX host shows up there.
 */
export const MAX_HOST_SUFFIXES = ['oneme.ru', 'max.ru', 'okcdn.ru', 'mycdn.me', 'vkuser.net', 'userapi.com', 'vk.com', 'vk.me', 'ok.ru'];

/** Exported for tests. */
export function isMaxHost(url: string): boolean {
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    return false;
  }
  if (u.protocol !== 'https:') return false;
  const host = u.hostname.toLowerCase();
  return MAX_HOST_SUFFIXES.some((s) => host === s || host.endsWith(`.${s}`));
}

const MAX_REDIRECTS = 5;

/** fetch through a MAX dispatcher, following redirects by hand so every hop is checked against MAX_HOST_SUFFIXES. */
async function fetchMaxHost(url: string, init: RequestInit, dispatcher: Agent): Promise<Response> {
  let current = url;
  for (let hop = 0; ; hop++) {
    if (!isMaxHost(current)) {
      let host = '[unparseable]';
      try {
        host = new URL(current).host;
      } catch {
        // keep the placeholder
      }
      logger.warn(`Refused a non-MAX URL (host ${host}${hop ? `, after ${hop} redirect(s)` : ''}) — not fetched with MAX's trust`);
      throw new Error(`not a MAX host: ${host}`);
    }
    const res = await undiciFetch(current, { ...init, dispatcher, redirect: 'manual' });
    const location = res.status >= 300 && res.status < 400 ? res.headers.get('location') : null;
    if (!location) return res;
    if (hop >= MAX_REDIRECTS) throw new Error('too many redirects from a MAX host');
    await res.body?.cancel().catch(() => {});
    current = new URL(location, current).toString();
  }
}

// Gigabyte transfers (fileShare.ts): the defaults (5 min to the response headers) are fine for a
// photo but not for MAX digesting a 4 GB upload; bodyTimeout stays an IDLE limit between chunks.
const maxBigDispatcher = new Agent({ connect: { ca: MAX_TLS_CA }, headersTimeout: 30 * 60_000, bodyTimeout: 5 * 60_000 });

/** maxFetch for streamed multi-gigabyte up/downloads — same trust set, longer timeouts. */
export function maxFetchBig(url: string, init: RequestInit = {}): Promise<Response> {
  return fetchMaxHost(url, init, maxBigDispatcher);
}
