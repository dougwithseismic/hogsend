/**
 * The Telegram env contract the CONSUMER validates. Documentation-as-types: the
 * plugin's connect/link helpers are env-source-agnostic. The outbound actions
 * DO read `process.env.TELEGRAM_BOT_TOKEN` directly (same as plugin-discord's
 * bot-REST helper) so a journey send needs no injection.
 */
export interface TelegramEnv {
  /** Bot token from BotFather — `bot<token>` for every Bot API call. */
  TELEGRAM_BOT_TOKEN?: string;
  /**
   * Secret echoed by Telegram in the `X-Telegram-Bot-Api-Secret-Token` header
   * (set via `setWebhook(secret_token=…)`); the engine webhook route compares it
   * against this var. When unset the route accepts unauthenticated posts (open).
   */
  TELEGRAM_WEBHOOK_SECRET?: string;
  /** Bot username (no `@`) — used to build `t.me/<username>?start=…` links. */
  TELEGRAM_BOT_USERNAME?: string;
}
