// Landing-page visit counter (telemax.svnest.ru and its GitHub Pages copy). The page sends a beacon
// `POST /site/hit {r: referrer, h: hostname}`; the server folds it into per-day counters right away
// and forgets the request: no IP, no user agent and no hash ever reaches the disk. Countries come
// from an in-memory GeoIP table (DB-IP Lite, CC BY 4.0); unique visitors are counted per day with
// a salt that lives only in memory and only for that day. `GET /site/stats` serves the aggregates
// to the public /stats/ page — visits only, nothing about installs.
// The decisions live here (pure, unit-tested); server.mjs does the I/O.
import { createHash, randomBytes } from 'node:crypto';

/** Days, hours and the «today» boundary follow Moscow time (UTC+3, no DST). */
export const MSK_OFFSET_MS = 3 * 60 * 60 * 1000;
export const KEEP_DAYS = 400;
/** Distinct sources per day before the rest fold into «other» — a bounded file whatever beacons say. */
const MAX_SOURCES_PER_DAY = 40;

export const mskDay = (ts) => new Date(ts + MSK_OFFSET_MS).toISOString().slice(0, 10);
export const mskHour = (ts) => new Date(ts + MSK_OFFSET_MS).getUTCHours();

const BOT_UA = /bot|crawl|spider|slurp|preview|headless|lighthouse|monitor|curl|wget|python|httpclient/i;
export const isBot = (ua) => !ua || BOT_UA.test(ua);

/** Our own hosts; anything else a beacon claims becomes «other». */
export const SITES = ['telemax.svnest.ru', 'trollobot.github.io'];
export const siteOf = (host) => {
  const h = String(host || '').toLowerCase();
  return SITES.includes(h) ? h : h === 'localhost' || h === '127.0.0.1' ? 'local' : 'other';
};

/** document.referrer → a source key: 'direct', a search engine or messenger family, or the bare host. Our own pages are 'internal'. */
export function sourceOf(referrer) {
  let host;
  try {
    host = new URL(String(referrer || '')).hostname.toLowerCase().replace(/^www\./, '');
  } catch {
    return 'direct';
  }
  if (!host) return 'direct';
  if (SITES.includes(host)) return 'internal';
  if (/(^|\.)google\.[a-z.]+$/.test(host)) return 'google';
  if (/(^|\.)(yandex\.[a-z.]+|ya\.ru)$/.test(host)) return 'yandex';
  if (/(^|\.)bing\.com$/.test(host)) return 'bing';
  if (/(^|\.)duckduckgo\.com$/.test(host)) return 'duckduckgo';
  if (/(^|\.)(t\.me|telegram\.org|telegram\.me)$/.test(host)) return 'telegram';
  if (/(^|\.)habr\.com$/.test(host)) return 'habr.com';
  if (/(^|\.)github\.com$/.test(host)) return 'github.com';
  return host.slice(0, 60);
}

// --- GeoIP (DB-IP «IP to Country Lite» CSV: start,end,country) ------------------------------

/** 32-bit number for a dotted IPv4, or null. */
export function ipv4ToNum(ip) {
  const m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(ip);
  if (!m) return null;
  const p = m.slice(1).map(Number);
  if (p.some((x) => x > 255)) return null;
  return ((p[0] << 24) >>> 0) + (p[1] << 16) + (p[2] << 8) + p[3];
}

/** The top 64 bits of an IPv6 address as a BigInt (enough to place it in a country range), or null. */
export function ipv6Prefix(ip) {
  if (!ip.includes(':')) return null;
  let s = ip.split('%')[0];
  // An embedded IPv4 tail (::ffff:1.2.3.4) only affects the low bits — drop it to two zero groups.
  s = s.replace(/(\d{1,3}\.){3}\d{1,3}$/, '0:0');
  const [head, tail] = s.split('::');
  const a = head ? head.split(':') : [];
  const b = tail !== undefined && tail !== '' ? tail.split(':') : [];
  if (s.includes('::') ? a.length + b.length > 7 : a.length !== 8) return null;
  const groups = [...a, ...Array(8 - a.length - b.length).fill('0'), ...b];
  let v = 0n;
  for (const g of groups.slice(0, 4)) {
    if (!/^[0-9a-f]{1,4}$/i.test(g)) return null;
    v = (v << 16n) | BigInt(parseInt(g, 16));
  }
  return v;
}

