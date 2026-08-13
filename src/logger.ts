/**
 * Minimal leveled logger. Deliberately does not touch the filesystem —
 * stdout/stderr only, so the packet-heavy paths (MaxClient events, bridge
 * forwarding) never block on disk I/O (see ТЗ.md §4). If persistent logs are
 * ever needed, pipe stdout to a log manager with rotation at the process
 * level instead of writing files from here.
 */

export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

const LEVELS: Record<LogLevel, number> = { debug: 0, info: 1, warn: 2, error: 3 };

function currentLevel(): number {
  const configured = (process.env.LOG_LEVEL as LogLevel | undefined) ?? 'info';
  return LEVELS[configured] ?? LEVELS.info;
}

function write(level: LogLevel, scope: string, args: unknown[]): void {
  if (LEVELS[level] < currentLevel()) return;
  const line = `[${new Date().toISOString()}] ${level.toUpperCase()} ${scope}:`;
  const target = level === 'error' || level === 'warn' ? console.error : console.log;
  target(line, ...args);
}

export function createLogger(scope: string) {
  return {
    debug: (...args: unknown[]) => write('debug', scope, args),
    info: (...args: unknown[]) => write('info', scope, args),
    warn: (...args: unknown[]) => write('warn', scope, args),
    error: (...args: unknown[]) => write('error', scope, args),
  };
}

const SECRET_KEYS = new Set([
  'token',
  'verifyCode',
  'sessionToken',
  'loginToken',
  'authToken',
  'photoToken',
  'code',
  'apiKey',
]);

/** Recursively redacts known secret-bearing keys before logging or sending to the UI. */
export function redactSecrets(value: unknown, seen = new Set<unknown>()): unknown {
  if (typeof value === 'string' || value === null || typeof value !== 'object') return value;
  if (seen.has(value)) return '[circular]';
  seen.add(value);

  if (Array.isArray(value)) return value.map((item) => redactSecrets(item, seen));

  if (value instanceof Map) {
    const out: Record<string, unknown> = {};
    for (const [k, v] of value.entries()) {
      out[String(k)] = SECRET_KEYS.has(String(k)) ? maskString(v) : redactSecrets(v, seen);
    }
    return out;
  }

  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
    out[k] = SECRET_KEYS.has(k) ? maskString(v) : redactSecrets(v, seen);
  }
  return out;
}

/** JSON.stringify that survives msgpack-decoded int64 fields (they arrive as BigInt). */
export function jsonStringify(value: unknown): string {
  return JSON.stringify(value, (_key, v) => (typeof v === 'bigint' ? v.toString() + 'n' : v));
}

function maskString(value: unknown): string {
  if (typeof value !== 'string') return '[redacted]';
  if (value.length <= 8) return '[redacted]';
  return `${value.slice(0, 4)}...${value.slice(-4)} (${value.length})`;
}
