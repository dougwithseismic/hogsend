import type { RecipeLander } from "./types";

const ONBOARDING_CODE = `// src/journeys/telegram-onboarding.ts — fires on a bare /start.
// A /start <token> from a minted deep link emits telegram.linked instead and
// never reaches here. The chat id to reply to rides on the trigger event.
import { hours } from "@hogsend/core";
import { defineJourney, sendConnectorAction } from "@hogsend/engine";
import { TelegramEvents } from "@hogsend/plugin-telegram";

export const telegramOnboarding = defineJourney({
  meta: {
    id: "telegram-onboarding",
    name: "Telegram — Onboarding (/start)",
    enabled: true,
    trigger: { event: TelegramEvents.STARTED }, // "telegram.started"
    entryLimit: "unlimited",
    suppress: hours(0),
  },

  run: async (user, _ctx) => {
    const chatId = user.properties.chatId ? String(user.properties.chatId) : null;
    if (!chatId) return;

    await sendConnectorAction({
      connectorId: "telegram",
      action: "sendMessage",
      args: {
        chatId,
        text:
          "👋 Welcome to Hogsend.\\n\\n" +
          "This bot is wired into a TypeScript lifecycle engine — send any " +
          "message and a journey replies in real time.",
      },
    });
  },
});`;

const ECHO_CODE = `// src/journeys/telegram-welcome.ts — fires on every inbound message.
// entryLimit "unlimited" replies to each one; the connector puts the message
// text (truncated to 500 chars) on the trigger event.
import { hours } from "@hogsend/core";
import { defineJourney, sendConnectorAction } from "@hogsend/engine";
import { TelegramEvents } from "@hogsend/plugin-telegram";

export const telegramWelcome = defineJourney({
  meta: {
    id: "telegram-welcome",
    name: "Telegram — Welcome / Echo",
    enabled: true,
    trigger: { event: TelegramEvents.MESSAGE }, // "telegram.message"
    entryLimit: "unlimited",
    suppress: hours(0),
  },

  run: async (user, _ctx) => {
    const chatId = user.properties.chatId ? String(user.properties.chatId) : null;
    if (!chatId) return;

    const said = user.properties.text ? String(user.properties.text) : "";

    // sendConnectorAction soft-fails: a blocked bot (403) returns delivered:false
    // rather than throwing out of the journey.
    await sendConnectorAction({
      connectorId: "telegram",
      action: "sendMessage",
      args: {
        chatId,
        text:
          "👋 You're connected to Hogsend. This reply is a TypeScript journey " +
          "reacting to your message in real time." +
          (said ? \`\\n\\nYou said: “\${said}”\` : ""),
      },
    });
  },
});`;

