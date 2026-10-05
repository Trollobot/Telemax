// Pure logic of the anonymous error reports (no I/O, no clock) — server.mjs wires it to HTTP,
// the data file and Telegram; tests/reports.test.ts covers it.

export const DAY_MS = 86_400_000;
export const HOUR_MS = 3_600_000;
export const REPORTS_PER_INSTALL_PER_DAY = 10;
export const MAX_SIGNATURES = 2000;
export const MAX_INSTALLS_PER_SIGNATURE = 500;
const MAX_VERSIONS_PER_SIGNATURE = 50;

const clip = (v, n) => (typeof v === 'string' && v.trim() ? v.trim().slice(0, n) : undefined);
const num = (v) => (typeof v === 'number' && Number.isFinite(v) && v >= 0 ? Math.round(v) : undefined);

/** Validates and truncates an incoming body; null when it is not a usable report. */
export function sanitizeReport(body) {
  if (!body || typeof body !== 'object') return null;
  const installId = typeof body.installId === 'string' && body.installId.length <= 64 ? body.installId : '';
  const kind = clip(body.kind, 60);
  if (!installId || !kind) return null;
  return {
    installId,
    kind,
    version: clip(body.version, 60) ?? 'unknown',
    step: clip(body.step, 60),
    error: clip(body.error, 300),
    toVersion: clip(body.toVersion, 60),
    os: clip(body.os, 60),
    docker: clip(body.docker, 60),
    git: clip(body.git, 60),
    node: clip(body.node, 60),
    freeMb: num(body.freeMb),
    memMb: num(body.memMb),
  };
}

/** Makes two occurrences of one fault compare equal: numbers, ids and install-specific paths go. */
export function normalizeError(error) {
  return String(error ?? '')
    .toLowerCase()
    // absolute path (posix or windows) -> its basename
    .replace(/(?:[a-z]:)?(?:[\\/][^\s\\/:'"),]+)+/g, (p) => p.slice(Math.max(p.lastIndexOf('/'), p.lastIndexOf('\\')) + 1))
    .replace(/\b[0-9a-f]{4,}(?:-[0-9a-f]{4,})+\b/g, '#') // uuid-like
    .replace(/\b(?=[a-f]*\d)[0-9a-f]{8,}\b/g, '#') // hex id (must hold a digit, so words survive)
    .replace(/\d+/g, '#')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 160);
}

export function signatureOf(report) {
  return `${report.kind}|${report.step ?? ''}|${normalizeError(report.error)}`;
}

/**
 * Whether a report counts. There is no shared secret (the code is open source), so the only gate
 * is "this id has pinged before" plus a per-install daily budget. `recent` is installId -> accepted
 * timestamps and is updated here.
 */
export function acceptReport(report, installs, recent, now) {
  if (!Object.hasOwn(installs, report.installId)) return false;
  const times = (recent.get(report.installId) ?? []).filter((t) => now - t < DAY_MS);
  if (times.length >= REPORTS_PER_INSTALL_PER_DAY) return false;
  times.push(now);
  recent.set(report.installId, times);
  return true;
}

/** Folds an accepted report into `signatures` (mutated); returns its signature and whether it is new. */
export function recordReport(signatures, report, now) {
  const sig = signatureOf(report);
  let e = signatures[sig];
  const isNew = !e;
  if (!e) {
    const keys = Object.keys(signatures);
    if (keys.length >= MAX_SIGNATURES) {
      delete signatures[keys.reduce((a, b) => (signatures[b].lastSeen < signatures[a].lastSeen ? b : a))];
    }
    e = signatures[sig] = { kind: report.kind, step: report.step ?? null, sample: report.error ?? null, firstSeen: now, count: 0, installs: {}, versions: {}, env: {} };
  }
  e.lastSeen = now;
  e.count += 1;
  if (e.installs[report.installId] !== undefined || Object.keys(e.installs).length < MAX_INSTALLS_PER_SIGNATURE) e.installs[report.installId] = now;
  if (e.versions[report.version] !== undefined || Object.keys(e.versions).length < MAX_VERSIONS_PER_SIGNATURE) {
    e.versions[report.version] = (e.versions[report.version] ?? 0) + 1;
  }
  for (const k of ['os', 'docker', 'git', 'node', 'toVersion', 'freeMb', 'memMb']) if (report[k] !== undefined) e.env[k] = report[k];
  return { sig, isNew };
}

/**
 * At most one maintainer message per hour. A NEW signature is queued; returns the signatures to
 * announce right now (empty while the hour is running — the caller retries after dueIn()).
 * `state` = { lastSentAt, queue } and is mutated. Pass sig = null to only flush what is due.
 */
export function scheduleNotice(state, sig, now) {
  if (sig && !state.queue.includes(sig)) state.queue.push(sig);
  if (!state.queue.length || now - (state.lastSentAt ?? 0) < HOUR_MS) return [];
  state.lastSentAt = now;
  return state.queue.splice(0);
}

/** Milliseconds until the queued signatures may be sent; null when nothing waits. */
export function dueIn(state, now) {
  return state.queue.length ? Math.max(0, (state.lastSentAt ?? 0) + HOUR_MS - now) : null;
}

/** The maintainer message: the first new signature in full, the rest folded into a counter. No installId. */
export function formatNotice(entries) {
  const [e, ...rest] = entries;
  const env = e.env ?? {};
  const versions = Object.keys(e.versions).join(', ') + (env.toVersion ? ` → ${env.toVersion}` : '');
  const lines = [
    `🤖 Новая ошибка: ${e.kind}${e.step ? ` · шаг «${e.step}»` : ''}`,
    e.sample ? `Текст: ${e.sample}` : null,
    `Версия: ${versions}`,
    env.freeMb !== undefined || env.memMb !== undefined ? `Свободно: диск ${env.freeMb ?? '?'} МБ, память ${env.memMb ?? '?'} МБ` : null,
    env.os ? `ОС: ${env.os}` : null,
    [env.docker && `Docker ${env.docker}`, env.git && `git ${env.git}`, env.node && `Node ${env.node}`].filter(Boolean).join(', ') || null,
    rest.length ? `…и ещё ${rest.length} новых (см. /reports)` : null,
  ];
  return lines.filter(Boolean).join('\n');
}

/** GET /reports body: signatures seen within `days`, newest first. */
export function listReports(signatures, days, now) {
  return Object.values(signatures)
    .filter((e) => e.lastSeen >= now - days * DAY_MS)
    .sort((a, b) => b.lastSeen - a.lastSeen)
    .map((e) => ({
      kind: e.kind,
      step: e.step,
      sample: e.sample,
      count: e.count,
      installs: Object.keys(e.installs).length,
      versions: e.versions,
      env: e.env,
      firstSeen: new Date(e.firstSeen).toISOString(),
      lastSeen: new Date(e.lastSeen).toISOString(),
    }));
}
