/** The connector/registry id — keys the webhook route at POST /v1/webhooks/telegram. */
export const TELEGRAM_PROVIDER_ID = "telegram";

/** Bot API base; a method call is `${BASE}/bot${token}/${method}`. */
export const TELEGRAM_API_BASE = "https://api.telegram.org";

/**
 * Redis key prefix for one-tap `/start <token>` deep-link bindings (token →
 * email). Telegram caps the `start` deep-link param at 64 chars and forbids the
 * `.`-separated signed-state form, so the email binding is stored server-side
 * under a short opaque token instead of riding inside the link.
 */
export const TELEGRAM_LINK_REDIS_PREFIX = "hogsend:telegram:link:";

/** Default TTL (seconds) for a minted `/start` link binding. */
export const TELEGRAM_LINK_TTL_SECONDS = 900;

/**
 * Redis key prefix for `/link <email>` email-confirmation bindings (token →
 * { telegramUserId, email }). The confirmation LINK is emailed to the address,
 * so a click proves inbox ownership; the token seals BOTH ids server-side.
 */
export const TELEGRAM_CONFIRM_REDIS_PREFIX = "hogsend:telegram:confirm:";

/** Path (under the customer's API_PUBLIC_URL) that serves the connect page. */
export const TELEGRAM_CONNECT_PATH = "/connect/telegram";