export const welcomeNewTelegramMembers: RecipeLander = {
  slug: "welcome-new-telegram-members",
  category: "onboarding",
  title: "Welcome new Telegram members",
  metaDescription:
    "A real-time onboarding pair triggered by telegram.started and telegram.message: reply to a bare /start with a welcome and echo every inbound message with a TypeScript journey, so an inbound platform event becomes an outbound Telegram reply in your repo.",
  cardDescription:
    "Reply on a bare /start with a welcome, and echo every inbound message — an inbound Telegram event becomes an outbound reply from a journey.",
  eyebrow: "Recipe — Onboarding & activation",
  subhead:
    "telegram.started and telegram.message arrive over the Bot API webhook carrying a chatId; a journey replies on that same chat with sendConnectorAction — no wait, no email, just an instant Telegram reply.",
  problem: {
    label: "The dead-bot problem",
    statement:
      "A Telegram bot that does not reply to /start or to a first message feels broken — the user taps Start, gets silence, and leaves. Wiring a separate webhook handler to answer is glue code that drifts from your lifecycle logic, so the reply ends up living somewhere other than the journeys that own the rest of onboarding.",
  },
  walkthrough: {
    eyebrow: "The journeys",
    title: "The reply is a journey, not a webhook handler",
    subtitle:
      "telegram.started triggers the onboarding welcome and telegram.message triggers the echo; each reads the chatId off the trigger event and replies with sendConnectorAction, so an inbound platform event and its outbound reply both live in your repo.",
    note: "Telegram is a two-way surface — the trigger event already carries a chatId to reply to, so the welcome reaches the user immediately with no address required. Linking the user's email is a separate concern handled by the /start deep link or the /link confirm flow.",
  },
  code: [
    {
      filename: "src/journeys/telegram-onboarding.ts",
      code: ONBOARDING_CODE,
      caption:
        "telegram.started fires on a bare /start (a /start <token> emits telegram.linked instead). The onboarding welcome replies on the chatId the trigger event carried — no email, no wait.",
    },
    {
      filename: "src/journeys/telegram-welcome.ts",
      code: ECHO_CODE,
      caption:
        'entryLimit "unlimited" makes the echo respond to every message, not just the first; the connector puts the message text (truncated to 500 chars) on the event, and sendConnectorAction soft-fails on a blocked bot.',
    },
  ],
  points: [
    {
      title: "The reply needs no email",
      body: "Telegram is two-way: the trigger event carries the chatId, so the welcome sends immediately on the same surface the user is on — unlike a Discord join, which has no address until the contact links one, so no waitForEvent is needed here.",
    },
    {
      title: "The event is a real contact upsert",
      body: "telegram.started and telegram.message run the same ingestion pipeline as every other event: stored in user_events, routed to the journey, and upserted onto a contact carrying a telegram:<id> external key plus the telegram metadata object — so the run has a stable user.id from the first step.",
    },
    {
      title: "/start <token> routes elsewhere",
      body: "A bare /start emits telegram.started and reaches the onboarding journey; a /start <token> from a minted deep link instead emits telegram.linked, handled by the linked journey. The two paths never collide, so a one-tap link never triggers the generic onboarding reply.",
    },
    {
      title: "Replies soft-fail, not throw",
      body: "sendConnectorAction is a bot-REST call that returns { messageId, delivered }: a Telegram-level error like 403 (the user blocked the bot) or a network blip returns delivered:false rather than throwing out of the journey, so one un-DMable user never kills the run.",
    },
  ],
  faq: [
    {
      q: "Why is there no waitForEvent, like the Discord welcome has?",
      a: "Telegram is a two-way surface and the trigger event already carries a chatId, so the welcome can reply immediately with no address. A Discord join has only a snowflake until the contact links an email, which is why that recipe parks on a link event; a Telegram reply needs none of that.",
    },
    {
      q: "Does every message really get a reply?",
      a: 'Yes — entryLimit: "unlimited" is what makes the echo journey respond to each distinct message rather than just the first. An onboarding-only flow would use "once" instead. Each event still carries a deterministic idempotencyKey, so a Telegram webhook retry won\'t double-fire a single message.',
    },
    {
      q: "How does the user link their email?",
      a: "Separately, and on their own terms: a one-tap /start deep link when you already know the email, or /link you@example.com for a cold connect that emails a confirmation link. See Link a Telegram account to an email — the welcome reply works whether or not the user has linked.",
    },
    {
      q: "Where does the chatId come from?",
      a: "The connector puts chatId (and fromId, message text, etc.) in the event's properties when it transforms the Telegram Update, so user.properties.chatId is populated on any telegram.* trigger. For a private chat the chat id equals the user id.",
    },
  ],
  links: [
    {
      label: "The full recipe in the docs",
      href: "/docs/recipes/welcome-new-telegram-members",
    },
    {
      label: "Telegram integration — events and identity",
      href: "/docs/integrations/telegram",
    },
    {
      label: "Journeys guide — sendConnectorAction",
      href: "/docs/guides/journeys",
    },
  ],
  related: ["link-telegram-to-email", "welcome-new-discord-members"],
};
