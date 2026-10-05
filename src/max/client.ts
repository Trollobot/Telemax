import tls from 'node:tls';
import { EventEmitter } from 'node:events';
import { pack } from 'msgpackr';
import { readFrameHeader, encodeFrame, decompressPayload, FRAME_HEADER_SIZE } from './frame.js';
import { decodeFramePayload, pickObject } from './msgpack.js';
import { OPCODES, DIR, formatOpcode } from './opcodes.js';
import { MAX_TLS_CA } from './ca.js';
import { toMaxReaction } from './reactions.js';
import { findAuthToken, findLongToken, describeAuthError, extractPasswordChallenge, type PasswordChallenge } from './tokens.js';

export type VerifyCodeResult = { status: 'ok'; loginToken: string } | { status: 'password_required'; challenge: PasswordChallenge };

export interface MaxMessageEvent {
  dir: number;
  seq: number;
  opcode: number;
  payload: unknown;
  length: number;
}

/** A single contact's profile details, from CONTACT_INFO. */
export interface MaxContactInfo {
  id?: unknown;
  names?: Array<{ name?: string; firstName?: string; lastName?: string; type?: string }>;
  country?: string;
  phone?: unknown; // arrives as BigInt (large integer) — format via String(), never coerce to Number
  registrationTime?: unknown; // ms timestamp, BigInt — see phone
  flags?: number;
  options?: string[];
  baseUrl?: string;
  baseRawUrl?: string;
  photoId?: unknown;
  description?: string;
  gender?: number;
  /** Public profile link `https://max.ru/<nick>` — bots have one; ordinary people (live 2026-10-05) don't. */
  link?: string;
}

/** A public channel found by PUBLIC_SEARCH. */
export interface MaxPublicChannel {
  id: unknown;
  title: string;
  /** `https://max.ru/<slug>`; absent → the channel can't be offered as a link. */
  link?: string;
}

/**
 * Splits a PUBLIC_SEARCH answer (live shape 2026-10-05) into contacts and channels. Each item is
 * either `{chat: {id, type:'CHANNEL', title, link}}` or `{contact: {contact: {...profile}, summary:
 * '@nick'}}` — the profile is nested TWICE; a single nesting is still accepted in case MAX flattens it.
 */
export function parsePublicSearch(payload: unknown): { contacts: MaxContactInfo[]; channels: MaxPublicChannel[] } {
  const contacts: MaxContactInfo[] = [];
  const channels: MaxPublicChannel[] = [];
  const p = payload as { result?: unknown[]; contacts?: MaxContactInfo[] } | null;
  if (p && Array.isArray(p.contacts)) contacts.push(...p.contacts);
  for (const item of Array.isArray(p?.result) ? p.result : []) {
    const r = item as { contact?: MaxContactInfo & { contact?: MaxContactInfo }; chat?: { id?: unknown; title?: unknown; link?: unknown } };
    const c = r.contact?.contact ?? r.contact;
    if (c?.id != null) contacts.push(c);
    if (r.chat?.id != null && typeof r.chat.title === 'string') {
      channels.push({ id: r.chat.id, title: r.chat.title, link: typeof r.chat.link === 'string' ? r.chat.link : undefined });
    }
  }
  return { contacts, channels };
}

/** A single CHAT_HISTORY message — same shape as a PUSH_MESSAGE payload's `message` field. */
export interface MaxHistoryMessage {
  id?: unknown;
  time: number;
  type?: string;
  sender?: unknown;
  cid?: number;
  text?: string;
  attaches?: unknown[];
  status?: string;
  reactions?: unknown;
  // A forward — same shape as PUSH_MESSAGE's link field (see bridge/sync.ts MaxPushPayload).
  link?: { type?: string; message?: { id?: unknown; text?: string; sender?: unknown; attaches?: unknown[] }; chatId?: unknown };
}

// The port, the INIT user agent and the ping interval are fixed (constants below), and the
// server's TLS certificate is always verified.
export interface MaxClientOptions {
  host?: string;
  sni?: string;
  /**
   * The INIT deviceId; a random one when unset. Nothing passes it today: the id saved into the
   * session is never read back, and MAX accepts the resumed token under a new id anyway —
   * deliberately left so until reusing the saved id is verified live.
   */
  deviceId?: string;
  reconnect?: boolean;
}

// Connect by hostname, NOT an IPv4 literal: a literal bypasses DNS64/NAT64, leaving an IPv6-only
// host on flaky CLAT/464XLAT — the cause of ~4h reconnect churn seen on one. Pin the literal via
// MAX_HOST=155.212.204.150 if DNS for oneme.ru is ever unreachable.
const DEFAULT_HOST = 'api2.oneme.ru';
const DEFAULT_PORT = 443;
const DEFAULT_SNI = 'api2.oneme.ru';
const DEFAULT_PING_INTERVAL_MS = 50_000;
// What INIT presents: the MAX desktop client's user agent.
const USER_AGENT = {
  deviceType: 'DESKTOP',
  appVersion: '26.24.0',
  osVersion: 'Ubuntu 24.04.4 LTS',
  locale: 'ru',
  screen: '2.0x',
  timezone: 'Europe/Moscow',
  buildNumber: 75261,
} as const;
const RECONNECT_DELAYS_MS = [1_000, 2_000, 5_000, 10_000, 30_000];
// A connection counts as healthy — and the reconnect backoff starts over — only once it has
// passed INIT and then stayed up this long. Resetting on TLS connect made a server that accepts
// TLS and drops the socket right away a reconnect loop once a second.
const STABLE_CONNECTION_MS = 30_000;
// TCP keepalive: a cheap extra probe for a silently dead path. The real half-open detection is
// the unanswered-PING check in ping() — keepalive only fires on an idle socket.
const TCP_KEEPALIVE_DELAY_MS = 30_000;
// Deadline for TCP connect + TLS handshake. Before secureConnect there is no PING and no
// keepalive: a path that black-holes the ClientHello left the socket "connecting" forever.
const TLS_HANDSHAKE_TIMEOUT_MS = 15_000;

/**
 * The server answered a request with an ERR frame — as opposed to a timeout, a socket error or
 * an undecodable frame, which say nothing about the request itself. For LOGIN this is the only
 * failure that means "this session token is rejected"; everything else is transient. Carries the
 * opcode and the server's machine error code (payload.error) — not the payload, which the logger would print.
 */
