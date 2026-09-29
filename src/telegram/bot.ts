import type { Telegraf } from 'telegraf';
import type { ChatMapStore } from '../store/chatMapStore.js';
import { createLogger } from '../logger.js';
import { isFallbackTitle } from '../max/names.js';
import { truncateUtf16 } from '../bridge/text.js';
import { withFloodRetry } from '../bridge/transient.js';

const logger = createLogger('telegram');

// Telegram only accepts these six values for a forum topic's icon_color. Hashing the MAX chat id
// picks one deterministically, so a contact's topic keeps its color even recreated after /reboot.
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

// Telegram API failures the group admin gets actionable advice for instead of digging through
// logs. `not enough rights to create a topic` confirmed live 2026-08-14: "Manage Topics" isn't in
// Telegram's default admin preset, so every chat failed the same way with no visible explanation.
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

// Module-level: the same misconfiguration repeats for every chat in a bulk resync (confirmed live:
// 14 identical failures in one /reboot). Cleared once a create succeeds, so a real fix is acknowledged.
let lastWarnedAdvice: string | null = null;

async function warnAboutKnownTelegramError(bot: Telegraf, groupId: string, err: unknown): Promise<void> {
  const message = err instanceof Error ? err.message : String(err);
  const known = KNOWN_TELEGRAM_ERRORS.find((k) => message.includes(k.match));
  if (!known || known.advice === lastWarnedAdvice) return;
  lastWarnedAdvice = known.advice;
  await bot.telegram.sendMessage(groupId, known.advice).catch((sendErr) => logger.error('Failed to report known Telegram error to the group', sendErr));
}

/** Telegram's limit for a forum topic name, in UTF-16 units. */
const TOPIC_TITLE_LIMIT = 128;

/** A topic title Telegram accepts: trimmed, at most 128 units without splitting an emoji; undefined when blank. */
export function clampTopicTitle(title: string | undefined | null): string | undefined {
  const clamped = truncateUtf16((title ?? '').trim(), TOPIC_TITLE_LIMIT).trim();
  return clamped || undefined;
}

// One ensureTopicForMaxChat at a time per chat: a brand-new chat arrives as a burst (CONTROL 'new',
// CHAT_UPDATE, the first message), and two concurrent check-then-create runs each opened a topic,
// orphaning one. Serialized, the second caller finds the mapping the first just wrote (created: false).
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
 * Finds the Telegram forum topic for a MAX chat, creating one on first contact. An existing topic
 * whose resolved display name changed (a better name via CONTACT_INFO, a contact renamed) is
 * renamed in place — but never to a generic fallback («MAX ID n», «CHAT n», see isFallbackTitle),
 * which is what a full resync passes while contact profiles are still unknown.
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
    // Flood control hits exactly here after /reboot (dozens of topics in a row): without the
    // retry the chat stayed without a topic until its next event.
    topic = await withFloodRetry(() =>
      bot.telegram.createForumTopic(groupId, title ?? `MAX chat ${String(maxChatId)}`, {
        icon_color: pickTopicIconColor(maxChatId),
      }),
    );
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
