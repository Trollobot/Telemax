import { describe, expect, it } from 'vitest';
import { formatAgo, formatBytes, formatDuration, formatStatus, maskPhone, type StatusInput } from '../src/bridge/status.js';

const NOW = 1_700_000_000_000;

function input(over: Partial<StatusInput> = {}): StatusInput {
  return {
    version: '0.6.0',
    uptimeSec: 3 * 86400 + 4 * 3600 + 5,
    max: { connected: true, phone: '+79959809587', lastLoginAt: NOW - 2 * 3600_000, paused: null },
    chats: { active: 12, banned: 1 },
    lastInAt: NOW - 3 * 60_000,
    lastOutAt: NOW - 12 * 60_000,
    disk: { freeBytes: 4.1 * 1024 ** 3, totalBytes: 20 * 1024 ** 3 },
    mem: { freeBytes: 900 * 1024 ** 2, totalBytes: 1.9 * 1024 ** 3 },
    load1: 0.123,
    update: { updateAvailable: false, latest: '0.6.0' },
    now: NOW,
    ...over,
  };
}

describe('status formatting', () => {
  it('formatAgo covers never / just now / minutes / hours / days', () => {
    expect(formatAgo(null, NOW)).toBe('ещё не было');
    expect(formatAgo(NOW - 30_000, NOW)).toBe('только что');
    expect(formatAgo(NOW - 5 * 60_000, NOW)).toBe('5 мин назад');
    expect(formatAgo(NOW - 3 * 3600_000, NOW)).toBe('3 ч назад');
    expect(formatAgo(NOW - 3 * 86400_000, NOW)).toBe('3 дн назад');
  });

  it('formatDuration / formatBytes', () => {
    expect(formatDuration(3 * 86400 + 4 * 3600)).toBe('3 дн 4 ч');
    expect(formatDuration(4 * 3600 + 12 * 60)).toBe('4 ч 12 мин');
    expect(formatDuration(12 * 60 + 5)).toBe('12 мин');
    expect(formatBytes(4.1 * 1024 ** 3)).toBe('4.1 ГБ');
    expect(formatBytes(512 * 1024 ** 2)).toBe('512 МБ');
  });

  it('maskPhone keeps a recognisable prefix/suffix only', () => {
    expect(maskPhone('+79959809587')).toBe('+7995***9587');
    expect(maskPhone('79959809587')).toBe('7995***9587');
    expect(maskPhone('')).toBe('не авторизован');
    expect(maskPhone('12345')).toBe('***');
  });

  it('renders the full card', () => {
    const text = formatStatus(input());
    expect(text).toContain('Версия 0.6.0 · аптайм 3 дн 4 ч');
    expect(text).toContain('MAX: 🟢 подключён · +7995***9587 · вход 2 ч назад');
    expect(text).toContain('Telegram: 🟢 бот на связи · чатов 12 (в бане 1)');
    expect(text).toContain('Последнее сообщение: из MAX 3 мин назад · в MAX 12 мин назад');
    expect(text).toContain('Диск (данные): свободно 4.1 ГБ из 20.0 ГБ');
    expect(text).not.toContain('мало места');
    expect(text).toContain('load 0.12');
    expect(text).toContain('Обновление: актуальная версия');
    expect(text).not.toContain('9809587'); // the full number never leaks
  });

  it('flags low disk, a pending update, a failed check, pause and no-session', () => {
    expect(formatStatus(input({ disk: { freeBytes: 500 * 1024 ** 2, totalBytes: 20 * 1024 ** 3 } }))).toContain('⚠️ мало места');
    expect(formatStatus(input({ update: { updateAvailable: true, latest: '0.6.1' } }))).toContain('⬆️ доступна 0.6.1 — /version');
    expect(formatStatus(input({ update: null }))).toContain('не удалось проверить');
    expect(formatStatus(input({ max: { connected: false, phone: '', lastLoginAt: null, paused: '~40 мин' } }))).toContain('MAX: ⏸ на паузе (~40 мин)');
    expect(formatStatus(input({ max: { connected: false, phone: '', lastLoginAt: null, paused: null } }))).toContain('MAX: 🔴 не авторизован — /login');
    // a connected but unauthenticated socket (fresh install) must NOT be green
    expect(formatStatus(input({ max: { connected: true, phone: '', lastLoginAt: null, paused: null } }))).toContain('MAX: 🔴 не авторизован — /login');
    expect(formatStatus(input({ max: { connected: false, phone: '+79959809587', lastLoginAt: null, paused: null } }))).toContain('MAX: 🔴 не подключён · +7995***9587');
    expect(formatStatus(input({ disk: null }))).not.toContain('Диск');
  });
});
