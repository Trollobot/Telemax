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
import { Agent } from 'undici';
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
 */
export function maxFetch(url: string, init: RequestInit = {}): Promise<Response> {
  // `dispatcher` is undici's fetch extension — absent from the standard RequestInit
  // type, and the installed undici's own types clash with @types/node's bundled
  // undici-types copy, so the cast has to go through unknown.
  return fetch(url, { ...init, dispatcher: maxDispatcher } as unknown as RequestInit);
}