export class MaxServerError extends Error {
  constructor(
    message: string,
    readonly opcode: number,
    readonly serverCode?: string,
  ) {
    super(message);
    this.name = 'MaxServerError';
  }
}

/** True when `err` is an ERR answer from the MAX server (optionally: to this opcode). */
export function isMaxServerError(err: unknown, opcode?: number): err is MaxServerError {
  return err instanceof MaxServerError && (opcode === undefined || err.opcode === opcode);
}

/**
 * The MAX socket went away while something was waiting for an answer on it. That answer can never
 * arrive on a new socket, so waiters fail at once instead of sitting out their timeout. The message
 * is what bridge/transient.ts isTransientMaxError keys on; `cause` is the socket error.
 */
export class MaxConnectionLostError extends Error {
  constructor(what: string, cause?: unknown) {
    const reason = cause instanceof Error ? cause.message : cause != null ? String(cause) : 'socket closed';
    super(`MaxClient connection lost while waiting for ${what}: ${reason}`, { cause });
    this.name = 'MaxConnectionLostError';
  }
}

/**
 * True when an EVENTS push says the upload with this id is processed: `{videoId}` for video,
 * `{audioId}` for a voice note (whose id is the upload slot's videoId). Ids compare via String()
 * (number, BigInt or string on the wire). Matching any id let two parallel uploads cross.
 */
export function isUploadReadyPush(payload: unknown, key: 'videoId' | 'audioId', id: unknown): boolean {
  if (!payload || typeof payload !== 'object' || id == null) return false;
  const got = (payload as Record<string, unknown>)[key];
  return got != null && String(got) === String(id);
}

/** One pending wait for a frame — a request's answer or an upload-ready push. See MaxClient.pending. */
interface PendingWait {
  readonly what: string;
  accept(event: MaxMessageEvent): boolean;
  resolve(event: MaxMessageEvent): void;
  fail(err: Error): void;
}

/**
 * The backoff step to use for the next reconnect: the running `attempt`, or 0 when the last
 * connection passed INIT (`readyAt`) and then stayed up for STABLE_CONNECTION_MS.
 */
export function reconnectAttemptFor(attempt: number, readyAt: number | null, now: number = Date.now()): number {
  return readyAt !== null && now - readyAt >= STABLE_CONNECTION_MS ? 0 : attempt;
}

function randomDeviceId(): string {
  return Array.from({ length: 18 }, () => Math.floor(Math.random() * 10)).join('');
}

/**
 * A chatId arrives as a plain number, a BigInt (large/negative ids — seen live on channels) or a
 * decimal string (our stores). Always repack as BigInt: msgpackr only emits a proper integer for
 * BigInt — a plain number beyond ~2^32 degrades to float64, which the server rejects.
 */
function toChatId(chatId: unknown): bigint {
  return typeof chatId === 'bigint' ? chatId : BigInt(chatId as string | number);
}

/** User ids share chatId's overflow trap: bot accounts have ids above 2^32 (seen live: 4725009270). */
function toUserId(id: unknown): bigint {
  return typeof id === 'bigint' ? id : BigInt(id as string | number);
}

interface ResolvedOptions {
  host: string;
  sni: string;
  reconnect: boolean;
}

/** What may go out on a socket before its LOGIN OK (MaxClient.authed). */
const PRE_LOGIN_OPCODES = new Set<number>([OPCODES.INIT, OPCODES.PING, OPCODES.START_AUTH, OPCODES.CHECK_CODE, OPCODES.CHECK_PASSWORD, OPCODES.LOGIN]);

export class MaxClient extends EventEmitter {
  readonly deviceId: string;
  private readonly opts: ResolvedOptions;
  private socket: tls.TLSSocket | null = null;
  private buffer = Buffer.alloc(0);
  private seq = 1;
  private pingTimer: ReturnType<typeof setInterval> | null = null;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private reconnectAttempt = 0;
  // When the current socket passed INIT (null before that) — see reconnectAttemptFor.
  private readyAt: number | null = null;
  // Set by this socket's LOGIN OK. Until then only the handshake and auth opcodes go out: a request
  // written before LOGIN gets MAX's session-state ERR, which reads as a permanent refusal — it
  // must fail as "not connected" (transient) instead.
  private authed = false;
  private closedByUser = false;
  // Everything waiting for a frame, keyed by opcode. ONE 'message' listener (dispatch) settles
  // them, and a lost socket fails them all at once (failPending).
  private readonly pending = new Map<number, Set<PendingWait>>();

  constructor(options: MaxClientOptions = {}) {
    super();
    this.on('message', (event: MaxMessageEvent) => this.dispatch(event));
    this.deviceId = options.deviceId ?? randomDeviceId();
    this.opts = {
      host: options.host ?? DEFAULT_HOST,
      sni: options.sni ?? DEFAULT_SNI,
      reconnect: options.reconnect ?? true,
    };
  }

