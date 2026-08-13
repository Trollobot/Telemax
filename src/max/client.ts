import tls from 'node:tls';
import { EventEmitter } from 'node:events';
import { pack } from 'msgpackr';
import { readFrameHeader, encodeFrame, decompressPayload, FRAME_HEADER_SIZE } from './frame.js';
import { decodeFramePayload, pickObject } from './msgpack.js';
import { OPCODES, DIR, formatOpcode } from './opcodes.js';
import { findAuthToken, findLongToken, describeAuthError } from './tokens.js';

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
  // Present when this message is a forward — its own text/attaches are empty, the
  // real content is in link.message. Same shape as PUSH_MESSAGE's link field.
  // `link.message.id` + `link.chatId` are the ORIGINAL message/chat the attachment
  // was uploaded against — FILE_DOWNLOAD/VIDEO_PLAY need those, not the wrapper's own.
  link?: { type?: string; message?: { id?: unknown; text?: string; sender?: unknown; attaches?: unknown[] }; chatId?: unknown };
}

export interface MaxClientOptions {
  host?: string;
  port?: number;
  sni?: string;
  deviceId?: string;
  appVersion?: string;
  osVersion?: string;
  locale?: string;
  timezone?: string;
  buildNumber?: number;
  /**
   * Verify the MAX server's TLS certificate. Only pass `false` for local,
   * throwaway protocol experiments — never in anything that touches a real
   * session token (see ТЗ.md §3.1).
   */
  rejectUnauthorized?: boolean;
  reconnect?: boolean;
  pingIntervalMs?: number;
}

const DEFAULT_HOST = '155.212.204.150';
const DEFAULT_PORT = 443;
const DEFAULT_SNI = 'api2.oneme.ru';
const DEFAULT_PING_INTERVAL_MS = 50_000;
const RECONNECT_DELAYS_MS = [1_000, 2_000, 5_000, 10_000, 30_000];

function randomDeviceId(): string {
  return Array.from({ length: 18 }, () => Math.floor(Math.random() * 10)).join('');
}

/**
 * MAX chatId can arrive as a plain number, a BigInt (large/negative ids — seen
 * live on channels — decode that way because of their wire type), or a decimal
 * string (from our own stores, which normalize to string to survive JSON).
 * Always repack as BigInt before sending: msgpackr only emits a proper integer
 * type for BigInt regardless of magnitude — a plain number beyond ~2^32 silently
 * degrades to float64, which the server rejects (same failure mode `cid` hit).
 */
function toChatId(chatId: unknown): bigint {
  return typeof chatId === 'bigint' ? chatId : BigInt(chatId as string | number);
}

interface ResolvedOptions {
  host: string;
  port: number;
  sni: string;
  appVersion: string;
  osVersion: string;
  locale: string;
  timezone: string;
  buildNumber: number;
  rejectUnauthorized: boolean;
  reconnect: boolean;
  pingIntervalMs: number;
}

export class MaxClient extends EventEmitter {
  readonly deviceId: string;
  private readonly opts: ResolvedOptions;
  private socket: tls.TLSSocket | null = null;
  private buffer = Buffer.alloc(0);
  private seq = 1;
  private pingTimer: ReturnType<typeof setInterval> | null = null;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private reconnectAttempt = 0;
  private closedByUser = false;

  constructor(options: MaxClientOptions = {}) {
    super();
    this.deviceId = options.deviceId ?? randomDeviceId();
    this.opts = {
      host: options.host ?? DEFAULT_HOST,
      port: options.port ?? DEFAULT_PORT,
      sni: options.sni ?? DEFAULT_SNI,
      appVersion: options.appVersion ?? '26.24.0',
      osVersion: options.osVersion ?? 'Ubuntu 24.04.4 LTS',
      locale: options.locale ?? 'ru',
      timezone: options.timezone ?? 'Europe/Moscow',
      buildNumber: options.buildNumber ?? 75261,
      rejectUnauthorized: options.rejectUnauthorized ?? true,
      reconnect: options.reconnect ?? true,
      pingIntervalMs: options.pingIntervalMs ?? DEFAULT_PING_INTERVAL_MS,
    };
  }

