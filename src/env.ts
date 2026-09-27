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