  connect(): void {
    this.closedByUser = false;
    // A manual connect() must not leave a stale reconnect timer that fires a second, overlapping connect.
    this.clearReconnectTimer();
    this.teardownSocket();
    this.buffer = Buffer.alloc(0);
    this.seq = 1;
    this.readyAt = null;
    this.authed = false;

    // `ca` REPLACES Node's default trust store for this socket, so MAX_TLS_CA re-includes the
    // bundled roots alongside the Russian state chain MAX's cert needs (see ca.ts).
    // autoSelectFamily (Happy Eyeballs): race IPv6 and IPv4 so an IPv6-only host reaches the
    // DNS64 AAAA and dual-stack doesn't stall on a dead family. (Intersection type: @types/node's
    // tls.ConnectionOptions doesn't declare the net-level field Node accepts at runtime.)
    const socketOpts: tls.ConnectionOptions & { autoSelectFamily?: boolean } = {
      servername: this.opts.sni,
      rejectUnauthorized: true, // never off: this socket carries the session token
      ca: MAX_TLS_CA,
      autoSelectFamily: true,
    };
    this.socket = tls.connect(
      DEFAULT_PORT,
      this.opts.host,
      socketOpts,
      () => {
        // The reconnect backoff is NOT reset here — only after INIT plus a stable stretch (reconnectAttemptFor).
        this.socket?.setTimeout(0); // handshake done — PING and keepalive watch the socket from here
        this.socket?.setKeepAlive(true, TCP_KEEPALIVE_DELAY_MS);
        this.emit('connected');
        this.startPing();
        this.sendDeviceInfo();
      },
    );

    this.socket.on('data', (data: Buffer) => {
      this.buffer = Buffer.concat([this.buffer, data]);
      this.drainBuffer();
    });

    const socket = this.socket;
    // Destroyed with an error: 'error' then 'close' below, which reconnects with backoff.
    socket.setTimeout(TLS_HANDSHAKE_TIMEOUT_MS, () => {
      socket.destroy(Object.assign(new Error(`MAX TLS handshake timed out after ${TLS_HANDSHAKE_TIMEOUT_MS / 1000}s`), { code: 'ETIMEDOUT' }));
    });
    socket.on('error', (err: Error) => {
      // Fail the waits first: whatever they wait for will not come on this socket.
      this.failPending(err);
      this.emit('error', err);
    });

    socket.on('close', () => {
      this.stopPing();
      // send() must say "not connected" at once, not write into a destroyed stream.
      if (this.socket === socket) this.socket = null;
      this.failPending(new Error('socket closed'));
      this.emit('disconnected');
      if (!this.closedByUser && this.opts.reconnect) this.scheduleReconnect();
    });
  }

  disconnect(): void {
    this.closedByUser = true;
    this.clearReconnectTimer();
    this.teardownSocket();
  }

  /** True after disconnect() until the next connect() — a deliberate stop (pause, /kill, shutdown), not a drop. */
  get stoppedByUser(): boolean {
    return this.closedByUser;
  }

  /** True once this socket's LOGIN was accepted — until then only auth opcodes may go out (send). */
  get loggedIn(): boolean {
    return this.authed;
  }

  private teardownSocket(): void {
    if (this.socket) {
      this.socket.removeAllListeners();
      // destroy() can still deliver a queued 'error'; with no listener it becomes an uncaughtException.
      this.socket.on('error', () => {});
      this.socket.destroy();
      this.socket = null;
    }
    this.failPending(new Error('socket torn down'));
    this.stopPing();
  }

  private scheduleReconnect(): void {
    this.clearReconnectTimer();
    this.reconnectAttempt = reconnectAttemptFor(this.reconnectAttempt, this.readyAt);
    this.readyAt = null;
    const idx = Math.min(this.reconnectAttempt, RECONNECT_DELAYS_MS.length - 1);
    const delay = RECONNECT_DELAYS_MS[idx] as number;
    this.reconnectAttempt += 1;
    this.reconnectTimer = setTimeout(() => this.connect(), delay);
  }

  private clearReconnectTimer(): void {
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
  }

  private startPing(): void {
    this.stopPing();
    this.lastPingSentAt = null; // a new socket: an unanswered PING of the old one doesn't count
    this.pingTimer = setInterval(() => this.ping(), DEFAULT_PING_INTERVAL_MS);
  }

  private stopPing(): void {
    if (this.pingTimer) {
      clearInterval(this.pingTimer);
      this.pingTimer = null;
    }
  }

  // Set when a PING goes out, cleared by its reply.
  private lastPingSentAt: number | null = null;

  /**
   * Half-open detection. The previous PING still unanswered a whole interval later means the path
   * is dead even though the socket looks open (a NAT/CLAT mapping dropped, a server gone without
   * a FIN): the kernel would keep retransmitting for 15+ minutes before 'close'. Destroy the socket
   * instead — 'error' fails the in-flight requests, 'close' runs the usual reconnect path.
   */
  private ping(): void {
    if (this.lastPingSentAt !== null) {
      const silentMs = Date.now() - this.lastPingSentAt;
      this.lastPingSentAt = null;
      // code ETIMEDOUT: the failed in-flight requests classify as transient (bridge/transient.ts).
      const err = Object.assign(new Error(`MAX did not answer PING for ${Math.round(silentMs / 1000)}s — connection is dead, reconnecting`), {
        code: 'ETIMEDOUT',
      });
      this.socket?.destroy(err);
      return;
    }
    this.lastPingSentAt = Date.now();
    this.send(OPCODES.PING);
  }

  private drainBuffer(): void {
    while (this.buffer.length >= FRAME_HEADER_SIZE) {
      let header;
      try {
        header = readFrameHeader(this.buffer);
      } catch (err) {
        this.emit('error', err as Error);
        // teardownSocket removes the socket's listeners, so no 'close' will fire: the reconnect
        // and 'disconnected' the 'close' path would do happen here — or a single desynced frame
        // leaves the client permanently offline, silently.
        this.teardownSocket();
        this.emit('disconnected');
        if (!this.closedByUser && this.opts.reconnect) this.scheduleReconnect();
        return;
      }

      const total = FRAME_HEADER_SIZE + header.payloadLength;
      if (this.buffer.length < total) return; // wait for more data

      const rawPayload = this.buffer.subarray(FRAME_HEADER_SIZE, total);
      this.buffer = this.buffer.subarray(total);

      let payload: unknown = null;
      if (header.payloadLength > 0) {
        try {
          const decompressed = decompressPayload(rawPayload, header.flags);
          const items = decodeFramePayload(decompressed);
          payload = pickObject(items) ?? items[0] ?? null;
        } catch (err) {
          // Diagnostic only, on its own event: the connection is fine, and a push of an unrelated
          // opcode must not fail the requests in flight. app.ts logs it.
          this.emit(
            'decode-error',
            new Error(`Failed to decode payload for ${formatOpcode(header.opcode)}: ${(err as Error).message}`),
          );
          continue;
        }
      }

      const event: MaxMessageEvent = {
        dir: header.cmd,
        seq: header.seq,
        opcode: header.opcode,
        payload,
        length: header.payloadLength,
      };

      if (header.opcode === OPCODES.INIT && header.cmd === DIR.OK) {
        this.readyAt = Date.now();
        this.emit('ready');
      }
      // A refused INIT (e.g. an outdated appVersion) leaves an open socket nothing ever logs in
      // on: dropped instead, so the usual reconnect and outage notice follow.
      if (header.opcode === OPCODES.INIT && header.cmd === DIR.ERR) {
        this.socket?.destroy(new Error(describeAuthError(payload, 'MAX rejected INIT')));
        return;
      }
      if (header.opcode === OPCODES.LOGIN && header.cmd === DIR.OK) this.authed = true;
      if (header.opcode === OPCODES.PING) this.lastPingSentAt = null;
      this.emit('message', event);
    }
  }

