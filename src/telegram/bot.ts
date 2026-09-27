import type { Telegraf } from 'telegraf';
import type { ChatMapStore } from '../store/chatMapStore.js';
import { createLogger } from '../logger.js';
import { isFallbackTitle } from '../max/names.js';
import { truncateUtf16 } from '../bridge/text.js';

const logger = createLogger('telegram');

// Telegram only accepts these six fixed values for a forum topic's icon_color —
// no arbitrary RGB, and no way to use an actual photo (Bot API limitation, not
// ours). Hashing the MAX chat id picks one deterministically, so the same
// contact's topic always gets the same color, even recreated after /reboot.
const TOPIC_ICON_COLORS = [0x6fb9f0, 0xffd67e, 0xcb86db, 0x8eee98, 0xff93b2, 0xfb6f5f] as const;

function pickTopicIconColor(maxChatId: unknown): (typeof TOPIC_ICON_COLORS)[number] {
  const str = String(maxChatId);
  let hash = 0;
  for (let i = 0; i < str.length; i++) hash = (hash * 31 + str.charCodeAt(i)) | 0;
  return TOPIC_ICON_COLORS[Math.abs(hash) % TOPIC_ICON_COLORS.length] as (typeof TOPIC_ICON_COLORS)[number];
}

export interface EnsuredTopic {
  topicId: number;
  /** True when this call just created the topic — callers use this to decide whether to seed it. */
  created: boolean;
}

// Recognized Telegram API failures we can give the group admin actionable advice
// for, instead of leaving them to dig through server logs (or, worse, just see
// nothing happen at all) — extend as new patterns turn up. `not enough rights to
// create a topic` confirmed live 2026-08-14: "Manage Topics" isn't part of
// Telegram's default admin preset, so every single chat failed the same way with
// no visible explanation to whoever set the bot up.
const KNOWN_TELEGRAM_ERRORS: { match: string; advice: string }[] = [
  {
    match: 'not enough rights to create a topic',
    advice:
      '⚠️ Не могу создавать темы в этой группе — у бота нет права «Управление темами» (Manage Topics). Включите его в настройках администраторов группы (изменить права этого админа → Управление темами), затем вызовите /reboot.',
  },
  {
    match: 'not enough rights to send text messages',
    advice: '⚠️ Не могу писать сообщения в этой группе — проверьте права бота (администраторы группы).',
  },
  {
    match: 'CHAT_WRITE_FORBIDDEN',
    advice: '⚠️ Бот больше не может писать в эту группу — проверьте, что он всё ещё её участник и не заблокирован/не удалён.',
  },
];

// Module-level, not per-call — the same misconfiguration will otherwise repeat
// for every single chat in a bulk resync (confirmed live: 14 identical failures
// in one /reboot run). Cleared once a create actually succeeds, so a real fix
// gets acknowledged instead of the warning going stale forever.
let lastWarnedAdvice: string | null = null;

async function warnAboutKnownTelegramError(bot: Telegraf, groupId: string, err: unknown): Promise<void> {
  const message = err instanceof Error ? err.message : String(err);
  const known = KNOWN_TELEGRAM_ERRORS.find((k) => message.includes(k.match));
  if (!known || known.advice === lastWarnedAdvice) return;
  lastWarnedAdvice = known.advice;
  await bot.telegram.sendMessage(groupId, known.advice).catch((sendErr) => logger.error('Failed to report known Telegram error to the group', sendErr));
}

/** Telegram's limit for a forum topic name, in UTF-16 units. */
export const TOPIC_TITLE_LIMIT = 128;

/** A topic title Telegram accepts: trimmed, at most 128 units without splitting an emoji; undefined when blank. */
export function clampTopicTitle(title: string | undefined | null): string | undefined {
  const clamped = truncateUtf16((title ?? '').trim(), TOPIC_TITLE_LIMIT).trim();
  return clamped || undefined;
}

