/**
 * `@hogsend/plugin-telegram` engine-facing surface — the INBOUND webhook
 * connector, the journey-callable OUTBOUND actions, and the `/start` deep-link
 * helpers. Everything here runs inside the engine API/worker process; there is
 * no long-lived socket (Telegram is webhook transport).
 */

export {
  type DmArgs,
  type DmResult,
  dm,
  type SendMessageArgs,
  type SendMessageResult,
  sendMessage,
  telegramActions,
} from "./actions/index.js";
export { telegramColdConnect } from "./cold-connect.js";
export { telegramConnector } from "./connector.js";
export {
  TELEGRAM_API_BASE,
  TELEGRAM_CONNECT_PATH,
  TELEGRAM_LINK_REDIS_PREFIX,
  TELEGRAM_LINK_TTL_SECONDS,
  TELEGRAM_PROVIDER_ID,
} from "./constants.js";
export type { TelegramEnv } from "./env.js";
export { type TelegramEventName, TelegramEvents } from "./events.js";
export {
  type MintStartLinkResult,
  mintTelegramStartLink,
  peekTelegramStartToken,
  randomLinkToken,
} from "./link.js";
export type {
  TelegramChat,
  TelegramMessage,
  TelegramUpdate,
  TelegramUser,
} from "./types.js";
