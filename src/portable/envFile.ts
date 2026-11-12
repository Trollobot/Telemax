/**
 * The portable build keeps its settings in the same `.env` the bridge reads (dotenv), so a folder
 * can move between a server and a PC as it is. The launcher only ever touches the keys its page
 * edits and leaves every other line — comments, keys set by hand — where it was.
 */

/** KEY -> value of every uncommented `KEY=value` line; a later line wins, as with dotenv. */
export function readEnvValues(text: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const line of text.split(/\r?\n/)) {
    const m = /^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/.exec(line);
    if (!m) continue;
    let value = (m[2] as string).trim();
    const quoted = /^(["'])(.*)\1$/.exec(value);
    if (quoted) value = quoted[2] as string;
    out[m[1] as string] = value;
  }
  return out;
}

/** A value the launcher may write: one line, no spaces or quotes — a token, an id, a URL. */
export function isSafeEnvValue(value: string): boolean {
  return !/[\s"'`\\]/.test(value) && !value.includes('#');
}

/**
 * Sets (a string) or removes (null) keys: an existing line is replaced in place, a new key is
 * appended. Throws on a value that could not be read back as written (see isSafeEnvValue).
 */
export function setEnvValues(text: string, values: Record<string, string | null>): string {
  for (const [key, value] of Object.entries(values)) {
    if (value != null && !isSafeEnvValue(value)) throw new Error(`${key}: в значении не должно быть пробелов, кавычек и знака #`);
  }
  const nl = text.includes('\r\n') ? '\r\n' : '\n';
  const pending = new Map(Object.entries(values));
  const lines: string[] = [];
  for (const line of text.split(/\r?\n/)) {
    const key = /^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=/.exec(line)?.[1];
    if (key == null || !pending.has(key)) {
      lines.push(line);
      continue;
    }
    const value = pending.get(key);
    pending.delete(key);
    if (value != null) lines.push(`${key}=${value}`);
  }
  while (lines.length > 0 && lines[lines.length - 1] === '') lines.pop();
  for (const [key, value] of pending) {
    if (value != null) lines.push(`${key}=${value}`);
  }
  return lines.join(nl) + nl;
}
