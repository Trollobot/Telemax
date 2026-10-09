import { describe, expect, it, vi } from 'vitest';
import type { Telegraf } from 'telegraf';
import { KEYBOARD_CONTACT, KEYBOARD_GEO, KEYBOARD_NA, KEYBOARD_PRESS, maxKeyboardToTelegram, miniAppLink, pressableButton, takeKeyboard } from '../src/bridge/attachments.js';
import { isMarkupRefusal, isRenderableAttach, sendAttachments, sendTextPieces } from '../src/bridge/sync.js';

const kb = (buttons: unknown) => ({ _type: 'INLINE_KEYBOARD', keyboard: { buttons }, callbackId: 'x' });
const na = (text: string) => ({ text, callback_data: KEYBOARD_NA });

describe('maxKeyboardToTelegram', () => {
  it('converts the live LINK sample', () => {
    const attach = {
      _type: 'INLINE_KEYBOARD',
      keyboard: { buttons: [[{ type: 'LINK', text: 'Завершить все сессии', url: 'https://max.ru/:settings/devices' }]] },
      callbackId: 'f9LHodD0',
    };
    expect(maxKeyboardToTelegram(attach)).toEqual({ inline_keyboard: [[{ text: 'Завершить все сессии', url: 'https://max.ru/:settings/devices' }]] });
  });

  it('converts the live CLIPBOARD sample', () => {
    const attach = { _type: 'INLINE_KEYBOARD', keyboard: { buttons: [[{ type: 'CLIPBOARD', text: 'Скопировать код', payload: '289219' }]] }, callbackId: 'x' };
    expect(maxKeyboardToTelegram(attach)).toEqual({ inline_keyboard: [[{ text: 'Скопировать код', copy_text: { text: '289219' } }]] });
  });

  it('keeps the layout of buttons Telegram has no twin for', () => {
    const attach = kb([
      [{ type: 'CALLBACK', text: 'Да', payload: 'yes' }, { type: 'MESSAGE', text: 'Нет' }],
      [{ type: 'OPEN_APP', text: 'Открыть', webApp: 'app', contactId: 5n }],
      [{ type: 'REQUEST_CONTACT', text: 'Контакт' }, { type: 'REQUEST_GEO_LOCATION', text: 'Гео' }, { type: 'SOMETHING_NEW', text: '?' }, { text: 'без типа' }],
      [{ type: 'LINK', text: 'Сайт', url: 'tg://resolve?domain=x' }],
    ]);
    expect(maxKeyboardToTelegram(attach)).toEqual({
      inline_keyboard: [[na('Да'), na('Нет')], [{ text: 'Открыть', url: 'https://max.ru/app?startapp' }], [{ text: 'Контакт', callback_data: KEYBOARD_CONTACT }, { text: 'Гео', callback_data: KEYBOARD_GEO }, na('?'), na('без типа')], [{ text: 'Сайт', url: 'tg://resolve?domain=x' }]],
    });
  });

  it('turns a url or a payload Telegram would refuse into an inert button', () => {
    const urls = ['', 'max://chat/1', 'javascript:alert(1)', 'https://', `https://a.b/${'x'.repeat(2048)}`, 42, undefined];
    const attach = kb([urls.map((url, i) => ({ type: 'LINK', text: `u${i}`, url })), [
      { type: 'CLIPBOARD', text: 'длинный', payload: 'p'.repeat(257) },
      { type: 'CLIPBOARD', text: 'пустой', payload: '' },
      { type: 'CLIPBOARD', text: 'число', payload: 289219 },
      { type: 'CLIPBOARD', text: 'ровно', payload: 'p'.repeat(256) },
    ]]);
    expect(maxKeyboardToTelegram(attach)).toEqual({
      inline_keyboard: [urls.map((_, i) => na(`u${i}`)), [na('длинный'), na('пустой'), na('число'), { text: 'ровно', copy_text: { text: 'p'.repeat(256) } }]],
    });
  });

  it('keeps at most 8 buttons per row and 100 in total, in order', () => {
    const row = (r: number, n: number) => Array.from({ length: n }, (_, i) => ({ type: 'CALLBACK', text: `${r}-${i}` }));
    const wide = maxKeyboardToTelegram(kb([row(0, 12)]));
    expect(wide?.inline_keyboard[0]?.map((b) => b.text)).toEqual(['0-0', '0-1', '0-2', '0-3', '0-4', '0-5', '0-6', '0-7']);
    const tall = maxKeyboardToTelegram(kb(Array.from({ length: 20 }, (_, r) => row(r, 7))));
    expect(tall?.inline_keyboard.flat()).toHaveLength(100);
    expect(tall?.inline_keyboard).toHaveLength(15); // 14 full rows + 2 buttons of the 15th
    expect(tall?.inline_keyboard[14]?.map((b) => b.text)).toEqual(['14-0', '14-1']);
  });

  it('survives garbage without throwing', () => {
    for (const attach of [undefined, null, 7, 'kb', {}, { keyboard: null }, { keyboard: 'x' }, { keyboard: [] }, { keyboard: { buttons: 'x' } }, kb([]), kb(['row', 5, null, {}])]) {
      expect(maxKeyboardToTelegram(attach)).toBeUndefined();
    }
    // Buttons without a usable text are skipped; a row left empty disappears.
    expect(maxKeyboardToTelegram(kb([[null, 5, 'b', {}, { type: 'LINK', url: 'https://a.b' }, { type: 'CALLBACK', text: 9 }, { type: 'CALLBACK', text: '  ' }]]))).toBeUndefined();
    expect(maxKeyboardToTelegram(kb([[{ text: '' }], [null, { type: 'CALLBACK', text: 'ок' }]]))).toEqual({ inline_keyboard: [[na('ок')]] });
  });

  it('cuts a long text to 64 UTF-16 units without splitting a surrogate pair', () => {
    const text = maxKeyboardToTelegram(kb([[{ type: 'CALLBACK', text: `${'a'.repeat(63)}😀хвост` }]]))?.inline_keyboard[0]?.[0]?.text;
    expect(text).toBe('a'.repeat(63));
    expect(maxKeyboardToTelegram(kb([[{ type: 'CALLBACK', text: 'b'.repeat(70) }]]))?.inline_keyboard[0]?.[0]?.text).toHaveLength(64);
  });
});

