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
