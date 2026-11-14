import { Markup, type Context } from 'telegraf';
import { createLogger } from '../logger.js';
import { maskPhone } from './status.js';
import { qrPng } from './qr.js';
import { isTransientMaxError } from './transient.js';

const logger = createLogger('maxauth');

/** The MAX auth steps this flow drives — implemented by MaxSessionController (server/maxSession.ts), the only place a MAX login happens. */
export interface MaxAuthCallbacks {
  /** Last phone we authenticated with ('' if none) — lets the flow offer a one-tap re-auth. */
  getLastKnownPhone: () => string;
  /** START_AUTH: send the SMS — or, when MAX wants a phone call instead, return its call-out offer. Throws with a human-readable message on failure. */
  requestSms: (phone: string) => Promise<void | { callOut: { pollingInterval: number } }>;
  /** A pending call-out sign-in: 0 waiting, 1 number to call ready, 2 confirmed, 3 expired. */
  callOutStatus: () => Promise<{ status: number; callNumber?: string }>;
  /** Completes a confirmed call-out or QR sign-in — the same outcome as verifyCode. */
  finishTrack: () => Promise<{ ok: true } | { passwordRequired: true; hint: string | null }>;
  /** Starts a QR sign-in (refresh: a new code on the same chain after the last one expired). */
  startQr: (refresh?: boolean) => Promise<{ qrLink: string; pollingInterval: number; ttl: number }>;
  /** A pending QR sign-in: confirmed in the MAX app yet, and ms before the code expires. */
  qrStatus: () => Promise<{ loginAvailable: boolean; ttl: number }>;
  /** CHECK_CODE: completes the login, or reports that a 2FA password is still required. */
  verifyCode: (code: string) => Promise<{ ok: true } | { passwordRequired: true; hint: string | null }>;
  /** CHECK_PASSWORD: completes a 2FA login. */
  checkPassword: (password: string) => Promise<void>;
}

/**
 * requestSms refusing because of the connection state (MAX paused, no connection), not the number:
 * the flow shows the message alone and ends, instead of «Проверьте номер…» and waiting for a number
 * that would only hit the same refusal. Likewise a code or password already spent on a LOGIN
 * that then failed.
 */
export class MaxAuthUnavailableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'MaxAuthUnavailableError';
  }
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

type Step = 'confirm' | 'phone' | 'code' | 'call' | 'qr' | 'password';
interface Flow {
  step: Step;
  at: number;
}

// A half-finished auth conversation shouldn't linger forever (a stray later message would otherwise
// be swallowed as auth input instead of becoming a bug report). Ten minutes is plenty for an SMS.
const FLOW_TTL_MS = 10 * 60_000;

/** A number as MAX sends it (sometimes without «+») in the international form. Exported for tests. */
export function formatCallNumber(raw: string): string {
  return /^[+8]/.test(raw) ? raw : `+${raw}`;
}