/** Normalizes a socket/header address: IPv4-mapped IPv6 → IPv4. */
export const cleanIp = (ip) => String(ip || '').trim().replace(/^::ffff:(?=\d+\.\d+\.\d+\.\d+$)/i, '');

/**
 * Collects DB-IP CSV lines one at a time (the server streams the gzip — the whole table as one string
 * cost ~150 MB of heap on the shared box) and builds the lookup table. build().lookup(ip) → 'RU', … or ''.
 */
export function createGeoBuilder() {
  const s4 = [];
  const e4 = [];
  const c4 = [];
  const s6 = [];
  const e6 = [];
  const c6 = [];
  const codes = [];
  const codeIdx = new Map();
  const idx = (c) => {
    if (!codeIdx.has(c)) {
      codeIdx.set(c, codes.length);
      codes.push(c);
    }
    return codeIdx.get(c);
  };
  return {
    add(line) {
      const [start, end, country] = line.trim().split(',');
      if (!start || !end || !/^[A-Z]{2}$/.test(country ?? '')) return;
      const a4 = ipv4ToNum(start);
      if (a4 !== null) {
        const b4 = ipv4ToNum(end);
        if (b4 !== null) s4.push(a4), e4.push(b4), c4.push(idx(country));
        return;
      }
      const a6 = ipv6Prefix(start);
      const b6 = ipv6Prefix(end);
      if (a6 !== null && b6 !== null) s6.push(a6), e6.push(b6), c6.push(idx(country));
    },
    build: () => buildGeo(codes, s4, e4, c4, s6, e6, c6),
  };
}

/** Builds a lookup table from the whole DB-IP CSV text (tests, small tables). */
export function createGeo(csvText) {
  const b = createGeoBuilder();
  for (const line of csvText.split('\n')) b.add(line);
  return b.build();
}

/** Sorted typed arrays (DB-IP ships the table sorted; anything else is sorted here) + binary search. */
function buildGeo(codes, s4raw, e4raw, c4raw, s6raw, e6raw, c6raw) {
  const order = (starts, cmp) => {
    const ix = starts.map((_, i) => i);
    for (let i = 1; i < starts.length; i++) if (cmp(starts[i - 1], starts[i]) > 0) return ix.sort((a, b) => cmp(starts[a], starts[b]));
    return ix;
  };
  const o4 = order(s4raw, (a, b) => a - b);
  const o6 = order(s6raw, (a, b) => (a < b ? -1 : a > b ? 1 : 0));
  const s4 = Uint32Array.from(o4, (i) => s4raw[i]);
  const e4 = Uint32Array.from(o4, (i) => e4raw[i]);
  const c4 = Uint16Array.from(o4, (i) => c4raw[i]);
  const s6 = BigUint64Array.from(o6, (i) => s6raw[i]);
  const e6 = BigUint64Array.from(o6, (i) => e6raw[i]);
  const c6 = Uint16Array.from(o6, (i) => c6raw[i]);
  const find = (starts, ends, cs, x) => {
    let lo = 0;
    let hi = starts.length - 1;
    let at = -1;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      if (starts[mid] <= x) {
        at = mid;
        lo = mid + 1;
      } else hi = mid - 1;
    }
    return at >= 0 && x <= ends[at] ? codes[cs[at]] : '';
  };
  return {
    size: s4.length + s6.length,
    lookup(ip) {
      const a = cleanIp(ip);
      const n4 = ipv4ToNum(a);
      if (n4 !== null) return find(s4, e4, c4, n4);
      const p6 = ipv6Prefix(a);
      return p6 === null ? '' : find(s6, e6, c6, p6);
    },
  };
}

