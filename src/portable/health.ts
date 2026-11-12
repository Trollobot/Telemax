import type { BridgeStatus } from '../bridge/statusFile.js';

/** green / yellow / red — the tray icon's colour and each line's on the status page. */
export type Level = 'ok' | 'warn' | 'bad';

export interface HealthLine {
  name: string;
  level: Level;
  text: string;
}

export interface Health {
  level: Level;
  /** One line for the tray tooltip. */
  summary: string;
  lines: HealthLine[];
}

/** What the launcher itself knows about the bridge process. */
export interface ProcessState {
  /** Token, group and session key are all in .env — without them the bridge is not started. */
  configured: boolean;
  running: boolean;
  /** When the current process was started. */
  startedAt: number | null;
  /** Crashes in a row; reset once a start holds. */
  failures: number;
  /** When the next start is due after a crash. */
  nextStartAt: number | null;
}

/** A status file this old means the bridge stopped writing it: twelve missed beats (bridge/statusFile.ts). */
export const HEARTBEAT_STALE_MS = 60_000;
/** A fresh process gets this long to write its first status before it counts as hung. */
export const STARTUP_GRACE_MS = 45_000;
/** A short blip is yellow; trouble that lasts is red and worth a notification. */
const BAD_AFTER_MS = 60_000;

function ago(since: number, now: number): string {
  const min = Math.max(0, Math.floor((now - since) / 60_000));
  if (min < 1) return 'меньше минуты';
  if (min < 60) return `${min} мин`;
  const h = Math.floor(min / 60);
  return h < 24 ? `${h} ч ${min % 60} мин` : `${Math.floor(h / 24)} дн ${h % 24} ч`;
}

const worst = (levels: Level[]): Level => (levels.includes('bad') ? 'bad' : levels.includes('warn') ? 'warn' : 'ok');

function maxLine(max: BridgeStatus['max'], now: number): HealthLine {
  const name = 'MAX';
  switch (max.state) {
    case 'loggedIn':
      return { name, level: 'ok', text: `подключён${max.phone ? ` · ${max.phone}` : ''}` };
    case 'ready':
      return { name, level: 'warn', text: 'связь есть, вход не выполнен — напишите боту в личку /login' };
    case 'paused':
      return { name, level: 'warn', text: 'на паузе — снять её можно в пульте (/panel) в Telegram' };
    case 'stopped':
      return { name, level: 'warn', text: 'отключён — войдите снова: /login в личке бота' };
    default: {
      // connecting / resuming / resumeRetry
      if (max.downSince == null) return { name, level: 'warn', text: 'подключаюсь…' };
      const level: Level = now - max.downSince >= BAD_AFTER_MS ? 'bad' : 'warn';
      return { name, level, text: `нет связи ${ago(max.downSince, now)} — мост переподключается сам` };
    }
  }
}

function telegramLine(tg: BridgeStatus['telegram'], now: number): HealthLine {
  const name = 'Telegram';
  const via = tg.proxy ? ` через прокси ${tg.proxy}` : '';
  if (tg.ok) return { name, level: 'ok', text: `подключён${via}` };
  const level: Level = now - tg.since >= BAD_AFTER_MS ? 'bad' : 'warn';
  const why = tg.error ? `: ${explainTelegramError(tg.error)}` : '';
  return { name, level, text: `нет связи ${ago(tg.since, now)}${via}${why}` };
}

/** The usual launch failures in plain words; anything else is shown as it came. */
export function explainTelegramError(error: string): string {
  if (/\b401\b|unauthorized/i.test(error)) return 'Telegram не принял токен бота — проверьте его в настройках';
  if (/\b409\b|conflict/i.test(error)) return 'этим ботом уже пользуется другой мост — одновременно может работать только один';
  if (/ENOTFOUND|EAI_AGAIN/i.test(error)) return 'не находится адрес сервера (DNS) — проверьте интернет или прокси';
  if (/ECONNREFUSED/i.test(error)) return 'соединение отклонено — прокси не отвечает по этому адресу';
  if (/ETIMEDOUT|timed? ?out|ECONNRESET|socket hang up|network/i.test(error)) return 'нет ответа от Telegram — возможно, нужен прокси';
  if (/\b407\b|proxy auth/i.test(error)) return 'прокси требует логин и пароль';
  return error.length > 160 ? `${error.slice(0, 160)}…` : error;
}

/**
 * The whole picture from what the launcher knows (process) and what the bridge last wrote
 * (status, null when there is no file yet). Pure — `now` is passed in.
 */
export function buildHealth(proc: ProcessState, status: BridgeStatus | null, now: number): Health {
  if (!proc.configured) {
    const line: HealthLine = { name: 'Мост', level: 'warn', text: 'не настроен — заполните настройки ниже' };
    return { level: 'warn', summary: 'Telemax: нужна настройка', lines: [line] };
  }
  if (!proc.running) {
    const wait = proc.nextStartAt != null ? Math.max(0, Math.ceil((proc.nextStartAt - now) / 1000)) : null;
    const text = proc.failures > 0 ? `остановился (сбоев подряд: ${proc.failures})${wait != null ? `, перезапуск через ${wait} с` : ''}` : 'остановлен';
    const level: Level = proc.failures >= 3 ? 'bad' : 'warn';
    return { level, summary: `Telemax: мост ${proc.failures > 0 ? 'перезапускается' : 'остановлен'}`, lines: [{ name: 'Мост', level, text }] };
  }
  const fresh = status != null && status.at >= (proc.startedAt ?? 0) && now - status.at < HEARTBEAT_STALE_MS;
  if (!fresh) {
    const starting = proc.startedAt != null && now - proc.startedAt < STARTUP_GRACE_MS;
    const line: HealthLine = starting ? { name: 'Мост', level: 'warn', text: 'запускается…' } : { name: 'Мост', level: 'bad', text: 'не отвечает — будет перезапущен' };
    return { level: line.level, summary: `Telemax: мост ${starting ? 'запускается' : 'не отвечает'}`, lines: [line] };
  }
  const lines: HealthLine[] = [{ name: 'Мост', level: 'ok', text: `работает · версия ${status.version}` }, maxLine(status.max, now)];
  if (status.telegram.configured) lines.push(telegramLine(status.telegram, now));
  const level = worst(lines.map((l) => l.level));
  const trouble = lines.filter((l) => l.level !== 'ok').map((l) => `${l.name}: ${l.text}`);
  const summary = level === 'ok' ? 'Telemax: всё работает' : `Telemax — ${trouble[0] ?? ''}`;
  return { level, summary, lines };
}

/** Whether the launcher should kill a running bridge as hung: alive past its grace with no fresh status. */
export function isHung(proc: ProcessState, status: BridgeStatus | null, now: number): boolean {
  if (!proc.running || proc.startedAt == null || now - proc.startedAt < STARTUP_GRACE_MS) return false;
  const last = status != null && status.at >= proc.startedAt ? status.at : proc.startedAt;
  return now - last >= HEARTBEAT_STALE_MS;
}

/** Wait before the next start after `failures` crashes in a row. */
export function restartDelayMs(failures: number): number {
  const delays = [2_000, 5_000, 15_000, 30_000, 60_000];
  return delays[Math.min(Math.max(failures, 1), delays.length) - 1] as number;
}
