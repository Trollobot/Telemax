import https from 'node:https';
import { buildTelegramProxyAgent } from '../telegram/proxy.js';

/**
 * The few Bot API calls the launcher's page makes on its own — checking a token and a proxy,
 * finding the group — before there is a configured bridge to ask. Same route as the bridge:
 * straight, or through the proxy given (buildTelegramProxyAgent).
 */
export class TelegramApiError extends Error {
  constructor(
    message: string,
    readonly code?: number,
  ) {
    super(message);
    this.name = 'TelegramApiError';
  }
}

const TIMEOUT_MS = 12_000;

export function callTelegram<T>(token: string, proxyUrl: string, method: string, params: Record<string, unknown> = {}): Promise<T> {
  const agent = buildTelegramProxyAgent(proxyUrl);
  const body = JSON.stringify(params);
  return new Promise<T>((resolve, reject) => {
    const req = https.request(
      {
        host: 'api.telegram.org',
        path: `/bot${token}/${method}`,
        method: 'POST',
        agent,
        headers: { 'content-type': 'application/json', 'content-length': Buffer.byteLength(body) },
        timeout: TIMEOUT_MS,
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on('data', (c: Buffer) => chunks.push(c));
        res.on('end', () => {
          try {
            const json = JSON.parse(Buffer.concat(chunks).toString('utf8')) as { ok?: boolean; result?: T; description?: string; error_code?: number };
            if (json.ok) resolve(json.result as T);
            else reject(new TelegramApiError(`${json.error_code ?? res.statusCode}: ${json.description ?? 'ошибка Telegram'}`, json.error_code ?? res.statusCode));
          } catch {
            // Not Telegram's JSON: a proxy's own error page, a captive portal.
            reject(new TelegramApiError(`ответ не от Telegram (HTTP ${res.statusCode})`, res.statusCode));
          }
        });
        res.on('error', reject);
      },
    );
    req.on('timeout', () => req.destroy(new Error('ETIMEDOUT: нет ответа за 12 секунд')));
    req.on('error', reject);
    req.end(body);
  });
}

export interface BotIdentity {
  id: number;
  username: string;
  name: string;
}

export async function getBot(token: string, proxyUrl: string): Promise<BotIdentity> {
  const me = await callTelegram<{ id: number; username?: string; first_name?: string }>(token, proxyUrl, 'getMe');
  return { id: me.id, username: me.username ?? '', name: me.first_name ?? '' };
}

export interface GroupCheck {
  ok: boolean;
  title: string;
  /** What is wrong, one item per line, in the user's words; empty when ok. */
  problems: string[];
}

/** The three things the bridge needs from its group — the same checks setup.sh makes on a server. */
export async function checkGroup(token: string, proxyUrl: string, groupId: string, botId: number): Promise<GroupCheck> {
  const chat = await callTelegram<{ title?: string; type?: string; is_forum?: boolean }>(token, proxyUrl, 'getChat', { chat_id: groupId });
  const problems: string[] = [];
  if (chat.type !== 'supergroup' || !chat.is_forum) problems.push('В группе выключены темы: настройки группы → «Темы» → включить.');
  const member = await callTelegram<{ status?: string; can_manage_topics?: boolean }>(token, proxyUrl, 'getChatMember', { chat_id: groupId, user_id: botId });
  if (member.status !== 'administrator' && member.status !== 'creator') problems.push('Бот не администратор группы: назначьте его администратором.');
  else if (member.status === 'administrator' && !member.can_manage_topics) problems.push('У бота нет права «Управление темами»: включите его в правах администратора.');
  return { ok: problems.length === 0, title: chat.title ?? '', problems };
}

export interface SeenGroup {
  id: string;
  title: string;
}

/** Groups out of a getUpdates answer: where someone wrote, or where the bot was added or promoted. Pure. */
export function groupsFromUpdates(updates: unknown[]): SeenGroup[] {
  const seen = new Map<string, string>();
  for (const u of updates) {
    const upd = u as Record<string, { chat?: { id?: number; type?: string; title?: string } } | undefined>;
    const chat = (upd.message ?? upd.channel_post ?? upd.my_chat_member)?.chat;
    if (chat?.id == null || (chat.type !== 'group' && chat.type !== 'supergroup')) continue;
    seen.set(String(chat.id), chat.title ?? '');
  }
  return [...seen].map(([id, title]) => ({ id, title }));
}

/**
 * Looks for the group the bot was just added to. Only while the bridge is NOT running: getUpdates
 * allows one reader per bot, and a second one would knock the bridge's own polling off.
 */
export async function findGroups(token: string, proxyUrl: string): Promise<SeenGroup[]> {
  // A webhook left on this bot makes getUpdates refuse outright; dropping it loses nothing here.
  await callTelegram(token, proxyUrl, 'deleteWebhook').catch(() => {});
  // No allowed_updates: a list given here would stick to the bot until the bridge's next launch.
  const updates = await callTelegram<unknown[]>(token, proxyUrl, 'getUpdates', { limit: 100, timeout: 0 });
  return groupsFromUpdates(updates);
}
