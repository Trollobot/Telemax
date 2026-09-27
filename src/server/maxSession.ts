import { isMaxServerError, type VerifyCodeResult } from '../max/client.js';
import type { MaxSession } from '../store/sessionStore.js';
import { RetryBackoff } from '../bridge/catchUp.js';
import { MaxAuthUnavailableError } from '../bridge/maxAuthFlow.js';
import { reportBridgeError, resetErrorKey } from '../bridge/errorReporter.js';
import { maskPhone } from '../bridge/status.js';
import { createLogger } from '../logger.js';

const logger = createLogger('max-session');

/**
 * The MAX leg's lifecycle — ONE state, moved in one place (setState), which also ends what only the
 * state being left waits on (the resume-retry timer, the pause timer, the outage window). Every
 * client event ('ready', 'disconnected'), every user action (/login's SMS/code/password, the panel's
 * pause/resume, /kill, shutdown) and every timer is a method here. (As a dozen separate flags and
 * timers they kept drifting out of step: a pause left "connected" true, /kill left a retry timer
 * that reconnected right back, a resume retry looped during a pause.)
 *
 *   stopped ──start()──▶ connecting ──'ready'──▶ ready       (no saved session: only /login logs in)
 *                            │                 └─▶ resuming  (saved session: LOGIN in flight)
 *                            │                        ├─OK──▶ loggedIn
 *                            │                        └─ERR─▶ resumeRetry ──timer──▶ connecting
 *                            │                                     (the 3rd server rejection wipes the session ─▶ ready)
 *                            ◀──'disconnected'── any live state (the client reconnects on its own)
 *   /login's LOGIN OK ─▶ loggedIn from ready / resumeRetry / resuming / loggedIn
 *   pause() ─▶ paused ──unpause() or timer──▶ connecting;   kill() / shutdown() ─▶ stopped
 */
export type MaxSessionState =
  | 'stopped' // before start(), after /kill or shutdown: socket closed on purpose, nothing pending
  | 'connecting' // socket down or INIT pending — the client reconnects on its own, 'ready' follows
  | 'ready' // INIT OK, no saved session: /login is the only way in
  | 'resuming' // INIT OK, the saved session's LOGIN is in flight
  | 'resumeRetry' // the resume LOGIN failed on this socket; one timer reconnects a fresh one
  | 'loggedIn' // LOGIN accepted — the bridge relays
  | 'paused'; // panel pause: socket closed on purpose until the panel or the pause timer resumes

/** What the controller needs from MaxClient (a narrow slice so tests can fake it). */
export interface SessionClient {
  readonly deviceId: string;
  connect(): void;
  disconnect(): void;
  on(event: 'ready' | 'disconnected', listener: () => void): unknown;
  once(event: 'ready', listener: () => void): unknown;
  off(event: 'ready', listener: () => void): unknown;
  login(token: string): Promise<{ sessionToken: string; payload: unknown }>;
  requestSms(phone: string): Promise<string>;
  verifyCode(authToken: string, code: string): Promise<VerifyCodeResult>;
  checkPassword(trackId: string, password: string): Promise<string>;
}

export interface MaxSessionDeps {
  client: SessionClient;
  store: { save(session: MaxSession): Promise<void>; clear(): Promise<void> };
  /** Runs after every accepted LOGIN, fresh or resumed, with its payload (chat snapshot, account id). */
  onLogin: (payload: unknown) => Promise<void>;
  /** Posts the «session rejected» notice (with the login button) to the group. */
  postReauthNotice: (text: string) => Promise<unknown>;
}

// The saved session is not wiped on the first resume miss: a fresh socket is reconnected and
// 'ready' retries, and only this many server REJECTIONS in a row (an ERR answer to LOGIN,
// MaxServerError) demand a fresh SMS. A timeout, a socket error or a bad frame says nothing about
// the token: those reconnect with backoff (resumeBackoff) and never wipe the session.
const MAX_RESUME_REJECTIONS = 3;
const RESUME_RETRY_DELAY_MS = 5_000;
// Bounds how long an auth chain (START_AUTH -> CHECK_CODE -> LOGIN) defers a pending resume
// retry: an abandoned /login flow must not end the retries.
const AUTH_CHAIN_TTL_MS = 10 * 60_000;
// A brief MAX drop during a reconnect is normal — only an outage still on this long later earns
// an operator notice, paired with a «recovered» once it's back. "Back" means a LOGIN went through
// when there is a session, and INIT OK only without one (a LOGIN that never completes must not go
// on without any notice); never the TLS handshake alone.
const MAX_DOWN_NOTICE_MS = 60_000;
const FRESH_CONNECT_TIMEOUT_MS = 15_000;

