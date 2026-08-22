import 'dotenv/config';

export const config = {
  telegramBotToken: process.env.TELEGRAM_BOT_TOKEN ?? '',
  targetTelegramGroup: process.env.TARGET_TELEGRAM_GROUP ?? '',
  // Override the MAX endpoint. Unset → connect by hostname (api2.oneme.ru), which lets
  // IPv6-only hosts reach MAX over DNS64/NAT64. Pin a literal IP here
  // (MAX_HOST=155.212.204.150) only if DNS for oneme.ru is ever unreachable; MAX_SNI stays
  // api2.oneme.ru either way so TLS validation still matches the server's certificate.
  maxHost: process.env.MAX_HOST || undefined,
  maxSni: process.env.MAX_SNI || undefined,
  get telegramEnabled(): boolean {
    return Boolean(this.telegramBotToken) && Boolean(this.targetTelegramGroup);
  },
};
