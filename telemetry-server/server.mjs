// Tiny anonymous install counter for Telemax. Runs ONLY on the maintainer's server (not part
// of a normal deployment). Receives `POST /ping {installId, version}` from installs and keeps
// installId -> {firstSeen, lastSeen, version}. Read the count with `GET /stats?key=<STATS_KEY>`.
// Also receives anonymous error reports (`POST /report`), aggregates them by signature into
// reports.json, tells the maintainer about each NEW signature through Telegram and lists them at
// `GET /reports`. The decisions live in reports.mjs.
// No frameworks, no deps — Node built-ins only.
import { createServer } from 'node:http';
import { readFile, writeFile, mkdir, rename } from 'node:fs/promises';
import path from 'node:path';
import { sanitizeReport, acceptReport, recordReport, scheduleNotice, dueIn, formatNotice, listReports } from './reports.mjs';

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
const REPORT_LIMIT_PER_IP = 30; // per rolling hour
const REPORTS_FILE = process.env.REPORTS_FILE || path.join(path.dirname(DATA_FILE), 'reports.json');
// Maintainer notifications about new error signatures; token or chat unset => off (aggregation still works).
const REPORT_BOT_TOKEN = process.env.REPORT_BOT_TOKEN || '';
const REPORT_CHAT_ID = process.env.REPORT_CHAT_ID || '';
const REPORT_THREAD_ID = Number(process.env.REPORT_THREAD_ID) || 0;

/** installId -> { firstSeen, lastSeen, version } */
let db = {};
/** signatures: signature -> aggregate; notify: { lastSentAt, queue, threadId } */
let reports = { signatures: {}, notify: { queue: [] } };
/** installId -> timestamps of accepted reports (the per-install daily budget; in memory only). */
const reportsByInstall = new Map();
/** file -> tail of its write queue, so writes to one file never interleave. */
const saveQueues = {};

/** ip -> recent request timestamps (bounded by the rate limit itself + periodic sweep). */
const pingsByIp = new Map();
const reportsByIp = new Map();
function ipRateLimited(ip, byIp = pingsByIp, limit = PING_LIMIT_PER_IP) {
  const now = Date.now();
  if (byIp.size >= 10_000 && !byIp.has(ip)) {
    for (const [k, times] of byIp) {
      if (times.every((t) => now - t >= PING_WINDOW_MS)) byIp.delete(k);
    }
  }
  const arr = (byIp.get(ip) ?? []).filter((t) => now - t < PING_WINDOW_MS);
  arr.push(now);
  byIp.set(ip, arr);
  return arr.length > limit;
}

async function load() {
  try {
    db = JSON.parse(await readFile(DATA_FILE, 'utf8'));
  } catch {
    db = {};
  }
  try {
    const saved = JSON.parse(await readFile(REPORTS_FILE, 'utf8'));
    reports = { signatures: saved.signatures ?? {}, notify: { queue: [], ...saved.notify } };
  } catch {
    // no reports yet
  }
}

function save(file = DATA_FILE, data = db) {
  const snapshot = JSON.stringify(data);
  saveQueues[file] = (saveQueues[file] ?? Promise.resolve())
    .then(async () => {
      await mkdir(path.dirname(file), { recursive: true });
      await writeFile(`${file}.tmp`, snapshot);
      await rename(`${file}.tmp`, file);
    })
    .catch(() => {});
  return saveQueues[file];
}

