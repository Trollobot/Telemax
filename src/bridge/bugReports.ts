import { type Telegraf, type Context } from 'telegraf';
import { BugReportStore } from '../store/bugReportStore.js';
import { createLogger } from '../logger.js';

const logger = createLogger('bugreport');

/** Public handle of the maintainer's bug-report bot. Shown in /help on every deployment and
 * used as the redirect target where the inbox is off. Public by design (it's meant to be given
 * out), so hardcoding it in the repo is fine. */
export const BUGREPORT_BOT_HANDLE = 'TelemaxSvv_bot';

/** Telegram's "topic no longer exists" errors — same set the bridge's topic self-heal uses. */
function isTopicGone(err: unknown): boolean {
  const msg = err instanceof Error ? err.message : String(err);
  return /message thread not found|thread not found|TOPIC_DELETED|TOPIC_ID_INVALID/i.test(msg);
}

// Keep an open DM from flooding the maintainer's group: at most RATE_LIMIT messages per
// window per reporter. In-memory only — a restart resets it, which is fine.
const RATE_LIMIT = 5;
const RATE_WINDOW_MS = 5 * 60 * 1000;

export interface BugReportsDeps {
  bot: Telegraf;
  targetGroupId: string;
  /** Inbox on (prod) vs off (every other deployment → redirect stub). Gated by BUGREPORT_INBOX. */
  enabled: boolean;
  /** Overridable for tests; defaults to the on-disk store. */
  store?: BugReportStore;
}

export interface BugReports {
  /** Any update in a private chat from an outsider: the inbox flow (enabled) or a redirect stub (disabled). */
  handleIncomingPrivate: (ctx: Context) => Promise<void>;
  /** If the message sits in a bug-report topic, relays it to that reporter's DM and returns true (consumed). */
  relayTopicReply: (ctx: Context) => Promise<boolean>;
}

