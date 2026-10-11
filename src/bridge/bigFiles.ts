/**
 * The chat side of big files (storage and links: fileShare.ts). Every message here says WHY a file
 * goes by link — to the user a link instead of a file otherwise looks like a bug.
 */
import { Markup, type Telegraf } from 'telegraf';
import type { MaxClient } from '../max/client.js';
import { maxFetchBig } from '../max/ca.js';
import { createLogger } from '../logger.js';
import { getMaxFileUrl, describeAttachment, type DownloadContext, type MaxAttachment } from './attachments.js';
import { FileShare, MAX_FILE_LIMIT, nodeReadable, type UploadTicket } from './fileShare.js';
import { formatBytes } from './status.js';
import { uploadFileFromDiskToMax } from './upload.js';
import { isTransientHttpStatus, isTransientNetworkError, TransientDownloadError } from './transient.js';
import { reportError } from './telemetry.js';
import { keepPanelBack } from './panelBack.js';
import { truncateUtf16 } from './text.js';

/**
 * What the topic is told about a failure: MAX's own answers are readable Russian and stay as they
 * are; a file-system or network error becomes a plain sentence (its details are in the log and,
 * scrubbed, in the anonymous report).
 */
export function humanError(err: unknown): string {
  const msg = (err as Error)?.message ?? String(err);
  if (/ENOSPC/.test(msg)) return 'на сервере кончилось место';
  if (err instanceof TransientDownloadError || isTransientNetworkError(err)) return 'прервалась связь с MAX';
  if (/\bE[A-Z]{3,}\b/.test(msg) || /^[A-Za-z ]*Error\b/.test(msg)) return 'внутренняя ошибка моста, подробности — в его логе';
  return msg;
}

/** Big-file failures reach the maintainer too (anonymous and scrubbed — see telemetry.ts reportError). */
function report(step: string, error: unknown): void {
  void reportError({ kind: 'internal', step: `big-file: ${step}`, error });
}

const logger = createLogger('big-files');

const WHY_TG_DOWNLOAD = 'Telegram не отдаёт ботам файлы больше 20 МБ';
const WHY_TG_UPLOAD = 'Telegram не принимает от ботов файлы больше 50 МБ';

export function formatExpiry(ms: number): string {
  return new Intl.DateTimeFormat('ru-RU', { day: 'numeric', month: 'long', hour: '2-digit', minute: '2-digit', timeZone: process.env.TZ || 'Europe/Moscow' }).format(new Date(ms));
}

type SentMessage = { message_id: number };
/** No message_thread_id = the group's General topic (where the panel lives). */
type SendOpts = { message_thread_id?: number; reply_parameters?: { message_id: number; allow_sending_without_reply: boolean } };

export interface BigFilesDeps {
  bot: Telegraf;
  max: MaxClient;
  targetGroupId: string;
  fileShare: FileShare;
  /** Records a message the bridge itself sent to MAX (echo suppression + the TG↔MAX link). */
  onSentToMax: (ticket: UploadTicket, sent: { cid: number; messageId: unknown; time: unknown }) => void;
}

export interface BigFiles {
  /**
   * Telegram → MAX: an upload link instead of the Bot API. Two ways in: a file the bot can't
   * download (over 20 MB — `name`/`size` known, the user already waited for Telegram once) or
   * /file (nothing sent yet — the file goes up once, straight to the server).
   */
  offerUpload(p: { maxChatId: string; topicId: number; telegramMessageId: number; caption?: string; name?: string; size?: number }): Promise<void>;
  /** MAX → Telegram: a FILE over the bot upload limit — save it and post a download link. */
  relayFromMax(att: MaxAttachment, ctx: DownloadContext, opts: SendOpts): Promise<SentMessage>;
  /** The panel's «📤 Загрузить файл»: an upload link into the server's own store, drawn in the panel message. */
  offerStore(panelMessageId: number): Promise<void>;
  /** The panel's «📤 Отправить в MAX»: a stored file that didn't make it, sent again from disk. */
  resendToMax(id: string): Promise<{ ok: boolean; text: string }>;
}

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
/** MAX's answer to MSG_SEND while a big upload is still being digested. */
const STILL_PROCESSING = /в процессе обработки|not[ ._]?ready|processing/i;