const SESSION_SAVE_FAILED_TEXT =
  '⚠️ Не удалось сохранить MAX-сессию на диск (нет места или нет прав на папку data?). Мост работает, но после перезапуска может понадобиться повторный вход. Подробности в логах контейнера (docker compose logs).';

type Timer = ReturnType<typeof setTimeout>;

export class MaxSessionController {
  private state_: MaxSessionState = 'stopped';
  // Bumped by every setState: an awaited LOGIN whose epoch moved on meanwhile (the socket dropped,
  // a pause, /kill) is stale — that transition already decided what happens next.
  private epoch = 0;
  private session: MaxSession | null = null;
  // The phone we last authenticated with. Unlike the session, SURVIVES a rejection so the /login
  // flow can offer «войти с +7999***9999?». Cleared only by /kill or a login with another number.
  private lastKnownPhone_ = '';
  private lastLoginAt: number | null = null; // every accepted LOGIN, fresh or resumed — the panel's status
  // The /login auth chain on the current socket.
  private pendingPhone = '';
  private pendingAuthToken: string | null = null;
  /** Set when verifyCode() comes back password_required — cleared only on a successful login, since the trackId survives a wrong password and can be retried (confirmed live 2026-08-14). */
  private pendingPasswordTrackId: string | null = null;
  private authChainStartedAt: number | null = null;
  private resumeRejections = 0;
  private readonly resumeBackoff = new RetryBackoff(RESUME_RETRY_DELAY_MS, 60_000);
  private resumeTimer: Timer | null = null;
  // Pause lives in memory only: any restart — including an auto-update — resumes MAX.
  private pausedUntil_: number | null = null; // Number.POSITIVE_INFINITY = until unpause()
  private pauseTimer: Timer | null = null;
  private downTimer: Timer | null = null;
  private downReported = false;
  // Set once the group was told the session was lost, so «восстановлена» only follows an actual loss — once.
  private sessionLostReported = false;

  constructor(private readonly deps: MaxSessionDeps) {}

  get state(): MaxSessionState {
    return this.state_;
  }

  /** The phone of the session an accepted LOGIN runs on ('' before the first LOGIN of this process, after a wipe, after /kill). */
  get activePhone(): string {
    return this.session && this.lastLoginAt != null ? this.session.phone : '';
  }

  get lastKnownPhone(): string {
    return this.lastKnownPhone_;
  }

  /** Epoch ms the panel pause ends at (Number.POSITIVE_INFINITY = until resumed); null when not paused. */
  get pausedUntil(): number | null {
    return this.pausedUntil_;
  }

  /** «📊 Статус»: connected = LOGIN accepted while a session exists (a socket whose LOGIN keeps failing must not read «🟢 подключён»), INIT OK without one. */
  status(): { connected: boolean; lastLoginAt: number | null } {
    return { connected: this.state_ === 'loggedIn' || this.state_ === 'ready', lastLoginAt: this.lastLoginAt };
  }

  /** Wires the client's events and opens the first socket; `session` is what the store loaded (null on a fresh install). */
  start(session: MaxSession | null): void {
    this.session = session;
    if (session) this.lastKnownPhone_ = session.phone;
    this.deps.client.on('ready', () => this.onReady());
    this.deps.client.on('disconnected', () => this.onDisconnected());
    this.connect();
  }

  // --- The one place the state moves ---------------------------------------------------------

  private setState(next: MaxSessionState): void {
    this.state_ = next;
    this.epoch += 1;
    // Only resumeRetry waits on the resume timer; only paused on the pause timer.
    if (next !== 'resumeRetry') this.resumeTimer = clearTimer(this.resumeTimer);
    if (next !== 'paused') {
      this.pauseTimer = clearTimer(this.pauseTimer);
      this.pausedUntil_ = null;
    }
    // Closed on purpose: no reconnect is coming, so «пытаюсь переподключиться» would be false —
    // and the auth chain died with the socket. Likewise on a new socket.
    if (next === 'paused' || next === 'stopped') this.downTimer = clearTimer(this.downTimer);
    if (next === 'paused' || next === 'stopped' || next === 'connecting') this.authChainStartedAt = null;
  }

  /** Tears down whatever socket there is (ending a pause) and starts a fresh INIT; 'ready' follows. */
  private connect(): void {
    this.setState('connecting');
    this.deps.client.connect();
  }

  // --- Client events ---------------------------------------------------------------------------

