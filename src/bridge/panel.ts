import path from 'node:path';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { Markup, type Telegraf, type Context } from 'telegraf';
import type { MaxClient, MaxContactInfo } from '../max/client.js';
import { getAppVersion } from './version.js';
import { formatBytes, maskPhone } from './status.js';
import { createLogger } from '../logger.js';
import { truncateUtf16 } from './text.js';
import { formatExpiry } from './bigFiles.js';
import type { FileShare, StoredFile } from './fileShare.js';

const logger = createLogger('panel');

/** Sends one of the reused command outputs (help, version, ban/unban list) to a chat. */
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
  /** Resolves a display name for a MAX user id from the WARM contact-profile cache only (undefined on a
   * miss). Lets the group-roster "Открыть личку" name a participant without a blocking CONTACT_INFO
   * round-trip — the same instant-name behaviour the search path gets from its own card cache. */
  resolveContactName?: (uid: string) => string | undefined;
  /** Builds the «📊 Статус» text; `pausedLabel` is the pause state (null when not paused). */
  getStatus?: (pausedLabel: string | null) => Promise<string>;
  /** The MAX pause (server/maxSession.ts owns it): a deliberate disconnect with no auto-reconnect until resumed or the timer fires. */
  pause: PauseControl;
  /** Big files kept for download links — the «📁 Файлы» section. */
  files?: FileShare;
  /** «📤 Отправить в MAX» for a stored file that didn't make it (bigFiles.ts). */
  resendToMax?: (id: string) => Promise<{ ok: boolean; text: string }>;
}

export interface PauseControl {
  /** Disconnects MAX for `seconds` (0 = until stop()). */
  start(seconds: number): void;
  /** Reconnects; false when not paused (a stale button). */
  stop(): boolean;
  /** Epoch ms the pause ends at (Number.POSITIVE_INFINITY = until stop()); null when not paused. */
  until(): number | null;
}

// The panel message id is remembered in ./data so the same pinned message is edited
// across restarts instead of spamming a new one each time (mirrors the welcome-sent
// marker in server/app.ts).
const PANEL_MARKER = path.join(process.cwd(), '.data', 'panel-message');

/** «до возобновления…» / «~N мин» for a pause ending at `until`; null when not paused. Pause lives in memory only: any container restart — including an auto-update — resumes MAX, so «навсегда» was a promise the code never kept. */
function pauseLabel(until: number | null): string | null {
  if (until == null) return null;
  return until === Number.POSITIVE_INFINITY ? 'до возобновления или перезапуска моста' : `~${Math.max(0, Math.round((until - Date.now()) / 60000))} мин`;
}

// --- Contact-search force-reply correlation ------------------------------------------
type SearchMode = 'phone' | 'nick' | 'id';
const pendingSearch = new Map<number, { mode: SearchMode; requesterId: number }>();
// Contacts shown with a "Начать чат" button, so the tap knows the display name / MAX
// membership without re-fetching. Keyed by userId (string).
const shownContacts = new Map<string, { name: string; onMax: boolean; bot?: boolean }>();

// Both maps live for the whole process and only ever grew (an abandoned search prompt,
// every contact ever shown) — bound them FIFO so months of uptime can't leak memory.
const PANEL_MAP_CAP = 200;
function boundedSet<K, V>(map: Map<K, V>, key: K, value: V): void {
  if (!map.has(key) && map.size >= PANEL_MAP_CAP) {
    const oldest = map.keys().next().value;
    if (oldest !== undefined) map.delete(oldest);
  }
  map.set(key, value);
}

