import tls from 'node:tls';
import { EventEmitter } from 'node:events';
import { pack } from 'msgpackr';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { MaxClient, MaxConnectionLostError, isUploadReadyPush } from '../src/max/client.js';
import { OPCODES, DIR } from '../src/max/opcodes.js';
import { encodeFrame } from '../src/max/frame.js';
import { isTransientMaxError } from '../src/bridge/transient.js';

/**
 * Fakes the socket layer: every send() gets a distinct async response for its
 * own opcode, mimicking a server that answers strictly one response per request.
 */
class FakeMaxClient extends MaxClient {
  readonly sentPayloads: unknown[] = [];
  private responseCounter = 0;

  override send(opcode: number, payload?: unknown): void {
    this.sentPayloads.push(payload);
    const n = ++this.responseCounter;
    queueMicrotask(() => {
      this.emit('message', {
        dir: 1,
        seq: n,
        opcode,
        payload: { message: { id: BigInt(n * 100), attaches: [] } },
        length: 0,
      });
    });
  }
}

describe('MaxClient request serialization', () => {
  it('concurrent same-opcode requests each get their own response, in send order', async () => {
    const client = new FakeMaxClient();

    // Two concurrent MSG_SENDs — exactly what Telegraf produces for two quick
    // Telegram messages (it handles a poll batch's updates concurrently).
    // Before serialization both promises resolved on the FIRST response frame,
    // cross-wiring the messageId links that edit/delete depend on.
    const [first, second] = await Promise.all([client.sendMessage(1, 'первое'), client.sendMessage(1, 'второе')]);

    expect(first.messageId).toBe(100n);
    expect(second.messageId).toBe(200n);

    const texts = client.sentPayloads.map((p) => (p as { message: { text: string } }).message.text);
    expect(texts).toEqual(['первое', 'второе']);
  });

  it('a failed request does not wedge the queue for the next one', async () => {
    const client = new FakeMaxClient();
    // First call throws at send time (e.g. socket gone) — the chain must survive.
    const realSend = FakeMaxClient.prototype.send;
    let calls = 0;
    client.send = (opcode: number, payload?: unknown): void => {
      calls += 1;
      if (calls === 1) throw new Error('not connected');
      realSend.call(client, opcode, payload);
    };

    await expect(client.sendMessage(1, 'сломается')).rejects.toThrow('not connected');
    const ok = await client.sendMessage(1, 'пройдёт');
    expect(ok.messageId).toBe(100n);
  });
});

// --- review 2026-09-26: one dispatcher for every wait (M3, M10), no-socket requests (M2),
// upload-ready waits keyed on their id (OUTBOUND9) and cut off by a lost socket (M13), the
// desync path (C18) and teardown (M11).

/** A stand-in for the TLS socket connect() creates: records writes, emits what a test tells it to. */
class FakeSocket extends EventEmitter {
  readonly write = vi.fn();
  readonly setKeepAlive = vi.fn();
  readonly setTimeout = vi.fn();
  readonly destroy = vi.fn();
}

type Internals = { pending: Map<number, Set<unknown>> };

function pendingCount(client: MaxClient): number {
  let n = 0;
  for (const set of (client as unknown as Internals).pending.values()) n += set.size;
  return n;
}

/** A real MaxClient whose connect() gets a FakeSocket instead of a TLS connection (logged in unless told not to). */
function connectedClient(loggedIn = true): { client: MaxClient; socket: FakeSocket } {
  const socket = new FakeSocket();
  vi.spyOn(tls, 'connect').mockReturnValueOnce(socket as unknown as tls.TLSSocket);
  const client = new MaxClient({ reconnect: false });
  client.connect();
  if (loggedIn) socket.emit('data', serverFrame(OPCODES.LOGIN, {}));
  return { client, socket };
}

/** A frame as the server sends it (DIR.OK, msgpack payload, the given compression flag). */
function serverFrame(opcode: number, payload: unknown, flags = 0): Buffer {
  const frame = encodeFrame(1, opcode, Buffer.from(pack(payload)));
  frame.writeUInt8(DIR.OK, 1);
  frame.writeUInt8(flags, 6);
  return frame;
}

const tick = (): Promise<void> => new Promise((resolve) => setImmediate(resolve));