  private onReady(): void {
    // A socket closed on purpose has no 'ready' (disconnect() drops the listeners) — and two 'ready'
    // events racing on one socket must not double-LOGIN.
    if (this.state_ === 'paused' || this.state_ === 'stopped' || this.state_ === 'resuming') return;
    if (this.session) {
      void this.loginWithSession(this.session);
      return;
    }
    this.setState('ready');
    this.noteUp();
  }

  private onDisconnected(): void {
    if (this.state_ === 'paused' || this.state_ === 'stopped') return;
    // The client reconnects on its own and 'ready' retries the LOGIN; a pending resume retry would only cut that short.
    this.setState('connecting');
    this.armDownNotice();
  }

  private async loginWithSession(session: MaxSession): Promise<void> {
    this.setState('resuming');
    const epoch = this.epoch;
    let login: { sessionToken: string; payload: unknown };
    try {
      login = await this.deps.client.login(session.sessionToken);
    } catch (err) {
      if (epoch === this.epoch) await this.onResumeFailed(err);
      return;
    }
    if (epoch !== this.epoch) return;
    // MAX rotates the session token on LOGIN and eventually invalidates the previous one, so a
    // resumed login persists the new token too — or every reconnect presents the ORIGINAL one
    // until MAX rejects it.
    const refreshed: MaxSession = { ...session, sessionToken: login.sessionToken, savedAt: new Date().toISOString() };
    this.session = refreshed;
    this.lastKnownPhone_ = session.phone;
    this.noteLoginSucceeded();
    await this.saveSession(refreshed);
    logger.info(`Resumed session for ${maskPhone(session.phone)} (token ${login.sessionToken === session.sessionToken ? 'unchanged' : 'rotated'})`);
    if (this.sessionLostReported) {
      this.sessionLostReported = false;
      reportBridgeError('max-session-ok', '✅ MAX-авторизация восстановлена.');
    }
    try {
      await this.deps.onLogin(login.payload);
    } catch (err) {
      logger.error('Post-login refresh after a resumed session failed:', err);
    }
  }

  /** The resume LOGIN threw while still current — see MAX_RESUME_REJECTIONS for which failures count. */
  private async onResumeFailed(err: unknown): Promise<void> {
    const msg = err instanceof Error ? err.message : String(err);
    if (!isMaxServerError(err)) {
      // Timeout (an undecodable answer too): nothing is known about the token, the session stays.
      // This loop (reconnect, INIT OK, LOGIN times out) never emits 'disconnected', so the outage
      // notice is armed here.
      const delay = this.resumeBackoff.next();
      logger.warn(`Resume login did not complete (not a rejection), reconnecting in ${Math.round(delay / 1000)}s: ${msg}`);
      this.armResumeRetry(delay);
      this.armDownNotice();
      return;
    }
    this.resumeRejections += 1;
    if (this.resumeRejections < MAX_RESUME_REJECTIONS) {
      // The socket stays up after a rejected LOGIN (no 'disconnected'): reconnect a fresh one and let 'ready' retry.
      logger.warn(`Resume login rejected (attempt ${this.resumeRejections}/${MAX_RESUME_REJECTIONS}), reconnecting to retry: ${msg}`);
      this.armResumeRetry(RESUME_RETRY_DELAY_MS);
      return;
    }
    this.resumeRejections = 0;
    logger.warn('Saved session was rejected after retries, clearing it:', msg);
    // lastKnownPhone deliberately kept — see its declaration.
    this.session = null;
    // The connection itself is up (the server answered) — the re-auth notice replaces an outage notice.
    this.setState('ready');
    this.noteUp();
    this.notifyReauthNeeded();
    await this.deps.store.clear().catch((clearErr) => logger.error('Failed to delete the rejected session file', clearErr));
  }

  /**
   * Reconnects a fresh socket after `delayMs` so 'ready' retries the resume LOGIN. Stands down with
   * the state: a LOGIN going through, a pause, /kill or a dropped socket (the client is then already
   * reconnecting) all leave resumeRetry, and setState ends the timer with it.
   */
  private armResumeRetry(delayMs: number): void {
    this.setState('resumeRetry');
    this.resumeTimer = setTimeout(() => {
      this.resumeTimer = null;
      // A /login auth chain runs on this socket: look again later instead of tearing it down under
      // the user typing the SMS code — kept pending, for at most the chain's TTL.
      if (this.authChainStartedAt != null && Date.now() - this.authChainStartedAt < AUTH_CHAIN_TTL_MS) {
        this.armResumeRetry(delayMs);
        return;
      }
      this.connect();
    }, delayMs);
  }

