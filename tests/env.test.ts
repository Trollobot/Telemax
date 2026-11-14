import { describe, expect, it } from 'vitest';
import { parseEnvBool } from '../src/env.js';
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

describe('isTelemetryDisabled (default off, opt-in)', () => {
  it('is off when nothing is set, or set to off or something unrecognised', () => {
    expect(isTelemetryDisabled({})).toBe(true);
    expect(isTelemetryDisabled({ TELEMETRY: 'whatever', NO_TELEMETRY: 'whatever' })).toBe(true);
    for (const v of ['off', '0', 'false', 'no', 'OFF', '']) expect(isTelemetryDisabled({ TELEMETRY: v })).toBe(true);
  });

  it('is on only with an explicit TELEMETRY on-value, and NO_TELEMETRY still wins', () => {
    for (const v of ['1', 'true', 'yes', 'on', 'YES']) expect(isTelemetryDisabled({ TELEMETRY: v })).toBe(false);
    expect(isTelemetryDisabled({ TELEMETRY: 'on', NO_TELEMETRY: '0' })).toBe(false);
    expect(isTelemetryDisabled({ TELEMETRY: 'on', NO_TELEMETRY: 'yes' })).toBe(true);
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
