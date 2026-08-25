// Tiny anonymous install counter for Telemax. Runs ONLY on the maintainer's server (not part
// of a normal deployment). Receives `POST /ping {installId, version}` from installs and keeps
// installId -> {firstSeen, lastSeen, version}. Read the count with `GET /stats?key=<STATS_KEY>`.
// No frameworks, no deps — Node built-ins only.
import { createServer } from 'node:http';
import { readFile, writeFile, mkdir, rename } from 'node:fs/promises';
import path from 'node:path';

const PORT = Number(process.env.PORT || 3100);
const DATA_FILE = process.env.DATA_FILE || '/data/installs.json';
const STATS_KEY = process.env.STATS_KEY || ''; // required to read /stats; empty => /stats disabled
const MAX_BODY = 4096;
// /ping is unauthenticated by design (it must be zero-friction for installs), so it
// needs bounds an abuser can't blow through: a hard cap on distinct installIds (far
// above any plausible real install count) and a per-IP rate limit.
const MAX_INSTALLS = 50_000;
const PING_LIMIT_PER_IP = 60; // per rolling hour
const PING_WINDOW_MS = 60 * 60 * 1000;

/** installId -> { firstSeen, lastSeen, version } */
let db = {};
let saveQueue = Promise.resolve();

/** ip -> recent ping timestamps (bounded by the rate limit itself + periodic sweep). */
const pingsByIp = new Map();
function ipRateLimited(ip) {
  const now = Date.now();
  if (pingsByIp.size >= 10_000 && !pingsByIp.has(ip)) {
    for (const [k, times] of pingsByIp) {
      if (times.every((t) => now - t >= PING_WINDOW_MS)) pingsByIp.delete(k);
    }
  }
  const arr = (pingsByIp.get(ip) ?? []).filter((t) => now - t < PING_WINDOW_MS);
  arr.push(now);
  pingsByIp.set(ip, arr);
  return arr.length > PING_LIMIT_PER_IP;
}

async function load() {
  try {
    db = JSON.parse(await readFile(DATA_FILE, 'utf8'));
  } catch {
    db = {};
  }
}

function save() {
  const snapshot = JSON.stringify(db);
  saveQueue = saveQueue
    .then(async () => {
      await mkdir(path.dirname(DATA_FILE), { recursive: true });
      await writeFile(`${DATA_FILE}.tmp`, snapshot);
      await rename(`${DATA_FILE}.tmp`, DATA_FILE);
    })
    .catch(() => {});
  return saveQueue;
}

function readBody(req) {
  return new Promise((resolve) => {
    let data = '';
    req.on('data', (c) => {
      data += c;
      if (data.length > MAX_BODY) req.destroy();
    });
    req.on('end', () => resolve(data));
    req.on('error', () => resolve(''));
  });
}

const server = createServer(async (req, res) => {
  const url = new URL(req.url, 'http://x');

  if (req.method === 'POST' && url.pathname === '/ping') {
    const body = await readBody(req);
    const ip = req.socket.remoteAddress ?? 'unknown';
    try {
      const { installId, version } = JSON.parse(body);
      if (
        typeof installId === 'string' &&
        installId.length > 0 &&
        installId.length <= 64 &&
        !ipRateLimited(ip) &&
        // Existing installs always update; NEW ids are only admitted under the cap,
        // so a flood of fabricated ids can't grow the db (and its disk file) unbounded.
        (db[installId] !== undefined || Object.keys(db).length < MAX_INSTALLS)
      ) {
        const now = Date.now();
        const prev = db[installId];
        db[installId] = {
          firstSeen: prev?.firstSeen ?? now,
          lastSeen: now,
          version: typeof version === 'string' ? version.slice(0, 40) : null,
        };
        void save();
      }
    } catch {
      // ignore malformed pings — never error back
    }
    res.writeHead(204).end();
    return;
  }

  if (req.method === 'GET' && url.pathname === '/stats') {
    // Prefer the x-stats-key header (doesn't land in access logs / proxies the way a
    // query string does); the ?key= form still works for quick curl checks.
    const presented = req.headers['x-stats-key'] ?? url.searchParams.get('key');
    if (!STATS_KEY || presented !== STATS_KEY) {
      res.writeHead(403).end('forbidden');
      return;
    }
    const days = Math.max(1, Number(url.searchParams.get('days') || 30));
    const cutoff = Date.now() - days * 86_400_000;
    const entries = Object.values(db);
    const active = entries.filter((e) => e.lastSeen >= cutoff);
    const byVersion = {};
    for (const e of active) {
      const v = e.version || 'unknown';
      byVersion[v] = (byVersion[v] || 0) + 1;
    }
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ totalEver: entries.length, activeInWindow: active.length, windowDays: days, byVersion }, null, 2));
    return;
  }

  res.writeHead(404).end('not found');
});

await load();
server.listen(PORT, () => console.log(`telemetry listening on :${PORT} (data: ${DATA_FILE})`));
