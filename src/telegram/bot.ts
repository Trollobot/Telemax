import { Telegraf } from 'telegraf';
import type { ChatMapStore } from '../store/chatMapStore.js';
import { createLogger } from '../logger.js';

const logger = createLogger('telegram');

export function createTelegramBot(token: string): Telegraf {
  return new Telegraf(token);
}

export interface EnsuredTopic {
  topicId: number;
  /** True when this call just created the topic — callers use this to decide whether to seed it. */
  created: boolean;
  /** False means the caller should (re)run the history backfill — independent of `created`, since a topic can exist with a backfill that never completed. */
  historySynced: boolean;
}

/**
 * Finds the Telegram forum topic for a MAX chat, creating one on first contact.
 * If the resolved display name has since changed (e.g. a better name became
 * available via CONTACT_INFO, or a contact renamed themselves) and the topic
 * already exists, renames it in place instead of leaving the stale title.
 */
export async function ensureTopicForMaxChat(
  bot: Telegraf,
  groupId: string,
  maxChatId: unknown,
  chatMapStore: ChatMapStore,
  title?: string,
): Promise<EnsuredTopic> {
  const existing = await chatMapStore.getByMaxChatId(maxChatId);
  if (existing) {
    if (title && title !== existing.title) {
      try {
        await bot.telegram.editForumTopic(groupId, existing.telegramTopicId, { name: title });
        await chatMapStore.upsert({ ...existing, maxChatId, title });
        logger.info(`Renamed Telegram topic ${existing.telegramTopicId} for MAX chat ${String(maxChatId)}: "${existing.title}" -> "${title}"`);
      } catch (err) {
        logger.error(`Failed to rename Telegram topic for MAX chat ${String(maxChatId)}`, err);
      }
    }
    return { topicId: existing.telegramTopicId, created: false, historySynced: existing.historySynced === true };
  }

  const topic = await bot.telegram.createForumTopic(groupId, title ?? `MAX chat ${String(maxChatId)}`);
  await chatMapStore.upsert({
    maxChatId,
    telegramTopicId: topic.message_thread_id,
    title: topic.name,
    createdAt: new Date().toISOString(),
  });
  logger.info(`Created Telegram topic ${topic.message_thread_id} for MAX chat ${maxChatId}`);
  return { topicId: topic.message_thread_id, created: true, historySynced: false };
}
