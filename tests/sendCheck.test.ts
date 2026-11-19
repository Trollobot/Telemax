import { describe, expect, it, vi } from 'vitest';
import { MaxClient, MaxSendUnconfirmedError, lookForSent, type MaxHistoryMessage } from '../src/max/client.js';
import { OPCODES, DIR } from '../src/max/opcodes.js';
import { encodeFrame } from '../src/max/frame.js';
import { sendFailureText } from '../src/bridge/sync.js';

describe('lookForSent', () => {
  const msg = (time: number, cid?: number): MaxHistoryMessage => ({ id: `m${time}`, time, cid });

  it('finds our message by cid on the first page', async () => {
    const pages = vi.fn(async () => [msg(300, 77), msg(290), msg(280)]);
    await expect(lookForSent(pages, 77, 100, 1000)).resolves.toEqual({ found: msg(300, 77) });
    expect(pages).toHaveBeenCalledTimes(1);
  });

  it('pages back from the oldest seen, a few at a time', async () => {
    const pages = vi.fn(async (from: number) => (from === 1000 ? [msg(500), msg(490), msg(480)] : [msg(470), msg(460, 77), msg(450)]));
    await expect(lookForSent(pages, 77, 100, 1000)).resolves.toMatchObject({ found: { cid: 77 } });
    expect(pages.mock.calls.map((c) => c[0])).toEqual([1000, 480]);
  });

  it('is absent once history goes past the last message known from before the send', async () => {
    const pages = vi.fn(async () => [msg(300), msg(200), msg(100)]);
    await expect(lookForSent(pages, 77, 200, 1000)).resolves.toBe('absent');
    expect(pages).toHaveBeenCalledTimes(1);
  });

  it('is absent when the chat runs out', async () => {
    await expect(lookForSent(async () => [], 77, 0, 1000)).resolves.toBe('absent');
  });

  it('cannot tell when the pages run out first (a busy chat)', async () => {
    let t = 10_000;
    const pages = async () => [msg((t -= 10)), msg((t -= 10)), msg((t -= 10))];
    await expect(lookForSent(pages, 77, 0, 20_000, 5)).resolves.toBe('unknown');
  });

  it('matches a cid that arrives as a BigInt', async () => {
    const page = [{ id: 1, time: 300, cid: BigInt(77) as unknown as number }];
    await expect(lookForSent(async () => page, 77, 100, 1000)).resolves.toMatchObject({ found: { id: 1 } });
  });
});

type Answer = { dir: number; payload: unknown } | Error;

/** A logged-in client whose sends are answered by `script` (PING always answers). */
class ScriptedClient extends MaxClient {
  readonly sent: Array<{ opcode: number; payload: unknown }> = [];
  constructor(private readonly script: (opcode: number, payload: unknown, sent: ScriptedClient['sent']) => Answer) {
    super({ reconnect: true }); // never connect()ed: the fake socket below stands in
    const internals = this as unknown as { socket: unknown; authed: boolean };
    internals.socket = { destroy() {}, write() {} };
    internals.authed = true;
  }

  override send(opcode: number, payload?: unknown): void {
    this.sent.push({ opcode, payload });
    queueMicrotask(() => {
      if (opcode === OPCODES.PING) {
        this.emit('pong');
        return;
      }
      const answer = this.script(opcode, payload, this.sent);
      if (answer instanceof Error) {
        (this as unknown as { failPending(err: Error): void }).failPending(answer);
        return;
      }
      this.emit('message', { dir: answer.dir, seq: 1, opcode, payload: answer.payload, length: 0 });
    });
  }
}

const sends = (c: ScriptedClient) => c.sent.filter((s) => s.opcode === OPCODES.MSG_SEND);
const cidOf = (s: { payload: unknown }) => Number((s.payload as { message: { cid: bigint } }).message.cid);
const lost = () => Object.assign(new Error('read ETIMEDOUT'), { code: 'ETIMEDOUT' });