  send(opcode: number, payload?: unknown): void {
    if (!this.socket || (!this.authed && !PRE_LOGIN_OPCODES.has(opcode))) throw new Error('MaxClient.send called while not connected');
    const payloadBuf = payload === undefined || payload === null ? Buffer.alloc(0) : pack(payload);
    const frame = encodeFrame(this.seq, opcode, payloadBuf);
    this.seq += 1;
    this.socket.write(frame);
    this.emit('sent', { opcode, payload, length: payloadBuf.length });
  }

  private sendDeviceInfo(): void {
    this.send(OPCODES.INIT, {
      userAgent: USER_AGENT,
      deviceId: this.deviceId,
      clientSessionId: Math.floor(Math.random() * 1000),
    });
  }

  /**
   * Registers a wait for the first frame of `opcode` that `accept` takes. It settles exactly once:
   * on that frame (dispatch), on its timeout, on a lost socket (failPending) or through the
   * returned `fail`. Every path removes it from `pending` and clears its timer.
   */
  private addWait(
    opcode: number,
    what: string,
    accept: (event: MaxMessageEvent) => boolean,
    timeoutMs: number,
    timeoutMessage: string,
  ): { promise: Promise<MaxMessageEvent>; fail: (err: Error) => void } {
    let wait!: PendingWait;
    const promise = new Promise<MaxMessageEvent>((resolve, reject) => {
      let settled = false;
      const settle = (): boolean => {
        if (settled) return false;
        settled = true;
        clearTimeout(timer);
        const set = this.pending.get(opcode);
        set?.delete(wait);
        if (set?.size === 0) this.pending.delete(opcode);
        return true;
      };
      const timer = setTimeout(() => {
        if (settle()) reject(new Error(timeoutMessage));
      }, timeoutMs);
      wait = {
        what,
        accept,
        resolve: (event) => {
          if (settle()) resolve(event);
        },
        fail: (err) => {
          if (settle()) reject(err);
        },
      };
    });
    let set = this.pending.get(opcode);
    if (!set) {
      set = new Set();
      this.pending.set(opcode, set);
    }
    set.add(wait);
    return { promise, fail: (err) => wait.fail(err) };
  }

  /** The single 'message' listener behind every wait: settles the waits this frame answers. */
  private dispatch(event: MaxMessageEvent): void {
    const set = this.pending.get(event.opcode);
    if (!set) return;
    for (const wait of [...set]) {
      if (wait.accept(event)) wait.resolve(event);
    }
  }

  /** The socket is gone: every wait fails now with a MaxConnectionLostError (see there). */
  private failPending(cause: Error): void {
    for (const set of [...this.pending.values()]) {
      for (const wait of [...set]) wait.fail(new MaxConnectionLostError(wait.what, cause));
    }
  }

  /**
   * Resolves with the first response frame matching `opcode`. The server doesn't reliably echo
   * `seq`, so opcode matching is the only correlation — unambiguous only while at most ONE request
   * per opcode is in flight, which request() enforces (hence private).
   */
  private waitForOpcode(opcode: number, timeoutMs = 20_000): { promise: Promise<MaxMessageEvent>; fail: (err: Error) => void } {
    return this.addWait(opcode, formatOpcode(opcode), () => true, timeoutMs, `Timed out waiting for ${formatOpcode(opcode)}`);
  }

  // Tail of the in-flight request chain per opcode — see request() below.
  private readonly requestChains = new Map<number, Promise<unknown>>();

  // `cid` doubles as the echo-suppression key (RecentCids in bridge/sync.ts), so two
  // sends within the same millisecond must not share one — Date.now() alone collides.
  private lastCid = 0;

  private nextCid(): number {
    const cid = Math.max(Date.now(), this.lastCid + 1);
    this.lastCid = cid;
    return cid;
  }

  /**
   * Sends `payload` and resolves with the first response frame carrying `opcode`, serializing
   * same-opcode requests: two concurrent calls for one opcode would both resolve on whichever
   * response landed first (a real race: Telegraf handles a poll batch's updates concurrently, and
   * two quick messages cross-wired the messageId links). Different opcodes still run in parallel.
   *
   * Known residual gap: if a request times out and its response arrives late, the NEXT same-opcode
   * request may consume that stale frame — unavoidable without seq correlation, and a timeout
   * usually means the connection is about to be torn down anyway.
   *
   * Without a socket, send() throws and the wait is withdrawn on the spot: the call rejects with
   * "not connected" and leaves no timer behind (an orphaned wait timed out 20 s later as an
   * unhandled rejection for every message written while MAX was paused).
   */
  private request(opcode: number, payload?: unknown, timeoutMs?: number): Promise<MaxMessageEvent> {
    const prev = this.requestChains.get(opcode) ?? Promise.resolve();
    const run = prev.then(() => {
      // Registered before send() so the answer cannot slip past; withdrawn if send() throws.
      const wait = this.waitForOpcode(opcode, timeoutMs);
      try {
        this.send(opcode, payload);
      } catch (err) {
        wait.fail(err instanceof Error ? err : new Error(String(err)));
      }
      return wait.promise;
    });
    // Keep the chain alive on failure so the next request still runs.
    this.requestChains.set(opcode, run.catch(() => undefined));
    return run;
  }

  async requestSms(phone: string): Promise<string> {
    const { dir, payload } = await this.request(OPCODES.START_AUTH, { phone, type: 'START_AUTH' });
    const token = findAuthToken(payload);
    if (dir === DIR.ERR || !token) {
      throw new Error(describeAuthError(payload, 'START_AUTH did not return an auth token'));
    }
    return token;
  }

