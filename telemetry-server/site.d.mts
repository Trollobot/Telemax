// Types for site.mjs — only so the vitest suite in tests/ type-checks (tsc --noEmit).
export const MSK_OFFSET_MS: number;
export const KEEP_DAYS: number;
export const SITES: string[];
export function mskDay(ts: number): string;
export function mskHour(ts: number): number;
export function isBot(ua: string | undefined): boolean;
export function siteOf(host: string | undefined): string;
export function sourceOf(referrer: string | undefined): string;
export function ipv4ToNum(ip: string): number | null;
export function ipv6Prefix(ip: string): bigint | null;
export function cleanIp(ip: string | undefined): string;
export interface Geo { size: number; lookup(ip: string): string }
export function createGeo(csvText: string): Geo;
export function createGeoBuilder(): { add(line: string): void; build(): Geo };
export interface DayRecord {
  views: number;
  visitors: number;
  hours: number[];
  countries: Record<string, number>;
  sources: Record<string, number>;
  sites: Record<string, number>;
}
export interface SiteStats {
  days: Record<string, DayRecord>;
  hit(h: { ip: string; ua: string; referrer?: string; host?: string; country: string; now: number }): boolean;
  prune(now: number): void;
  toJSON(): { days: Record<string, DayRecord> };
}
export function createSiteStats(saved?: unknown): SiteStats;
export interface Summary {
  updatedAt: number;
  since: string;
  today: { views: number; visitors: number };
  yesterday: { views: number; visitors: number };
  last7: { views: number; visitors: number };
  last30: { views: number; visitors: number };
  total: { views: number; visitors: number };
  days: { d: string; views: number; visitors: number }[];
  hours: number[];
  countries: [string, number][];
  sources: [string, number][];
  sites: [string, number][];
}
export function summarize(days: Record<string, DayRecord>, now: number): Summary;