// One ensureTopicForMaxChat at a time per chat. MAX pushes aren't serialized (handleMaxPush runs
// per frame without awaiting the previous one) and a brand-new chat arrives as a burst (CONTROL
// 'new', CHAT_UPDATE, the first message) — two concurrent check-then-create runs each opened a
// topic, the later upsert won and the first topic was orphaned along with the message sent into
// it (review 2026-09-26, S3). Serializing per chat makes the second caller find the mapping the
// first one just wrote (created: false, so only one of them seeds the topic).
const topicLocks = new Map<string, Promise<unknown>>();

/** Runs `fn` after every earlier call holding the same key has settled. Exported for tests. */
export function withTopicLock<T>(key: string, fn: () => Promise<T>): Promise<T> {
  const previous = topicLocks.get(key) ?? Promise.resolve();
  const run = previous.then(fn, fn);
  const tail = run.then(
    () => undefined,
    () => undefined,
  );
  topicLocks.set(key, tail);
  void tail.then(() => {
    if (topicLocks.get(key) === tail) topicLocks.delete(key);
  });
  return run;
}

/**
 * Finds the Telegram forum topic for a MAX chat, creating one on first contact.
 * If the resolved display name has since changed (e.g. a better name became
 * available via CONTACT_INFO, or a contact renamed themselves) and the topic
 * already exists, renames it in place instead of leaving the stale title — but
 * never to a generic fallback («MAX ID n», «CHAT n», … — see isFallbackTitle): a
 * full resync passes resolveChatName's raw result, which is exactly that while
 * contact profiles are still unknown (review 2026-09-26, C5). Titles are clamped
 * to Telegram's 128-unit limit for both rename and create.
 */
export function ensureTopicForMaxChat(
  bot: Telegraf,
  groupId: string,
  maxChatId: unknown,
  chatMapStore: ChatMapStore,
  title?: string,
): Promise<EnsuredTopic> {
  return withTopicLock(`${groupId}:${String(maxChatId)}`, () => ensureTopicUnlocked(bot, groupId, maxChatId, chatMapStore, clampTopicTitle(title)));
}

async function ensureTopicUnlocked(
  bot: Telegraf,
  groupId: string,
  maxChatId: unknown,
  chatMapStore: ChatMapStore,
  title: string | undefined,
): Promise<EnsuredTopic> {
  const existing = await chatMapStore.getByMaxChatId(maxChatId);
  if (existing) {
    if (title && title !== existing.title && !isFallbackTitle(title)) {
      try {
        await bot.telegram.editForumTopic(groupId, existing.telegramTopicId, { name: title });
        await chatMapStore.setTitle(maxChatId, existing.telegramTopicId, title); // title only — see setTitle
        logger.info(`Renamed Telegram topic ${existing.telegramTopicId} for MAX chat ${String(maxChatId)}: "${existing.title}" -> "${title}"`);
      } catch (err) {
        logger.error(`Failed to rename Telegram topic for MAX chat ${String(maxChatId)}`, err);
      }
    }
    return { topicId: existing.telegramTopicId, created: false };
  }

  let topic;
  try {
    topic = await bot.telegram.createForumTopic(groupId, title ?? `MAX chat ${String(maxChatId)}`, {
      icon_color: pickTopicIconColor(maxChatId),
    });
    lastWarnedAdvice = null; // it worked — a previous warning (if any) no longer applies
  } catch (err) {
    await warnAboutKnownTelegramError(bot, groupId, err);
    throw err; // callers already log + handle this per chat; we're only adding the one-time notice
  }
  await chatMapStore.upsert({
    maxChatId,
    telegramTopicId: topic.message_thread_id,
    title: topic.name,
    createdAt: new Date().toISOString(),
  });
  logger.info(`Created Telegram topic ${topic.message_thread_id} for MAX chat ${maxChatId}`);
  return { topicId: topic.message_thread_id, created: true };
}