  /** Bookkeeping shared by both accepted LOGIN paths (fresh auth and a resumed session). */
  private noteLoginSucceeded(): void {
    this.setState('loggedIn'); // a pending resume retry must not reconnect over this socket
    this.authChainStartedAt = null;
    this.resumeRejections = 0;
    this.resumeBackoff.reset();
    this.lastLoginAt = Date.now();
    this.noteUp(); // with a session, "MAX is up" means a LOGIN went through, not just INIT
  }

  /** A failed write (disk full, EACCES) is not a session failure: LOGIN succeeded and the token in memory is valid, so the bridge runs on it (counting it as a resume rejection deleted a valid session). */
  private async saveSession(session: MaxSession): Promise<void> {
    try {
      await this.deps.store.save(session);
    } catch (err) {
      logger.error('MAX login succeeded but the session could not be saved to disk — running on the in-memory copy:', err);
      reportBridgeError('session-save-failed', SESSION_SAVE_FAILED_TEXT);
    }
  }

  // --- /login: the Telegram flow (maxAuthFlow.ts) drives these three — the only way to log in ---

  async requestSms(rawPhone: string): Promise<void> {
    const phone = rawPhone.replace(/[^\d+]/g, '');
    if (!phone) throw new Error('Пустой номер телефона');
    if (!this.session) {
      // A FRESH socket first: one left over from a rejected session refuses START_AUTH with
      // «Недопустимое состояние сессии» (hit live 2026-08-18). A pause ends here, timer included,
      // so the pause timer can't later tear down the socket the auth chain runs on.
      await this.freshConnectForAuth();
    } else if (this.state_ === 'paused') {
      // Typed: the /login flow shows these alone and ends, no «Проверьте номер…».
      throw new MaxAuthUnavailableError('MAX на паузе — снимите паузу в /panel (▶️ Возобновить MAX) и повторите /login.');
    } else if (this.state_ === 'connecting' || this.state_ === 'stopped') {
      throw new MaxAuthUnavailableError('Нет связи с MAX — подождите минуту и повторите /login.');
    }
    // An auth chain now runs on this socket: a pending resume retry defers itself (armResumeRetry)
    // but is NOT ended — it is the only thing that reconnects after a failed resume LOGIN, and
    // ending it left the bridge on that dead socket when the user abandoned the flow.
    this.authChainStartedAt = Date.now();
    try {
      this.pendingAuthToken = await this.deps.client.requestSms(phone);
    } catch (err) {
      this.authChainStartedAt = null;
      throw err;
    }
    this.pendingPhone = phone;
  }

  async verifyCode(code: string): Promise<{ ok: true } | { passwordRequired: true; hint: string | null }> {
    if (!this.pendingAuthToken) throw new MaxAuthUnavailableError('Код уже использован или устарел — начните заново: /login');
    const verified = await this.deps.client.verifyCode(this.pendingAuthToken, code);
    if (verified.status === 'password_required') {
      this.pendingPasswordTrackId = verified.challenge.trackId;
      return { passwordRequired: true, hint: verified.challenge.hint ?? null };
    }
    this.pendingAuthToken = null;
    await this.completeLogin(verified.loginToken);
    return { ok: true };
  }

  async checkPassword(password: string): Promise<void> {
    if (!this.pendingPasswordTrackId) throw new MaxAuthUnavailableError('Проверка пароля уже завершена или устарела — начните заново: /login');
    // NOT cleared on a throw — see pendingPasswordTrackId.
    const loginToken = await this.deps.client.checkPassword(this.pendingPasswordTrackId, password);
    this.pendingPasswordTrackId = null;
    await this.completeLogin(loginToken);
  }