  connect(): void {
    this.closedByUser = false;
    this.teardownSocket();
    this.buffer = Buffer.alloc(0);
    this.seq = 1;

    this.socket = tls.connect(
      this.opts.port,
      this.opts.host,
      { servername: this.opts.sni, rejectUnauthorized: this.opts.rejectUnauthorized },
      () => {
        this.reconnectAttempt = 0;
        this.emit('connected');
        this.startPing();
        this.sendDeviceInfo();
      },
    );

    this.socket.on('data', (data: Buffer) => {
      this.buffer = Buffer.concat([this.buffer, data]);
      this.drainBuffer();
    });

    this.socket.on('error', (err: Error) => {
      this.emit('error', err);
    });

    this.socket.on('close', () => {
      this.stopPing();
      this.emit('disconnected');
      if (!this.closedByUser && this.opts.reconnect) this.scheduleReconnect();
    });
  }

  disconnect(): void {
    this.closedByUser = true;
    this.clearReconnectTimer();
    this.teardownSocket();
  }

  private teardownSocket(): void {
    if (this.socket) {
      this.socket.removeAllListeners();
      this.socket.destroy();
      this.socket = null;
    }
    this.stopPing();
  }

  private scheduleReconnect(): void {
    this.clearReconnectTimer();
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
    this.pingTimer = setInterval(() => this.ping(), this.opts.pingIntervalMs);
  }

  private stopPing(): void {
    if (this.pingTimer) {
      clearInterval(this.pingTimer);
      this.pingTimer = null;
    }
  }

  private lastPingSentAt: number | null = null;

  private ping(): void {
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
        this.teardownSocket();
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
          this.emit(
            'error',
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

      if (header.opcode === OPCODES.INIT && header.cmd === DIR.OK) this.emit('ready');
      if (header.opcode === OPCODES.PING && this.lastPingSentAt !== null) {
        this.emit('latency', Date.now() - this.lastPingSentAt);
        this.lastPingSentAt = null;
      }
      this.emit('message', event);
    }
  }

  send(opcode: number, payload?: unknown): void {
    if (!this.socket) throw new Error('MaxClient.send called while not connected');
    const payloadBuf = payload === undefined || payload === null ? Buffer.alloc(0) : pack(payload);
    const frame = encodeFrame(this.seq, opcode, payloadBuf);
    this.seq += 1;
    this.socket.write(frame);
    this.emit('sent', { opcode, payload, length: payloadBuf.length });
  }

  private sendDeviceInfo(): void {
    this.send(OPCODES.INIT, {
      userAgent: {
        deviceType: 'DESKTOP',
        appVersion: this.opts.appVersion,
        osVersion: this.opts.osVersion,
        locale: this.opts.locale,
        screen: '2.0x',
        timezone: this.opts.timezone,
        buildNumber: this.opts.buildNumber,
      },
      deviceId: this.deviceId,
      clientSessionId: Math.floor(Math.random() * 1000),
    });
  }

  /**
   * Resolves with the first response frame matching `opcode`. Auth calls are
   * sent one at a time on a single connection, so simple opcode matching
   * (rather than tracking `seq` correlation, which the server doesn't
   * reliably echo) is sufficient here — do not fire concurrent calls for the
   * same opcode.
   */
  waitForOpcode(opcode: number, timeoutMs = 20_000): Promise<MaxMessageEvent> {
    return new Promise((resolve, reject) => {
      const cleanup = () => {
        clearTimeout(timer);
        this.off('message', onMessage);
        this.off('error', onError);
      };
      const onMessage = (event: MaxMessageEvent) => {
        if (event.opcode !== opcode) return;
        cleanup();
        resolve(event);
      };
      const onError = (err: Error) => {
        cleanup();
        reject(err);
      };
      const timer = setTimeout(() => {
        cleanup();
        reject(new Error(`Timed out waiting for ${formatOpcode(opcode)}`));
      }, timeoutMs);
      this.on('message', onMessage);
      this.on('error', onError);
    });
  }

  async requestSms(phone: string): Promise<string> {
    const wait = this.waitForOpcode(OPCODES.START_AUTH);
    this.send(OPCODES.START_AUTH, { phone, type: 'START_AUTH' });
    const { dir, payload } = await wait;
    const token = findAuthToken(payload);
    if (dir === DIR.ERR || !token) {
      throw new Error(describeAuthError(payload, 'START_AUTH did not return an auth token'));
    }
    return token;
  }

