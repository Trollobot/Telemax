import { readFileSync } from 'node:fs';

/**
 * The one boolean-env parser: true for 1/true/yes/on, false for
 * 0/false/off/no — any case, surrounding whitespace ignored — and undefined for anything else,
 * including unset/empty. Each caller decides what undefined means for its variable (its default,
 * and how a value outside both sets counts), so every variable keeps its own default.
 *
 * Deliberately NOT in server/config.ts: that module loads .env on import (dotenv/config), and
 * the bridge modules using this are imported by the tests.
 */
export function parseEnvBool(raw: string | undefined): boolean | undefined {
  const v = (raw ?? '').trim();
  if (/^(1|true|yes|on)$/i.test(v)) return true;
  if (/^(0|false|off|no)$/i.test(v)) return false;
  return undefined;
}

/**
 * Docker-secrets convention (as in the postgres/mysql images): NAME_FILE=/run/secrets/name fills
 * NAME from that file, trailing newline trimmed — so a token or key need not sit in .env or in the
 * container's environment. An explicitly set NAME wins. An unreadable file throws: a secret that is
 * configured but missing must stop the start, not silently run without it.
 */
export function loadFileEnv(env: NodeJS.ProcessEnv = process.env, read = (p: string) => readFileSync(p, 'utf8')): void {
  for (const [key, file] of Object.entries(env)) {
    if (!key.endsWith('_FILE') || !file?.trim()) continue;
    const name = key.slice(0, -'_FILE'.length);
    if (env[name]) continue;
    try {
      env[name] = read(file.trim()).replace(/\r?\n$/, '');
    } catch (err) {
      throw new Error(`${key}: cannot read ${file.trim()} (${(err as Error).message})`);
    }
  }
}
