import { AsyncLocalStorage } from 'node:async_hooks';

/**
 * Silent delivery for history: a history fill or a catch-up after downtime can post hundreds of old
 * messages, and each one used to ring the phone. Code inside runQuietly() — and everything it awaits —
 * sends with `disable_notification: true`; installQuietSends() makes that happen in one place, the
 * bot's API client, instead of threading a flag through every send helper.
 */
const quiet = new AsyncLocalStorage<boolean>();

export function runQuietly<T>(fn: () => Promise<T>): Promise<T> {
  return quiet.run(true, fn);
}

/** runQuietly when `on`, a plain call otherwise. Scoped to `fn` — enterWith() would leak to the caller. */
export function quietlyIf<T>(on: boolean, fn: () => Promise<T>): Promise<T> {
  return on ? quiet.run(true, fn) : fn();
}

/** Bot API methods that post a message and accept disable_notification. */
const POSTING = /^(send(?!ChatAction$)\w+|copyMessages?|forwardMessages?)$/;

type CallApi = (method: string, payload: object, options?: object) => Promise<unknown>;

export function installQuietSends(telegram: { callApi: CallApi }): void {
  const original = telegram.callApi.bind(telegram);
  telegram.callApi = (method, payload, options) =>
    original(method, quiet.getStore() && POSTING.test(method) ? { ...payload, disable_notification: true } : payload, options);
}
