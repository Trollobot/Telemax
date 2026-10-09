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

const logger = createLogger('big-files');

const WHY_TG_DOWNLOAD = 'Telegram не отдаёт ботам файлы больше 20 МБ';
const WHY_TG_UPLOAD = 'Telegram не принимает от ботов файлы больше 50 МБ';

export function formatExpiry(ms: number): string {
  return new Intl.DateTimeFormat('ru-RU', { day: 'numeric', month: 'long', hour: '2-digit', minute: '2-digit', timeZone: process.env.TZ || 'Europe/Moscow' }).format(new Date(ms));
}

type SentMessage = { message_id: number };
type SendOpts = { message_thread_id: number; reply_parameters?: { message_id: number; allow_sending_without_reply: boolean } };

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
}

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
    await send(text, { message_thread_id: topicId }, markup).catch((e) => logger.error('Posting a big-file notice failed', e));
  };
  const reserveText = formatBytes(fileShare.opts.reserveBytes);

  // --- Telegram → MAX -------------------------------------------------------------------------

  const CANCEL = 'tlmx_panel:fcancel:';
  const uploadKeyboard = (url: string, token: string) =>
    Markup.inlineKeyboard([[Markup.button.url('📤 Загрузить файл', url)], [Markup.button.callback('✖️ Отменить', CANCEL + token)]]);

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
    const svc = await fileShare.ensureService();
    if (!svc.ok) {
      await fileShare.dropTicket(ticket.token);
      await edit(prompt.message_id, p.topicId, fromTelegram ? `⚠️ Файл ${label} не отправлен в MAX: ${WHY_TG_DOWNLOAD}, а ссылку для загрузки подготовить не удалось — ${svc.reason}.` : `⚠️ Ссылку для загрузки подготовить не удалось — ${svc.reason}.`);
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
        : `📤 Загрузите файл по ссылке — мост отправит его в этот чат MAX. До 4 ГБ, ссылка действует до ${until}.`,
      uploadKeyboard(`${svc.url}/f/${ticket.token}`, ticket.token),
    );
  }

  // «✖️ Отменить» under an upload link: the link stops working (an upload in flight is cut off too).
  bot.action(new RegExp(`^${CANCEL}(.+)$`), async (ctx) => {
    const ticket = fileShare.getTicket(ctx.match[1] ?? '');
    await ctx.answerCbQuery(ticket ? 'Загрузка отменена' : 'Ссылка уже не действует').catch(() => {});
    if (ticket) await fileShare.dropTicket(ticket.token);
    const text = (ctx.callbackQuery.message as { text?: string } | undefined)?.text;
    await ctx.editMessageText(ticket || !text ? '✖️ Загрузка отменена — ссылка больше не работает.' : text).catch(() => {});
  });

  fileShare.onUpload(async (ticket, filePath, size, name) => {
    const label = `«${name}» (${formatBytes(size)})`;
    if (size > MAX_FILE_LIMIT) {
      // The page and the service refuse this already — belt and braces.
      await fileShare.dropTicket(ticket.token);
      await edit(ticket.promptMessageId, ticket.topicId, `⚠️ Файл ${label} не отправлен: MAX не принимает файлы больше 4 ГБ.`);
      return;
    }
    await edit(ticket.promptMessageId, ticket.topicId, `⏳ Файл ${label} получен — отправляю в MAX…`);
    try {
      const attach = await uploadFileFromDiskToMax(max, filePath, size, name);
      const sent = await max.sendMessage(ticket.maxChatId, ticket.caption ?? null, [attach]);
      onSentToMax(ticket, sent);
      await fileShare.dropTicket(ticket.token);
      await edit(ticket.promptMessageId, ticket.topicId, `✅ Файл ${label} отправлен в MAX.`);
      logger.info(`TG -> MAX: uploaded ${name} (${size} bytes) sent to chat ${ticket.maxChatId}`);
    } catch (err) {
      logger.error(`Sending the uploaded ${name} to MAX failed — keeping it as a link`, err);
      const file = await fileShare.adoptUpload(ticket, filePath, size, name);
      await edit(
        ticket.promptMessageId,
        ticket.topicId,
        `⚠️ Файл ${label} получен, но в MAX не ушёл: ${(err as Error).message}.
Он сохранён до ${formatExpiry(file.expiresAt)} — ссылку на него можно взять в пульте → 📁 Файлы и отправить вручную.`,
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
    let file;
    try {
      const res = await maxFetchBig(url);
      if (!res.ok || !res.body) {
        if (isTransientHttpStatus(res.status)) throw new TransientDownloadError(`MAX CDN answered ${res.status}`);
        throw new Error(`MAX отдал ${res.status}`);
      }
      file = await fileShare.storeStream(nodeReadable(res.body), name, size);
      logger.info(`MAX -> TG: ${name} (${file.size} bytes) saved for a download link`);
    } catch (err) {
      const transient = err instanceof TransientDownloadError || isTransientNetworkError(err);
      if (transient && ctx.throwOnTransient) throw err instanceof TransientDownloadError ? err : new TransientDownloadError(`big file download: ${(err as Error).message}`, err);
      logger.error(`Saving the big MAX file ${name} failed`, err);
      return send(`📎 Файл ${label} — ${WHY_TG_UPLOAD}, а сохранить его для скачивания не удалось (${(err as Error).message}). Откройте его в MAX.`, opts);
    }
    const msg = await send(`📎 Файл ${label} — ${WHY_TG_UPLOAD}. Готовлю ссылку для скачивания…`, opts);
    // Not awaited: the service may take a minute or two to come up, and this runs inside the
    // chat's queue — the next message must not wait for it.
    void (async () => {
      const svc = await fileShare.ensureService();
      if (!svc.ok) {
        await edit(msg.message_id, opts.message_thread_id, `📎 Файл ${label} — ${WHY_TG_UPLOAD}. Ссылку подготовить не удалось: ${svc.reason}.\nФайл сохранён до ${formatExpiry(file.expiresAt)} — новую ссылку можно получить в пульте → 📁 Файлы.`);
        return;
      }
      await edit(
        msg.message_id,
        opts.message_thread_id,
        `📎 Файл ${label} — ${WHY_TG_UPLOAD}, поэтому он лежит на вашем сервере. Скачайте по ссылке до ${formatExpiry(file.expiresAt)} — потом файл удалится.`,
        Markup.inlineKeyboard([Markup.button.url('⬇️ Скачать', `${svc.url}/f/${file.token}`)]),
      );
    })().catch((err) => logger.error('Posting the download link failed', err));
    return msg;
  }

  return { offerUpload, relayFromMax };
}
