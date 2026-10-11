import { Markup, type Context } from 'telegraf';
import type { InlineKeyboardButton, InlineKeyboardMarkup } from 'telegraf/types';

/**
 * The panel's own «◀️ …» button on the message a button was pressed in, kept for the result. The panel
 * draws lists and prompts (ban/unban, version, the upload link) IN its own message, so a press that
 * rewrites that message must leave a way back — or the pinned panel ends up a dead text with no
 * buttons. The same lists sent by /ban, /version… carry no such button, and their results stay bare.
 */
export function keepPanelBack(ctx: Context): { reply_markup?: InlineKeyboardMarkup } {
  const rows = (ctx.callbackQuery?.message as { reply_markup?: InlineKeyboardMarkup } | undefined)?.reply_markup?.inline_keyboard ?? [];
  const back = rows
    .flat()
    .find((b): b is InlineKeyboardButton.CallbackButton => 'callback_data' in b && b.callback_data.startsWith('tlmx_panel:') && b.text.startsWith('◀️'));
  return back ? { reply_markup: Markup.inlineKeyboard([[Markup.button.callback(back.text, back.callback_data)]]).reply_markup } : {};
}