  async verifyCode(authToken: string, code: string): Promise<string> {
    const wait = this.waitForOpcode(OPCODES.CHECK_CODE);
    this.send(OPCODES.CHECK_CODE, { token: authToken, verifyCode: code });
    const { dir, payload } = await wait;
    const token = findLongToken(payload);
    if (dir === DIR.ERR || !token) {
      throw new Error(describeAuthError(payload, 'CHECK_CODE did not return a login token — was the code correct?'));
    }
    return token;
  }

  async login(token: string, chatsCount = 50): Promise<{ sessionToken: string; payload: unknown }> {
    if (chatsCount > 50) {
      throw new Error('chatsCount must be <= 50 — the server returns an internal error above that (see ТЗ.md §2)');
    }
    const wait = this.waitForOpcode(OPCODES.LOGIN);
    this.send(OPCODES.LOGIN, { token, interactive: true, chatsCount });
    const { dir, payload } = await wait;
    const sessionToken = findLongToken(payload);
    if (dir === DIR.ERR || !sessionToken) {
      throw new Error(describeAuthError(payload, 'LOGIN did not return a session token — token may have expired'));
    }
    return { sessionToken, payload };
  }

  /**
   * Resolves once the server echoes the message back, with both the `cid` it
   * generated (for recognizing our own messages echoed as pushes) and the
   * real MAX-assigned `messageId` (needed to later edit/react to this message).
   *
   * `cid` must be packed as a genuine msgpack integer (BigInt forces msgpackr to emit
   * int64 rather than float64) — the server's decoder rejects a float64 there with a
   * "proto.payload / Expected number" validation error. Confirmed live against a real
   * account: plain `Date.now()` (packed as float64) was rejected, `BigInt(Date.now())`
   * (packed as int64, matching how real messages' cid arrives over the wire) was not.
   */
  /** `text: null` for attach-only sends (e.g. polls) — MAX accepts and expects null there, not an empty string. */
  async sendMessage(
    chatId: unknown,
    text: string | null,
    attaches: unknown[] = [],
  ): Promise<{ cid: number; messageId: unknown; attaches: unknown[] }> {
    const cid = Date.now();
    const wait = this.waitForOpcode(OPCODES.MSG_SEND);
    this.send(OPCODES.MSG_SEND, {
      chatId: toChatId(chatId),
      message: { text, cid: BigInt(cid), elements: [], attaches, link: null },
      notify: true,
    });
    const { dir, payload } = await wait;
    const responseMessage = (payload as { message?: { id?: unknown; attaches?: unknown[] } } | null)?.message;
    if (dir === DIR.ERR) throw new Error(describeAuthError(payload, 'MSG_SEND failed'));
    return { cid, messageId: responseMessage?.id, attaches: responseMessage?.attaches ?? [] };
  }

  /** `answerIds` — MAX's own assigned ids (from the poll's `answers[].answerId`), not Telegram option indexes. */
  async sendVote(chatId: unknown, messageId: unknown, pollId: unknown, answerIds: number[]): Promise<void> {
    const wait = this.waitForOpcode(OPCODES.SEND_VOTE);
    this.send(OPCODES.SEND_VOTE, { chatId: toChatId(chatId), messageId, pollId, answersIds: answerIds });
    const { dir, payload } = await wait;
    if (dir === DIR.ERR) throw new Error(describeAuthError(payload, 'SEND_VOTE failed'));
  }

  async getPollVoters(chatId: unknown, messageId: unknown, pollId: unknown, answerId: number): Promise<{ voters: unknown[]; voteCount: number }> {
    const wait = this.waitForOpcode(OPCODES.VOTERS_LIST_BY_ANSWER);
    this.send(OPCODES.VOTERS_LIST_BY_ANSWER, { chatId: toChatId(chatId), messageId, pollId, answerId });
    const { dir, payload } = await wait;
    if (dir === DIR.ERR) throw new Error(describeAuthError(payload, 'VOTERS_LIST_BY_ANSWER failed'));
    const p = payload as { voters?: unknown[]; voteCount?: number } | null;
    return { voters: p?.voters ?? [], voteCount: p?.voteCount ?? 0 };
  }

