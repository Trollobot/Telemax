import { createLogger } from '../logger.js';

const logger = createLogger('error-reporter');

type Notifier = (text: string) => Promise<unknown>;

let notifier: Notifier | null = null;

// A repeating fault must not spam the group: at most one message per `key` every
// 10 minutes, and a hard ceiling across all keys per rolling hour. Anything over the
// limits is dropped from Telegram (still logged locally by whoever caught it).
const PER_KEY_COOLDOWN_MS = 10 * 60 * 1000;
const GLOBAL_CAP_PER_HOUR = 6;
const WINDOW_MS = 60 * 60 * 1000;

const lastSentByKey = new Map<string, number>();
let windowStart = 0;
let sentInWindow = 0;

/** Wires the sink error notices go to (the Telegram group). Called once at startup. */
export function configureErrorReporter(notify: Notifier): void {
  notifier = notify;
}

/**
 * Surfaces an operator-actionable error to the Telegram group — but throttled, so a
 * fault that fires in a tight loop can't flood it. Reserve this for things the
 * operator can actually act on (MAX connection lost, Telegram delivery failing,
 * an unhandled internal error) — NOT routine protocol noise. No-op until
 * configureErrorReporter has run.
 */
export function reportBridgeError(key: string, message: string): void {
  if (!notifier) return;
  const now = Date.now();

  const last = lastSentByKey.get(key);
  if (last !== undefined && now - last < PER_KEY_COOLDOWN_MS) return;

  if (now - windowStart > WINDOW_MS) {
    windowStart = now;
    sentInWindow = 0;
  }
  if (sentInWindow >= GLOBAL_CAP_PER_HOUR) return;

  lastSentByKey.set(key, now);
  sentInWindow += 1;
  void notifier(message).catch((err) => logger.error('Failed to deliver error notice to Telegram', err));
}

/**
 * Clears the cooldown for a key so the next event of that kind reports immediately —
 * used to let a "recovered" notice through right after the matching failure without
 * waiting out the cooldown.
 */
export function resetErrorKey(key: string): void {
  lastSentByKey.delete(key);
}