  /** Forces a clean socket and resolves once it has finished INIT ('ready'). */
  private freshConnectForAuth(): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      const { client } = this.deps;
      const onReady = (): void => {
        clearTimeout(timer);
        resolve();
      };
      const timer = setTimeout(() => {
        client.off('ready', onReady);
        reject(new MaxAuthUnavailableError('MAX не ответил при переподключении для авторизации — подождите минуту и повторите /login.'));
      }, FRESH_CONNECT_TIMEOUT_MS);
      client.once('ready', onReady);
      this.connect();
    });
  }

  /** Shared tail end of both auth paths (plain SMS, and SMS + password) — exchanges a login token for a session and persists it. */
  private async completeLogin(loginToken: string): Promise<void> {
    let login: { sessionToken: string; payload: unknown };
    try {
      login = await this.deps.client.login(loginToken);
    } catch (err) {
      // The SMS code (or password) is spent by now, so the chain is over and a pending resume retry
      // no longer defers to it. The raw client error is English / log-only diagnostics — logged, not shown.
      this.authChainStartedAt = null;
      logger.error('LOGIN after a successful auth chain failed', err);
      throw new MaxAuthUnavailableError(`Не удалось завершить вход в MAX: ${isMaxServerError(err) ? 'MAX отклонил вход' : 'MAX не ответил'}. Начните заново: /login`);
    }
    const session: MaxSession = {
      sessionToken: login.sessionToken,
      phone: this.pendingPhone,
      deviceId: this.deps.client.deviceId,
      savedAt: new Date().toISOString(),
    };
    // In memory at once, before the save and the refresh: a failed write or a reconnect meanwhile
    // must not leave a relaying bridge that never logs in again.
    this.session = session;
    this.lastKnownPhone_ = session.phone;
    // No group notice from here: the /login flow (maxAuthFlow.announceAuthed) posts «восстановлена» itself.
    this.sessionLostReported = false;
    this.noteLoginSucceeded();
    await this.saveSession(session);
    await this.deps.onLogin(login.payload);
  }

  // --- Panel pause, /kill, shutdown ------------------------------------------------------------

  /** Closes the socket until unpause() or, with `seconds` > 0, until the timer resumes it. disconnect() removes the socket listeners, so no «connection lost» alarm goes out for a deliberate pause. */
  pause(seconds: number): void {
    this.pauseTimer = clearTimer(this.pauseTimer); // a pause over a pause: the new duration counts
    this.setState('paused');
    this.deps.client.disconnect();
    if (seconds <= 0) {
      this.pausedUntil_ = Number.POSITIVE_INFINITY;
      return;
    }
    this.pausedUntil_ = Date.now() + seconds * 1000;
    this.pauseTimer = setTimeout(() => this.unpause(), seconds * 1000);
    this.pauseTimer.unref?.();
  }

  /** Reconnects after a pause; false when not paused — a stale button must not tear down the live socket an auth chain may be running on. */
  unpause(): boolean {
    if (this.state_ !== 'paused') return false;
    this.connect();
    return true;
  }

  /**
   * /kill: closes the connection for good and deletes the encrypted session, so only a fresh
   * /login brings the bridge back. The in-memory copy goes only once the file is gone: a failed
   * delete leaves the bridge stopped with the session it would load again after a restart.
   */
  async kill(): Promise<void> {
    this.setState('stopped');
    this.deps.client.disconnect();
    await this.deps.store.clear();
    this.session = null;
    this.lastKnownPhone_ = '';
    this.pendingPhone = '';
    this.pendingAuthToken = null;
    this.pendingPasswordTrackId = null;
  }

  /** SIGTERM / a fatal startup error: closes the socket and stops every reconnect. */
  shutdown(): void {
    this.setState('stopped');
    this.deps.client.disconnect();
  }

  // --- Group notices ---------------------------------------------------------------------------

  /** Tells the group the session was rejected (or unreadable) and offers the in-bot re-auth flow. Once per loss; a later accepted LOGIN posts «восстановлена». */
  notifyReauthNeeded(): void {
    if (this.sessionLostReported) return;
    this.sessionLostReported = true;
    this.deps
      .postReauthNotice(
        '❌ MAX-сессия отклонена — нужна повторная авторизация (номер + код из SMS). ' +
          'Нажмите «🔐 Войти в MAX» и авторизуйтесь в личке бота (или напишите боту в личку /login). Пока переписка не пересылается.',
      )
      .catch((err) => logger.error('Failed to send re-auth notice', err));
  }

  /** Starts the outage window unless one runs or an outage is already reported. */
  private armDownNotice(): void {
    if (this.downTimer != null || this.downReported) return;
    this.downTimer = setTimeout(() => {
      this.downTimer = null;
      this.downReported = true;
      // Every reported loss gets its «✅»: 'max-up' has its own cooldown, which would swallow a second recovery within 10 minutes.
      resetErrorKey('max-up');
      reportBridgeError('max-down', '❌ Потеряна связь с MAX. Пытаюсь переподключиться…');
    }, MAX_DOWN_NOTICE_MS);
  }

  /** MAX is up again: cancels a running outage window, and reports the recovery of a reported outage. */
  private noteUp(): void {
    this.downTimer = clearTimer(this.downTimer);
    if (!this.downReported) return;
    this.downReported = false;
    resetErrorKey('max-down');
    reportBridgeError('max-up', '✅ Связь с MAX восстановлена.');
  }
}

function clearTimer(timer: Timer | null): null {
  if (timer) clearTimeout(timer);
  return null;
}