  /**
   * A password-protected account (2FA on top of SMS) makes CHECK_CODE respond with a
   * `passwordChallenge` instead of a login token — confirmed live 2026-08-14. Distinguished from a
   * wrong SMS code so the caller can ask for a password instead of a fresh code.
   */
  async verifyCode(authToken: string, code: string): Promise<VerifyCodeResult> {
    const { dir, payload } = await this.request(OPCODES.CHECK_CODE, { token: authToken, verifyCode: code });
    const token = findLongToken(payload);
    if (dir !== DIR.ERR && token) {
      return { status: 'ok', loginToken: token };
    }
    const challenge = extractPasswordChallenge(payload);
    if (challenge) {
      return { status: 'password_required', challenge };
    }
    // No login token AND no password challenge: a wrong/stale code, or a number not registered in
    // MAX yet (its REGISTRATION flow returns no login token) — spell out both.
    throw new Error(
      describeAuthError(
        payload,
        'Код не подтверждён. Проверьте, что код верный и свежий — и что номер уже зарегистрирован в приложении MAX: мост подключает существующий аккаунт, а не создаёт новый.',
      ),
    );
  }

  /**
   * The second factor after a verifyCode() that returned `password_required`. `trackId` survives a
   * wrong password (safe to retry) but is consumed on success — confirmed live 2026-08-14.
   */
  async checkPassword(trackId: string, password: string): Promise<string> {
    const { dir, payload } = await this.request(OPCODES.CHECK_PASSWORD, { trackId, password });
    const token = findLongToken(payload);
    if (dir === DIR.ERR || !token) {
      throw new Error(describeAuthError(payload, 'CHECK_PASSWORD did not return a login token — was the password correct?'));
    }
    return token;
  }

  async login(token: string, chatsCount = 50): Promise<{ sessionToken: string; payload: unknown }> {
    if (chatsCount > 50) {
      throw new Error('chatsCount must be <= 50 — the server returns an internal error above that (see ТЗ.md §2)');
    }
    const { dir, payload } = await this.request(OPCODES.LOGIN, { token, interactive: true, chatsCount });
    if (dir === DIR.ERR) {
      // A safe shape hint (top-level field NAMES, never values) makes a resume failure self-diagnosing.
      const shape =
        payload && typeof payload === 'object' && !Array.isArray(payload)
          ? `keys=[${Object.keys(payload as object).join(',')}]`
          : `type=${typeof payload}`;
      const serverCode = (payload as { error?: unknown } | null)?.error;
      throw new MaxServerError(
        `${describeAuthError(payload, 'LOGIN was rejected — the session token is no longer valid')} (dir=0x${dir.toString(16)}, ${shape})`,
        OPCODES.LOGIN,
        typeof serverCode === 'string' ? serverCode : undefined,
      );
    }
    // A successful LOGIN only SOMETIMES rotates the session token; a token-less OK (confirmed live:
    // keys=[profile,chats,messages,…], no token) means the presented token is still valid. Treating
    // it as expiry bricked valid sessions. Only a dir=ERR frame is a real rejection.
    const sessionToken = findLongToken(payload) ?? token;
    return { sessionToken, payload };
  }

  /**
   * Resolves once the server echoes the message back, with the `cid` (for recognizing our own
   * messages echoed as pushes) and the MAX-assigned `messageId` (for later edit/react/delete).
   * `cid` must be packed as int64 (BigInt) — a float64 there is rejected with "proto.payload /
   * Expected number" (confirmed live). `text: null` for attach-only sends (e.g. polls) — MAX
   * expects null there, not an empty string.
   */
  async sendMessage(
    chatId: unknown,
    text: string | null,
    attaches: unknown[] = [],
    replyTo?: { messageId: unknown; chatId: unknown },
  ): Promise<{ cid: number; messageId: unknown; attaches: unknown[]; time: unknown }> {
    const cid = this.nextCid();
    // The OUTGOING reply link is {type, messageId, chatId}; the INCOMING one carries `message`
    // instead (two shapes, confirmed 2026-08-16). messageId is the quoted message's BigInt id.
    const link = replyTo ? { type: 'REPLY', messageId: replyTo.messageId, chatId: toChatId(replyTo.chatId) } : null;
    const { dir, payload } = await this.request(OPCODES.MSG_SEND, {
      chatId: toChatId(chatId),
      message: { text, cid: BigInt(cid), elements: [], attaches, link },
      notify: true,
    });
    const responseMessage = (payload as { message?: { id?: unknown; attaches?: unknown[]; time?: unknown } } | null)?.message;
    if (dir === DIR.ERR) throw new Error(describeAuthError(payload, 'MSG_SEND failed'));
    // `time` is the echoed message's MAX server timestamp, raw — the chat's history cursor (liveCursorTime).
    return { cid, messageId: responseMessage?.id, attaches: responseMessage?.attaches ?? [], time: responseMessage?.time };
  }

  /**
   * Opens a 1:1 dialog with a FRESH contact by sending the first message with a top-level `userId`
   * (NOT `chatId`) — MAX creates the dialog and returns its real `chatId`; how the official app's
   * "Открыть чат" works (confirmed live 2026-08-21). A `CONTROL {event:'new', chatType:'DIALOG'}`
   * creates a GROUP instead. `text` MUST be non-empty ("Message text must not be empty").
   */
  async sendToNewDialog(
    userId: unknown,
    text: string,
    attaches: unknown[] = [],
    replyTo?: { messageId: unknown; chatId: unknown },
  ): Promise<{ cid: number; messageId: unknown; chatId: unknown; attaches: unknown[]; time: unknown }> {
    const cid = this.nextCid();
    const link = replyTo ? { type: 'REPLY', messageId: replyTo.messageId, chatId: toChatId(replyTo.chatId) } : null;
    const { dir, payload } = await this.request(OPCODES.MSG_SEND, {
      userId: toUserId(userId),
      message: { text, cid: BigInt(cid), elements: [], attaches, link },
      notify: true,
    });
    if (dir === DIR.ERR) throw new Error(describeAuthError(payload, 'Open-dialog send failed'));
    const p = payload as { chatId?: unknown; message?: { id?: unknown; attaches?: unknown[]; time?: unknown } } | null;
    if (p?.chatId == null) throw new Error('Open-dialog send did not return a chat id');
    return { cid, messageId: p.message?.id, chatId: p.chatId, attaches: p.message?.attaches ?? [], time: p.message?.time };
  }

