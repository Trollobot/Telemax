import { describe, expect, it, vi } from 'vitest';
import { MaxClient, MaxConnectionLostError, MaxServerError, isMaxServerError, reconnectAttemptFor } from '../src/max/client.js';
import { OPCODES, DIR } from '../src/max/opcodes.js';
import { encodeFrame } from '../src/max/frame.js';

/** Answers every send() with one frame of the given direction and payload — or with a client 'error'. */
class ScriptedClient extends MaxClient {
  constructor(private readonly answer: { dir: number; payload: unknown } | Error) {
    super({ reconnect: false });
  }

  override send(opcode: number): void {
    queueMicrotask(() => {
      if (this.answer instanceof Error) {
        // What the socket 'error' handler does: fail every wait, then report.
        (this as unknown as { failPending(err: Error): void }).failPending(this.answer);
        this.emit('error', this.answer);
        return;
      }
      this.emit('message', { dir: this.answer.dir, seq: 1, opcode, payload: this.answer.payload, length: 0 });
    });
  }
}

describe('MaxClient.login failure kinds (review 2026-09-26, RECOVERY4)', () => {
  it('an ERR answer is a MaxServerError carrying the opcode and the server code', async () => {
    const client = new ScriptedClient({ dir: DIR.ERR, payload: { error: 'login.token', localizedMessage: 'Сессия устарела' } });
    const err = await client.login('t').catch((e: unknown) => e);
    expect(err).toBeInstanceOf(MaxServerError);
    expect(isMaxServerError(err, OPCODES.LOGIN)).toBe(true);
    expect((err as MaxServerError).serverCode).toBe('login.token');
    expect((err as Error).message).toContain('Сессия устарела');
  });

  it('a socket error while waiting is NOT a server rejection', async () => {
    const client = new ScriptedClient(Object.assign(new Error('read ECONNRESET'), { code: 'ECONNRESET' }));
    client.on('error', () => {});
    const err = await client.login('t').catch((e: unknown) => e);
    expect(err).toBeInstanceOf(MaxConnectionLostError);
    expect((err as Error).message).toContain('ECONNRESET');
    expect(isMaxServerError(err)).toBe(false);
  });

  it('isMaxServerError filters by opcode', () => {
    const err = new MaxServerError('x', OPCODES.LOGIN);
    expect(isMaxServerError(err, OPCODES.LOGIN)).toBe(true);
    expect(isMaxServerError(err, OPCODES.PING)).toBe(false);
    expect(isMaxServerError(new Error('x'))).toBe(false);
  });

  it('an OK answer without a token logs in with the presented token', async () => {
    const client = new ScriptedClient({ dir: DIR.OK, payload: { profile: {}, chats: [] } });
    await expect(client.login('presented')).resolves.toMatchObject({ sessionToken: 'presented' });
  });
});

describe('half-open detection (review 2026-09-26, M1)', () => {
  type Internals = { socket: unknown; buffer: Buffer; ping(): void; drainBuffer(): void };

  function withFakeSocket(): { client: MaxClient; internals: Internals; destroy: ReturnType<typeof vi.fn>; sent: number[] } {
    const sent: number[] = [];
    const client = new (class extends MaxClient {
      override send(opcode: number): void {
        sent.push(opcode);
      }
    })({ reconnect: false });
    const destroy = vi.fn();
    const internals = client as unknown as Internals;
    internals.socket = { destroy };
    return { client, internals, destroy, sent };
  }

  it('an answered PING keeps the socket', () => {
    const { internals, destroy, sent } = withFakeSocket();
    internals.ping();
    internals.buffer = encodeFrame(1, OPCODES.PING, Buffer.alloc(0));
    internals.drainBuffer();
    internals.ping();
    expect(destroy).not.toHaveBeenCalled();
    expect(sent).toEqual([OPCODES.PING, OPCODES.PING]);
  });

  it('a PING still unanswered at the next tick destroys the socket instead of sending another', () => {
    const { internals, destroy, sent } = withFakeSocket();
    internals.ping();
    internals.ping();
    expect(destroy).toHaveBeenCalledTimes(1);
    const err = destroy.mock.calls[0]?.[0] as Error & { code?: string };
    expect(err.message).toMatch(/did not answer PING/);
    expect(err.code).toBe('ETIMEDOUT');
    expect(sent).toEqual([OPCODES.PING]);
  });
});

describe('reconnectAttemptFor (review 2026-09-26, M4)', () => {
  const now = 1_000_000;

  it('keeps counting while connections never pass INIT', () => {
    expect(reconnectAttemptFor(3, null, now)).toBe(3);
  });

  it('keeps counting when the connection dropped soon after INIT', () => {
    expect(reconnectAttemptFor(3, now - 5_000, now)).toBe(3);
  });

  it('starts over after a stable connection', () => {
    expect(reconnectAttemptFor(4, now - 30_000, now)).toBe(0);
    expect(reconnectAttemptFor(4, now - 3_600_000, now)).toBe(0);
  });
});

describe('TLS handshake deadline (review 2026-09-26, client-r1#1)', () => {
  it('destroys a socket whose handshake stalls, and lifts the deadline once TLS is up', async () => {
    const tls = (await import('node:tls')).default;
    const { EventEmitter } = await import('node:events');
    let onSecure: (() => void) | undefined;
    const fake = Object.assign(new EventEmitter(), {
      setTimeout: vi.fn(),
      setKeepAlive: vi.fn(),
      destroy: vi.fn(),
      write: vi.fn(),
    });
    const spy = vi.spyOn(tls, 'connect').mockImplementation(((...args: unknown[]) => {
      onSecure = args.find((a) => typeof a === 'function') as () => void;
      return fake;
    }) as unknown as typeof tls.connect);
    try {
      const client = new MaxClient({ reconnect: false });
      client.on('error', () => {});
      client.connect();
      const [ms, onTimeout] = fake.setTimeout.mock.calls[0] as [number, () => void];
      expect(ms).toBe(15_000);
      onTimeout();
      const err = fake.destroy.mock.calls[0]?.[0] as Error & { code?: string };
      expect(err.message).toMatch(/handshake timed out/);
      expect(err.code).toBe('ETIMEDOUT');
      // A handshake that does complete clears the deadline (PING takes over).
      onSecure?.();
      expect(fake.setTimeout).toHaveBeenLastCalledWith(0);
      client.disconnect();
    } finally {
      spy.mockRestore();
    }
  });
});
