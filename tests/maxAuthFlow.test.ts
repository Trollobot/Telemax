import { describe, expect, it, vi } from 'vitest';
import type { Context } from 'telegraf';
import { createMaxAuthFlow, MaxAuthUnavailableError } from '../src/bridge/maxAuthFlow.js';

// A refusal about the connection state is shown alone and ends the flow (review 2026-09-26, client-r2#2).

function fakeCtx(update: { text?: string; data?: string }) {
  const replies: string[] = [];
  const ctx = {
    chat: { id: 7 },
    from: { id: 8 },
    message: update.text != null ? { text: update.text } : undefined,
    callbackQuery: update.data != null ? { data: update.data } : undefined,
    telegram: { getChatMember: vi.fn(async () => ({ status: 'creator' })), sendMessage: vi.fn(async () => ({})) },
    reply: vi.fn(async (text: string) => {
      replies.push(text);
      return {};
    }),
    answerCbQuery: vi.fn(async () => true),
    deleteMessage: vi.fn(async () => true),
  };
  return { ctx: ctx as unknown as Context, replies };
}

function flowWith(requestSms: (phone: string) => Promise<void>) {
  return createMaxAuthFlow({
    targetGroupId: '-100',
    auth: {
      getLastKnownPhone: () => '+79999999999',
      requestSms,
      verifyCode: async () => ({ ok: true }),
      checkPassword: async () => {},
    },
  });
}

describe('maxAuthFlow — requestSms refusals', () => {
  it('shows a connection-state refusal without «Проверьте номер» and ends the flow', async () => {
    const flow = flowWith(async () => {
      throw new MaxAuthUnavailableError('MAX на паузе — снимите паузу в /panel (▶️ Возобновить MAX) и повторите /login.');
    });
    await flow.handlePrivate(fakeCtx({ text: '/login' }).ctx);
    const confirm = fakeCtx({ data: 'maxauth:yes' });
    await flow.handlePrivate(confirm.ctx);
    expect(confirm.replies).toEqual(['❌ MAX на паузе — снимите паузу в /panel (▶️ Возобновить MAX) и повторите /login.']);
    // The flow is over: a later message is no longer taken as auth input.
    expect(await flow.handlePrivate(fakeCtx({ text: '+79999999999' }).ctx)).toBe(false);
  });

  it('keeps asking for the number on any other failure', async () => {
    const flow = flowWith(async () => {
      throw new Error('Неверный номер');
    });
    await flow.handlePrivate(fakeCtx({ text: '/login' }).ctx);
    const confirm = fakeCtx({ data: 'maxauth:yes' });
    await flow.handlePrivate(confirm.ctx);
    expect(confirm.replies[0]).toContain('Проверьте номер');
    expect(await flow.handlePrivate(fakeCtx({ text: '+79999999999' }).ctx)).toBe(true);
  });
});