export function createBugReports(deps: BugReportsDeps): BugReports {
  const { bot, targetGroupId, enabled } = deps;
  const store = deps.store ?? new BugReportStore();
  const recent = new Map<number, number[]>(); // reporterChatId -> recent message timestamps

  function rateLimited(chatId: number): boolean {
    const now = Date.now();
    // Opportunistic cleanup so the map can't grow one entry per stranger forever:
    // drop reporters whose window has fully expired before admitting a new one.
    if (recent.size >= 1000 && !recent.has(chatId)) {
      for (const [id, times] of recent) {
        if (times.every((t) => now - t >= RATE_WINDOW_MS)) recent.delete(id);
      }
    }
    const arr = (recent.get(chatId) ?? []).filter((t) => now - t < RATE_WINDOW_MS);
    arr.push(now);
    recent.set(chatId, arr);
    return arr.length > RATE_LIMIT;
  }

  function reporterLabel(ctx: Context): { name: string; username?: string } {
    const from = ctx.from;
    const name = [from?.first_name, from?.last_name].filter(Boolean).join(' ').trim() || `id${from?.id}`;
    return { name, username: from?.username };
  }

  async function createReporterTopic(ctx: Context, reporterChatId: number): Promise<number> {
    const { name, username } = reporterLabel(ctx);
    const title = `🐞 ${name}${username ? ` (@${username})` : ''}`.slice(0, 128);
    const topic = await bot.telegram.createForumTopic(targetGroupId, title);
    await store.upsert({ reporterChatId, topicId: topic.message_thread_id, username, name, createdAt: new Date().toISOString() });
    // Header so the maintainer knows who's on the other end even if the topic gets renamed.
    const header = ['🐞 Баг-репорт', `От: ${name}`, username ? `@${username}` : null, `ID: ${reporterChatId}`]
      .filter(Boolean)
      .join('\n');
    await bot.telegram.sendMessage(targetGroupId, header, { message_thread_id: topic.message_thread_id }).catch(() => {});
    return topic.message_thread_id;
  }

  /** Copies the reporter's message into their topic, recreating the topic if the maintainer deleted it. */
  async function relayToTopic(ctx: Context, reporterChatId: number, messageId: number): Promise<{ created: boolean }> {
    const mapping = await store.getByReporter(reporterChatId);
    let topicId = mapping ? mapping.topicId : await createReporterTopic(ctx, reporterChatId);
    let created = !mapping;
    try {
      await bot.telegram.copyMessage(targetGroupId, reporterChatId, messageId, { message_thread_id: topicId });
    } catch (err) {
      if (!isTopicGone(err)) throw err;
      await store.remove(reporterChatId);
      topicId = await createReporterTopic(ctx, reporterChatId);
      created = true;
      await bot.telegram.copyMessage(targetGroupId, reporterChatId, messageId, { message_thread_id: topicId });
    }
    return { created };
  }

  async function handleIncomingPrivate(ctx: Context): Promise<void> {
    const chatId = ctx.chat?.id;
    if (chatId == null) return;
    const msg = ctx.message as { text?: string; message_id?: number } | undefined;
    if (!msg || msg.message_id == null) return; // service update (block/unblock), callback, edit — nothing to relay
    // Disabled on this deployment → redirect to the maintainer's bug-report bot.
    if (!enabled) {
      await ctx.reply(`🐞 Это Telemax. По багам и вопросам пишите: https://t.me/${BUGREPORT_BOT_HANDLE}`).catch(() => {});
      return;
    }
    if (msg.text?.startsWith('/start')) {
      await ctx
        .reply('👋 Это Telemax. Опишите проблему одним сообщением — можно со скриншотом. Я передам разработчику, ответ придёт сюда.')
        .catch(() => {});
      return;
    }
    if (rateLimited(chatId)) {
      await ctx.reply('⏳ Слишком много сообщений подряд. Подождите пару минут.').catch(() => {});
      return;
    }
    try {
      const { created } = await relayToTopic(ctx, chatId, msg.message_id);
      if (created) await ctx.reply('✅ Спасибо, передал разработчику. Ответ придёт в этот чат.').catch(() => {});
    } catch (err) {
      logger.error('Failed to relay bug report to maintainer group', err);
      await ctx.reply('⚠️ Не удалось отправить репорт. Попробуйте позже.').catch(() => {});
    }
  }

  async function relayTopicReply(ctx: Context): Promise<boolean> {
    if (!enabled) return false;
    if (String(ctx.chat?.id) !== targetGroupId) return false;
    const message = ctx.message as
      | {
          message_thread_id?: number;
          message_id?: number;
          forum_topic_created?: unknown;
          forum_topic_edited?: unknown;
          forum_topic_closed?: unknown;
          forum_topic_reopened?: unknown;
          pinned_message?: unknown;
        }
      | undefined;
    const topicId = message?.message_thread_id;
    if (topicId == null || message?.message_id == null) return false;
    const report = await store.getByTopicId(topicId);
    if (!report) return false; // not a bug-report topic — let the normal relay handle it
    // Telegram drops forum service messages (topic created/edited/closed/reopened, pins)
    // into the topic — the bot itself just created this one on open. They aren't the
    // maintainer talking and copyMessage can't copy them, so consume without relaying
    // (otherwise the copy fails and posts a spurious "не удалось доставить" warning).
    if (
      message.forum_topic_created ||
      message.forum_topic_edited ||
      message.forum_topic_closed ||
      message.forum_topic_reopened ||
      message.pinned_message
    ) {
      return true;
    }
    try {
      await bot.telegram.copyMessage(report.reporterChatId, targetGroupId, message.message_id);
    } catch (err) {
      logger.error('Failed to relay maintainer reply to reporter', err);
      await bot.telegram
        .sendMessage(targetGroupId, '⚠️ Не удалось доставить ответ (возможно, репортёр остановил бота).', { message_thread_id: topicId })
        .catch(() => {});
    }
    return true; // it IS a bug-report topic — consumed regardless of delivery outcome
  }

  return { handleIncomingPrivate, relayTopicReply };
}