  /** `answerIds` — MAX's own assigned ids (from the poll's `answers[].answerId`), not Telegram option indexes. */
  async sendVote(chatId: unknown, messageId: unknown, pollId: unknown, answerIds: number[]): Promise<void> {
    const { dir, payload } = await this.request(OPCODES.SEND_VOTE, { chatId: toChatId(chatId), messageId, pollId, answersIds: answerIds });
    if (dir === DIR.ERR) throw new Error(describeAuthError(payload, 'SEND_VOTE failed'));
  }

  /** `messageId` must be the genuine MAX integer id (BigInt) — see opcodes.ts for the type pitfall across these three calls. */
  async editMessage(chatId: unknown, messageId: unknown, text: string): Promise<void> {
    const { dir, payload } = await this.request(OPCODES.MSG_EDIT, { chatId: toChatId(chatId), messageId, text, elements: [], attachments: [] });
    if (dir === DIR.ERR) throw new Error(describeAuthError(payload, 'MSG_EDIT failed'));
  }

  /**
   * Contrary to the spec (decimal string), the server wants `messageId` in the same integer
   * encoding as MSG_EDIT/MSG_CANCEL_REACTION — a live "Expected number" validation error at the
   * string's byte proved it. Pass the BigInt through; do not stringify.
   */
  async addReaction(chatId: unknown, messageId: unknown, emoji: string): Promise<void> {
    const { dir, payload } = await this.request(OPCODES.MSG_REACTION, { chatId: toChatId(chatId), messageId, reaction: { reactionType: 'EMOJI', id: toMaxReaction(emoji) } });
    if (dir === DIR.ERR) throw new Error(describeAuthError(payload, 'MSG_REACTION failed'));
  }

  async removeReaction(chatId: unknown, messageId: unknown): Promise<void> {
    const { dir, payload } = await this.request(OPCODES.MSG_CANCEL_REACTION, { chatId: toChatId(chatId), messageId });
    if (dir === DIR.ERR) throw new Error(describeAuthError(payload, 'MSG_CANCEL_REACTION failed'));
  }

  /**
   * Polling fallback for reaction removal — MAX sends no live push for it (see bridge/sync.ts).
   * Returns the current reaction counters, or `[]` once none remain.
   *
   * IMPORTANT: `messageIds` (plural, array) — the singular `messageId` doesn't just get rejected,
   * the server drops the whole TCP connection (confirmed live). A malformed payload to MAX can
   * cost the live session, not just an error.
   */
  async getReactions(chatId: unknown, messageId: unknown): Promise<Array<{ reaction: string; count: number }>> {
    const { dir, payload } = await this.request(OPCODES.MSG_GET_REACTIONS, { chatId: toChatId(chatId), messageIds: [messageId] });
    if (dir === DIR.ERR) throw new Error(describeAuthError(payload, 'MSG_GET_REACTIONS failed'));
    // Real shape confirmed live 2026-08-15: `{messagesReactions: {"<messageId>": {counters:[...]}}}`.
    // The reactionInfo/reactions guesses never matched (every relayed reaction then looked removed
    // and was stripped in Telegram after ~60 s); kept as fallbacks only.
    type Counters = Array<{ reaction: string; count: number }>;
    const p = payload as
      | { messagesReactions?: Record<string, { counters?: Counters }> }
      | { reactionInfo?: { counters?: Counters } }
      | { reactions?: Array<{ counters?: Counters }> }
      | null;
    if (p && 'messagesReactions' in p && p.messagesReactions) {
      const byId = p.messagesReactions[String(messageId)];
      if (byId?.counters) return byId.counters;
      // Only one messageId is ever asked for, so the sole entry is ours even if the key's string form differs.
      const first = Object.values(p.messagesReactions)[0];
      if (first?.counters) return first.counters;
    }
    if (p && 'reactionInfo' in p && p.reactionInfo?.counters) return p.reactionInfo.counters;
    if (p && 'reactions' in p && p.reactions?.[0]?.counters) return p.reactions[0].counters;
    return [];
  }

  /**
   * Contact profile details (name variants, country, phone, registration time) — not in LOGIN's
   * contacts[]/CHATS_LIST's participants, needs its own round trip per batch of ids. Response
   * wrapper key unconfirmed (reverse-engineered 2026-08-09), so the plausible ones are tried.
   */
  async getContactInfo(contactIds: unknown[]): Promise<MaxContactInfo[]> {
    const { dir, payload } = await this.request(OPCODES.CONTACT_INFO, { contactIds: contactIds.map(toUserId) });
    if (dir === DIR.ERR) throw new Error(describeAuthError(payload, 'CONTACT_INFO failed'));
    const p = payload as { contacts?: MaxContactInfo[]; profiles?: MaxContactInfo[] } | null;
    if (p && Array.isArray(p.contacts)) return p.contacts;
    if (p && Array.isArray(p.profiles)) return p.profiles;
    return [];
  }

  /**
   * Finds a contact by phone number (CONTACT_INFO_BY_PHONE, 0x002E). The field is `phone` (NOT
   * phoneNumber — "Field requirement failed: phone"); the leading `+` is optional. Response
   * `{contact}` (live shapes 2026-08-16).
   */
  async searchContactByPhone(phone: string): Promise<MaxContactInfo | null> {
    const { dir, payload } = await this.request(OPCODES.CONTACT_INFO_BY_PHONE, { phone });
    if (dir === DIR.ERR) {
      // "not found" is an ERROR frame ({error:"not.found"}), not an empty result — the number
      // isn't a MAX user. Any OTHER error propagates.
      const err = (payload as { error?: string } | null)?.error;
      if (err === 'not.found') return null;
      throw new Error(describeAuthError(payload, 'CONTACT_INFO_BY_PHONE failed'));
    }
    return (payload as { contact?: MaxContactInfo } | null)?.contact ?? null;
  }

  /**
   * Global catalog search (PUBLIC_SEARCH, 0x003C). Probed live 2026-10-05: it finds public BOTS and
   * CHANNELS by title or by the nick in their link; ordinary people are not returned, and a query
   * with a leading «@» finds nothing (strip it before calling). Shape: see parsePublicSearch.
   */
  async publicSearch(query: string, count = 10): Promise<{ contacts: MaxContactInfo[]; channels: MaxPublicChannel[] }> {
    const { dir, payload } = await this.request(OPCODES.PUBLIC_SEARCH, { query, count });
    if (dir === DIR.ERR) throw new Error(describeAuthError(payload, 'PUBLIC_SEARCH failed'));
    return parsePublicSearch(payload);
  }


