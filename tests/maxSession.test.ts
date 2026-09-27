import { EventEmitter } from 'node:events';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { MaxServerError } from '../src/max/client.js';
import { OPCODES } from '../src/max/opcodes.js';
import { configureErrorReporter } from '../src/bridge/errorReporter.js';
import { MaxAuthUnavailableError } from '../src/bridge/maxAuthFlow.js';
import { MaxSessionController } from '../src/server/maxSession.js';
import type { MaxSession } from '../src/store/sessionStore.js';

// The transitions that bit us before the controller existed: a pause that kept reconnecting, /kill
// leaving timers behind, an abandoned /login parking the resume retries, network blips wiping a
// valid session, lastLoginAt set on one login path only.

const SESSION: MaxSession = { sessionToken: 'tok', phone: '+79999999999', deviceId: 'dev', savedAt: 'x' };
const REJECTED = (): MaxServerError => new MaxServerError('Сессия устарела', OPCODES.LOGIN);
const TIMEOUT = (): Error => new Error('LOGIN timed out');

/** A MaxClient stand-in: `connect()` emits 'ready' on the next tick when `autoReady`; LOGIN answers are scripted through `login`. */
class FakeClient extends EventEmitter {
  readonly deviceId = 'dev';
  autoReady = false;
  connect = vi.fn(() => {
    if (this.autoReady) queueMicrotask(() => this.emit('ready'));
  });
  disconnect = vi.fn();
  login = vi.fn<(token: string) => Promise<{ sessionToken: string; payload: unknown }>>();
  requestSms = vi.fn(async () => 'auth-token');
  verifyCode = vi.fn(async () => ({ status: 'ok' as const, loginToken: 'login-token' }));
  checkPassword = vi.fn(async () => 'login-token');
}

function setup(session: MaxSession | null = SESSION) {
  const client = new FakeClient();
  const store = { save: vi.fn(async () => {}), clear: vi.fn(async () => {}) };
  const onLogin = vi.fn(async () => {});
  const postReauthNotice = vi.fn(async () => {});
  const ctl = new MaxSessionController({ client, store, onLogin, postReauthNotice });
  ctl.start(session);
  return { ctl, client, store, onLogin, postReauthNotice };
}

/** Lets awaited LOGIN promises settle without moving the clock. */
const settle = (): Promise<void> => vi.advanceTimersByTimeAsync(0).then(() => undefined);

/** Drives one 'ready' whose resume LOGIN fails with `err`; returns once the controller has handled it. */
async function failedResume(client: FakeClient, err: Error): Promise<void> {
  client.login.mockRejectedValueOnce(err);
  client.emit('ready');
  await settle();
}

const notices = vi.fn<(text: string) => Promise<unknown>>(async () => {});
let day = 0;

beforeEach(() => {
  vi.useFakeTimers();
  // A fresh day per test: the error reporter's per-key cooldown must not carry over between tests.
  vi.setSystemTime(new Date(2030, 0, 1 + day++));
  notices.mockClear();
  configureErrorReporter(notices);
});
afterEach(() => vi.useRealTimers());

describe('MaxSessionController — resume retries', () => {
  it('a transient LOGIN failure reconnects with backoff and never wipes the session', async () => {
    const { ctl, client, store } = setup();
    expect(client.connect).toHaveBeenCalledTimes(1);
    for (const delay of [5_000, 10_000, 20_000, 40_000, 60_000]) {
      await failedResume(client, TIMEOUT());
      expect(ctl.state).toBe('resumeRetry');
      const before = client.connect.mock.calls.length;
      await vi.advanceTimersByTimeAsync(delay - 1);
      expect(client.connect).toHaveBeenCalledTimes(before);
      await vi.advanceTimersByTimeAsync(1);
      expect(client.connect).toHaveBeenCalledTimes(before + 1);
      expect(ctl.state).toBe('connecting');
    }
    expect(store.clear).not.toHaveBeenCalled();
    expect(ctl.status().connected).toBe(false);
  });

  it('the third server rejection wipes the session and asks the group to re-auth', async () => {
    const { ctl, client, store, postReauthNotice } = setup();
    for (let n = 1; n <= 2; n += 1) {
      await failedResume(client, REJECTED());
      expect(store.clear).not.toHaveBeenCalled();
      await vi.advanceTimersByTimeAsync(5_000);
      expect(client.connect).toHaveBeenCalledTimes(n + 1);
    }
    await failedResume(client, REJECTED());
    expect(store.clear).toHaveBeenCalledTimes(1);
    expect(ctl.state).toBe('ready');
    expect(ctl.activePhone).toBe('');
    expect(ctl.lastKnownPhone).toBe(SESSION.phone); // the /login flow still offers the number
    expect(postReauthNotice).toHaveBeenCalledTimes(1);
    // No retry timer is left: nothing reconnects a socket that has no session to resume.
    await vi.advanceTimersByTimeAsync(3_600_000);
    expect(client.connect).toHaveBeenCalledTimes(3);
  });

  it('a socket drop while the resume LOGIN is in flight is not a rejection and leaves the retry to the client', async () => {
    const { ctl, client, store } = setup();
    let reject!: (err: Error) => void;
    client.login.mockImplementationOnce(() => new Promise((_, rej) => (reject = rej)));
    client.emit('ready');
    await settle();
    expect(ctl.state).toBe('resuming');
    client.emit('disconnected');
    reject(new Error('socket closed'));
    await settle();
    expect(ctl.state).toBe('connecting');
    await vi.advanceTimersByTimeAsync(600_000);
    expect(client.connect).toHaveBeenCalledTimes(1); // the client reconnects by itself
    // It did not count either: two more rejections are still short of the wipe.
    for (let n = 0; n < 2; n += 1) {
      await failedResume(client, REJECTED());
      await vi.advanceTimersByTimeAsync(5_000);
    }
    expect(store.clear).not.toHaveBeenCalled();
    await failedResume(client, REJECTED());
    expect(store.clear).toHaveBeenCalledTimes(1);
  });

  it('a failed disk write after an accepted LOGIN keeps the bridge logged in', async () => {
    const { ctl, client, store } = setup();
    store.save.mockRejectedValueOnce(new Error('ENOSPC'));
    client.login.mockResolvedValueOnce({ sessionToken: 'rotated', payload: {} });
    client.emit('ready');
    await settle();
    expect(ctl.state).toBe('loggedIn');
    expect(store.clear).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(3_600_000);
    expect(client.connect).toHaveBeenCalledTimes(1);
  });
});

