import type { InlineKeyboardButton } from 'telegraf/types';

// The history depth: how far back a topic filled from scratch reaches (sync.ts ChatCatchUp.replay),
// asked in the group before every chat is filled (sync.ts askHistoryDepth) and set in the panel
// (panel.ts «📜 История»). Kept apart so sync.ts and panel.ts share it without importing each other.

/** How far back (days) a topic filled from scratch reaches unless the owner chose otherwise; 0 = the whole history. */
export const DEFAULT_HISTORY_DAYS = 7;
/** The choices of «📜 Сколько истории перенести?» and the panel's «📜 История». */
export const HISTORY_DAY_CHOICES = [1, 7, 30, 0] as const;

/** «1 день», «7 дней», «30 дней», «вся история». Pure + exported for unit testing. */
export function historyDaysLabel(days: number): string {
  if (days <= 0) return 'вся история';
  const d = days % 10;
  const dd = days % 100;
  const word = d === 1 && dd !== 11 ? 'день' : d >= 2 && d <= 4 && (dd < 12 || dd > 14) ? 'дня' : 'дней';
  return `${days} ${word}`;
}

/** The line a topic filled from scratch starts with when the history depth left older messages in MAX. Pure + exported for unit testing. */
export function historyDaysNotice(days: number): string {
  const span = days === 1 ? 'последний день' : `последние ${historyDaysLabel(days)}`;
  return `📜 Здесь история за ${span} — более ранняя переписка осталась в MAX. Глубина истории для новых тем: /panel → ⚙️ Система.`;
}

/** «📜 Сколько истории перенести?» — asked in the group before every chat is filled from scratch. Pure + exported for unit testing. */
export function historyQuestionText(current: number, waitMin: number): string {
  return [
    '📜 Сколько истории перенести из MAX в темы?',
    'Telegram пускает около 20 сообщений в минуту — большой чат за всю историю заливается часами. Новые сообщения приходят сразу в любом случае.',
    `Без ответа через ${waitMin} мин — ${historyDaysLabel(current)}. Поменять потом: /panel → ⚙️ Система.`,
  ].join('\n\n');
}

/** The four choices, the current one ticked; `prefix` + days is the callback data. */
export function historyChoiceKeyboard(current: number, prefix: string): InlineKeyboardButton[][] {
  const button = (days: number) => ({ text: `${days === 0 ? 'Вся история' : historyDaysLabel(days)}${days === current ? ' ✓' : ''}`, callback_data: `${prefix}${days}` });
  return [
    [button(1), button(7)],
    [button(30), button(0)],
  ];
}
