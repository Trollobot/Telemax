import { describe, expect, it } from 'vitest';
import { MaxClient } from '../src/max/client.js';

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
