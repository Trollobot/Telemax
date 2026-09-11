import os from 'node:os';
import { statfsSync } from 'node:fs';
import { getAppVersion } from './version.js';

/**
 * «📊 Статус» in the control panel — everything the bridge can honestly see from INSIDE its
 * container: its own version/uptime, the MAX and Telegram legs, when messages last flowed, and the
 * host's disk (the data volume is host-mounted, so that number is real), RAM and load. What it can
 * NOT see is deliberately absent: Fail2ban, Docker, host services — the container boundary hides
 * them, and poking holes in it for a status line isn't worth the exposure.
 */
export interface StatusInput {
  version: string;
  uptimeSec: number;
  max: { connected: boolean; phone: string; lastLoginAt: number | null; paused: string | null };
  chats: { active: number; banned: number };
  lastInAt: number | null;
  lastOutAt: number | null;
  disk: { freeBytes: number; totalBytes: number } | null;
  mem: { freeBytes: number; totalBytes: number };
  load1: number;
  /** null = the update check itself failed (offline / rate-limited). */
  update: { updateAvailable: boolean; latest: string | null } | null;
  now?: number;
}

export function formatAgo(ts: number | null, now = Date.now()): string {
  if (ts == null) return 'ещё не было';
  const s = Math.max(0, Math.round((now - ts) / 1000));
  if (s < 60) return 'только что';
  const m = Math.round(s / 60);
  if (m < 60) return `${m} мин назад`;
  const h = Math.round(m / 60);
  if (h < 48) return `${h} ч назад`;
  return `${Math.round(h / 24)} дн назад`;
}

export function formatDuration(sec: number): string {
  const s = Math.max(0, Math.floor(sec));
  const d = Math.floor(s / 86400);
  const h = Math.floor((s % 86400) / 3600);
  const m = Math.floor((s % 3600) / 60);
  if (d > 0) return `${d} дн ${h} ч`;
  if (h > 0) return `${h} ч ${m} мин`;
  return `${m} мин`;
}

export function formatBytes(b: number): string {
  if (b >= 1024 ** 3) return `${(b / 1024 ** 3).toFixed(1)} ГБ`;
  return `${Math.round(b / 1024 ** 2)} МБ`;
}

/** +79959809587 -> +7995***9587: enough to recognise the number, not enough to dial it. */
export function maskPhone(p: string): string {
  const digits = p.replace(/\D/g, '');
  if (digits.length < 8) return p ? '***' : 'не авторизован';
  return `${p.startsWith('+') ? '+' : ''}${digits.slice(0, 4)}***${digits.slice(-4)}`;
}

export function formatStatus(i: StatusInput): string {
  const now = i.now ?? Date.now();
  const maxLine = i.max.paused
    ? `MAX: ⏸ на паузе (${i.max.paused})`
    : i.max.connected
      ? `MAX: 🟢 подключён · ${maskPhone(i.max.phone)} · вход ${formatAgo(i.max.lastLoginAt, now)}`
      : `MAX: 🔴 не подключён${i.max.phone ? ` · ${maskPhone(i.max.phone)}` : ' · не авторизован (/login)'}`;
  const lines = [
    '📊 Telemax — состояние',
    `Версия ${i.version} · аптайм ${formatDuration(i.uptimeSec)}`,
    maxLine,
    `Telegram: 🟢 бот на связи · чатов ${i.chats.active}${i.chats.banned > 0 ? ` (в бане ${i.chats.banned})` : ''}`,
    `Последнее сообщение: из MAX ${formatAgo(i.lastInAt, now)} · в MAX ${formatAgo(i.lastOutAt, now)}`,
  ];
  if (i.disk) {
    const low = i.disk.freeBytes < 1024 ** 3;
    lines.push(`Диск (данные): свободно ${formatBytes(i.disk.freeBytes)} из ${formatBytes(i.disk.totalBytes)}${low ? ' ⚠️ мало места' : ''}`);
  }
  lines.push(`RAM: свободно ${formatBytes(i.mem.freeBytes)} из ${formatBytes(i.mem.totalBytes)} · load ${i.load1.toFixed(2)}`);
  if (i.update == null) lines.push('Обновление: не удалось проверить (сеть)');
  else if (i.update.updateAvailable) lines.push(`Обновление: ⬆️ доступна ${i.update.latest ?? 'новая версия'} — /version`);
  else lines.push('Обновление: актуальная версия');
  return lines.join('\n');
}

/** Host-side numbers the container can see. Disk is null if statfs isn't available (very old Node / odd FS). */
export function collectHostStats(dataDir: string): { disk: StatusInput['disk']; mem: StatusInput['mem']; load1: number } {
  let disk: StatusInput['disk'] = null;
  try {
    const st = statfsSync(dataDir);
    disk = { freeBytes: Number(st.bavail) * Number(st.bsize), totalBytes: Number(st.blocks) * Number(st.bsize) };
  } catch {
    disk = null;
  }
  return { disk, mem: { freeBytes: os.freemem(), totalBytes: os.totalmem() }, load1: os.loadavg()[0] ?? 0 };
}

export function buildStatusText(i: Omit<StatusInput, 'version'>): string {
  return formatStatus({ ...i, version: getAppVersion() });
}