describe('sendMessage — an unanswered send', () => {
  it('found in the history: taken as sent, not sent again', async () => {
    let n = 0;
    const client = new ScriptedClient((opcode, _p, sent) => {
      if (opcode === OPCODES.MSG_SEND) return n++ === 0 ? lost() : { dir: DIR.OK, payload: {} };
      const cid = cidOf(sends(client)[0]!);
      return { dir: DIR.OK, payload: { messages: [{ id: 'theirs', time: Date.now() + 1, cid: 1 }, { id: 'ours', time: Date.now(), cid }] } };
    });
    const res = await client.sendMessage(5, 'привет');
    expect(res.messageId).toBe('ours');
    expect(sends(client)).toHaveLength(1);
    expect(client.sent.some((s) => s.opcode === OPCODES.CHAT_HISTORY)).toBe(true);
  });

  it('not in the history: sent once more, with the same cid', async () => {
    let n = 0;
    const client = new ScriptedClient((opcode) => {
      if (opcode === OPCODES.MSG_SEND) return n++ === 0 ? lost() : { dir: DIR.OK, payload: { message: { id: 'again', time: 1 } } };
      // Older than the boundary (no message of this chat seen: the send's moment less the clock slack).
      return { dir: DIR.OK, payload: { messages: [{ id: 'old', time: Date.now() - 10 * 60_000, cid: 1 }] } };
    });
    const res = await client.sendMessage(5, 'привет');
    expect(res.messageId).toBe('again');
    const [first, second] = sends(client);
    expect(sends(client)).toHaveLength(2);
    expect(cidOf(second!)).toBe(cidOf(first!));
    expect(res.cid).toBe(cidOf(first!));
  });

  it('history that cannot be read: unconfirmed, not sent again', async () => {
    const client = new ScriptedClient((opcode) => (opcode === OPCODES.MSG_SEND ? lost() : { dir: DIR.ERR, payload: { error: 'x' } }));
    const err = await client.sendMessage(5, 'привет').catch((e: unknown) => e);
    expect(err).toBeInstanceOf(MaxSendUnconfirmedError);
    expect(sends(client)).toHaveLength(1);
    expect(sendFailureText(err)).toMatch(/посмотрите в MAX, прежде чем отправлять ещё раз/);
  });

  it('a refusal is not an unanswered send — no history check', async () => {
    const client = new ScriptedClient(() => ({ dir: DIR.ERR, payload: { error: 'chat.denied', localizedMessage: 'Нельзя' } }));
    await expect(client.sendMessage(5, 'привет')).rejects.toThrow(/Нельзя/);
    expect(client.sent.some((s) => s.opcode === OPCODES.CHAT_HISTORY)).toBe(false);
  });

  it('the chat’s newest known message bounds the history walk', async () => {
    let n = 0;
    const client = new ScriptedClient((opcode) => {
      if (opcode === OPCODES.MSG_SEND) return n++ === 0 ? lost() : { dir: DIR.OK, payload: {} };
      return { dir: DIR.OK, payload: { messages: [{ id: 'a', time: 5_000 }, { id: 'b', time: 4_000 }, { id: 'c', time: 3_000 }] } };
    });
    // A push of this chat seen before the send: its last message is at 4 500.
    const internals = client as unknown as { buffer: Buffer; drainBuffer(): void };
    const { pack } = await import('msgpackr');
    internals.buffer = encodeFrame(1, OPCODES.PUSH_MESSAGE, pack({ chatId: 5, message: { id: 'p', time: 4_500 } }));
    internals.drainBuffer();
    await client.sendMessage(5, 'привет');
    expect(client.sent.filter((s) => s.opcode === OPCODES.CHAT_HISTORY)).toHaveLength(1);
    expect(sends(client)).toHaveLength(2);
  });
});

describe('the probe of an unanswered request', () => {
  it('drops a connection that does not answer its own PING within 10 s', async () => {
    vi.useFakeTimers();
    try {
      const destroy = vi.fn();
      const client = new (class extends MaxClient {
        override send(): void {}
      })({ reconnect: false });
      Object.assign(client as unknown as object, { socket: { destroy }, authed: true });
      const probe = client.probeConnection();
      expect(client.probeConnection()).toBe(probe); // one probe shared
      await vi.advanceTimersByTimeAsync(10_000);
      await probe;
      expect((destroy.mock.calls[0]?.[0] as Error).message).toMatch(/after an unanswered request/);
    } finally {
      vi.useRealTimers();
    }
  });
});
