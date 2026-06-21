/**
 * Telegram inbound event names emitted by the connector transform. The
 * `telegram.` namespace mirrors `discord.` — a consumer journey triggers on
 * these strings (e.g. `trigger: { event: TelegramEvents.MESSAGE }`).
 */
export const TelegramEvents = {
  /** Any inbound text message that isn't a `/start` deep-link. */
  MESSAGE: "telegram.message",
  /** A bare `/start` (or `/start` with an unknown/expired token) — onboarding entry. */
  STARTED: "telegram.started",
  /** A `/start <token>` whose token resolved to a bound email — identity linked. */
  LINKED: "telegram.linked",
  /** A `/link <email>` request — an email-confirmation link is sent to bind it. */
  LINK_REQUESTED: "telegram.link_requested",
  /** An inline-keyboard button callback. */
  CALLBACK: "telegram.callback",
} as const;

export type TelegramEventName =
  (typeof TelegramEvents)[keyof typeof TelegramEvents];
