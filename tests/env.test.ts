import { describe, expect, it } from 'vitest';
import { loadFileEnv, parseEnvBool } from '../src/env.js';
import { isTelemetryDisabled } from '../src/bridge/telemetry.js';
import { isBugReportInboxEnabled } from '../src/bridge/bugReports.js';

describe('parseEnvBool', () => {
  it('reads the on and off spellings in any case, ignoring surrounding whitespace', () => {
    for (const v of ['1', 'true', 'TRUE', 'yes', 'On', ' on ']) expect(parseEnvBool(v)).toBe(true);
    for (const v of ['0', 'false', 'False', 'no', 'OFF', ' off ']) expect(parseEnvBool(v)).toBe(false);
  });

  it('is undefined for unset, empty and anything else', () => {
    for (const v of [undefined, '', '  ', 'prod', 'enabled', '2']) expect(parseEnvBool(v)).toBeUndefined();
  });
});

describe('isTelemetryDisabled (default on)', () => {
  it('is on when nothing is set, or set to something unrecognised', () => {
    expect(isTelemetryDisabled({})).toBe(false);
    expect(isTelemetryDisabled({ TELEMETRY: 'on' })).toBe(false);
    expect(isTelemetryDisabled({ TELEMETRY: 'whatever', NO_TELEMETRY: 'whatever' })).toBe(false);
    expect(isTelemetryDisabled({ NO_TELEMETRY: '0' })).toBe(false);
  });

  it('keeps every opt-out spelling it accepted before', () => {
    for (const v of ['off', '0', 'false', 'no', 'OFF']) expect(isTelemetryDisabled({ TELEMETRY: v })).toBe(true);
    for (const v of ['1', 'true', 'yes', 'on', 'YES']) expect(isTelemetryDisabled({ NO_TELEMETRY: v })).toBe(true);
  });
});

describe('isBugReportInboxEnabled (default off)', () => {
  it('is off when unset or empty', () => {
    expect(isBugReportInboxEnabled({})).toBe(false);
    expect(isBugReportInboxEnabled({ BUGREPORT_INBOX: '' })).toBe(false);
  });

  it('is off for the off spellings', () => {
    for (const v of ['0', 'false', 'off', 'OFF', 'no']) expect(isBugReportInboxEnabled({ BUGREPORT_INBOX: v })).toBe(false);
  });

  it('is on for any other value, as before', () => {
    for (const v of ['1', 'true', 'yes', 'on', 'prod']) expect(isBugReportInboxEnabled({ BUGREPORT_INBOX: v })).toBe(true);
  });
});

describe('loadFileEnv (NAME_FILE → NAME)', () => {
  const files: Record<string, string> = { '/run/secrets/token': '123:abc\n', '/run/secrets/key': 'k' };
  const read = (p: string): string => {
    const v = files[p];
    if (v === undefined) throw new Error('ENOENT');
    return v;
  };

  it('fills an unset variable from its file, trimming the trailing newline', () => {
    const env: NodeJS.ProcessEnv = { TELEGRAM_BOT_TOKEN_FILE: '/run/secrets/token', MAX_SESSION_KEY_FILE: ' /run/secrets/key ' };
    loadFileEnv(env, read);
    expect(env.TELEGRAM_BOT_TOKEN).toBe('123:abc');
    expect(env.MAX_SESSION_KEY).toBe('k');
  });

  it('keeps an explicitly set variable and ignores an empty _FILE', () => {
    const env: NodeJS.ProcessEnv = { TELEGRAM_BOT_TOKEN: 'direct', TELEGRAM_BOT_TOKEN_FILE: '/run/secrets/token', X_FILE: '' };
    loadFileEnv(env, read);
    expect(env.TELEGRAM_BOT_TOKEN).toBe('direct');
    expect(env.X).toBeUndefined();
  });

  it('throws on a configured but unreadable file', () => {
    expect(() => loadFileEnv({ MAX_SESSION_KEY_FILE: '/nope' }, read)).toThrow(/MAX_SESSION_KEY_FILE/);
  });
});
