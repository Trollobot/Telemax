import { describe, expect, it } from 'vitest';
import { BUGREPORT_BOT_DESCRIPTION, isCommandNotReport } from '../src/bridge/bugReports.js';

describe('isCommandNotReport', () => {
  it('answers the bridge commands pressed from a menu instead of relaying them', () => {
    expect(isCommandNotReport('/logout')).toBe(true);
    expect(isCommandNotReport('/version')).toBe(true);
    expect(isCommandNotReport('/help@SomeBot')).toBe(true);
    expect(isCommandNotReport('  /panel ')).toBe(true);
  });

  it('leaves /start and real reports alone', () => {
    expect(isCommandNotReport('/start')).toBe(false);
    expect(isCommandNotReport('/start login')).toBe(false);
    expect(isCommandNotReport('Не приходят фото')).toBe(false);
    expect(isCommandNotReport('после /version ничего не происходит')).toBe(false);
    expect(isCommandNotReport('/')).toBe(false);
    expect(isCommandNotReport(undefined)).toBe(false);
  });
});

describe('BUGREPORT_BOT_DESCRIPTION', () => {
  it('fits Telegram’s 512-character limit', () => {
    expect(BUGREPORT_BOT_DESCRIPTION.length).toBeLessThanOrEqual(512);
  });
});