describe('a keyboard attach in the relay', () => {
  const keyboard = kb([[{ type: 'LINK', text: 'Сайт', url: 'https://max.ru' }]]);

  it('is taken out of the attaches and is not renderable', async () => {
    const photo = { _type: 'PHOTO' };
    const taken = takeKeyboard([photo, keyboard]);
    expect(taken.attaches).toEqual([photo]);
    expect(taken.keyboard).toEqual({ inline_keyboard: [[{ text: 'Сайт', url: 'https://max.ru' }]] });
    // A keyboard with nothing usable still leaves the attaches.
    expect(takeKeyboard([kb('x')])).toEqual({ attaches: [], keyboard: undefined });
    expect(isRenderableAttach(keyboard as never)).toBe(false);
    // No «[вложение: INLINE_KEYBOARD]» line even if one reaches sendAttachments.
    const sendMessage = vi.fn(async () => ({ message_id: 1 }));
    const bot = { telegram: { sendMessage } } as unknown as Telegraf;
    expect(await sendAttachments(bot, 'g', 7, [keyboard] as never, { max: {} } as never)).toEqual([]);
    expect(sendMessage).not.toHaveBeenCalled();
  });

  it('resends a text without the keyboard when Telegram refuses a button', async () => {
    const refusal = Object.assign(new Error('400: Bad Request: BUTTON_URL_INVALID'), { response: { error_code: 400, description: 'Bad Request: BUTTON_URL_INVALID' } });
    expect(isMarkupRefusal(refusal)).toBe(true);
    expect(isMarkupRefusal(new Error("400: Bad Request: can't parse inline keyboard button: reply markup is invalid"))).toBe(true);
    expect(isMarkupRefusal(new Error('400: Bad Request: message is too long'))).toBe(false);
    const sendMessage = vi.fn(async (_chat: string, _text: string, extra: { reply_markup?: unknown }) => {
      if (extra.reply_markup) throw refusal;
      return { message_id: 5 };
    });
    const bot = { telegram: { sendMessage } } as unknown as Telegraf;
    const replyMarkup = takeKeyboard([keyboard]).keyboard;
    expect(await sendTextPieces(bot, 'g', 7, 'текст', { replyMarkup, maxMessageId: 1n })).toEqual([5]);
    expect(sendMessage).toHaveBeenCalledTimes(2);
    // Any other refusal still propagates.
    const broken = { telegram: { sendMessage: vi.fn(async () => { throw new Error('400: Bad Request: chat not found'); }) } } as unknown as Telegraf;
    await expect(sendTextPieces(broken, 'g', 7, 'текст', { replyMarkup })).rejects.toThrow('chat not found');
  });
});

