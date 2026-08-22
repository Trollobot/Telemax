import { Markup, type Context } from 'telegraf';
import { createLogger } from '../logger.js';

const logger = createLogger('maxauth');

/** The MAX auth steps this flow drives — same functions the web panel's /api/auth/* routes call. */
export interface MaxAuthCallbacks {
  /** Last phone we authenticated with ('' if none) — lets the flow offer a one-tap re-auth. */
  getLastKnownPhone: () => string;
  /** START_AUTH: send the SMS. Throws with a human-readable message on failure. */
  requestSms: (phone: string) => Promise<void>;
  /** CHECK_CODE: completes the login, or reports that a 2FA password is still required. */
  verifyCode: (code: string) => Promise<{ ok: true } | { passwordRequired: true; hint: string | null }>;
  /** CHECK_PASSWORD: completes a 2FA login. */
  checkPassword: (password: string) => Promise<void>;
}

export interface MaxAuthFlow {
  /**
   * Handle a PRIVATE-chat update if it belongs to the /login flow — a trigger (`/login`, deep-link
   * `/start login`), an inline confirm button, or an in-progress step. Returns true when consumed,
   * so the caller must NOT then fall through to the bug-report handler. Returns false for anything
   * unrelated, letting bug reports take it.
   */
  handlePrivate: (ctx: Context) => Promise<boolean>;
}

type Step = 'confirm' | 'phone' | 'code' | 'password';
interface Flow {
  step: Step;
  at: number;
}

// A half-finished auth conversation shouldn't linger forever (a stray later message would otherwise
// be swallowed as auth input instead of becoming a bug report). Ten minutes is plenty for an SMS.
const FLOW_TTL_MS = 10 * 60_000;

/** +79959809587 -> +7•••••9587 (leading digit + last 4, rest masked) for display in chat. */
function maskPhone(phone: string): string {
  const digits = phone.replace(/\D/g, '');
  if (digits.length < 5) return phone;
  return `+${digits.slice(0, 1)}${'•'.repeat(Math.max(3, digits.length - 5))}${digits.slice(-4)}`;
}

