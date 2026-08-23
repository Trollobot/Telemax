import path from 'node:path';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { Markup, type Telegraf, type Context } from 'telegraf';
import type { MaxClient, MaxContactInfo } from '../max/client.js';
import { getAppVersion } from './version.js';
import { createLogger } from '../logger.js';

const logger = createLogger('panel');

/** Sends one of the reused command outputs (help, apikey, version, ban/unban list) to a chat. */
type LeafSender = (chatId: number) => Promise<void>;

export interface ControlPanelDeps {
  bot: Telegraf;
  targetGroupId: string;
  max: MaxClient;
  getActivePhone: () => string;
  triggerFullResync: () => Promise<void>;
  /** Reused slash-command bodies — the panel just triggers the same output. */
  leaves: {
    sendHelp: LeafSender;
    sendVersion: LeafSender;
    sendBanList: LeafSender;
    sendUnbanList: LeafSender;
  };
  /** Reuses or creates a MAX dialog with the contact and its Telegram topic; returns a deep link to open it. */
  startDialog: (
    recipientUserId: string,
    name: string,
  ) => Promise<{ ok: boolean; error?: string; topicName: string; chatLink?: string; existed?: boolean }>;
}

// The panel message id is remembered in ./data so the same pinned message is edited
// across restarts instead of spamming a new one each time (mirrors the welcome-sent
// marker in server/app.ts).
const PANEL_MARKER = path.join(process.cwd(), '.data', 'panel-message');

// --- Pause state (panel-owned) -------------------------------------------------------
// A deliberate pause disconnects MAX and suppresses auto-reconnect until resumed or the
// timer fires. max.disconnect() removes its socket listeners, so no "connection lost"
// alarm goes out for a deliberate pause. Not persisted — a container restart brings MAX
// back online.
let pauseUntil: number | null = null; // epoch ms; Number.POSITIVE_INFINITY = "forever"
let pauseTimer: ReturnType<typeof setTimeout> | null = null;

function clearPauseTimer(): void {
  if (pauseTimer) {
    clearTimeout(pauseTimer);
    pauseTimer = null;
  }
}
function isPaused(): boolean {
  return pauseUntil != null;
}

// --- Contact-search force-reply correlation ------------------------------------------
type SearchMode = 'phone' | 'nick';
const pendingSearch = new Map<number, { mode: SearchMode; requesterId: number }>();
// Contacts shown with a "Начать чат" button, so the tap knows the display name / MAX
// membership without re-fetching. Keyed by userId (string).
const shownContacts = new Map<string, { name: string; onMax: boolean }>();

function contactName(c: MaxContactInfo): string {
  const names = c.names ?? [];
  const primary = names.find((n) => n.type === 'ONEME') ?? names[0];
  const full = [primary?.firstName, primary?.lastName].filter(Boolean).join(' ').trim();
  return (primary?.name || full || `MAX ${String(c.id)}`).slice(0, 120);
}
function isOnMax(c: MaxContactInfo): boolean {
  return Array.isArray(c.options) && c.options.includes('ONEME');
}

type View = { text: string; markup: ReturnType<typeof Markup.inlineKeyboard>['reply_markup'] };

