import { createColdConnect } from "@hogsend/engine";
import { TELEGRAM_PROVIDER_ID } from "./constants.js";
import { TelegramEvents } from "./events.js";

/**
 * Official Telegram paper-plane mark (monochrome, `currentColor`). Static
 * authored markup — see the `iconSvg` security note in the engine connect page.
 */
const TELEGRAM_ICON_SVG = `<svg viewBox="0 0 24 24" fill="currentColor" xmlns="http://www.w3.org/2000/svg"><path d="M9.78 18.65l.28-4.23 7.68-6.92c.34-.31-.07-.46-.52-.19L7.74 13.3 3.64 12c-.88-.25-.89-.86.2-1.3l15.97-6.16c.73-.27 1.43.18 1.15 1.3l-2.72 12.81c-.19.91-.74 1.13-1.5.71L12.6 16.3l-1.99 1.93c-.23.23-.42.42-.83.42z"/></svg>`;

/**
 * Telegram cold-connect flow, built on the engine `createColdConnect()`
 * primitive: `/link <email>` → emailed one-click confirm link → click →
 * engine-served connect page → button POST → server-sealed token → `ingestEvent`
 * folds `telegram:<id>` + email onto one contact → page runs CLIENT-side
 * `posthog.identify(contactKey, { telegram_id })`.
 *
 * Replaces the hand-rolled `apps/api/src/telegram-connect.ts` + the confirm-token
 * family in `link.ts`. The basePath stays `/connect/telegram` (derived from
 * `connectorId`), so confirmation emails already in flight keep resolving.
 *
 * CORRECTION (locked): the `telegram-linked` welcome journey branches on
 * `user.properties.chatId`, and `contactProperties` never reach the Hatchet
 * payload — so `chatId` (and the other ids the `/start` LINKED path emits) MUST
 * ride as scalar `eventProperties`. This mirrors the connector transform's
 * `/start <token>` LINKED branch (`source`/`chatId`/`fromId`/`via`) so both link
 * paths feed the journey identical trigger properties. For a private Telegram
 * chat the chat id IS the user id, so both resolve to the sealed platform id.
 */
export const telegramColdConnect = createColdConnect<Record<string, never>>({
  connectorId: TELEGRAM_PROVIDER_ID,
  identityKind: "userId",
  platformKey: (id) => `telegram:${id}`,
  linkedEvent: TelegramEvents.LINKED,
  identifyPropKey: "telegram_id",
  buildIngest: (binding) => ({
    // Scalar trigger properties the `telegram-linked` journey reads off
    // `user.properties.*`. chat_id === user id for a private chat.
    eventProperties: {
      source: "telegram",
      chatId: binding.platformUserId,
      fromId: binding.platformUserId,
      via: "email_confirm",
    },
    // `telegram` is in DEEP_MERGE_KEYS, so this never clobbers richer fields
    // (username/etc.) set by inbound messages — it merges.
    contactProperties: {
      telegram: {
        id: binding.platformUserId,
        chat_id: binding.platformUserId,
      },
    },
  }),
  branding: {
    badge: "✈️", // emoji fallback — not rendered while iconSvg is set
    iconSvg: TELEGRAM_ICON_SVG,
    // Telegram brand blue, darkened so the white Confirm-button label clears
    // WCAG AA (#2f81f7 was 3.75:1; #1f6feb is 4.63:1). Badge tint is unaffected.
    accentColor: "#1f6feb",
    title: "Connect your Telegram",
    blurb: "Tap below to finish linking your Telegram account to your contact.",
    reassurance:
      "Didn't start this in Telegram? You can safely close this tab — nothing links to your account until you tap Confirm above.",
    successCopy: {
      heading: "You're connected ✓",
      body: "Your Telegram is now linked. You can close this tab and head back to Telegram.",
    },
    errorCopy: {
      heading: "Link unavailable",
      body: "This link is invalid or already used. Send /link again in Telegram for a fresh one.",
    },
  },
  // No afterBind — Telegram has no post-bind side effect (no role grant).
});