async function tg(method, payload) {
  const res = await fetch(`https://api.telegram.org/bot${REPORT_BOT_TOKEN}/${method}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ chat_id: REPORT_CHAT_ID, ...payload }),
    signal: AbortSignal.timeout(10_000),
  });
  const json = await res.json();
  if (!json.ok) throw new Error(json.description ?? `HTTP ${res.status}`);
  return json.result;
}

let noticeTimer = null;
/** Announces new signatures (sig = one just seen, or null to flush the queue) — at most one message per hour. */
async function notifyMaintainer(sig) {
  if (!REPORT_BOT_TOKEN || !REPORT_CHAT_ID) return;
  const due = scheduleNotice(reports.notify, sig, Date.now());
  const wait = dueIn(reports.notify, Date.now());
  if (wait !== null && !noticeTimer) {
    noticeTimer = setTimeout(() => {
      noticeTimer = null;
      void notifyMaintainer(null);
    }, wait + 1000);
  }
  const entries = due.map((s) => reports.signatures[s]).filter(Boolean);
  if (!entries.length) return;
  const text = formatNotice(entries);
  try {
    let thread = REPORT_THREAD_ID || reports.notify.threadId;
    if (!thread) {
      // One topic for all reports, created once; a chat without topics just gets plain messages.
      thread = await tg('createForumTopic', { name: '🤖 Автоотчёты об ошибках' }).then((t) => t.message_thread_id, () => 0);
      if (thread) reports.notify.threadId = thread;
    }
    await tg('sendMessage', thread ? { text, message_thread_id: thread } : { text }).catch((err) => {
      if (!thread) throw err;
      // The topic may have been deleted: forget a self-created one and still deliver.
      delete reports.notify.threadId;
      return tg('sendMessage', { text });
    });
  } catch (err) {
    console.log(`report notice failed: ${err.message}`);
  }
  void save(REPORTS_FILE, reports);
}

/** /stats and /reports: HTTPS-only + STATS_KEY. Answers 403 itself and returns false when refused. */
function allowed(req, res, url) {
  // HTTPS-only: the request must arrive via the Caddy TLS front (which stamps
  // X-Forwarded-Proto), never over the plain-HTTP port that stays open for legacy
  // /ping clients — so the key can't be accidentally sent in the clear. The header
  // is spoofable, but that only lets an attacker who ALREADY sends the key over
  // HTTP defeat their own transport security, not ours; the guard exists to stop
  // the owner from doing it by habit.
  if (req.headers['x-forwarded-proto'] !== 'https') {
    res.writeHead(403).end(`${url.pathname.slice(1)} is https-only — use https://zergont-gate.duckdns.org${url.pathname}`);
    return false;
  }
  // Prefer the x-stats-key header (doesn't land in access logs / proxies the way a
  // query string does); the ?key= form still works for quick curl/browser checks.
  const presented = req.headers['x-stats-key'] ?? url.searchParams.get('key');
  if (!STATS_KEY || presented !== STATS_KEY) {
    res.writeHead(403).end('forbidden');
    return false;
  }
  return true;
}

function readBody(req) {
  return new Promise((resolve) => {
    let data = '';
    req.setEncoding('utf8'); // a multi-byte character (a Russian step name) may straddle two chunks
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

  if (req.method === 'POST' && url.pathname === '/report') {
    const body = await readBody(req);
    const ip = req.socket.remoteAddress ?? 'unknown';
    try {
      const report = sanitizeReport(JSON.parse(body));
      const now = Date.now();
      if (report && !ipRateLimited(ip, reportsByIp, REPORT_LIMIT_PER_IP) && acceptReport(report, db, reportsByInstall, now)) {
        const { sig, isNew } = recordReport(reports.signatures, report, now);
        void save(REPORTS_FILE, reports);
        if (isNew) void notifyMaintainer(sig);
      }
    } catch {
      // ignore malformed reports — never error back
    }
    res.writeHead(204).end();
    return;
  }

  if (req.method === 'GET' && url.pathname === '/reports') {
    if (!allowed(req, res, url)) return;
    const days = Math.max(1, Number(url.searchParams.get('days') || 30));
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(listReports(reports.signatures, days, Date.now()), null, 2));
    return;
  }

  if (req.method === 'GET' && url.pathname === '/stats') {
    if (!allowed(req, res, url)) return;
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
void notifyMaintainer(null); // signatures queued before a restart
server.listen(PORT, () => console.log(`telemetry listening on :${PORT} (data: ${DATA_FILE})`));