function rootView(phone: string): View {
  const version = getAppVersion();
  let status: string;
  if (isPaused()) {
    status =
      pauseUntil === Number.POSITIVE_INFINITY
        ? '⏸ MAX на паузе (до ручного возобновления)'
        : `⏸ MAX на паузе (~${Math.max(0, Math.round((pauseUntil! - Date.now()) / 60000))} мин)`;
  } else {
    status = `🟢 MAX: ${phone || 'не авторизован'}`;
  }
  return {
    text: `🎛 Telemax — пульт\n${status} · версия ${version}`,
    markup: Markup.inlineKeyboard([
      [Markup.button.callback('👤 Найти контакт', 'tlmx_panel:contacts'), Markup.button.callback('🚫 Чаты', 'tlmx_panel:chats')],
      [Markup.button.callback('🔐 Вход в MAX', 'tlmx_panel:web'), Markup.button.callback('⚙️ Система', 'tlmx_panel:system')],
    ]).reply_markup,
  };
}
function contactsView(): View {
  return {
    text: '👤 Найти контакт в MAX:',
    markup: Markup.inlineKeyboard([
      [Markup.button.callback('🔢 По номеру', 'tlmx_panel:find:phone'), Markup.button.callback('@ По нику', 'tlmx_panel:find:nick')],
      [Markup.button.callback('◀️ Назад', 'tlmx_panel:root')],
    ]).reply_markup,
  };
}
function chatsView(): View {
  return {
    text: '🚫 Управление чатами:',
    markup: Markup.inlineKeyboard([
      [Markup.button.callback('🚫 Забанить', 'tlmx_panel:ban'), Markup.button.callback('✅ Разбанить', 'tlmx_panel:unban')],
      [Markup.button.callback('◀️ Назад', 'tlmx_panel:root')],
    ]).reply_markup,
  };
}
function webView(botUsername?: string): View {
  // Auth is a deep link into the bot's DM (t.me/<bot>?start=login) — SMS code and 2FA password
  // are entered privately there, never in the group. Button shown only once we know the username.
  const rows = [
    ...(botUsername ? [[Markup.button.url('🔐 Войти в MAX', `https://t.me/${botUsername}?start=login`)]] : []),
    [Markup.button.callback('◀️ Назад', 'tlmx_panel:root')],
  ];
  return {
    text: botUsername
      ? '🔐 Вход в MAX — в личке бота:\nнажмите кнопку (или напишите боту в личку /login). Код и пароль не попадут в группу.'
      : '🔐 Вход в MAX: напишите боту в личку /login.',
    markup: Markup.inlineKeyboard(rows).reply_markup,
  };
}
function systemView(): View {
  const pauseBtn = isPaused()
    ? Markup.button.callback('▶️ Возобновить MAX', 'tlmx_panel:resume')
    : Markup.button.callback('⏸ Пауза MAX', 'tlmx_panel:pause');
  return {
    text: '⚙️ Система:',
    markup: Markup.inlineKeyboard([
      [pauseBtn, Markup.button.callback('⬆️ Обновление', 'tlmx_panel:update')],
      [Markup.button.callback('🔄 Пересинхронизация', 'tlmx_panel:resync'), Markup.button.callback('📋 Команды', 'tlmx_panel:help')],
      [Markup.button.callback('◀️ Назад', 'tlmx_panel:root')],
    ]).reply_markup,
  };
}
function pauseView(): View {
  return {
    text: '⏸ На сколько поставить MAX на паузу? Приём/отправка остановятся, авто-возобновление по таймеру.',
    markup: Markup.inlineKeyboard([
      [Markup.button.callback('10 минут', 'tlmx_panel:pause:600'), Markup.button.callback('1 час', 'tlmx_panel:pause:3600')],
      [Markup.button.callback('1 сутки', 'tlmx_panel:pause:86400'), Markup.button.callback('Навсегда', 'tlmx_panel:pause:0')],
      [Markup.button.callback('◀️ Назад', 'tlmx_panel:system')],
    ]).reply_markup,
  };
}