describe('MaxSessionController — pause and /kill', () => {
  it('a pause stops the resume retries and reads as not connected until resumed', async () => {
    const { ctl, client } = setup();
    await failedResume(client, TIMEOUT());
    expect(ctl.state).toBe('resumeRetry');
    ctl.pause(0);
    expect(client.disconnect).toHaveBeenCalledTimes(1);
    expect(ctl.pausedUntil).toBe(Number.POSITIVE_INFINITY);
    await vi.advanceTimersByTimeAsync(3_600_000);
    expect(client.connect).toHaveBeenCalledTimes(1);
    expect(ctl.state).toBe('paused');
    expect(ctl.status().connected).toBe(false); // what keeps a catch-up retry from running
    expect(notices).not.toHaveBeenCalled(); // no «Потеряна связь» for a deliberate stop
    expect(ctl.unpause()).toBe(true);
    expect(ctl.state).toBe('connecting');
    expect(client.connect).toHaveBeenCalledTimes(2);
    expect(ctl.unpause()).toBe(false); // a stale button does not touch the live socket
    expect(client.connect).toHaveBeenCalledTimes(2);
  });

  it('a timed pause resumes by itself, and /login over a pause is refused', async () => {
    const { ctl, client } = setup();
    ctl.pause(600);
    await expect(ctl.requestSms('+79999999999')).rejects.toBeInstanceOf(MaxAuthUnavailableError);
    expect(client.requestSms).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(600_000);
    expect(ctl.state).toBe('connecting');
    expect(ctl.pausedUntil).toBeNull();
    expect(client.connect).toHaveBeenCalledTimes(2);
  });

  it('/kill clears every timer: no reconnect, no pause resume, no outage notice', async () => {
    const { ctl, client, store } = setup();
    client.emit('disconnected'); // arms the 60 s outage window
    await failedResume(client, TIMEOUT()); // arms the resume retry
    ctl.pause(600); // arms the pause timer
    await ctl.kill();
    expect(ctl.state).toBe('stopped');
    expect(store.clear).toHaveBeenCalledTimes(1);
    expect(ctl.lastKnownPhone).toBe('');
    await vi.advanceTimersByTimeAsync(3_600_000);
    expect(client.connect).toHaveBeenCalledTimes(1);
    expect(notices).not.toHaveBeenCalled();
    // 'ready' from a socket closed on purpose is not acted on either.
    const logins = client.login.mock.calls.length;
    client.emit('ready');
    await settle();
    expect(ctl.state).toBe('stopped');
    expect(client.login).toHaveBeenCalledTimes(logins);
  });
});