  /**
   * One page of the account's full chat list (not the capped ≤50 LOGIN snapshot). `marker` starts
   * as "now" (ms, BigInt on the wire) and each response's `marker` feeds the next call; an empty
   * `chats` means the walk is done (reverse-engineered 2026-08-09).
   */
  private async getChatsList(marker: number): Promise<{ chats: unknown[]; marker: number | null }> {
    const { dir, payload } = await this.request(OPCODES.CHATS_LIST, { marker: BigInt(marker) });
    if (dir === DIR.ERR) throw new Error(describeAuthError(payload, 'CHATS_LIST failed'));
    const p = payload as { chats?: unknown[]; marker?: unknown } | null;
    const chats = Array.isArray(p?.chats) ? p.chats : [];
    const nextMarker = p?.marker != null ? Number(p.marker) : null;
    return { chats, marker: nextMarker };
  }

  /** Walks getChatsList to completion — the account's actual full chat list, unlike LOGIN's capped ≤50 snapshot. */
  async getAllChats(): Promise<unknown[]> {
    const all: unknown[] = [];
    const seenIds = new Set<string>();
    let marker: number | null = Date.now();
    const MAX_PAGES = 500; // safety valve, not an expected ceiling
    for (let i = 0; i < MAX_PAGES && marker != null; i++) {
      const page = await this.getChatsList(marker);
      if (page.chats.length === 0) break;
      let addedAny = false;
      for (const c of page.chats) {
        const key = String((c as { id?: unknown } | null)?.id);
        if (seenIds.has(key)) continue;
        seenIds.add(key);
        all.push(c);
        addedAny = true;
      }
      // Nothing new, or the marker stopped moving — the end (same guard as fetchFullHistory).
      if (!addedAny || page.marker == null || !(page.marker < marker)) break;
      marker = page.marker;
    }
    return all;
  }

  /**
   * Creates a group or channel — the one MSG_SEND with no `chatId` (there isn't one yet).
   * `event: 'new'` (lowercase); `userIds` invites members immediately (reverse-engineered 2026-08-10).
   */
  async createGroup(title: string, userIds: number[] = [], chatType: 'CHAT' | 'CHANNEL' = 'CHAT'): Promise<{ chatId: unknown; owner: unknown }> {
    const { dir, payload } = await this.request(OPCODES.MSG_SEND, {
      message: {
        cid: BigInt(this.nextCid()),
        attaches: [{ _type: 'CONTROL', event: 'new', chatType, title, userIds: userIds.map(toUserId) }],
      },
      notify: true,
    });
    if (dir === DIR.ERR) throw new Error(describeAuthError(payload, 'Group creation failed'));
    const chat = (payload as { chat?: { id?: unknown; owner?: unknown } } | null)?.chat;
    if (chat?.id == null) throw new Error('Group creation did not return a chat id');
    return { chatId: chat.id, owner: chat.owner };
  }

  /** `operation: 'add' | 'remove'`. */
  async updateChatMembers(chatId: unknown, userIds: number[], operation: 'add' | 'remove', showHistory = true): Promise<void> {
    const { dir, payload } = await this.request(OPCODES.CHAT_MEMBERS, { chatId: toChatId(chatId), userIds: userIds.map(toUserId), showHistory, operation });
    if (dir === DIR.ERR) throw new Error(describeAuthError(payload, 'CHAT_MEMBERS failed'));
  }

  /** `avatarId` is accepted by the wire format but silently ignored server-side — user-confirmed, so not exposed here. */
  async updateChatInfo(chatId: unknown, fields: { title?: string; description?: string }): Promise<void> {
    const { dir, payload } = await this.request(OPCODES.CHAT_SET_INFO, { chatId: toChatId(chatId), ...fields });
    if (dir === DIR.ERR) throw new Error(describeAuthError(payload, 'CHAT_SET_INFO failed'));
  }

  async leaveChat(chatId: unknown): Promise<void> {
    const { dir, payload } = await this.request(OPCODES.CHAT_LEAVE, { chatId: toChatId(chatId) });
    if (dir === DIR.ERR) throw new Error(describeAuthError(payload, 'CHAT_LEAVE failed'));
  }

  /** `forAll: true` deletes for every participant — irreversible for them too, not just us. */
  async deleteChat(chatId: unknown, lastEventTime: number, forAll: boolean): Promise<void> {
    const { dir, payload } = await this.request(OPCODES.CHAT_DELETE, { chatId: toChatId(chatId), lastEventTime: BigInt(lastEventTime), forAll });
    if (dir === DIR.ERR) throw new Error(describeAuthError(payload, 'CHAT_DELETE failed'));
  }

  /** `forMe: true` deletes only from our own view; `false` deletes for everyone. */
  /** Presses a CALLBACK button of a bot message's keyboard; `payload` is the pressed button's own (see OPCODES.MSG_CALLBACK). */
  async sendCallback(chatId: unknown, callbackId: string, payload?: string): Promise<void> {
    const { dir, payload: answer } = await this.request(OPCODES.MSG_CALLBACK, {
      callbackId,
      chatId: toChatId(chatId),
      ...(payload != null ? { payload } : {}),
    });
    if (dir === DIR.ERR) throw new Error(describeAuthError(answer, 'MSG_CALLBACK failed'));
  }

  async deleteMessages(chatId: unknown, messageIds: unknown[], forMe: boolean): Promise<void> {
    const { dir, payload } = await this.request(OPCODES.MSG_DELETE, { chatId: toChatId(chatId), messageIds, forMe });
    if (dir === DIR.ERR) throw new Error(describeAuthError(payload, 'MSG_DELETE failed'));
  }