function contactName(c: MaxContactInfo): string {
  const names = c.names ?? [];
  const primary = names.find((n) => n.type === 'ONEME') ?? names[0];
  const full = [primary?.firstName, primary?.lastName].filter(Boolean).join(' ').trim();
  // Surrogate-safe cut: a lone half of an emoji makes Telegram refuse the whole button list.
  return truncateUtf16(primary?.name || full || `MAX ${String(c.id)}`, 120);
}
function isOnMax(c: MaxContactInfo): boolean {
  return Array.isArray(c.options) && c.options.includes('ONEME');
}
function isBot(c: MaxContactInfo): boolean {
  return Array.isArray(c.options) && c.options.includes('BOT');
}
/** `maxbot` from `https://max.ru/maxbot`; undefined for a profile without a public link. */
function linkSlug(link: string | undefined): string | undefined {
  const m = link ? /max\.ru\/([^/?#]+)\/?$/i.exec(link) : null;
  return m?.[1];
}

/**
 * What the user typed into the nick search → the PUBLIC_SEARCH query. Accepts `@nick`, `nick` and a
 * pasted `max.ru/nick` link (MAX finds nothing for a query with «@»). A link with a deeper path
 * (`max.ru/u/…`, `max.ru/join/…`) is a personal or invite link, which the catalog can't resolve.
 */
export function normalizeNickQuery(raw: string): { query: string } | { personalLink: true } | null {
  let q = raw.trim();
  const link = /^(?:https?:\/\/)?(?:www\.)?max\.ru\/(.*)$/i.exec(q);
  if (link) {
    const path = link[1]!.split(/[?#]/)[0]!.replace(/\/+$/, '');
    if (path.includes('/')) return { personalLink: true };
    q = path;
  }
  q = q.replace(/^@+/, '').trim();
  return q ? { query: q } : null;
}

type View = { text: string; markup: ReturnType<typeof Markup.inlineKeyboard>['reply_markup'] };

function rootView(phone: string, pausedUntil: number | null): View {
  const version = getAppVersion();
  const paused = pauseLabel(pausedUntil);
  let status: string;
  if (paused) {
    status = `⏸ MAX на паузе (${paused})`;
  } else if (!phone) {
    // No session yet (fresh install, or after /kill): must not look green — the user read it as "ok".
    status = '🔴 MAX: не авторизован — /login';
  } else {
    // The panel card is pinned in a group every member can read, and status.ts already decided the
    // full number shouldn't be on display — same rule here.
    status = `🟢 MAX: ${maskPhone(phone)}`;
  }
  return {
    text: `🎛 Telemax — пульт\n${status} · версия ${version}`,
    markup: Markup.inlineKeyboard([
      [Markup.button.callback('👤 Найти контакт', 'tlmx_panel:contacts'), Markup.button.callback('🚫 Чаты', 'tlmx_panel:chats')],
      [Markup.button.callback('🔐 Вход в MAX', 'tlmx_panel:web'), Markup.button.callback('⚙️ Система', 'tlmx_panel:system')],
      [Markup.button.callback('📁 Файлы', 'tlmx_panel:files')],
    ]).reply_markup,
  };
}

/** 72 h → «3 дня», 12 h → «12 ч». */
function ttlText(ms: number): string {
  const hours = Math.round(ms / 3600_000);
  if (hours % 24 !== 0) return `${hours} ч`;
  const d = hours / 24;
  const word = d % 10 === 1 && d % 100 !== 11 ? 'день' : [2, 3, 4].includes(d % 10) && ![12, 13, 14].includes(d % 100) ? 'дня' : 'дней';
  return `${d} ${word}`;
}

function filesView(files: FileShare): View {
  const back = [Markup.button.callback('◀️ Назад', 'tlmx_panel:root')];
  if (!files.enabled) {
    return { text: '📁 Пересылка больших файлов отключена: FILES=off в .env.', markup: Markup.inlineKeyboard([back]).reply_markup };
  }
  const list = files.list();
  const saving = files.inProgress();
  const pending = files.pendingUploads();
  const ttl = ttlText(files.opts.ttlMs);
  const savingLines = saving.map((x) => `⏳ Сохраняется: ${x.name} — ${formatBytes(x.written)} из ${formatBytes(x.size)}`);
  const pendingLine = pending ? `⏳ Ждут загрузки по ссылке: ${pending}` : '';
  const footer =
    'Здесь хранятся файлы, которые мост держит на сервере для скачивания по ссылке:\n' +
    '• файлы из MAX больше 50 МБ — Telegram не принимает от ботов такие файлы напрямую;\n' +
    '• загруженные для отправки в MAX, но не ушедшие из-за ошибки — их можно отправить ещё раз.\n\n' +
    'Файлы, которые уже ушли в MAX, на сервере не остаются.\n' +
    `Файлы со ссылкой хранятся ${ttl} от последней выданной ссылки, потом удаляются.`;
  const extra = [...savingLines, pendingLine].filter(Boolean).join('\n');
  if (list.length === 0) {
    return {
      text: `📁 Файлов нет.${extra ? `\n\n${extra}` : ''}\n\n${footer}`,
      markup: Markup.inlineKeyboard([[Markup.button.callback('🔄 Обновить', 'tlmx_panel:files')], back]).reply_markup,
    };
  }
  const total = list.reduce((s, f) => s + f.size, 0);
  const lines = list.map((f, i) => `${i + 1}. ${f.direction === 'max2tg' ? '⬇️' : '⬆️'} ${f.name} — ${formatBytes(f.size)}, до ${formatExpiry(f.expiresAt)}`);
  return {
    text: `📁 Файлы на сервере: ${list.length}, всего ${formatBytes(total)}.\n⬇️ — из MAX, ⬆️ — не ушли в MAX.\n\n${lines.join('\n')}${extra ? `\n\n${extra}` : ''}\n\n${footer}`,
    markup: Markup.inlineKeyboard([
      ...list.slice(0, 20).map((f, i) => [Markup.button.callback(`${i + 1}. ${truncateUtf16(f.name, 48)}`, `tlmx_panel:file:${f.id}`)]),
      [Markup.button.callback('🔄 Обновить', 'tlmx_panel:files')],
      back,
    ]).reply_markup,
  };
}

function fileCardView(f: StoredFile, files: FileShare, link?: string, canResend = false): View {
  const where = f.direction === 'max2tg' ? 'пришёл из MAX' : 'загружен для MAX';
  const linkLine = link ? `\n\n🔗 ${link}\nСсылку можно переслать — по ней откроется страница со скачиванием.` : '';
  return {
    text: `📄 ${f.name}\n${formatBytes(f.size)} · ${where}\nХранится до ${formatExpiry(f.expiresAt)}, потом удалится.${linkLine}`,
    markup: Markup.inlineKeyboard([
      ...(link ? [[Markup.button.url('⬇️ Открыть ссылку', link)]] : []),
      ...(canResend && f.direction === 'tg2max' && f.target ? [[Markup.button.callback('📤 Отправить в MAX', `tlmx_panel:fsend:${f.id}`)]] : []),
      [Markup.button.callback(`🔗 Новая ссылка (+${ttlText(files.opts.ttlMs)})`, `tlmx_panel:frenew:${f.id}`)],
      [Markup.button.callback('🗑 Удалить', `tlmx_panel:fdel:${f.id}`)],
      [Markup.button.callback('◀️ К файлам', 'tlmx_panel:files')],
    ]).reply_markup,
  };
}
function contactsView(): View {
  return {
    text: '👤 Найти контакт в MAX:',
    markup: Markup.inlineKeyboard([
      [Markup.button.callback('🔢 По номеру', 'tlmx_panel:find:phone'), Markup.button.callback('@ По нику', 'tlmx_panel:find:nick')],
      [Markup.button.callback('🆔 По ID', 'tlmx_panel:find:id')],
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
function systemView(paused: boolean): View {
  const pauseBtn = paused
    ? Markup.button.callback('▶️ Возобновить MAX', 'tlmx_panel:resume')
    : Markup.button.callback('⏸ Пауза MAX', 'tlmx_panel:pause');
  return {
    text: '⚙️ Система:',
    markup: Markup.inlineKeyboard([
      [Markup.button.callback('📊 Статус', 'tlmx_panel:status')],
      [pauseBtn, Markup.button.callback('⬆️ Обновление', 'tlmx_panel:update')],
      [Markup.button.callback('🔄 Пересинхронизация', 'tlmx_panel:resync'), Markup.button.callback('📋 Команды', 'tlmx_panel:help')],
      [Markup.button.callback('◀️ Назад', 'tlmx_panel:root')],
    ]).reply_markup,
  };
}
function pauseView(): View {
  return {
    text: '⏸ На сколько поставить MAX на паузу? Приём/отправка остановятся, авто-возобновление по таймеру.\nПауза живёт в памяти: перезапуск моста (в том числе автообновление) снимет её в любом случае.',
    markup: Markup.inlineKeyboard([
      [Markup.button.callback('10 минут', 'tlmx_panel:pause:600'), Markup.button.callback('1 час', 'tlmx_panel:pause:3600')],
      [Markup.button.callback('1 сутки', 'tlmx_panel:pause:86400'), Markup.button.callback('До перезапуска', 'tlmx_panel:pause:0')],
      [Markup.button.callback('◀️ Назад', 'tlmx_panel:system')],
    ]).reply_markup,
  };
}

export function wireControlPanel(deps: ControlPanelDeps): void {
  const { bot, targetGroupId, max, getActivePhone, triggerFullResync, leaves, startDialog, resolveContactName, getStatus, pause, files, resendToMax } = deps;
  const card = (f: StoredFile, link?: string): View => fileCardView(f, files!, link, Boolean(resendToMax));
  const root = (): View => rootView(getActivePhone(), pause.until());
  const system = (): View => systemView(pause.until() != null);

  const edit = (ctx: Context, view: View) =>
    ctx.editMessageText(view.text, { reply_markup: view.markup }).catch((err) => {
      // «not modified» is a no-op; anything else used to vanish here without a trace.
      if (!/not modified/i.test((err as Error)?.message ?? '')) logger.error('Panel edit failed', err);
    });
  const chatIdOf = (ctx: Context): number => ctx.chat?.id ?? Number(targetGroupId);

  // --- Startup: edit the remembered pinned panel, or post + pin a fresh one -----------
  async function postAndPin(): Promise<void> {
    const { text, markup } = root();
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
      const { text, markup } = root();
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
  // unref (as with every maintenance timer): must not hold the process open during shutdown.
  setTimeout(() => void restoreOrPost(), 4000).unref();

  bot.command('panel', async (ctx) => {
    await postAndPin().catch((err) => logger.error('Failed to post control panel (/panel)', err));
    await ctx.deleteMessage().catch(() => {}); // remove the "/panel" command message
  });

  // --- Navigation ---------------------------------------------------------------------
  bot.action('tlmx_panel:root', async (ctx) => {
    await ctx.answerCbQuery();
    await edit(ctx, root());
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
    await edit(ctx, system());
  });
  bot.action('tlmx_panel:pause', async (ctx) => {
    await ctx.answerCbQuery();
    await edit(ctx, pauseView());
  });
  // --- Big files («📁 Файлы»): list, a fresh link (+TTL), delete ------------------------------
  bot.action('tlmx_panel:files', async (ctx) => {
    await ctx.answerCbQuery();
    if (files) await edit(ctx, filesView(files));
  });
  bot.action(/^tlmx_panel:file:(.+)$/, async (ctx) => {
    await ctx.answerCbQuery();
    const f = files?.get(ctx.match[1] ?? '');
    if (!files || !f) {
      if (files) await edit(ctx, filesView(files));
      return;
    }
    await edit(ctx, card(f));
  });
  bot.action(/^tlmx_panel:frenew:(.+)$/, async (ctx) => {
    const id = ctx.match[1] ?? '';
    // Answered first: the service may take a minute or two to start, far past the callback's life.
    await ctx.answerCbQuery('Готовлю ссылку…').catch(() => {});
    const f = files ? await files.renew(id) : undefined;
    if (!files || !f) {
      if (files) await edit(ctx, filesView(files));
      return;
    }
    const logFail = (err: unknown) => logger.error(`Panel: editing the file card of «${f.name}» failed`, err);
    await ctx.editMessageText(`⏳ Готовлю ссылку на «${f.name}»… Если служба файлов не запущена, это займёт до пары минут.`).catch(logFail);
    const svc = await files.ensureService();
    logger.info(`Panel: new link for «${f.name}» — service ${svc.ok ? `up at ${svc.url}` : `unavailable: ${svc.reason}`}`);
    if (!svc.ok) {
      const c = card(f);
      await ctx.editMessageText(`${c.text}\n\n⚠️ Ссылку подготовить не удалось: ${svc.reason}.`, { reply_markup: c.markup }).catch(logFail);
      return;
    }
    await edit(ctx, card(f, `${svc.url}/f/${f.token}`));
  });
  bot.action(/^tlmx_panel:fsend:(.+)$/, async (ctx) => {
    const f = files?.get(ctx.match[1] ?? '');
    await ctx.answerCbQuery(f ? 'Отправляю в MAX…' : 'Файла уже нет').catch(() => {});
    if (!files || !f || !resendToMax) return;
    await ctx.editMessageText(`⏳ Отправляю «${f.name}» в MAX… Большой файл MAX обрабатывает несколько минут — сообщение обновится само.`).catch(() => {});
    const r = await resendToMax(f.id);
    const back = Markup.inlineKeyboard([[Markup.button.callback('◀️ К файлам', 'tlmx_panel:files')]]).reply_markup;
    await ctx.editMessageText(r.text, { reply_markup: back }).catch(() => {});
  });
  bot.action(/^tlmx_panel:fdel:(.+)$/, async (ctx) => {
    const removed = files ? await files.remove(ctx.match[1] ?? '') : false;
    await ctx.answerCbQuery(removed ? 'Файл удалён' : 'Файла уже нет').catch(() => {});
    if (files) await edit(ctx, filesView(files));
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
    // Without a MAX session CHATS_LIST is rejected ("Недопустимое состояние сессии") and the only
    // trace was a stack in the log while the user read "запущена" (hit live 2026-09-11 right after a
    // fresh install). Say it plainly instead; after /login the sync starts by itself anyway.
    if (!getActivePhone()) {
      await ctx.answerCbQuery('MAX не авторизован — сначала /login').catch(() => {});
      await ctx.reply('⛔ MAX не авторизован — сначала войдите: /login в личке бота. После входа синхронизация запустится сама.').catch(() => {});
      return;
    }
    await ctx.answerCbQuery('Пересинхронизация запущена');
    await ctx.reply('🔄 Пересинхронизация запущена…').catch(() => {});
    void triggerFullResync().catch((err) => logger.error('panel resync failed', err));
  });

  // «📊 Статус»: server/bridge health in one card (see status.ts for what is and isn't visible).
  bot.action('tlmx_panel:status', async (ctx) => {
    await ctx.answerCbQuery().catch(() => {});
    if (!getStatus) return;
    let text: string;
    try {
      text = await getStatus(pauseLabel(pause.until()));
    } catch (err) {
      logger.error('panel status failed', err);
      text = '❌ Не удалось собрать статус — смотрите логи контейнера.';
    }
    await ctx
      .editMessageText(text, {
        reply_markup: Markup.inlineKeyboard([[Markup.button.callback('🔄 Обновить', 'tlmx_panel:status'), Markup.button.callback('◀️ Назад', 'tlmx_panel:system')]]).reply_markup,
      })
      .catch(() => {});
  });

  // --- Pause / resume -----------------------------------------------------------------
  bot.action('tlmx_panel:resume', async (ctx) => {
    // A stale button (the pause already ended: its timer, /login, /kill) must not tear down the
    // live socket — an auth chain may be running on it.
    await ctx.answerCbQuery(pause.stop() ? 'MAX возобновлён' : 'MAX не на паузе').catch(() => {});
    await edit(ctx, system());
  });
  bot.action(/^tlmx_panel:pause:(\d+)$/, async (ctx) => {
    pause.start(Number(ctx.match[1]));
    await ctx.answerCbQuery('MAX на паузе');
    await edit(ctx, system());
  });

  // --- Contact search -----------------------------------------------------------------
  async function promptSearch(ctx: Context, mode: SearchMode): Promise<void> {
    // The MAX catalog holds public bots and channels only (probed live 2026-10-05) — say so up front,
    // or a person's nick (or a Telegram @username) just ends in «Ничего не найдено».
    const text =
      mode === 'phone'
        ? '🔎 Отправьте номер телефона (с + или без) в ответ на это сообщение:'
        : mode === 'id'
          ? '🔎 Отправьте MAX ID (число — например, из карточки группы или из сообщения о выходе участника) в ответ на это сообщение:'
          : '🔎 Отправьте в ответ на это сообщение ник бота или канала MAX, ссылку max.ru/… или их название.\nЛюдей по нику не найти — их ищите по номеру или MAX ID. Ник из Telegram тоже не подойдёт.';
    const sent = await bot.telegram.sendMessage(chatIdOf(ctx), text, {
      reply_markup: { force_reply: true, input_field_placeholder: mode === 'phone' ? '+79991234567' : mode === 'id' ? '123456789' : '@nick или max.ru/nick' },
    });
    boundedSet(pendingSearch, sent.message_id, { mode, requesterId: ctx.from?.id ?? 0 });
    // A force_reply prompt left in the chat keeps popping up as «В ответ …» in Telegram Desktop
    // whenever the bot posts or edits something later (seen live 2026-10-09) — so it doesn't stay:
    // removed once answered (below) or after 10 minutes unanswered.
    setTimeout(() => {
      if (!pendingSearch.delete(sent.message_id)) return;
      void bot.telegram.deleteMessage(chatIdOf(ctx), sent.message_id).catch(() => {});
    }, 10 * 60_000).unref();
  }
  bot.action('tlmx_panel:find:phone', async (ctx) => {
    await ctx.answerCbQuery();
    await promptSearch(ctx, 'phone');
  });
  bot.action('tlmx_panel:find:nick', async (ctx) => {
    await ctx.answerCbQuery();
    await promptSearch(ctx, 'nick');
  });
  bot.action('tlmx_panel:find:id', async (ctx) => {
    await ctx.answerCbQuery();
    await promptSearch(ctx, 'id');
  });

  async function sendCard(chatId: number, c: MaxContactInfo): Promise<void> {
    const uid = String(c.id);
    const name = contactName(c);
    const onMax = isOnMax(c);
    boundedSet(shownContacts, uid, { name, onMax, bot: isBot(c) });
    const phone = c.phone != null ? ` · ${String(c.phone)}` : '';
    const country = c.country ? ` · ${c.country}` : '';
    const slug = linkSlug(c.link);
    const nick = slug ? ` · @${slug}` : '';
    const text = `${isBot(c) ? '🤖' : '👤'} ${name}\nID ${uid}${nick}${phone}${country}${onMax ? '' : '\n⚠️ Контакт не в MAX — начать чат нельзя.'}`;
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
      if (mode === 'id') {
        // Any MAX ID the bridge prints (roster card, member events) can be pasted here to open a chat.
        const id = Number(query.replace(/\D/g, ''));
        if (!Number.isInteger(id) || id <= 0) {
          await bot.telegram.sendMessage(chatId, '❌ MAX ID — это число, например 123456789.');
          return;
        }
        const [contact] = await max.getContactInfo([id]);
        if (!contact) {
          await bot.telegram.sendMessage(chatId, '❌ Контакт с таким MAX ID не найден.');
          return;
        }
        await sendCard(chatId, contact);
        return;
      }
      const parsed = normalizeNickQuery(query);
      if (parsed == null) {
        await bot.telegram.sendMessage(chatId, 'Пусто — отмена.');
        return;
      }
      if ('personalLink' in parsed) {
        await bot.telegram.sendMessage(chatId, '❌ Это личная ссылка или приглашение — поиск MAX их не открывает. Откройте её в приложении MAX или найдите человека по номеру либо MAX ID.');
        return;
      }
      const { contacts, channels: allChannels } = await max.publicSearch(parsed.query, 8);
      const channels = allChannels.filter((ch) => ch.link);
      logger.info(`Nick search "${parsed.query}": ${contacts.length} contact(s), ${channels.length} channel(s)`);
      // An exact nick wins over everything the catalog matched by title.
      const exact = contacts.filter((c) => linkSlug(c.link)?.toLowerCase() === parsed.query.toLowerCase());
      if (exact.length === 1 || (contacts.length === 1 && channels.length === 0)) {
        await sendCard(chatId, exact[0] ?? contacts[0]!);
        return;
      }
      if (contacts.length === 0 && channels.length === 0) {
        await bot.telegram.sendMessage(chatId, '❌ Ничего не найдено. По нику находятся только боты и каналы MAX; людей ищите по номеру или MAX ID.');
        return;
      }
      for (const c of contacts) boundedSet(shownContacts, String(c.id), { name: contactName(c), onMax: isOnMax(c), bot: isBot(c) });
      // Channels can't be opened as a bridge topic — a link into MAX is all we can offer.
      const buttons = [
        ...contacts.map((c) =>
          Markup.button.callback(`${isBot(c) ? '🤖 ' : ''}${contactName(c)}${isOnMax(c) ? '' : ' (не в MAX)'}`, `tlmx_panel:pick:${String(c.id)}`),
        ),
        ...channels.map((ch) => Markup.button.url(`📢 ${truncateUtf16(ch.title, 120)}`, ch.link!)),
      ].slice(0, 8);
      const hint = channels.length ? '\n📢 — каналы: они откроются в MAX, в мост их не добавить.' : '';
      await bot.telegram.sendMessage(chatId, `Нашёл ${buttons.length}. Выберите:${hint}`, {
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
    const text = `${info.bot ? '🤖' : '👤'} ${info.name}\nID ${uid}${info.onMax ? '' : '\n⚠️ Не в MAX — начать чат нельзя.'}`;
    const buttons = info.onMax
      ? [Markup.button.callback('💬 Начать чат', `tlmx_panel:startchat:${uid}`), Markup.button.callback('◀️ Готово', 'tlmx_panel:dismiss')]
      : [Markup.button.callback('◀️ Готово', 'tlmx_panel:dismiss')];
    await ctx.editMessageText(text, { reply_markup: Markup.inlineKeyboard(buttons, { columns: 1 }).reply_markup }).catch(() => {});
  });

  bot.action(/^tlmx_panel:startchat:(.+)$/, async (ctx) => {
    const uid = ctx.match?.[1];
    if (!uid) return;
    // Name from a WARM cache first (search card → shownContacts; group roster → the contact-profile
    // cache buildRoster already filled), so we normally skip MAX entirely — exactly what the search
    // path does. CRITICAL: answer the callback BEFORE any MAX round-trip. A CONTACT_INFO lookup can
    // take up to its 20s timeout, well past Telegram's ~15s callback expiry — so awaiting it first
    // killed the handler before startDialog ran, and the group-roster "Открыть личку" did "вообще
    // ничего" for a stranger (reported live 2026-08-24). Search never hit this: its name was cached.
    let name = shownContacts.get(uid)?.name ?? resolveContactName?.(uid);
    await ctx.answerCbQuery('Открываю чат…').catch(() => {});
    if (!name) {
      // Cache miss (rare for a roster button) — now safe to hit MAX; the callback is already answered.
      try {
        const contacts = await max.getContactInfo([Number(uid)]);
        if (contacts[0]) name = contactName(contacts[0]);
      } catch (err) {
        logger.error(`Failed to resolve contact ${uid} for startchat`, err);
      }
      name = name ?? `MAX ${uid}`;
    }
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

  // A Telegram contact card shared into the group's General topic (no thread) = "find this person in
  // MAX". The bot cannot read anyone's Telegram contact list (Bot API grants no such access — by
  // design), but a card the admin shares carries the phone, and THAT is matchable: it reuses the
  // phone search → same result card → «Начать чат». Inside a chat topic (thread id present) a contact
  // still relays to MAX as content, untouched. Admin-only, like every other panel action.
  bot.on('message', async (ctx, next) => {
    const m = ctx.message as { contact?: { phone_number?: string; first_name?: string; last_name?: string }; message_thread_id?: number };
    const phone = m.contact?.phone_number;
    if (!phone || m.message_thread_id != null) return next();
    const userId = ctx.from?.id;
    if (userId == null) return;
    try {
      const member = await ctx.telegram.getChatMember(targetGroupId, userId);
      if (member.status !== 'creator' && member.status !== 'administrator') return; // not an admin — ignore
    } catch {
      return;
    }
    const who = [m.contact?.first_name, m.contact?.last_name].filter(Boolean).join(' ').trim();
    await ctx.reply(`📇 Контакт из Telegram${who ? ` «${who}»` : ''} — ищу в MAX по номеру…`).catch(() => {});
    await runSearch(chatIdOf(ctx), 'phone', phone);
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
    await ctx.telegram.deleteMessage(chatIdOf(ctx), replyTo).catch(() => {});
    const query = (msg.text ?? '').trim();
    if (!query) {
      await ctx.reply('Пусто — отмена.').catch(() => {});
      return;
    }
    await runSearch(chatIdOf(ctx), pending.mode, query);
    // consumed — do NOT call next()
  });
}