describe('MaxSessionController — /login', () => {
  it('a /login started over a rejected session and then abandoned still lets the resume retry fire after its TTL', async () => {
    const { ctl, client } = setup();
    await failedResume(client, REJECTED());
    expect(ctl.state).toBe('resumeRetry');
    await ctl.requestSms('+7 999 999-99-99');
    expect(client.requestSms).toHaveBeenCalledWith('+79999999999');
    // The retry keeps deferring while the chain is fresh...
    await vi.advanceTimersByTimeAsync(9 * 60_000);
    expect(client.connect).toHaveBeenCalledTimes(1);
    // ...and reconnects once the flow's own lifetime is over.
    await vi.advanceTimersByTimeAsync(60_000 + 5_000);
    expect(client.connect).toHaveBeenCalledTimes(2);
    expect(ctl.state).toBe('connecting');
  });

  it('a socket drop ends the auth chain: the next resume retry no longer defers to it', async () => {
    const { ctl, client } = setup();
    await failedResume(client, REJECTED());
    await ctl.requestSms('+79999999999');
    client.emit('disconnected');
    expect(ctl.state).toBe('connecting');
    await vi.advanceTimersByTimeAsync(600_000);
    expect(client.connect).toHaveBeenCalledTimes(1); // the old timer went with the socket
    await failedResume(client, TIMEOUT());
    await vi.advanceTimersByTimeAsync(5_000);
    expect(client.connect).toHaveBeenCalledTimes(2); // not deferred: no chain on this socket
  });

  it('a fresh login sets lastLoginAt, saves the session and ends a pending resume retry', async () => {
    const { ctl, client, store, onLogin } = setup(null);
    client.autoReady = true;
    expect(ctl.status()).toEqual({ connected: false, lastLoginAt: null });
    client.login.mockResolvedValueOnce({ sessionToken: 'fresh', payload: { chats: [] } });
    await ctl.requestSms('+79999999999');
    expect(client.connect).toHaveBeenCalledTimes(2); // a fresh socket before START_AUTH
    await expect(ctl.verifyCode('1234')).resolves.toEqual({ ok: true });
    expect(ctl.state).toBe('loggedIn');
    expect(ctl.status()).toEqual({ connected: true, lastLoginAt: Date.now() });
    expect(ctl.activePhone).toBe('+79999999999');
    expect(store.save).toHaveBeenCalledWith(expect.objectContaining({ sessionToken: 'fresh', phone: '+79999999999', deviceId: 'dev' }));
    expect(onLogin).toHaveBeenCalledWith({ chats: [] });
  });

  it('a resumed login sets lastLoginAt too and persists the rotated token', async () => {
    const { ctl, client, store, onLogin } = setup();
    expect(ctl.activePhone).toBe(''); // nothing accepted yet in this process
    client.login.mockResolvedValueOnce({ sessionToken: 'rotated', payload: {} });
    client.emit('ready');
    await settle();
    expect(ctl.status()).toEqual({ connected: true, lastLoginAt: Date.now() });
    expect(ctl.activePhone).toBe(SESSION.phone);
    expect(store.save).toHaveBeenCalledWith(expect.objectContaining({ sessionToken: 'rotated', phone: SESSION.phone }));
    expect(onLogin).toHaveBeenCalledTimes(1);
  });

  it('a LOGIN over a resumeRetry socket ends the retry (it must not reconnect over the new login)', async () => {
    const { ctl, client } = setup();
    await failedResume(client, REJECTED());
    client.login.mockResolvedValueOnce({ sessionToken: 'fresh', payload: {} });
    await ctl.requestSms('+79999999999');
    await ctl.verifyCode('1234');
    expect(ctl.state).toBe('loggedIn');
    await vi.advanceTimersByTimeAsync(3_600_000);
    expect(client.connect).toHaveBeenCalledTimes(1);
  });

  it('a LOGIN that fails after the code was spent ends the flow with a typed refusal', async () => {
    const { ctl, client } = setup();
    await failedResume(client, REJECTED());
    client.login.mockRejectedValueOnce(REJECTED());
    await ctl.requestSms('+79999999999');
    await expect(ctl.verifyCode('1234')).rejects.toBeInstanceOf(MaxAuthUnavailableError);
    // The code is gone with it: a second attempt is refused without a MAX round trip.
    await expect(ctl.verifyCode('1234')).rejects.toBeInstanceOf(MaxAuthUnavailableError);
    expect(client.verifyCode).toHaveBeenCalledTimes(1);
    // The chain is over, so the pending resume retry reconnects at its next tick.
    await vi.advanceTimersByTimeAsync(5_000);
    expect(client.connect).toHaveBeenCalledTimes(2);
  });
});

describe('MaxSessionController — outage notice', () => {
  it('reports a sustained outage once and its recovery on the next accepted LOGIN', async () => {
    const { client } = setup();
    client.emit('disconnected');
    await vi.advanceTimersByTimeAsync(59_000);
    expect(notices).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1_000);
    expect(notices).toHaveBeenCalledTimes(1);
    expect(notices.mock.calls[0]?.[0]).toContain('Потеряна связь');
    // INIT alone is not "up" while a session exists: the LOGIN is.
    await failedResume(client, TIMEOUT());
    expect(notices).toHaveBeenCalledTimes(1);
    client.login.mockResolvedValueOnce({ sessionToken: 'tok', payload: {} });
    client.emit('ready');
    await settle();
    expect(notices).toHaveBeenCalledTimes(2);
    expect(notices.mock.calls[1]?.[0]).toContain('восстановлена');
  });
});