export function wireControlPanel(deps: ControlPanelDeps): void {
  const { bot, targetGroupId, max, getActivePhone, triggerFullResync, leaves, startDialog } = deps;

  const edit = (ctx: Context, view: View) => ctx.editMessageText(view.text, { reply_markup: view.markup }).catch(() => {});
  const chatIdOf = (ctx: Context): number => ctx.chat?.id ?? Number(targetGroupId);

  // --- Startup: edit the remembered pinned panel, or post + pin a fresh one -----------
  async function postAndPin(): Promise<void> {
    const { text, markup } = rootView(getActivePhone());
    const sent = await bot.telegram.sendMessage(targetGroupId, text, { reply_markup: markup });
    await bot.telegram.pinChatMessage(targetGroupId, sent.message_id, { disable_notification: true }).catch(() => {});
    await mkdir(path.dirname(PANEL_MARKER), { recursive: true }).catch(() => {});
    await writeFile(PANEL_MARKER, String(sent.message_id), 'utf8').catch(() => {});
  }
  async function restoreOrPost(): Promise<void> {
    let stored: number | null = null;
    try {
      stored = Number((await readFile(PANEL_MARKER, 'utf8')).trim()) || null;
    } catch {
      stored = null;
    }
    if (stored != null) {
      const { text, markup } = rootView(getActivePhone());
      try {
        await bot.telegram.editMessageText(targetGroupId, stored, undefined, text, { reply_markup: markup });
        await bot.telegram.pinChatMessage(targetGroupId, stored, { disable_notification: true }).catch(() => {});
        return;
      } catch (err) {
        // "message is not modified" means the panel already exists and is current — Telegram just
        // refuses a no-op edit (the panel text is unchanged since last start). Re-pin the existing
        // one and keep it, instead of posting a FRESH panel — which notifies the group AND piles up
        // a duplicate pinned panel on every restart/update (each update.sh restart hit this).
        // Only a genuinely deleted/uneditable message falls through to a fresh post.
        if (/not modified/i.test((err as Error)?.message ?? '')) {
          await bot.telegram.pinChatMessage(targetGroupId, stored, { disable_notification: true }).catch(() => {});
          return;
        }
        // Message was deleted / uneditable — fall through and post a fresh one.
      }
    }
    await postAndPin().catch((err) => logger.error('Failed to post control panel', err));
  }
  // Fire-and-forget on wire-up; a small delay lets the bot finish coming up first.
  setTimeout(() => void restoreOrPost(), 4000);

  bot.command('panel', async (ctx) => {
    await postAndPin().catch((err) => logger.error('Failed to post control panel (/panel)', err));
    await ctx.deleteMessage().catch(() => {}); // remove the "/panel" command message
  });

  // --- Navigation ---------------------------------------------------------------------
  bot.action('tlmx_panel:root', async (ctx) => {
    await ctx.answerCbQuery();
    await edit(ctx, rootView(getActivePhone()));
  });
  bot.action('tlmx_panel:contacts', async (ctx) => {
    await ctx.answerCbQuery();
    await edit(ctx, contactsView());
  });
  bot.action('tlmx_panel:chats', async (ctx) => {
    await ctx.answerCbQuery();
    await edit(ctx, chatsView());
  });
  bot.action('tlmx_panel:web', async (ctx) => {
    await ctx.answerCbQuery();
    await edit(ctx, webView(ctx.botInfo?.username));
  });
  bot.action('tlmx_panel:system', async (ctx) => {
    await ctx.answerCbQuery();
    await edit(ctx, systemView());
  });
  bot.action('tlmx_panel:pause', async (ctx) => {
    await ctx.answerCbQuery();
    await edit(ctx, pauseView());
  });
  bot.action('tlmx_panel:dismiss', async (ctx) => {
    await ctx.answerCbQuery();
    await ctx.deleteMessage().catch(() => {});
  });

  // --- Leaves that spawn their own message (reuse the slash-command output) -----------
  bot.action('tlmx_panel:help', async (ctx) => {
    await ctx.answerCbQuery();
    await leaves.sendHelp(chatIdOf(ctx));
  });
  bot.action('tlmx_panel:update', async (ctx) => {
    await ctx.answerCbQuery();
    await leaves.sendVersion(chatIdOf(ctx));
  });
  bot.action('tlmx_panel:ban', async (ctx) => {
    await ctx.answerCbQuery();
    await leaves.sendBanList(chatIdOf(ctx));
  });
  bot.action('tlmx_panel:unban', async (ctx) => {
    await ctx.answerCbQuery();
    await leaves.sendUnbanList(chatIdOf(ctx));
  });
  bot.action('tlmx_panel:resync', async (ctx) => {
    await ctx.answerCbQuery('Пересинхронизация запущена');
    await ctx.reply('🔄 Пересинхронизация запущена…').catch(() => {});
    void triggerFullResync().catch((err) => logger.error('panel resync failed', err));
  });

  // --- Pause / resume -----------------------------------------------------------------
  bot.action('tlmx_panel:resume', async (ctx) => {
    clearPauseTimer();
    pauseUntil = null;
    max.connect();
    await ctx.answerCbQuery('MAX возобновлён');
    await edit(ctx, systemView());
  });
  bot.action(/^tlmx_panel:pause:(\d+)$/, async (ctx) => {
    const secs = Number(ctx.match[1]);
    clearPauseTimer();
    max.disconnect();
    if (secs === 0) {
      pauseUntil = Number.POSITIVE_INFINITY;
    } else {
      pauseUntil = Date.now() + secs * 1000;
      pauseTimer = setTimeout(() => {
        pauseUntil = null;
        pauseTimer = null;
        max.connect();
      }, secs * 1000);
    }
    await ctx.answerCbQuery('MAX на паузе');
    await edit(ctx, systemView());
  });

  // --- Contact search -----------------------------------------------------------------
  async function promptSearch(ctx: Context, mode: SearchMode): Promise<void> {
    const label = mode === 'phone' ? 'номер телефона (с + или без)' : 'имя или ник';
    const sent = await bot.telegram.sendMessage(chatIdOf(ctx), `🔎 Отправьте ${label} в ответ на это сообщение:`, {
      reply_markup: { force_reply: true, input_field_placeholder: mode === 'phone' ? '+79991234567' : 'Имя' },
    });
    pendingSearch.set(sent.message_id, { mode, requesterId: ctx.from?.id ?? 0 });
  }
  bot.action('tlmx_panel:find:phone', async (ctx) => {
    await ctx.answerCbQuery();
    await promptSearch(ctx, 'phone');
  });
  bot.action('tlmx_panel:find:nick', async (ctx) => {
    await ctx.answerCbQuery();
    await promptSearch(ctx, 'nick');
  });

  async function sendCard(chatId: number, c: MaxContactInfo): Promise<void> {
    const uid = String(c.id);
    const name = contactName(c);
    const onMax = isOnMax(c);
    shownContacts.set(uid, { name, onMax });
    const phone = c.phone != null ? ` · ${String(c.phone)}` : '';
    const country = c.country ? ` · ${c.country}` : '';
    const text = `👤 ${name}\nID ${uid}${phone}${country}${onMax ? '' : '\n⚠️ Контакт не в MAX — начать чат нельзя.'}`;
    const buttons = onMax
      ? [Markup.button.callback('💬 Начать чат', `tlmx_panel:startchat:${uid}`), Markup.button.callback('◀️ Готово', 'tlmx_panel:dismiss')]
      : [Markup.button.callback('◀️ Готово', 'tlmx_panel:dismiss')];
    await bot.telegram.sendMessage(chatId, text, { reply_markup: Markup.inlineKeyboard(buttons, { columns: 1 }).reply_markup });
  }

  async function runSearch(chatId: number, mode: SearchMode, query: string): Promise<void> {
    try {
      if (mode === 'phone') {
        const contact = await max.searchContactByPhone(query);
        if (!contact) {
          await bot.telegram.sendMessage(chatId, '❌ Контакт по этому номеру не найден в MAX.');
          return;
        }
        await sendCard(chatId, contact);
        return;
      }
      const list = await max.publicSearch(query, 8);
      if (list.length === 0) {
        await bot.telegram.sendMessage(chatId, '❌ Ничего не найдено.');
        return;
      }
      if (list.length === 1) {
        await sendCard(chatId, list[0]!);
        return;
      }
      for (const c of list) shownContacts.set(String(c.id), { name: contactName(c), onMax: isOnMax(c) });
      const buttons = list
        .slice(0, 8)
        .map((c) => Markup.button.callback(`${contactName(c)}${isOnMax(c) ? '' : ' (не в MAX)'}`, `tlmx_panel:pick:${String(c.id)}`));
      await bot.telegram.sendMessage(chatId, `Нашёл ${list.length}. Выберите:`, {
        reply_markup: Markup.inlineKeyboard(buttons, { columns: 1 }).reply_markup,
      });
    } catch (err) {
      logger.error('panel contact search failed', err);
      await bot.telegram.sendMessage(chatId, `❌ Поиск не удался: ${(err as Error).message}`).catch(() => {});
    }
  }

  bot.action(/^tlmx_panel:pick:(.+)$/, async (ctx) => {
    await ctx.answerCbQuery();
    const uid = ctx.match?.[1];
    if (!uid) return;
    const info = shownContacts.get(uid);
    if (!info) {
      await ctx.editMessageText('Список устарел — повторите поиск.').catch(() => {});
      return;
    }
    const text = `👤 ${info.name}\nID ${uid}${info.onMax ? '' : '\n⚠️ Не в MAX — начать чат нельзя.'}`;
    const buttons = info.onMax
      ? [Markup.button.callback('💬 Начать чат', `tlmx_panel:startchat:${uid}`), Markup.button.callback('◀️ Готово', 'tlmx_panel:dismiss')]
      : [Markup.button.callback('◀️ Готово', 'tlmx_panel:dismiss')];
    await ctx.editMessageText(text, { reply_markup: Markup.inlineKeyboard(buttons, { columns: 1 }).reply_markup }).catch(() => {});
  });

  bot.action(/^tlmx_panel:startchat:(.+)$/, async (ctx) => {
    const uid = ctx.match?.[1];
    if (!uid) return;
    // Name usually comes from a prior search card (shownContacts). For a button sourced from a group
    // ROSTER (no prior search), fall back to a fresh CONTACT_INFO lookup so the topic gets a real name.
    let name = shownContacts.get(uid)?.name;
    if (!name) {
      try {
        const contacts = await max.getContactInfo([Number(uid)]);
        if (contacts[0]) name = contactName(contacts[0]);
      } catch (err) {
        logger.error(`Failed to resolve contact ${uid} for startchat`, err);
      }
      name = name ?? `MAX ${uid}`;
    }
    await ctx.answerCbQuery('Открываю чат…');
    const res = await startDialog(uid, name).catch((err) => ({
      ok: false,
      error: (err as Error).message,
      topicName: name,
      chatLink: undefined as string | undefined,
      existed: false,
    }));
    if (res.ok) {
      const verb = res.existed ? 'уже был — открыл' : 'создан';
      const markup = res.chatLink ? Markup.inlineKeyboard([Markup.button.url('➡️ Открыть чат', res.chatLink)]).reply_markup : undefined;
      await ctx.editMessageText(`✅ Чат с «${res.topicName}» ${verb}.`, markup ? { reply_markup: markup } : {}).catch(() => {});
    } else {
      await ctx.editMessageText(`❌ Не удалось создать чат: ${res.error ?? 'ошибка'}`).catch(() => {});
    }
  });

  // Force-reply answers to a search prompt. Registered here (early in wireBridge) so it
  // runs before the main relay handler; anything that isn't a reply to one of our
  // prompts is passed straight through with next().
  bot.on('message', async (ctx, next) => {
    const msg = ctx.message as { reply_to_message?: { message_id: number }; text?: string };
    const replyTo = msg.reply_to_message?.message_id;
    if (replyTo == null || !pendingSearch.has(replyTo)) return next();
    const pending = pendingSearch.get(replyTo)!;
    if (ctx.from?.id !== pending.requesterId) return next();
    pendingSearch.delete(replyTo);
    const query = (msg.text ?? '').trim();
    if (!query) {
      await ctx.reply('Пусто — отмена.').catch(() => {});
      return;
    }
    await runSearch(chatIdOf(ctx), pending.mode, query);
    // consumed — do NOT call next()
  });
}
