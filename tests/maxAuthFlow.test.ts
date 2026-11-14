import { describe, expect, it, vi } from 'vitest';
import type { Context } from 'telegraf';
import { createMaxAuthFlow, formatCallNumber, MaxAuthUnavailableError } from '../src/bridge/maxAuthFlow.js';
import { parseCallOutParams } from '../src/max/client.js';

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
      callOutStatus: async () => ({ status: 0 }),
      finishCallOut: async () => ({ ok: true }),
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

describe('maxAuthFlow — sign-in confirmed by a phone call (callOutParams)', () => {
  function callOutFlow(statuses: { status: number; callNumber?: string }[], finish: () => Promise<{ ok: true } | { passwordRequired: true; hint: string | null }>) {
    const queue = [...statuses];
    const finishCallOut = vi.fn(finish);
    const flow = createMaxAuthFlow({
      targetGroupId: '-100',
      wait: async () => {},
      auth: {
        getLastKnownPhone: () => '',
        requestSms: async () => ({ callOut: { pollingInterval: 5000 } }),
        verifyCode: async () => ({ ok: true }),
        checkPassword: async () => {},
        callOutStatus: async () => queue.shift() ?? { status: 0 },
        finishCallOut,
      },
    });
    return { flow, finishCallOut };
  }
  const settle = () => new Promise((resolve) => setTimeout(resolve, 20));

  it('shows the number to call once, then finishes the login when MAX confirms the call', async () => {
    const { flow, finishCallOut } = callOutFlow(
      [{ status: 0 }, { status: 1, callNumber: '79585383960' }, { status: 1, callNumber: '79585383960' }, { status: 2 }],
      async () => ({ ok: true }),
    );
    await flow.handlePrivate(fakeCtx({ text: '/login' }).ctx);
    const phone = fakeCtx({ text: '+79030160112' });
    await flow.handlePrivate(phone.ctx);
    await settle();
    expect(phone.replies[0]).toContain('звонком');
    expect(phone.replies.filter((r) => r.includes('+79585383960'))).toHaveLength(1);
    expect(finishCallOut).toHaveBeenCalledTimes(1);
    expect(phone.replies.at(-1)).toContain('✅ MAX авторизован');
    expect(await flow.handlePrivate(fakeCtx({ text: 'hello' }).ctx)).toBe(false); // flow over
  });

  it('asks for the 2FA password after a confirmed call', async () => {
    const { flow } = callOutFlow([{ status: 1, callNumber: '+79585383960' }, { status: 2 }], async () => ({ passwordRequired: true, hint: 'кот' }));
    await flow.handlePrivate(fakeCtx({ text: '/login' }).ctx);
    const phone = fakeCtx({ text: '+79030160112' });
    await flow.handlePrivate(phone.ctx);
    await settle();
    expect(phone.replies.at(-1)).toContain('Подсказка: кот');
    expect(await flow.handlePrivate(fakeCtx({ text: 'secret' }).ctx)).toBe(true); // taken as the password
  });

  it('ends with a retry hint when the offer expires, and stops polling on /cancel', async () => {
    const expired = callOutFlow([{ status: 0 }, { status: 3 }], async () => ({ ok: true }));
    await expired.flow.handlePrivate(fakeCtx({ text: '/login' }).ctx);
    const phone = fakeCtx({ text: '+79030160112' });
    await expired.flow.handlePrivate(phone.ctx);
    await settle();
    expect(phone.replies.at(-1)).toContain('/login');
    expect(expired.finishCallOut).not.toHaveBeenCalled();
  });

  it('parses callOutParams (int64 as bigint) and formats the number', () => {
    expect(parseCallOutParams({ trackId: 't', pollingInterval: 3000n, expiresAt: 1700000000000n })).toEqual({ trackId: 't', pollingInterval: 3000, expiresAt: 1700000000000 });
    expect(parseCallOutParams(undefined)).toBeUndefined();
    expect(parseCallOutParams({ pollingInterval: 1 })).toBeUndefined();
    expect(formatCallNumber('79585383960')).toBe('+79585383960');
    expect(formatCallNumber('+79585383960')).toBe('+79585383960');
  });
});