export function createBigFiles({ bot, max, targetGroupId, fileShare, onSentToMax }: BigFilesDeps): BigFiles {
  const send = (text: string, opts: SendOpts, markup?: ReturnType<typeof Markup.inlineKeyboard>) =>
    bot.telegram.sendMessage(targetGroupId, text, { ...opts, ...(markup ? { reply_markup: markup.reply_markup } : {}) });
  const edit = async (messageId: number | undefined, topicId: number, text: string, markup?: ReturnType<typeof Markup.inlineKeyboard>) => {
    if (messageId != null) {
      try {
        await bot.telegram.editMessageText(targetGroupId, messageId, undefined, text, markup ? { reply_markup: markup.reply_markup } : {});
        return;
      } catch (err) {
        if (/not modified/i.test((err as Error).message ?? '')) return;
        logger.error('Editing a big-file notice failed — posting a new one', err);
      }
    }
    await send(text, topicId ? { message_thread_id: topicId } : {}, markup).catch((e) => logger.error('Posting a big-file notice failed', e));
  };
  const reserveText = formatBytes(fileShare.opts.reserveBytes);

  /**
   * Uploads a file from disk and sends it. A big file is still «в процессе обработки» for a while
   * after its upload (a 2.7 GB ISO: well over the 30 s guessed in uploadFileFromDiskToMax — live
   * 2026-10-09), so the send is retried for up to 15 minutes while MAX says exactly that.
   */
  async function uploadAndSend(maxChatId: string, filePath: string, size: number, name: string, caption: string | undefined, onWaiting?: () => void) {
    const attach = await uploadFileFromDiskToMax(max, filePath, size, name);
    const deadline = Date.now() + 15 * 60_000;
    let pause = 5000;
    let told = false;
    for (;;) {
      try {
        return await max.sendMessage(maxChatId, caption ?? null, [attach]);
      } catch (err) {
        if (!STILL_PROCESSING.test((err as Error).message ?? '') || Date.now() > deadline) throw err;
        if (!told) {
          told = true;
          onWaiting?.();
        }
        await sleep(pause);
        pause = Math.min(Math.round(pause * 1.5), 30_000);
      }
    }
  }

  // --- Telegram → MAX -------------------------------------------------------------------------

  const CANCEL = 'tlmx_panel:fcancel:';
  /** /file's «send a file that is already on the server» buttons (user's request, 2026-10-11). */
  const PUT = 'tlmx_panel:fput:';
  /**
   * /file prompt → the chat it was typed in: where its server-file buttons send. In memory only — after
   * a restart the button asks for /file again; a pending ticket isn't used, because the server files
   * are offered even when the upload link itself failed (a home server with no white IP).
   */
  const putTargets = new Map<number, { maxChatId: string; topicId: number }>();
  /** Files on the server MAX would take (≤ 4 GB), newest first: ⬇️ from MAX, 📦 file exchange, ⬆️ didn't make it. */
  const serverFileRows = () =>
    fileShare
      .list()
      .filter((f) => f.size <= MAX_FILE_LIMIT)
      .slice(-8)
      .reverse()
      .map((f) => [Markup.button.callback(`${f.direction === 'max2tg' ? '⬇️' : f.direction === 'stored' ? '📦' : '⬆️'} ${truncateUtf16(f.name, 40)} · ${formatBytes(f.size)}`, PUT + f.id)]);
  const SERVER_NOTE = '\n\nИли отправьте сюда файл, который уже лежит на сервере, — загружать его заново не придётся:';
  const uploadRows = (url: string, token: string) => [[Markup.button.url('📤 Загрузить файл', url)], [Markup.button.callback('✖️ Отменить', CANCEL + token)]];
  const uploadKeyboard = (url: string, token: string) => Markup.inlineKeyboard(uploadRows(url, token));
  /** The way back to «📁 Файлы» for everything the file exchange draws in the panel message. */
  const TO_FILES = [Markup.button.callback('◀️ К файлам', 'tlmx_panel:files')];

  async function offerUpload(p: Parameters<BigFiles['offerUpload']>[0]): Promise<void> {
    const fromTelegram = p.name != null && p.size != null;
    const label = fromTelegram ? `«${p.name}» (${formatBytes(p.size!)})` : '';
    const opts: SendOpts = { message_thread_id: p.topicId, reply_parameters: { message_id: p.telegramMessageId, allow_sending_without_reply: true } };
    const refuse = (why: string) =>
      send(fromTelegram ? `⚠️ Файл ${label} не отправлен в MAX: ${WHY_TG_DOWNLOAD}, а ${why}.` : `⚠️ Отправить файл по ссылке не выйдет: ${why}.`, opts);
    if (!fileShare.enabled) {
      await send(
        fromTelegram
          ? `⚠️ Файл ${label} не отправлен в MAX: ${WHY_TG_DOWNLOAD}. Отправьте его из самого MAX или поделите на части.`
          : '⚠️ Пересылка больших файлов отключена в настройках (FILES=off).',
        opts,
      );
      return;
    }
    const room = await fileShare.roomFor(p.size ?? 1);
    if (!room.fits) {
      await refuse(`на сервере свободно ${formatBytes(room.freeBytes)}${fromTelegram ? `, нужно ${formatBytes(p.size!)}` : ''} и ещё ${reserveText} запаса для обновлений`);
      return;
    }
    const prompt = await send(
      fromTelegram
        ? `⏳ Файл ${label} больше 20 МБ — ${WHY_TG_DOWNLOAD}. Готовлю ссылку, чтобы загрузить его в обход Telegram…`
        : '⏳ Готовлю ссылку для загрузки файла в этот чат…',
      opts,
    );
    // /file has no Telegram message of its own: the MAX copy is tied to this notice instead, so
    // deleting it (or 👎) deletes the file in MAX too.
    const ticket = await fileShare.createUploadTicket({
      maxChatId: p.maxChatId,
      topicId: p.topicId,
      telegramMessageId: fromTelegram ? p.telegramMessageId : prompt.message_id,
      caption: p.caption,
      name: p.name ?? '',
      expectedSize: p.size ?? 0,
      promptMessageId: prompt.message_id,
    });
    logger.info(fromTelegram ? `TG -> MAX: ${p.name} is ${p.size} bytes, over the bot download limit — offering an upload link` : `TG -> MAX: /file — offering an upload link for chat ${p.maxChatId}`);
    // /file: the server's own files go to this chat straight from the disk — no link, no service needed.
    const fromServer = fromTelegram ? [] : serverFileRows();
    if (fromServer.length) {
      if (putTargets.size >= 200) putTargets.delete(putTargets.keys().next().value!);
      putTargets.set(prompt.message_id, { maxChatId: p.maxChatId, topicId: p.topicId });
    }
    const serverNote = fromServer.length ? SERVER_NOTE : '';
    const svc = await fileShare.ensureService();
    if (!svc.ok) {
      report('service', svc.reason);
      await fileShare.dropTicket(ticket.token);
      await edit(
        prompt.message_id,
        p.topicId,
        fromTelegram
          ? `⚠️ Файл ${label} не отправлен в MAX: ${WHY_TG_DOWNLOAD}, а ссылку для загрузки подготовить не удалось — ${svc.reason}.`
          : `⚠️ Ссылку для загрузки подготовить не удалось — ${svc.reason}.${serverNote}`,
        fromServer.length ? Markup.inlineKeyboard(fromServer) : undefined,
      );
      return;
    }
    const until = formatExpiry(ticket.expiresAt);
    await edit(
      prompt.message_id,
      p.topicId,
      fromTelegram
        ? `📤 Файл ${label} больше 20 МБ — ${WHY_TG_DOWNLOAD}.
Загрузите его по ссылке, и мост отправит его в MAX. Ссылка действует до ${until}.

В следующий раз большие файлы отправляйте через /file в теме — загружать придётся один раз, а не два.`
        : `📤 Загрузите файл по ссылке — мост отправит его в этот чат MAX. До 4 ГБ, ссылка действует до ${until}.${serverNote}`,
      Markup.inlineKeyboard([...uploadRows(`${svc.url}/f/${ticket.token}`, ticket.token), ...fromServer]),
    );
  }

  // A server file sent from a /file prompt: into that topic's MAX chat, straight from the disk.
  bot.action(new RegExp(`^${PUT}(.+)$`), async (ctx) => {
    const promptId = ctx.callbackQuery.message?.message_id;
    const target = promptId != null ? putTargets.get(promptId) : undefined;
    const file = fileShare.get(ctx.match[1] ?? '');
    if (promptId == null || !target) {
      await ctx.answerCbQuery('Кнопка устарела — напишите /file в теме ещё раз').catch(() => {});
      return;
    }
    if (!file) {
      await ctx.answerCbQuery('Этого файла на сервере уже нет').catch(() => {});
      return;
    }
    await ctx.answerCbQuery('Отправляю в MAX…').catch(() => {});
    putTargets.delete(promptId);
    // The upload link of this /file isn't needed any more — and shouldn't keep the service up.
    const pending = fileShare.pendingUploads().find((t) => t.promptMessageId === promptId);
    if (pending) await fileShare.dropTicket(pending.token);
    const label = `«${file.name}» (${formatBytes(file.size)})`;
    await edit(promptId, target.topicId, `⏳ Отправляю ${label} в MAX с сервера…`);
    try {
      const sent = await uploadAndSend(target.maxChatId, fileShare.pathOf(file), file.size, file.name, undefined, () => {
        void edit(promptId, target.topicId, `⏳ Файл ${label} загружен в MAX — MAX его обрабатывает, это может занять несколько минут…`);
      });
      // Tied to this message like any /file send: deleting it (or 👎) deletes the file in MAX too.
      onSentToMax({ maxChatId: target.maxChatId, topicId: target.topicId, telegramMessageId: promptId, token: '', name: file.name, expectedSize: file.size, createdAt: 0, expiresAt: 0 }, sent);
      await edit(promptId, target.topicId, `✅ Файл ${label} отправлен в MAX с сервера. На сервере он остаётся — его можно отправить и в другие чаты.`);
      logger.info(`TG -> MAX: server file ${file.name} (${file.size} bytes) sent to chat ${target.maxChatId}`);
    } catch (err) {
      logger.error(`Sending the server file ${file.name} to MAX failed`, err);
      report('send server file to MAX', err);
      await edit(promptId, target.topicId, `⚠️ Файл ${label} в MAX не ушёл: ${humanError(err)}. Он остаётся на сервере — напишите /file, чтобы попробовать ещё раз.`);
    }
  });

  // «✖️ Отменить» under an upload link: the link stops working (an upload in flight is cut off too).
  bot.action(new RegExp(`^${CANCEL}(.+)$`), async (ctx) => {
    const ticket = fileShare.getTicket(ctx.match[1] ?? '');
    await ctx.answerCbQuery(ticket ? 'Загрузка отменена' : 'Ссылка уже не действует').catch(() => {});
    if (ticket) logger.info(`Upload link for «${ticket.name || 'any file'}» cancelled`);
    if (ticket) await fileShare.dropTicket(ticket.token);
    const text = (ctx.callbackQuery.message as { text?: string } | undefined)?.text;
    // In the panel (the file exchange) the cancelled link keeps «◀️ К файлам».
    await ctx.editMessageText(ticket || !text ? '✖️ Загрузка отменена — ссылка больше не работает.' : text, keepPanelBack(ctx)).catch(() => {});
    // Cancelled from the panel's «⏳» card: the message that offered the link stops offering it too.
    const pressedId = ctx.callbackQuery.message?.message_id;
    if (ticket?.promptMessageId != null && ticket.promptMessageId !== pressedId) {
      await bot.telegram.editMessageText(targetGroupId, ticket.promptMessageId, undefined, '✖️ Загрузка отменена — ссылка больше не работает.').catch(() => {});
    }
  });

  // An upload link nobody used: its message says so instead of offering a dead button.
  fileShare.onTicketExpired(async (ticket) => {
    if (ticket.promptMessageId == null) return;
    const hours = Math.round(fileShare.opts.uploadTtlMs / 3600_000);
    const text =
      ticket.purpose === 'store'
        ? `⌛ Ссылка на загрузку истекла — она действовала ${hours} ч. Нужна снова — «📤 Загрузить файл».`
        : `⌛ Ссылка на загрузку${ticket.name ? ` «${ticket.name}»` : ''} истекла — она действовала ${hours} ч, файл в MAX не ушёл. Нужна снова — /file в этой теме.`;
    // A store link lives in the panel message: it keeps a way back to the files.
    const markup = ticket.purpose === 'store' ? { reply_markup: Markup.inlineKeyboard([TO_FILES]).reply_markup } : {};
    await bot.telegram.editMessageText(targetGroupId, ticket.promptMessageId, undefined, text, markup).catch(() => {});
  });

  /**
   * The panel's «📤 Загрузить файл», drawn IN the panel message: the admin is looking at the panel,
   * and a link posted at the bottom of the chat went unseen (2026-10-11). The finished upload lands
   * in the same message, with «◀️ К файлам».
   */
  async function offerStore(panelId: number): Promise<void> {
    const show = (text: string, rows: ReturnType<typeof uploadRows> = []) => edit(panelId, 0, text, Markup.inlineKeyboard([...rows, TO_FILES]));
    if (!fileShare.enabled) {
      await show('⚠️ Пересылка больших файлов отключена в настройках (FILES=off).');
      return;
    }
    const room = await fileShare.roomFor(1);
    if (!room.fits) {
      await show(`⚠️ Загрузить файл не выйдет: на сервере свободно ${formatBytes(room.freeBytes)}, а ${reserveText} нужно оставить для обновлений.`);
      return;
    }
    await show('⏳ Готовлю ссылку для загрузки файла на сервер…');
    const ticket = await fileShare.createUploadTicket({
      purpose: 'store',
      maxChatId: '',
      topicId: 0,
      telegramMessageId: panelId,
      name: '',
      expectedSize: 0,
      promptMessageId: panelId,
    });
    logger.info('Panel: offering an upload link into the server store');
    const svc = await fileShare.ensureService();
    if (!svc.ok) {
      report('service', svc.reason);
      await fileShare.dropTicket(ticket.token);
      await show(`⚠️ Ссылку для загрузки подготовить не удалось — ${svc.reason}.`);
      return;
    }
    await show(
      `📤 Загрузите файл по ссылке — он сохранится на вашем сервере, а ссылка для скачивания появится здесь же. Ею можно делиться где угодно.
Ссылка на загрузку действует до ${formatExpiry(ticket.expiresAt)}.`,
      uploadRows(`${svc.url}/f/${ticket.token}`, ticket.token),
    );
  }

  fileShare.onUpload(async (ticket, filePath, size, name) => {
    const label = `«${name}» (${formatBytes(size)})`;
    if (ticket.purpose === 'store') {
      const file = await fileShare.adoptUpload(ticket, filePath, size, name);
      logger.info(`Panel store: ${name} (${size} bytes) uploaded`);
      const svc = await fileShare.ensureService(30_000);
      const until = formatExpiry(file.expiresAt);
      if (!svc.ok) {
        await edit(ticket.promptMessageId, 0, `✅ Файл ${label} на сервере до ${until}. Ссылку можно взять в пульте → 📁 Файлы.`, Markup.inlineKeyboard([TO_FILES]));
        return;
      }
      await edit(
        ticket.promptMessageId,
        0,
        `✅ Файл ${label} на сервере до ${until}.
🔗 ${svc.url}/f/${file.token}
Ссылкой можно делиться — по ней откроется страница со скачиванием. Продлить или удалить — в пульте → 📁 Файлы.`,
        Markup.inlineKeyboard([[Markup.button.url('⬇️ Скачать', `${svc.url}/f/${file.token}`)], TO_FILES]),
      );
      return;
    }
    if (size > MAX_FILE_LIMIT) {
      // The page and the service refuse this already — belt and braces.
      await fileShare.dropTicket(ticket.token);
      await edit(ticket.promptMessageId, ticket.topicId, `⚠️ Файл ${label} не отправлен: MAX не принимает файлы больше 4 ГБ.`);
      return;
    }
    await edit(ticket.promptMessageId, ticket.topicId, `⏳ Файл ${label} получен — отправляю в MAX…`);
    try {
      const sent = await uploadAndSend(ticket.maxChatId, filePath, size, name, ticket.caption, () => {
        void edit(ticket.promptMessageId, ticket.topicId, `⏳ Файл ${label} загружен в MAX — MAX его обрабатывает, это может занять несколько минут…`);
      });
      onSentToMax(ticket, sent);
      await fileShare.dropTicket(ticket.token);
      await edit(ticket.promptMessageId, ticket.topicId, `✅ Файл ${label} отправлен в MAX.`);
      logger.info(`TG -> MAX: uploaded ${name} (${size} bytes) sent to chat ${ticket.maxChatId}`);
    } catch (err) {
      logger.error(`Sending the uploaded ${name} to MAX failed — keeping it as a link`, err);
        report('send to MAX', err);
      const file = await fileShare.adoptUpload(ticket, filePath, size, name);
      await edit(
        ticket.promptMessageId,
        ticket.topicId,
        `⚠️ Файл ${label} получен, но в MAX не ушёл: ${humanError(err)}.
Он сохранён до ${formatExpiry(file.expiresAt)} — отправить его ещё раз можно из пульта → 📁 Файлы, загружать заново не нужно.`,
      );
    }
  });

  // --- MAX → Telegram -------------------------------------------------------------------------

  async function relayFromMax(att: MaxAttachment, ctx: DownloadContext, opts: SendOpts): Promise<SentMessage> {
    const name = att.name ?? 'file';
    const size = Number(att.size ?? 0);
    const label = `«${name}» (${formatBytes(size)})`;
    if (!fileShare.enabled) return send(`${describeAttachment(att)} ${formatBytes(size)} — ${WHY_TG_UPLOAD}. Откройте его в MAX.`, opts);
    const room = await fileShare.roomFor(size);
    if (!room.fits) {
      return send(
        `📎 Файл ${label} — ${WHY_TG_UPLOAD}, а сохранить его для скачивания не выйдет: на сервере свободно ${formatBytes(room.freeBytes)}, нужно ещё ${reserveText} запаса для обновлений. Откройте его в MAX.`,
        opts,
      );
    }
    const url = await getMaxFileUrl(att, ctx);
    if (!url) return send(describeAttachment(att), opts);
    // The recipient sees at once that something is coming — saving gigabytes takes minutes.
    const notice = `📥 Пришёл файл ${label} — ${WHY_TG_UPLOAD}, поэтому мост сохраняет его на ваш сервер и пришлёт сюда ссылку.`;
    const msg = await send(`${notice}
⏳ Сохраняю…`, opts);
    let lastShown = Date.now();
    const progress = (written: number) => {
      if (Date.now() - lastShown < 20_000) return;
      lastShown = Date.now();
      const pct = size > 0 ? ` (${Math.min(99, Math.floor((written / size) * 100))}%)` : '';
      void edit(msg.message_id, opts.message_thread_id ?? 0, `${notice}
⏳ Сохранено ${formatBytes(written)} из ${formatBytes(size)}${pct}…`);
    };
    let file;
    try {
      const res = await maxFetchBig(url);
      if (!res.ok || !res.body) {
        if (isTransientHttpStatus(res.status)) throw new TransientDownloadError(`MAX CDN answered ${res.status}`);
        throw new Error(`MAX отдал ${res.status}`);
      }
      file = await fileShare.storeStream(nodeReadable(res.body), name, size, progress);
      logger.info(`MAX -> TG: ${name} (${file.size} bytes) saved for a download link`);
    } catch (err) {
      const transient = err instanceof TransientDownloadError || isTransientNetworkError(err);
      if (transient && ctx.throwOnTransient) {
        // The catch-up retries this message later and posts a fresh notice — don't leave this one hanging.
        await bot.telegram.deleteMessage(targetGroupId, msg.message_id).catch(() => {});
        throw err instanceof TransientDownloadError ? err : new TransientDownloadError(`big file download: ${(err as Error).message}`, err);
      }
      logger.error(`Saving the big MAX file ${name} failed`, err);
      report('save from MAX', err);
      await edit(msg.message_id, opts.message_thread_id ?? 0, `📎 Файл ${label} — ${WHY_TG_UPLOAD}, а сохранить его для скачивания не удалось: ${humanError(err)}. Откройте его в MAX.`);
      return msg;
    }
    await edit(msg.message_id, opts.message_thread_id ?? 0, `${notice}
✅ Сохранён — готовлю ссылку…`);
    // Not awaited: the service may take a minute or two to come up, and this runs inside the
    // chat's queue — the next message must not wait for it.
    void (async () => {
      const svc = await fileShare.ensureService();
      if (!svc.ok) {
      report('service', svc.reason);
        await edit(msg.message_id, opts.message_thread_id ?? 0, `📎 Файл ${label} — ${WHY_TG_UPLOAD}. Ссылку подготовить не удалось: ${svc.reason}.\nФайл сохранён до ${formatExpiry(file.expiresAt)} — новую ссылку можно получить в пульте → 📁 Файлы.`);
        return;
      }
      await edit(
        msg.message_id,
        opts.message_thread_id ?? 0,
        `📎 Файл ${label} — ${WHY_TG_UPLOAD}, поэтому он лежит на вашем сервере. Скачайте по ссылке до ${formatExpiry(file.expiresAt)} — потом файл удалится.`,
        Markup.inlineKeyboard([Markup.button.url('⬇️ Скачать', `${svc.url}/f/${file.token}`)]),
      );
    })().catch((err) => logger.error('Posting the download link failed', err));
    return msg;
  }

  async function resendToMax(id: string): Promise<{ ok: boolean; text: string }> {
    const file = fileShare.get(id);
    if (!file?.target) return { ok: false, text: 'Этот файл не для MAX или его уже нет.' };
    const label = `«${file.name}» (${formatBytes(file.size)})`;
    try {
      const sent = await uploadAndSend(file.target.maxChatId, fileShare.pathOf(file), file.size, file.name, file.target.caption);
      onSentToMax({ ...file.target, token: '', name: file.name, expectedSize: file.size, createdAt: 0, expiresAt: 0 }, sent);
      await fileShare.remove(file.id);
      logger.info(`TG -> MAX: stored ${file.name} sent again to chat ${file.target.maxChatId}`);
      return { ok: true, text: `✅ Файл ${label} отправлен в MAX и удалён с сервера.` };
    } catch (err) {
      logger.error(`Sending the stored ${file.name} to MAX failed`, err);
      report('resend to MAX', err);
      return { ok: false, text: `⚠️ Файл ${label} в MAX не ушёл: ${humanError(err)}. Он остаётся на сервере — можно попробовать ещё раз.` };
    }
  }

  return { offerUpload, offerStore, relayFromMax, resendToMax };
}