// --- Counters -------------------------------------------------------------------------------

const emptyDay = () => ({ views: 0, visitors: 0, hours: Array(24).fill(0), countries: {}, sources: {}, sites: {} });
const bump = (obj, key, by = 1) => {
  obj[key] = (obj[key] ?? 0) + by;
};

/**
 * The counters. `days` is what gets saved; the day's salt and the set of visitor hashes stay in
 * memory (a restart mid-day only recounts a returning visitor once more).
 */
export function createSiteStats(saved = {}) {
  const days = saved && typeof saved.days === 'object' && saved.days ? saved.days : {};
  let day = null;
  let salt = null;
  let seen = new Set();

  return {
    days,
    /** Folds one beacon in. Returns false when it isn't counted (a bot, our own navigation). */
    hit({ ip, ua, referrer, host, country, now }) {
      if (isBot(ua)) return false;
      const source = sourceOf(referrer);
      const d = mskDay(now);
      if (d !== day) {
        day = d;
        salt = randomBytes(16);
        seen = new Set();
      }
      const rec = (days[d] ??= emptyDay());
      rec.views += 1;
      rec.hours[mskHour(now)] += 1;
      bump(rec.sites, siteOf(host));
      const visitor = createHash('sha256').update(salt).update(cleanIp(ip)).update('\0').update(String(ua)).digest('base64').slice(0, 16);
      if (!seen.has(visitor)) {
        seen.add(visitor);
        rec.visitors += 1;
        bump(rec.countries, country || '??');
        if (source !== 'internal') {
          const known = Object.keys(rec.sources);
          bump(rec.sources, known.includes(source) || known.length < MAX_SOURCES_PER_DAY ? source : 'other');
        }
      }
      return true;
    },
    /** Drops days older than KEEP_DAYS. */
    prune(now) {
      const cutoff = mskDay(now - KEEP_DAYS * 86_400_000);
      for (const d of Object.keys(days)) if (d < cutoff) delete days[d];
    },
    toJSON: () => ({ days }),
  };
}

/** What the public /stats/ page shows: totals, the last 30 days, hours, countries, sources. Visits only. */
export function summarize(days, now) {
  const today = mskDay(now);
  const dayList = (n) => Array.from({ length: n }, (_, i) => mskDay(now - (n - 1 - i) * 86_400_000));
  const sum = (list) =>
    list.reduce(
      (acc, d) => {
        const r = days[d];
        if (r) {
          acc.views += r.views;
          acc.visitors += r.visitors;
        }
        return acc;
      },
      { views: 0, visitors: 0 },
    );
  const last30 = dayList(30);
  const hours = Array(24).fill(0);
  const countries = {};
  const sources = {};
  const sites = {};
  for (const d of last30) {
    const r = days[d];
    if (!r) continue;
    r.hours.forEach((n, h) => (hours[h] += n));
    for (const [k, n] of Object.entries(r.countries)) bump(countries, k, n);
    for (const [k, n] of Object.entries(r.sources)) bump(sources, k, n);
    for (const [k, n] of Object.entries(r.sites)) bump(sites, k, n);
  }
  const top = (o, n) =>
    Object.entries(o)
      .sort((a, b) => b[1] - a[1])
      .slice(0, n);
  const all = Object.keys(days).sort();
  return {
    updatedAt: now,
    since: all[0] ?? today,
    today: sum([today]),
    yesterday: sum([mskDay(now - 86_400_000)]),
    last7: sum(dayList(7)),
    last30: sum(last30),
    total: sum(all),
    days: last30.map((d) => ({ d, views: days[d]?.views ?? 0, visitors: days[d]?.visitors ?? 0 })),
    hours,
    countries: top(countries, 20),
    sources: top(sources, 15),
    sites: top(sites, 5),
  };
}