  /**
   * One page of chat history, newest-first from `from` (ms timestamp, exclusive upper bound).
   * Message objects match PUSH_MESSAGE's shape exactly (reverse-engineered 2026-08-08).
   */
  async getChatHistory(chatId: unknown, from: number, backward = 100): Promise<MaxHistoryMessage[]> {
    const { dir, payload } = await this.request(OPCODES.CHAT_HISTORY, {
      chatId: toChatId(chatId),
      // A ms timestamp (~1.7e12) — same overflow trap as cid/messageId/chatId (see toChatId).
      from: BigInt(from),
      backward,
      forward: 0,
      backwardTime: 0,
      forwardTime: 0,
      getChat: false,
      getMessages: true,
      interactive: false,
      itemType: 'REGULAR',
    });
    if (dir === DIR.ERR) throw new Error(describeAuthError(payload, 'CHAT_HISTORY failed'));
    const messages = (payload as { messages?: MaxHistoryMessage[] } | null)?.messages;
    return Array.isArray(messages) ? messages : [];
  }

  /** Requests an upload slot for a single photo. Response shape supplied by the user, not in max-protocol-full.md. */
  async requestPhotoUpload(): Promise<{ url: string; photoIds: unknown[] }> {
    const { dir, payload } = await this.request(OPCODES.PHOTO_UPLOAD, { count: 1 });
    const result = payload as { url?: string; photoIds?: unknown[] } | null;
    if (dir === DIR.ERR || !result?.url) {
      throw new Error(describeAuthError(payload, 'PHOTO_UPLOAD did not return an upload url'));
    }
    return { url: result.url, photoIds: result.photoIds ?? [] };
  }

  /** Requests an upload slot for a single video. */
  async requestVideoUpload(): Promise<{ url: string; videoId: unknown; token: string }> {
    const { dir, payload } = await this.request(OPCODES.VIDEO_UPLOAD, { count: 1, type: 0, uploaderType: 0, profile: false });
    const slot = (payload as { info?: Array<{ url: string; videoId: unknown; token: string }> } | null)?.info?.[0];
    if (dir === DIR.ERR || !slot) {
      throw new Error(describeAuthError(payload, 'VIDEO_UPLOAD did not return an upload slot'));
    }
    return slot;
  }

  /**
   * Voice notes go through the SAME upload opcode as video (0x52) — `type: 2` marks audio,
   * `type: 0` video. Confirmed live 2026-08-13; FILE_UPLOAD (0x57) is not the opcode for it.
   */
  async requestVoiceUploadSlot(): Promise<{ url: string; videoId: unknown; token: string }> {
    const { dir, payload } = await this.request(OPCODES.VIDEO_UPLOAD, { count: 1, type: 2, uploaderType: 0, profile: false });
    const slot = (payload as { info?: Array<{ url: string; videoId: unknown; token: string }> } | null)?.info?.[0];
    if (dir === DIR.ERR || !slot) {
      throw new Error(describeAuthError(payload, 'VIDEO_UPLOAD (voice) did not return an upload slot'));
    }
    return slot;
  }

  /**
   * Waits for the server-side "video is ready" signal: an EVENTS push (0x88) with `{videoId}` at
   * the top level — NOT PUSH_MESSAGE (0x80). Confirmed live 2026-08-07.
   */
  waitForVideoReady(videoId: unknown, timeoutMs = 15_000): Promise<void> {
    return this.waitForUploadReady('videoId', videoId, 'video', timeoutMs);
  }

  /**
   * Same EVENTS push as video-ready, keyed on `audioId`. Confirmed live 2026-08-13: without it
   * MSG_SEND with the audioId sometimes fails validation because the file isn't processed yet.
   */
  waitForAudioReady(audioId: unknown, timeoutMs = 15_000): Promise<void> {
    return this.waitForUploadReady('audioId', audioId, 'audio', timeoutMs);
  }

  /**
   * The ready wait behind waitForVideoReady / waitForAudioReady. Only the push for THIS upload's
   * id counts (isUploadReadyPush), and a lost socket fails it at once (failPending) — the push
   * would never come on a new socket.
   */
  private waitForUploadReady(key: 'videoId' | 'audioId', id: unknown, kind: string, timeoutMs: number): Promise<void> {
    const what = `the ${kind}-ready push for ${String(id)}`;
    if (!this.socket) return Promise.reject(new MaxConnectionLostError(what, new Error('not connected')));
    const wait = this.addWait(
      OPCODES.EVENTS,
      what,
      (event) => isUploadReadyPush(event.payload, key, id),
      timeoutMs,
      `Timed out waiting for the ${kind}-ready push`,
    );
    return wait.promise.then(() => undefined);
  }

  /** Requests an upload slot for a single file (also used for GIFs — MAX only accepts those as FILE). */
  async requestFileUpload(): Promise<{ url: string; fileId: unknown; token: string }> {
    const { dir, payload } = await this.request(OPCODES.FILE_UPLOAD, { count: 1, type: 0, uploaderType: 0, profile: false });
    const slot = (payload as { info?: Array<{ url: string; fileId: unknown; token: string }> } | null)?.info?.[0];
    if (dir === DIR.ERR || !slot) {
      throw new Error(describeAuthError(payload, 'FILE_UPLOAD did not return an upload slot'));
    }
    return slot;
  }

  /** Exchanges a FILE attachment's opaque token for a short-lived signed download URL. */
  async getFileDownloadUrl(chatId: unknown, messageId: unknown, fileId: unknown): Promise<string> {
    const { dir, payload } = await this.request(OPCODES.FILE_DOWNLOAD, { chatId: toChatId(chatId), messageId, fileId });
    const url = (payload as { url?: string } | null)?.url;
    if (dir === DIR.ERR || !url) {
      throw new Error(describeAuthError(payload, 'FILE_DOWNLOAD did not return a url'));
    }
    return url;
  }

  /** VIDEO has its own id namespace — FILE_DOWNLOAD rejects a videoId with "file not found". Returns quality-keyed URLs (MP4_240, …) plus EXTERNAL. */
  async getVideoPlayUrls(chatId: unknown, messageId: unknown, videoId: unknown): Promise<Record<string, string>> {
    const { dir, payload } = await this.request(OPCODES.VIDEO_PLAY, { chatId: toChatId(chatId), messageId, videoId });
    const urls = payload as Record<string, string> | null;
    if (dir === DIR.ERR || !urls) {
      throw new Error(describeAuthError(payload, 'VIDEO_PLAY did not return any playback urls'));
    }
    return urls;
  }
}