  /** `messageId` must be the genuine MAX integer id (BigInt) — see opcodes.ts for the type pitfall across these three calls. */
  async editMessage(chatId: unknown, messageId: unknown, text: string): Promise<void> {
    const wait = this.waitForOpcode(OPCODES.MSG_EDIT);
    this.send(OPCODES.MSG_EDIT, { chatId: toChatId(chatId), messageId, text, elements: [], attachments: [] });
    const { dir, payload } = await wait;
    if (dir === DIR.ERR) throw new Error(describeAuthError(payload, 'MSG_EDIT failed'));
  }

  /**
   * Contradicts the spec we were given (which said `messageId` should be a decimal
   * string for this call): a live 406-style validation error ("Expected number" at
   * the exact byte where the string value started) showed the server actually wants
   * the same integer encoding as MSG_EDIT/MSG_CANCEL_REACTION. Pass `messageId`
   * through as-is (already a BigInt from wherever it was captured) — do not stringify.
   */
  async addReaction(chatId: unknown, messageId: unknown, emoji: string): Promise<void> {
    const wait = this.waitForOpcode(OPCODES.MSG_REACTION);
    this.send(OPCODES.MSG_REACTION, { chatId: toChatId(chatId), messageId, reaction: { reactionType: 'EMOJI', id: emoji } });
    const { dir, payload } = await wait;
    if (dir === DIR.ERR) throw new Error(describeAuthError(payload, 'MSG_REACTION failed'));
  }

  async removeReaction(chatId: unknown, messageId: unknown): Promise<void> {
    const wait = this.waitForOpcode(OPCODES.MSG_CANCEL_REACTION);
    this.send(OPCODES.MSG_CANCEL_REACTION, { chatId: toChatId(chatId), messageId });
    const { dir, payload } = await wait;
    if (dir === DIR.ERR) throw new Error(describeAuthError(payload, 'MSG_CANCEL_REACTION failed'));
  }

  /**
   * Polling fallback for reaction removal — MAX sends no live push for it (see
   * bridge/sync.ts). Returns the current reaction counters, or `[]` once none remain.
   *
   * IMPORTANT: `messageIds` (plural, array) — sending the singular `messageId` we
   * first guessed doesn't just get rejected, it gets the whole TCP connection
   * dropped by the server (confirmed live: a validation error response was
   * immediately followed by full reconnect+re-login). Treat any unverified MAX
   * request the same way going forward — a malformed payload here isn't just an
   * error, it can cost the live session.
   */
  async getReactions(chatId: unknown, messageId: unknown): Promise<Array<{ reaction: string; count: number }>> {
    const wait = this.waitForOpcode(OPCODES.MSG_GET_REACTIONS);
    this.send(OPCODES.MSG_GET_REACTIONS, { chatId: toChatId(chatId), messageIds: [messageId] });
    const { dir, payload } = await wait;
    if (dir === DIR.ERR) throw new Error(describeAuthError(payload, 'MSG_GET_REACTIONS failed'));
    // Response shape unverified — try the single-message shape we already know from
    // MSG_REACTION, then a couple of plausible batch shapes, before giving up empty.
    const p = payload as
      | { reactionInfo?: { counters?: Array<{ reaction: string; count: number }> } }
      | { reactions?: Array<{ counters?: Array<{ reaction: string; count: number }> }> }
      | null;
    if (p && 'reactionInfo' in p && p.reactionInfo?.counters) return p.reactionInfo.counters;
    if (p && 'reactions' in p && p.reactions?.[0]?.counters) return p.reactions[0].counters as Array<{ reaction: string; count: number }>;
    return [];
  }

  /**
   * Contact profile details (name variants, country, phone, registration time) —
   * not present in LOGIN's contacts[]/CHATS_LIST's participants, needs its own
   * round trip per batch of ids. Payload shape supplied by the user from their
   * own reverse engineering (2026-08-09); response wrapper key unconfirmed, so
   * this tries the plausible ones rather than assuming `contacts`.
   */
  async getContactInfo(contactIds: unknown[]): Promise<MaxContactInfo[]> {
    const wait = this.waitForOpcode(OPCODES.CONTACT_INFO);
    this.send(OPCODES.CONTACT_INFO, { contactIds });
    const { dir, payload } = await wait;
    if (dir === DIR.ERR) throw new Error(describeAuthError(payload, 'CONTACT_INFO failed'));
    const p = payload as { contacts?: MaxContactInfo[]; profiles?: MaxContactInfo[] } | null;
    if (p && Array.isArray(p.contacts)) return p.contacts;
    if (p && Array.isArray(p.profiles)) return p.profiles;
    return [];
  }

