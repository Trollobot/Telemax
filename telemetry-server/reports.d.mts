// Types for reports.mjs — only so the vitest suite in tests/ type-checks (tsc --noEmit).
export interface Report {
  installId: string;
  kind: string;
  version: string;
  step?: string;
  error?: string;
  toVersion?: string;
  os?: string;
  docker?: string;
  git?: string;
  node?: string;
  freeMb?: number;
  memMb?: number;
}
export interface SignatureEntry {
  kind: string;
  step: string | null;
  sample: string | null;
  firstSeen: number;
  lastSeen: number;
  count: number;
  installs: Record<string, number>;
  versions: Record<string, number>;
  env: Partial<Pick<Report, 'os' | 'docker' | 'git' | 'node' | 'toVersion' | 'freeMb' | 'memMb'>>;
}
export interface NoticeState {
  lastSentAt?: number;
  queue: string[];
}
export const DAY_MS: number;
export const HOUR_MS: number;
export const REPORTS_PER_INSTALL_PER_DAY: number;
export const MAX_SIGNATURES: number;
export const MAX_INSTALLS_PER_SIGNATURE: number;
export function sanitizeReport(body: unknown): Report | null;
export function normalizeError(error: unknown): string;
export function signatureOf(report: Pick<Report, 'kind' | 'step' | 'error'>): string;
export function acceptReport(report: Report, installs: Record<string, unknown>, recent: Map<string, number[]>, now: number): boolean;
export function recordReport(signatures: Record<string, SignatureEntry>, report: Report, now: number): { sig: string; isNew: boolean };
export function scheduleNotice(state: NoticeState, sig: string | null, now: number): string[];
export function dueIn(state: NoticeState, now: number): number | null;
export function formatNotice(entries: SignatureEntry[]): string;
export function listReports(signatures: Record<string, SignatureEntry>, days: number, now: number): unknown[];