describe('MaxClient pending waits', () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.useRealTimers();
  });

  it('without a socket a request rejects at once and leaves no listener or timer behind', async () => {
    vi.useFakeTimers();
    const client = new MaxClient({ reconnect: false });
    const messageListeners = client.listenerCount('message');
    const errorListeners = client.listenerCount('error');
    for (let i = 0; i < 12; i += 1) {
      await expect(client.sendMessage(1, `пауза ${i}`)).rejects.toThrow('MaxClient.send called while not connected');
    }
    expect(client.listenerCount('message')).toBe(messageListeners);
    expect(client.listenerCount('error')).toBe(errorListeners);
    expect(pendingCount(client)).toBe(0);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('before LOGIN OK only auth requests go out; the rest fail as transient', async () => {
    const { client, socket } = connectedClient(false);
    const err = await client.getFileDownloadUrl(1, 2, 3).catch((e: unknown) => e);
    expect(isTransientMaxError(err)).toBe(true);
    expect(socket.write).not.toHaveBeenCalled();
    void client.requestSms('+79999999999').catch(() => {});
    await tick();
    expect(socket.write).toHaveBeenCalledTimes(1);
    client.disconnect();
  });

  it('requests in flight add no listeners — one dispatcher serves them all', async () => {
    const { client } = connectedClient();
    const before = client.listenerCount('message');
    const waits = [client.sendMessage(1, 'a'), client.getFileDownloadUrl(1, 2, 3), client.getVideoPlayUrls(1, 2, 3)];
    waits.forEach((w) => w.catch(() => {}));
    await tick();
    expect(pendingCount(client)).toBe(3);
    expect(client.listenerCount('message')).toBe(before);
    expect(client.listenerCount('error')).toBe(0);
    client.disconnect();
  });

  it('an undecodable frame is only reported — the request in flight still gets its answer', async () => {
    const { client, socket } = connectedClient();
    const decodeErrors: Error[] = [];
    client.on('decode-error', (err: Error) => decodeErrors.push(err));
    let settled = false;
    const sent = client.sendMessage(1, 'текст').finally(() => {
      settled = true;
    });
    await tick();

    // A push of an unrelated opcode with an unknown compression flag: cannot be decoded.
    socket.emit('data', serverFrame(OPCODES.PUSH_MESSAGE, { x: 1 }, 0x80));
    await tick();
    expect(decodeErrors).toHaveLength(1);
    expect(decodeErrors[0]?.message).toMatch(/Failed to decode payload/);
    expect(settled).toBe(false);

    socket.emit('data', serverFrame(OPCODES.MSG_SEND, { message: { id: 777, attaches: [] } }));
    await expect(sent).resolves.toMatchObject({ messageId: 777 });
    client.disconnect();
  });

  it('a socket close fails every request in flight at once, as a transient connection loss', async () => {
    const { client, socket } = connectedClient();
    const disconnected = vi.fn();
    client.on('disconnected', disconnected);
    const a = client.sendMessage(1, 'a').catch((e: unknown) => e);
    const b = client.getFileDownloadUrl(1, 2, 3).catch((e: unknown) => e);
    await tick();
    expect(pendingCount(client)).toBe(2);

    socket.emit('close');
    const [errA, errB] = await Promise.all([a, b]);
    expect(errA).toBeInstanceOf(MaxConnectionLostError);
    expect(errB).toBeInstanceOf(MaxConnectionLostError);
    expect((errA as Error).message).toMatch(/connection lost while waiting for .*MSG_SEND.*: socket closed/);
    expect(isTransientMaxError(errA)).toBe(true);
    expect(disconnected).toHaveBeenCalledTimes(1);
    expect(pendingCount(client)).toBe(0);
    // The closed socket is gone: the next send fails at once instead of timing out.
    await expect(client.sendMessage(1, 'c')).rejects.toThrow('not connected');
  });

  it('a socket error fails the requests in flight and is still reported', async () => {
    const { client, socket } = connectedClient();
    const errors: Error[] = [];
    client.on('error', (err: Error) => errors.push(err));
    const a = client.sendMessage(1, 'a').catch((e: unknown) => e);
    await tick();
    socket.emit('error', Object.assign(new Error('read ECONNRESET'), { code: 'ECONNRESET' }));
    const err = await a;
    expect(err).toBeInstanceOf(MaxConnectionLostError);
    expect((err as Error).cause).toMatchObject({ code: 'ECONNRESET' });
    expect(errors).toHaveLength(1);
    client.disconnect();
  });

  it('disconnect() (a pause) fails the requests in flight at once', async () => {
    const { client } = connectedClient();
    const a = client.sendMessage(1, 'a').catch((e: unknown) => e);
    await tick();
    client.disconnect();
    expect(await a).toBeInstanceOf(MaxConnectionLostError);
    expect(pendingCount(client)).toBe(0);
    expect(client.stoppedByUser).toBe(true);
  });

  it('a desynced frame header emits disconnected, fails the waits and tears the socket down safely', async () => {
    const { client, socket } = connectedClient();
    const disconnected = vi.fn();
    client.on('disconnected', disconnected);
    client.on('error', () => {});
    const a = client.sendMessage(1, 'a').catch((e: unknown) => e);
    await tick();

    socket.emit('data', Buffer.alloc(32, 0xee)); // first byte is not PROTOCOL_VERSION
    expect(disconnected).toHaveBeenCalledTimes(1);
    expect(await a).toBeInstanceOf(MaxConnectionLostError);
    expect(socket.destroy).toHaveBeenCalledTimes(1);
    // Only the no-op 'error' guard is left: a late socket error is swallowed, not thrown.
    expect(socket.listenerCount('data')).toBe(0);
    expect(socket.listenerCount('error')).toBe(1);
    expect(() => socket.emit('error', new Error('late'))).not.toThrow();
  });

  it('an upload-ready wait resolves only on the push for its own id', async () => {
    const { client } = connectedClient();
    const done: string[] = [];
    const first = client.waitForVideoReady('111').then(() => done.push('first'));
    const second = client.waitForVideoReady(222n).then(() => done.push('second'));
    const voice = client.waitForAudioReady(333).then(() => done.push('voice'));

    client.emit('message', { dir: 0, seq: 1, opcode: OPCODES.EVENTS, payload: { videoId: 222 }, length: 0 });
    await tick();
    expect(done).toEqual(['second']);

    // A video push carrying the voice's id counts for neither; then the right pushes arrive.
    client.emit('message', { dir: 0, seq: 2, opcode: OPCODES.EVENTS, payload: { videoId: 333 }, length: 0 });
    await tick();
    expect(done).toEqual(['second']);
    client.emit('message', { dir: 0, seq: 3, opcode: OPCODES.EVENTS, payload: { audioId: '333' }, length: 0 });
    await tick();
    client.emit('message', { dir: 0, seq: 4, opcode: OPCODES.EVENTS, payload: { videoId: BigInt(111) }, length: 0 });
    await Promise.all([first, second, voice]);
    expect(done).toEqual(['second', 'voice', 'first']);
    expect(pendingCount(client)).toBe(0);
    client.disconnect();
  });

  it('an upload-ready wait fails at once when the connection drops, and without a socket', async () => {
    const { client, socket } = connectedClient();
    const wait = client.waitForVideoReady('111').catch((e: unknown) => e);
    socket.emit('close');
    const err = await wait;
    expect(err).toBeInstanceOf(MaxConnectionLostError);
    expect((err as Error).message).toMatch(/video-ready push for 111/);

    await expect(new MaxClient({ reconnect: false }).waitForAudioReady('1')).rejects.toBeInstanceOf(MaxConnectionLostError);
  });
});

describe('isUploadReadyPush', () => {
  it('matches the id across number, BigInt and string', () => {
    expect(isUploadReadyPush({ videoId: 5n }, 'videoId', '5')).toBe(true);
    expect(isUploadReadyPush({ audioId: '5' }, 'audioId', 5)).toBe(true);
  });

  it('ignores other ids, the other key and junk', () => {
    expect(isUploadReadyPush({ videoId: 6 }, 'videoId', 5)).toBe(false);
    expect(isUploadReadyPush({ videoId: 5 }, 'audioId', 5)).toBe(false);
    expect(isUploadReadyPush(null, 'videoId', 5)).toBe(false);
    expect(isUploadReadyPush({ videoId: 5 }, 'videoId', undefined)).toBe(false);
    expect(isUploadReadyPush({}, 'videoId', 5)).toBe(false);
  });
});