  getChats(marker = 0): void {
    this.send(OPCODES.CHATS_LIST, { marker });
  }

  /**
   * One page of the account's full chat list (not the capped ≤50 LOGIN snapshot).
   * `marker` starts as "now" (ms) and each response's `marker` feeds the next call;
   * an empty `chats` array means the walk is done. Same overflow trap as every
   * other ms-timestamp field here — must go over the wire as BigInt. Payload
   * shape supplied by the user from their own reverse engineering (2026-08-09).
   */
  async getChatsList(marker: number): Promise<{ chats: unknown[]; marker: number | null }> {
    const wait = this.waitForOpcode(OPCODES.CHATS_LIST);
    this.send(OPCODES.CHATS_LIST, { marker: BigInt(marker) });
    const { dir, payload } = await wait;
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
      // Either nothing new came back, or the marker stopped moving forward —
      // both mean we've reached the end (same guard as fetchFullHistory).
      if (!addedAny || page.marker == null || !(page.marker < marker)) break;
      marker = page.marker;
    }
    return all;
  }

  /**
   * Creates a group or channel — the one MSG_SEND call in this client with no
   * `chatId` (there isn't one yet). Payload shape supplied by the user from their
   * own reverse engineering (2026-08-10): `event: 'new'` (lowercase), `userIds`
   * invites members immediately.
   */
  async createGroup(title: string, userIds: number[] = [], chatType: 'CHAT' | 'CHANNEL' = 'CHAT'): Promise<{ chatId: unknown; owner: unknown }> {
    const wait = this.waitForOpcode(OPCODES.MSG_SEND);
    this.send(OPCODES.MSG_SEND, {
      message: {
        cid: BigInt(Date.now()),
        attaches: [{ _type: 'CONTROL', event: 'new', chatType, title, userIds }],
      },
      notify: true,
    });
    const { dir, payload } = await wait;
    if (dir === DIR.ERR) throw new Error(describeAuthError(payload, 'Group creation failed'));
    const chat = (payload as { chat?: { id?: unknown; owner?: unknown } } | null)?.chat;
    if (chat?.id == null) throw new Error('Group creation did not return a chat id');
    return { chatId: chat.id, owner: chat.owner };
  }

  /** `operation: 'add' | 'remove'`. */
  async updateChatMembers(chatId: unknown, userIds: number[], operation: 'add' | 'remove', showHistory = true): Promise<void> {
    const wait = this.waitForOpcode(OPCODES.CHAT_MEMBERS);
    this.send(OPCODES.CHAT_MEMBERS, { chatId: toChatId(chatId), userIds, showHistory, operation });
    const { dir, payload } = await wait;
    if (dir === DIR.ERR) throw new Error(describeAuthError(payload, 'CHAT_MEMBERS failed'));
  }

  /** `avatarId` is accepted by the wire format but silently ignored server-side — user-confirmed, so not exposed here. */
  async updateChatInfo(chatId: unknown, fields: { title?: string; description?: string }): Promise<void> {
    const wait = this.waitForOpcode(OPCODES.CHAT_SET_INFO);
    this.send(OPCODES.CHAT_SET_INFO, { chatId: toChatId(chatId), ...fields });
    const { dir, payload } = await wait;
    if (dir === DIR.ERR) throw new Error(describeAuthError(payload, 'CHAT_SET_INFO failed'));
  }

  async leaveChat(chatId: unknown): Promise<void> {
    const wait = this.waitForOpcode(OPCODES.CHAT_LEAVE);
    this.send(OPCODES.CHAT_LEAVE, { chatId: toChatId(chatId) });
    const { dir, payload } = await wait;
    if (dir === DIR.ERR) throw new Error(describeAuthError(payload, 'CHAT_LEAVE failed'));
  }

  /** `forAll: true` deletes for every participant — irreversible for them too, not just us. */
  async deleteChat(chatId: unknown, lastEventTime: number, forAll: boolean): Promise<void> {
    const wait = this.waitForOpcode(OPCODES.CHAT_DELETE);
    this.send(OPCODES.CHAT_DELETE, { chatId: toChatId(chatId), lastEventTime: BigInt(lastEventTime), forAll });
    const { dir, payload } = await wait;
    if (dir === DIR.ERR) throw new Error(describeAuthError(payload, 'CHAT_DELETE failed'));
  }

  /** `forMe: true` deletes only from our own view; `false` deletes for everyone. */
  async deleteMessages(chatId: unknown, messageIds: unknown[], forMe: boolean): Promise<void> {
    const wait = this.waitForOpcode(OPCODES.MSG_DELETE);
    this.send(OPCODES.MSG_DELETE, { chatId: toChatId(chatId), messageIds, forMe });
    const { dir, payload } = await wait;
    if (dir === DIR.ERR) throw new Error(describeAuthError(payload, 'MSG_DELETE failed'));
  }

  /**
   * One page of chat history, newest-first from `from` (ms timestamp, exclusive
   * upper bound). Payload shape supplied by the user from their own reverse
   * engineering (2026-08-08) — same CamelModel convention as every other opcode
   * here, message objects match PUSH_MESSAGE's shape exactly.
   */
  async getChatHistory(chatId: unknown, from: number, backward = 100): Promise<MaxHistoryMessage[]> {
    const wait = this.waitForOpcode(OPCODES.CHAT_HISTORY);
    this.send(OPCODES.CHAT_HISTORY, {
      chatId: toChatId(chatId),
      // `from` is a ms timestamp (~1.7e12) — same overflow trap as cid/messageId/chatId:
      // a plain number that size packs as float64 and the server rejects it outright.
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
    const { dir, payload } = await wait;
    if (dir === DIR.ERR) throw new Error(describeAuthError(payload, 'CHAT_HISTORY failed'));
    const messages = (payload as { messages?: MaxHistoryMessage[] } | null)?.messages;
    return Array.isArray(messages) ? messages : [];
  }

  /** Requests an upload slot for a single photo. Response shape supplied by the user, not in max-protocol-full.md. */
  async requestPhotoUpload(): Promise<{ url: string; photoIds: unknown[] }> {
    const wait = this.waitForOpcode(OPCODES.PHOTO_UPLOAD);
    this.send(OPCODES.PHOTO_UPLOAD, { count: 1 });
    const { dir, payload } = await wait;
    const result = payload as { url?: string; photoIds?: unknown[] } | null;
    if (dir === DIR.ERR || !result?.url) {
      throw new Error(describeAuthError(payload, 'PHOTO_UPLOAD did not return an upload url'));
    }
    return { url: result.url, photoIds: result.photoIds ?? [] };
  }

  /** Requests an upload slot for a single video. */
  async requestVideoUpload(): Promise<{ url: string; videoId: unknown; token: string }> {
    const wait = this.waitForOpcode(OPCODES.VIDEO_UPLOAD);
    this.send(OPCODES.VIDEO_UPLOAD, { count: 1, type: 0, uploaderType: 0, profile: false });
    const { dir, payload } = await wait;
    const slot = (payload as { info?: Array<{ url: string; videoId: unknown; token: string }> } | null)?.info?.[0];
    if (dir === DIR.ERR || !slot) {
      throw new Error(describeAuthError(payload, 'VIDEO_UPLOAD did not return an upload slot'));
    }
    return slot;
  }

  /**
   * Voice notes go through the SAME upload opcode as video (0x52) — `type: 2` is what
   * marks it as audio instead of an actual video (`type: 0`). Confirmed live by the
   * user 2026-08-13; this was the whole reason voice uploads never fired VOICE_READY
   * before — FILE_UPLOAD (0x57) simply isn't the right opcode for it at all.
   */
  async requestVoiceUploadSlot(): Promise<{ url: string; videoId: unknown; token: string }> {
    const wait = this.waitForOpcode(OPCODES.VIDEO_UPLOAD);
    this.send(OPCODES.VIDEO_UPLOAD, { count: 1, type: 2, uploaderType: 0, profile: false });
    const { dir, payload } = await wait;
    const slot = (payload as { info?: Array<{ url: string; videoId: unknown; token: string }> } | null)?.info?.[0];
    if (dir === DIR.ERR || !slot) {
      throw new Error(describeAuthError(payload, 'VIDEO_UPLOAD (voice) did not return an upload slot'));
    }
    return slot;
  }

  /**
   * Waits for the server-side "video is ready" signal. Confirmed live 2026-08-07:
   * arrives as an EVENTS push (opcode 0x88), payload `{videoId: "..."}` at the
   * top level — NOT PUSH_MESSAGE (0x80) as max_send_attach.py's own comments
   * suggested (its check didn't actually pin the opcode, just dir+payload shape).
   */
  waitForVideoReady(timeoutMs = 15_000): Promise<void> {
    return new Promise((resolve, reject) => {
      const cleanup = () => {
        clearTimeout(timer);
        this.off('message', onMessage);
      };
      const onMessage = (event: MaxMessageEvent) => {
        if (event.opcode !== OPCODES.EVENTS) return;
        const payload = event.payload as { videoId?: unknown } | null;
        if (payload && payload.videoId != null) {
          cleanup();
          resolve();
        }
      };
      const timer = setTimeout(() => {
        cleanup();
        reject(new Error('Timed out waiting for the video-ready push'));
      }, timeoutMs);
      this.on('message', onMessage);
    });
  }

  /**
   * Waits for the server-side "voice note is ready" signal — same EVENTS push (0x88) as
   * video-ready, just keyed on `audioId` instead. Confirmed live by the user 2026-08-13:
   * without this, MSG_SEND with the resulting audioId sometimes fails validation because
   * the file isn't actually processed yet — a fixed sleep isn't a reliable substitute.
   */
  waitForAudioReady(timeoutMs = 15_000): Promise<void> {
    return new Promise((resolve, reject) => {
      const cleanup = () => {
        clearTimeout(timer);
        this.off('message', onMessage);
      };
      const onMessage = (event: MaxMessageEvent) => {
        if (event.opcode !== OPCODES.EVENTS) return;
        const payload = event.payload as { audioId?: unknown } | null;
        if (payload && payload.audioId != null) {
          cleanup();
          resolve();
        }
      };
      const timer = setTimeout(() => {
        cleanup();
        reject(new Error('Timed out waiting for the audio-ready push'));
      }, timeoutMs);
      this.on('message', onMessage);
    });
  }

  /** Requests an upload slot for a single file (also used for GIFs — MAX only accepts those as FILE). */
  async requestFileUpload(): Promise<{ url: string; fileId: unknown; token: string }> {
    const wait = this.waitForOpcode(OPCODES.FILE_UPLOAD);
    this.send(OPCODES.FILE_UPLOAD, { count: 1, type: 0, uploaderType: 0, profile: false });
    const { dir, payload } = await wait;
    const slot = (payload as { info?: Array<{ url: string; fileId: unknown; token: string }> } | null)?.info?.[0];
    if (dir === DIR.ERR || !slot) {
      throw new Error(describeAuthError(payload, 'FILE_UPLOAD did not return an upload slot'));
    }
    return slot;
  }

  /** Exchanges a FILE attachment's opaque token for a short-lived signed download URL. */
  async getFileDownloadUrl(chatId: unknown, messageId: unknown, fileId: unknown): Promise<string> {
    const wait = this.waitForOpcode(OPCODES.FILE_DOWNLOAD);
    this.send(OPCODES.FILE_DOWNLOAD, { chatId: toChatId(chatId), messageId, fileId });
    const { dir, payload } = await wait;
    const url = (payload as { url?: string } | null)?.url;
    if (dir === DIR.ERR || !url) {
      throw new Error(describeAuthError(payload, 'FILE_DOWNLOAD did not return a url'));
    }
    return url;
  }

  /**
   * VIDEO has its own opcode and id namespace, separate from FILE — FILE_DOWNLOAD
   * rejects a videoId with "file not found". Returns quality-keyed URLs (e.g.
   * MP4_240) plus an EXTERNAL link; callers pick whichever MP4_* they want.
   */
  async getVideoPlayUrls(chatId: unknown, messageId: unknown, videoId: unknown): Promise<Record<string, string>> {
    const wait = this.waitForOpcode(OPCODES.VIDEO_PLAY);
    this.send(OPCODES.VIDEO_PLAY, { chatId: toChatId(chatId), messageId, videoId });
    const { dir, payload } = await wait;
    const urls = payload as Record<string, string> | null;
    if (dir === DIR.ERR || !urls) {
      throw new Error(describeAuthError(payload, 'VIDEO_PLAY did not return any playback urls'));
    }
    return urls;
  }
}