export function createMaxAuthFlow(opts: { targetGroupId: string; auth: MaxAuthCallbacks }): MaxAuthFlow {
  const { targetGroupId, auth } = opts;
  const flows = new Map<number, Flow>();

  async function isGroupAdmin(ctx: Context, userId: number): Promise<boolean> {
    // Not for MAX's sake (its SMS already proves account access) — this stops a STRANGER who finds
    // the bot from re-pointing the bridge at THEIR own MAX account, or SMS-spamming via requestSms.
    try {
      const m = await ctx.telegram.getChatMember(targetGroupId, userId);
      return m.status === 'creator' || m.status === 'administrator';
    } catch (err) {
      logger.error('Failed to check admin status for /login', err);
      return false; // fail closed
    }
  }

  function setFlow(chatId: number, step: Step): void {
    flows.set(chatId, { step, at: Date.now() });
  }

  function freshFlow(chatId: number): Flow | undefined {
    const f = flows.get(chatId);
    if (!f) return undefined;
    if (Date.now() - f.at > FLOW_TTL_MS) {
      flows.delete(chatId);
      return undefined;
    }
    return f;
  }

  async function begin(ctx: Context, chatId: number): Promise<void> {
    const phone = auth.getLastKnownPhone();
    if (phone) {
      setFlow(chatId, 'confirm');
      await ctx.reply(
        `🔐 Авторизация MAX.\nВойти с номером ${maskPhone(phone)}?`,
        Markup.inlineKeyboard([
          [Markup.button.callback('✅ Да', 'maxauth:yes'), Markup.button.callback('✏️ Другой номер', 'maxauth:other')],
        ]),
      );
    } else {
      setFlow(chatId, 'phone');
      await ctx.reply('🔐 Авторизация MAX.\nПришлите номер телефона MAX в формате +7XXXXXXXXXX.');
    }
  }

  async function requestSmsThen(ctx: Context, chatId: number, phone: string): Promise<void> {
    try {
      await auth.requestSms(phone);
      setFlow(chatId, 'code');
      await ctx.reply('📲 Код отправлен по SMS. Пришлите его сюда одним сообщением.');
    } catch (err) {
      await ctx.reply(`❌ ${(err as Error).message}\nПроверьте номер и пришлите ещё раз, или /cancel.`);
    }
  }

  async function announceAuthed(ctx: Context): Promise<void> {
    const phone = auth.getLastKnownPhone();
    const masked = phone ? ` (${maskPhone(phone)})` : '';
    await ctx.reply(`✅ MAX авторизован${masked}. Пересылка снова работает.`);
    await ctx.telegram.sendMessage(targetGroupId, '✅ MAX-авторизация восстановлена.').catch(() => {});
  }

  async function handleConfirmButton(ctx: Context, chatId: number, data: string, userId: number): Promise<void> {
    if (!(await isGroupAdmin(ctx, userId))) {
      await ctx.answerCbQuery('Только для администратора группы.').catch(() => {});
      return;
    }
    const flow = freshFlow(chatId);
    if (!flow || flow.step !== 'confirm') {
      await ctx.answerCbQuery('Сессия истекла — начните заново: /login').catch(() => {});
      return;
    }
    await ctx.answerCbQuery().catch(() => {});
    if (data === 'maxauth:other') {
      setFlow(chatId, 'phone');
      await ctx.reply('Пришлите номер телефона MAX в формате +7XXXXXXXXXX.');
      return;
    }
    await requestSmsThen(ctx, chatId, auth.getLastKnownPhone());
  }

  async function handlePrivate(ctx: Context): Promise<boolean> {
    const chatId = ctx.chat?.id;
    const userId = ctx.from?.id;
    if (chatId == null || userId == null) return false;

    // Inline confirm buttons (only ever sent by this flow, so they're always ours).
    const cbData = (ctx.callbackQuery as { data?: string } | undefined)?.data;
    if (cbData === 'maxauth:yes' || cbData === 'maxauth:other') {
      await handleConfirmButton(ctx, chatId, cbData, userId);
      return true;
    }

    const text = (ctx.message as { text?: string } | undefined)?.text?.trim();

    // Triggers: /login, or the panel's deep link (t.me/<bot>?start=login -> "/start login").
    if (text === '/login' || text === '/start login') {
      if (!(await isGroupAdmin(ctx, userId))) {
        await ctx.reply('🔐 Вход в MAX доступен только администратору группы Telemax.');
        return true;
      }
      await begin(ctx, chatId);
      return true;
    }

    // In-progress conversation.
    const flow = freshFlow(chatId);
    if (!flow) return false; // nothing pending — not ours; let bug reports handle it
    if (!(await isGroupAdmin(ctx, userId))) {
      flows.delete(chatId);
      return false;
    }
    if (text === '/cancel') {
      flows.delete(chatId);
      await ctx.reply('Отменено.');
      return true;
    }
    if (!text) {
      await ctx.reply('Пришлите, пожалуйста, текстом.');
      return true; // consume so a mid-flow photo isn't misrouted
    }

    switch (flow.step) {
      case 'confirm': // user typed instead of tapping — treat it as a fresh number
      case 'phone':
        await requestSmsThen(ctx, chatId, text);
        return true;
      case 'code':
        try {
          const result = await auth.verifyCode(text);
          await ctx.deleteMessage().catch(() => {}); // don't leave the code sitting in the chat
          if ('passwordRequired' in result) {
            setFlow(chatId, 'password');
            const hint = result.hint ? `\nПодсказка: ${result.hint}` : '';
            await ctx.reply(`🔐 На аккаунте включён пароль (2FA).${hint}\nПришлите пароль — я удалю ваше сообщение сразу после проверки.`);
          } else {
            flows.delete(chatId);
            await announceAuthed(ctx);
          }
        } catch (err) {
          await ctx.reply(`❌ ${(err as Error).message}\nПришлите код ещё раз или /cancel.`);
        }
        return true;
      case 'password':
        // Delete the password message IMMEDIATELY — before the network round-trip — so it spends the
        // least possible time in the chat, then confirm receipt as the user asked.
        await ctx.deleteMessage().catch(() => {});
        try {
          await auth.checkPassword(text);
          flows.delete(chatId);
          await ctx.reply('🔐 Пароль принят.');
          await announceAuthed(ctx);
        } catch (err) {
          await ctx.reply(`❌ Пароль не подошёл: ${(err as Error).message}\nПришлите пароль ещё раз или /cancel.`);
        }
        return true;
    }
  }

  return { handlePrivate };
}