describe('CALLBACK buttons — presses relayed to MAX', () => {
  // Verbatim from GigaChat, live 2026-10-05 (payloads shortened).
  const giga = {
    _type: 'INLINE_KEYBOARD',
    callbackId: 'f9LHodD0cOJugVuIGDqvXNFedEn6vqee',
    keyboard: {
      buttons: [
        [
          { type: 'CALLBACK', text: '🔄 Новый ответ', payload: '{"command":"regenerate"}', intent: 'DEFAULT' },
          { type: 'CALLBACK', text: '💡 Подсказки', payload: '{"command":"request_suggests"}', intent: 'DEFAULT' },
        ],
        [{ type: 'CALLBACK', text: 'Веб-версия и приложение', payload: '{"command":"web_and_app"}', intent: 'DEFAULT' }],
      ],
    },
  };

  it('each button gets its own key, and the key leads back to the chat, callbackId and ITS payload', () => {
    const markup = maxKeyboardToTelegram(giga, 361838255);
    const data = (markup?.inline_keyboard ?? []).flat().map((b) => (b as { callback_data: string }).callback_data);
    expect(data).toHaveLength(3);
    expect(new Set(data).size).toBe(3);
    for (const d of data) {
      expect(d.startsWith(KEYBOARD_PRESS)).toBe(true);
      expect(Buffer.byteLength(d)).toBeLessThanOrEqual(64); // Telegram's callback_data limit
    }
    expect(pressableButton(data[1]!.slice(KEYBOARD_PRESS.length))).toEqual({
      chatId: 361838255,
      callbackId: giga.callbackId,
      payload: '{"command":"request_suggests"}',
      text: '💡 Подсказки',
    });
  });

  it('a MESSAGE button is pressable too: its press sends the text, no callback', () => {
    const markup = maxKeyboardToTelegram(kb([[{ type: 'MESSAGE', text: 'Позвать оператора' }]]), 7);
    const data = (markup?.inline_keyboard[0]?.[0] as { callback_data: string }).callback_data;
    expect(pressableButton(data.slice(KEYBOARD_PRESS.length))).toEqual({ chatId: 7, callbackId: '', text: 'Позвать оператора', sendsText: true });
  });

  it('without a chat (or without a callbackId) the button stays inert, and an unknown key finds nothing', () => {
    expect(maxKeyboardToTelegram(giga)?.inline_keyboard[1]).toEqual([na('Веб-версия и приложение')]);
    expect(maxKeyboardToTelegram({ ...giga, callbackId: undefined }, 1)?.inline_keyboard[1]).toEqual([na('Веб-версия и приложение')]);
    expect(pressableButton('no-such-key')).toBeUndefined();
  });
});

describe('miniAppLink', () => {
  it('builds the public deep link of the live «Настройки» sample (2026-10-06)', () => {
    const b = { type: 'OPEN_APP', text: 'Настройки', webApp: 'maxnotifications_bot', contactId: 18948480, payload: 'v2bdo2qespQHrvVOL0TsKEKUXUk2RsTqvbcEFsHcdRp63ILky2my5' };
    expect(miniAppLink(b)).toBe('https://max.ru/maxnotifications_bot?startapp=v2bdo2qespQHrvVOL0TsKEKUXUk2RsTqvbcEFsHcdRp63ILky2my5');
  });

  it('drops a payload MAX would strip anyway, and refuses a bad app name', () => {
    expect(miniAppLink({ webApp: 'shop_bot', payload: 'a b' })).toBe('https://max.ru/shop_bot?startapp');
    expect(miniAppLink({ webApp: 'shop_bot', payload: 'x'.repeat(513) })).toBe('https://max.ru/shop_bot?startapp');
    expect(miniAppLink({ webApp: 'shop_bot' })).toBe('https://max.ru/shop_bot?startapp');
    expect(miniAppLink({ webApp: '../evil' })).toBeUndefined();
    expect(miniAppLink({ payload: 'x' })).toBeUndefined();
  });
});