export function createMaxAuthFlow(opts: {
  targetGroupId: string;
  auth: MaxAuthCallbacks;
  /** Pause between call-out polls; overridable for tests. */
  wait?: (ms: number) => Promise<void>;
}): MaxAuthFlow {
  const { targetGroupId, auth } = opts;
  const wait = opts.wait ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
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
    setFlow(chatId, 'confirm');
    const byPhone = phone
      ? [Markup.button.callback(`📱 С номером ${maskPhone(phone)}`, 'maxauth:yes'), Markup.button.callback('✏️ Другой номер', 'maxauth:other')]
      : [Markup.button.callback('📱 По номеру телефона', 'maxauth:other')];
    await ctx.reply(
      '🔐 Авторизация MAX. Как войти?\n\n📷 QR-код — подтвердите вход в приложении MAX, где вы уже вошли.\n📱 По номеру — MAX пришлёт код по SMS или попросит позвонить.\n\nМожно и просто прислать номер в формате +7XXXXXXXXXX.',
      Markup.inlineKeyboard([[Markup.button.callback('📷 QR-код', 'maxauth:qr')], byPhone]),
    );
  }

  const QR_CAPTION =
    '📷 Отсканируйте этот код в приложении MAX, где вы уже вошли (там, где MAX предлагает подключить устройство или сканировать QR). ' +
    'Если MAX стоит на этом же телефоне — нажмите кнопку под кодом. Код действует около 2 минут, я обновлю его сам. Отмена — /cancel.';

  async function sendQr(ctx: Context, link: string, refreshed: boolean): Promise<void> {
    await ctx.replyWithPhoto(
      { source: qrPng(link) },
      { caption: refreshed ? `🔄 Новый код.\n${QR_CAPTION}` : QR_CAPTION, ...Markup.inlineKeyboard([[Markup.button.url('Открыть в MAX', link)]]) },
    );
  }

  async function startQrThen(ctx: Context, chatId: number): Promise<void> {
    try {
      const qr = await auth.startQr();
      setFlow(chatId, 'qr');
      await sendQr(ctx, qr.qrLink, false);
      void watchQr(ctx, chatId, qr.pollingInterval);
    } catch (err) {
      if (await replyKnownError(ctx, chatId, err)) return;
      flows.delete(chatId);
      await ctx.reply(`❌ ${(err as Error).message}\nНачните заново: /login`);
    }
  }

  /**
   * Drives a QR sign-in in the background: polls until the code is confirmed in the MAX app (finish the
   * login, or ask for the 2FA password), shows a fresh code when one expires (a few times, then gives
   * up), and stops as soon as the flow is cancelled, replaced or stale.
   */
  async function watchQr(ctx: Context, chatId: number, pollingInterval: number): Promise<void> {
    const MAX_CODES = 5;
    const interval = Math.min(Math.max(pollingInterval, 1000), 10_000);
    const stillWaiting = (): boolean => freshFlow(chatId)?.step === 'qr';
    let codes = 1;
    let failures = 0;
    while (stillWaiting()) {
      await wait(interval);
      if (!stillWaiting()) return;
      let st: { loginAvailable: boolean; ttl: number };
      try {
        st = await auth.qrStatus();
        failures = 0;
      } catch (err) {
        if (isTransientMaxError(err) && ++failures < 5) continue;
        flows.delete(chatId);
        logger.warn('QR sign-in: status poll failed', err);
        await ctx.reply(`❌ Не удалось узнать у MAX, подтверждён ли вход: ${(err as Error).message}\nНачните заново: /login`).catch(() => {});
        return;
      }
      if (st.loginAvailable) {
        await finishTrackThen(ctx, chatId, '📷 Вход подтверждён в приложении.');
        return;
      }
      if (st.ttl > 0) continue;
      if (codes >= MAX_CODES) {
        flows.delete(chatId);
        await ctx.reply('⌛ QR-код так и не подтвердили. Начните заново: /login').catch(() => {});
        return;
      }
      try {
        const qr = await auth.startQr(true);
        codes++;
        if (stillWaiting()) await sendQr(ctx, qr.qrLink, true);
      } catch (err) {
        flows.delete(chatId);
        await ctx.reply(`❌ ${(err as Error).message}\nНачните заново: /login`).catch(() => {});
        return;
      }
    }
  }

  /** The common end of a call-out or QR sign-in. */
  async function finishTrackThen(ctx: Context, chatId: number, confirmed: string): Promise<void> {
    try {
      const result = await auth.finishTrack();
      if ('passwordRequired' in result) {
        setFlow(chatId, 'password');
        const hint = result.hint ? `\nПодсказка: ${result.hint}` : '';
        await ctx.reply(`🔐 ${confirmed} На аккаунте включён пароль (2FA).${hint}\nПришлите пароль — я удалю ваше сообщение сразу после проверки.`);
      } else {
        flows.delete(chatId);
        await announceAuthed(ctx);
      }
    } catch (err) {
      flows.delete(chatId);
      await ctx.reply(`❌ ${(err as Error).message}`).catch(() => {});
    }
  }

  async function requestSmsThen(ctx: Context, chatId: number, phone: string): Promise<void> {
    try {
      const started = await auth.requestSms(phone);
      if (started && 'callOut' in started) {
        setFlow(chatId, 'call');
        await ctx.reply('📞 MAX подтверждает этот вход не кодом из SMS, а звонком: вы звоните с телефона, на который зарегистрирован аккаунт, на номер, который даст MAX. Запрашиваю номер…');
        void watchCallOut(ctx, chatId, started.callOut.pollingInterval);
        return;
      }
      setFlow(chatId, 'code');
      await ctx.reply('📲 Код отправлен по SMS. Пришлите его сюда одним сообщением.');
    } catch (err) {
      if (await replyKnownError(ctx, chatId, err)) return;
      await ctx.reply(`❌ ${(err as Error).message}\nПроверьте номер и пришлите ещё раз, или /cancel.`);
    }
  }

  /**
   * A MaxAuthUnavailableError is shown alone and ends the flow: resending would only hit it again.
   * A timeout or dropped socket says nothing about the number, code or password: a plain retry hint
   * instead of the raw English client error, and the flow stays open.
   */
  async function replyKnownError(ctx: Context, chatId: number, err: unknown): Promise<boolean> {
    if (err instanceof MaxAuthUnavailableError) {
      flows.delete(chatId);
      await ctx.reply(`❌ ${err.message}`);
      return true;
    }
    if (!isTransientMaxError(err)) return false;
    logger.warn('MAX auth step failed on the connection', err);
    await ctx.reply('❌ MAX не ответил — пришлите ещё раз или /cancel.');
    return true;
  }

  /**
   * Drives a call-out sign-in in the background: polls MAX until it gives the number to call (shown,
   * and shown again if MAX changes it), then until the call is confirmed (finish the login, or ask for
   * the 2FA password) or the offer expires. Stops as soon as the flow is cancelled, replaced or stale.
   */
  async function watchCallOut(ctx: Context, chatId: number, pollingInterval: number): Promise<void> {
    const interval = Math.min(Math.max(pollingInterval, 1000), 10_000);
    const stillCalling = (): boolean => freshFlow(chatId)?.step === 'call';
    let shown = '';
    let failures = 0;
    while (stillCalling()) {
      await wait(interval);
      if (!stillCalling()) return;
      let st: { status: number; callNumber?: string };
      try {
        st = await auth.callOutStatus();
        failures = 0;
      } catch (err) {
        if (isTransientMaxError(err) && ++failures < 5) continue;
        flows.delete(chatId);
        logger.warn('Call-out sign-in: status poll failed', err);
        await ctx.reply(`❌ Не удалось узнать у MAX, прошёл ли звонок: ${(err as Error).message}\nНачните заново: /login`).catch(() => {});
        return;
      }
      if (st.status === 1 && st.callNumber && st.callNumber !== shown) {
        const again = shown !== '';
        shown = st.callNumber;
        await ctx
          .reply(
            `📞 ${again ? 'MAX сменил номер. ' : ''}Позвоните с телефона аккаунта MAX на ${formatCallNumber(st.callNumber)}. ` +
              'Если ответит робот — следуйте его подсказкам. Я сам увижу, что звонок прошёл. Отмена — /cancel.',
          )
          .catch(() => {});
      } else if (st.status === 2) {
        await finishTrackThen(ctx, chatId, 'Звонок подтверждён.');
        return;
      } else if (st.status === 3) {
        flows.delete(chatId);
        await ctx.reply('⌛ Время на звонок вышло. Начните заново: /login').catch(() => {});
        return;
      }
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
    if (data === 'maxauth:qr') {
      await startQrThen(ctx, chatId);
      return;
    }
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
    if (cbData === 'maxauth:yes' || cbData === 'maxauth:other' || cbData === 'maxauth:qr') {
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
      case 'call':
        await ctx.reply('📞 Жду звонка на номер выше — я сам увижу, что он прошёл. Отмена — /cancel.');
        return true;
      case 'qr':
        await ctx.reply('📷 Жду подтверждения QR-кода в приложении MAX — я сам увижу, что вход подтверждён. Отмена — /cancel.');
        return true;
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
          if (await replyKnownError(ctx, chatId, err)) return true;
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
          if (await replyKnownError(ctx, chatId, err)) return true;
          await ctx.reply(`❌ Пароль не подошёл: ${(err as Error).message}\nПришлите пароль ещё раз или /cancel.`);
        }
        return true;
    }
  }

  return { handlePrivate };
}
