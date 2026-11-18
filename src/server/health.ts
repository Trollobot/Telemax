/** A long poll answered within this long counts as Telegram reachable. */
const TELEGRAM_FRESH_MS = 3 * 60_000;

/** What the bridge sees, for .data/health.json; `ok` decides whether the heartbeat is touched. */
export function healthSnapshot(input: { maxState: string; maxLoggedIn: boolean; lastPollOkAt: number; telegramEnabled: boolean; now: number }): {
  ok: boolean;
  max: string;
  telegramAgoS: number | null;
  at: string;
} {
  const telegramOk = !input.telegramEnabled || (input.lastPollOkAt > 0 && input.now - input.lastPollOkAt < TELEGRAM_FRESH_MS);
  return {
    ok: input.maxState === 'loggedIn' && input.maxLoggedIn && telegramOk,
    max: input.maxState,
    telegramAgoS: input.lastPollOkAt > 0 ? Math.round((input.now - input.lastPollOkAt) / 1000) : null,
    at: new Date(input.now).toISOString(),
  };
}

