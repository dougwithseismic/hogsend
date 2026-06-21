import { hours } from "@hogsend/core";
import {
  defineJourney,
  getEmailService,
  getRedis,
  sendConnectorAction,
} from "@hogsend/engine";
import {
  buildTelegramConfirmUrl,
  mintTelegramConfirmToken,
  TelegramEvents,
} from "@hogsend/plugin-telegram";

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

    // Anti email-bomb: cap confirmation-email sends per Telegram user. The
    // Telegram webhook has no per-message signature (only a static secret token),
    // so a forged/replayed /link could otherwise spray a victim's inbox from the
    // customer's own sending domain. 3 per rolling hour per fromId.
    const redis = getRedis();
    if (redis) {
      const rlKey = `hogsend:telegram:linkreq:rl:${fromId}`;
      const n = await redis.incr(rlKey);
      if (n === 1) await redis.expire(rlKey, 3600);
      if (n > 3) {
        await reply(
          "You've requested a few link emails recently — check your inbox, " +
            "or try again in a little while.",
        );
        return;
      }
    }

    const minted = await mintTelegramConfirmToken({
      telegramUserId: fromId,
      email,
    });
    if (!minted.ok) {
      await reply("Linking is briefly unavailable — please try again shortly.");
      return;
    }

    const apiPublicUrl = process.env.API_PUBLIC_URL ?? "http://localhost:3002";
    const url = buildTelegramConfirmUrl({ apiPublicUrl, token: minted.token });

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
