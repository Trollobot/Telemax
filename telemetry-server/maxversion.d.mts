// Types for maxversion.mjs — only so the vitest suite in tests/ type-checks (tsc --noEmit).
export interface ClientVersion {
  version: string;
  build: number | null;
}
export const MAX_PACKAGES_URL: string;
export const BRIDGE_CLIENT_URL: string;
export function compareVersions(a: string, b: string): -1 | 0 | 1;
export function parsePackages(text: string): ClientVersion[];
export function newestPackage(list: ClientVersion[]): ClientVersion | null;
export function parseBridgeDefaults(source: string): ClientVersion | null;
export function shouldNotify(maxLatest: ClientVersion | null, bridge: ClientVersion | null, lastNotified: string | null | undefined): boolean;
export function formatVersionNotice(maxLatest: ClientVersion, bridge: ClientVersion): string;
