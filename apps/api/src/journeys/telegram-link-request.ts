import { hours } from "@hogsend/core";
import {
  defineJourney,
  deriveJourneyKey,
  getEmailService,
  getJourneyBoundary,
  sendConnectorAction,
} from "@hogsend/engine";
import { TelegramEvents, telegramColdConnect } from "@hogsend/plugin-telegram";

/** Loose shape check only — the binding is PROVEN by the email being delivered. */
const EMAIL_RE = /^[^@\s]+@[^@\s]+\.[^@\s]+$/;

/**
 * Telegram — Link Request. Fires on `/link <email>`. Emails a single-use
 * confirmation link to that address; clicking it (see `telegram-connect.ts`)
 * proves inbox ownership, binds telegram↔email, and stitches PostHog from the
 * client (real geo/IP). The email IS the ownership proof — we never trust the
 * typed address until it's clicked.
 */
export const telegramLinkRequest = defineJourney({
  meta: {
    id: "telegram-link-request",
    name: "Telegram — Link Request (/link)",
    enabled: true,
    trigger: { event: TelegramEvents.LINK_REQUESTED },
    entryLimit: "unlimited",
    suppress: hours(0),
  },

  run: async (user, _ctx) => {
    const chatId = user.properties.chatId
      ? String(user.properties.chatId)
      : null;
    const fromId = user.properties.fromId
      ? String(user.properties.fromId)
      : null;
    if (!chatId || !fromId) return;

    const reply = (text: string) =>
      sendConnectorAction({
        connectorId: "telegram",
        action: "sendMessage",
        args: { chatId, text },
      });

    const email = user.properties.email ? String(user.properties.email) : "";
    if (!email || !EMAIL_RE.test(email)) {
      await reply("To connect your email, send:\n\n/link you@example.com");
      return;
    }

    // Mint a server-sealed confirm token. The cold-connect primitive owns the
    // anti email-bomb throttle now (Redis-INCR, fail-closed) — a forged/replayed
    // /link can't spray a victim's inbox, and a Redis fault returns
    // `{ ok:false }` so we never send a link we can't honor.
    //
    // The mint does a non-idempotent Redis INCR rate-limit bump, so a durable
    // replay would double-count it and could trip an honest user's `rate_limited`
    // gate. Memoize it through the journey boundary so a replay returns the
    // recorded mint instead of re-bumping (Layer 1, eviction-gated). On a
    // pre-eviction engine this falls through and re-runs — acceptable: the bump
    // is a soft limit, not a delivery.
    const boundary = getJourneyBoundary();
    const mintFn = () =>
      telegramColdConnect.mintConfirm({ platformUserId: fromId, email });
    const minted = boundary
      ? await boundary.memoize(
          [
            deriveJourneyKey({
              kind: "connector",
              anchor: boundary.runAnchor,
              site: "mint-confirm",
              discriminant: "telegram:mintConfirm",
            }),
          ],
          mintFn,
        )
      : await mintFn();
    if (!minted.ok) {
      if (minted.reason === "rate_limited") {
        await reply(
          "You've requested a few link emails recently — check your inbox, " +
            "or try again in a little while.",
        );
        return;
      }
      await reply("Linking is briefly unavailable — please try again shortly.");
      return;
    }

    const apiPublicUrl = process.env.API_PUBLIC_URL ?? "http://localhost:3002";
    const url = telegramColdConnect.confirmUrl({
      apiPublicUrl,
      token: minted.token,
    });

    await getEmailService().send({
      template: "transactional/magic-link",
      props: { magicLinkUrl: url, expiresIn: "15 minutes" },
      to: email,
      userId: email,
      userEmail: email,
      subject: "Confirm your Telegram connection",
      category: "transactional",
      skipPreferenceCheck: true,
    });

    await reply(
      `📧 I've emailed a confirmation link to ${email}.\n\n` +
        "Open it to finish connecting — it expires in 15 minutes.",
    );
  },
});
