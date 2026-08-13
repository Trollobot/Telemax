import 'dotenv/config';

function required(name: string): string {
  const value = process.env[name];
  if (!value) {
    throw new Error(`${name} is not set — see .env.example`);
  }
  return value;
}

export const config = {
  port: Number(process.env.PORT ?? 3000),
  // Shared secret required on every /api/* route except /api/health (ТЗ.md §3.4).
  apiKey: required('API_KEY'),
  telegramBotToken: process.env.TELEGRAM_BOT_TOKEN ?? '',
  targetTelegramGroup: process.env.TARGET_TELEGRAM_GROUP ?? '',
  get telegramEnabled(): boolean {
    return Boolean(this.telegramBotToken) && Boolean(this.targetTelegramGroup);
  },
};
