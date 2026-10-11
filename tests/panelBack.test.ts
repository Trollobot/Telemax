import { describe, expect, it } from 'vitest';
import type { Context } from 'telegraf';
import { keepPanelBack } from '../src/bridge/panelBack.js';

const pressedIn = (inline_keyboard: unknown[][]) => ({ callbackQuery: { message: { reply_markup: { inline_keyboard } } } }) as unknown as Context;

describe('keepPanelBack', () => {
  it('keeps the panel «◀️ Назад» of a list drawn in the panel', () => {
    const ctx = pressedIn([[{ text: 'Чат 1', callback_data: 'tlmx_ban:1' }], [{ text: '◀️ Назад', callback_data: 'tlmx_panel:chats' }]]);
    expect(keepPanelBack(ctx)).toEqual({ reply_markup: { inline_keyboard: [[{ text: '◀️ Назад', callback_data: 'tlmx_panel:chats', hide: false }]] } });
  });
  it('keeps «◀️ К файлам» under an upload link in the panel', () => {
    const ctx = pressedIn([[{ text: '📤 Загрузить файл', url: 'https://x/f/t' }], [{ text: '✖️ Отменить', callback_data: 'tlmx_panel:fcancel:t' }], [{ text: '◀️ К файлам', callback_data: 'tlmx_panel:files' }]]);
    expect(keepPanelBack(ctx).reply_markup?.inline_keyboard).toEqual([[{ text: '◀️ К файлам', callback_data: 'tlmx_panel:files', hide: false }]]);
  });
  it('adds nothing to the lists sent by /ban, /version or an upload link in a topic', () => {
    expect(keepPanelBack(pressedIn([[{ text: 'Чат 1', callback_data: 'tlmx_ban:1' }]]))).toEqual({});
    expect(keepPanelBack(pressedIn([[{ text: '🔄 Обновить', callback_data: 'tlmx_update' }, { text: '⏰ Позже', callback_data: 'tlmx_dismiss' }]]))).toEqual({});
    expect(keepPanelBack(pressedIn([[{ text: '📤 Загрузить файл', url: 'https://x/f/t' }], [{ text: '✖️ Отменить', callback_data: 'tlmx_panel:fcancel:t' }]]))).toEqual({});
    expect(keepPanelBack({} as Context)).toEqual({});
  });
});
