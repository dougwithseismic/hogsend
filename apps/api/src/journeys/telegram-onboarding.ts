import { hours } from "@hogsend/core";
import { defineJourney, sendConnectorAction } from "@hogsend/engine";
import { TelegramEvents } from "@hogsend/plugin-telegram";

/**
 * Telegram — Onboarding. Fires on a bare `/start` (or `/start` with an
 * unknown/expired token), so tapping the bot or hitting Start always gets a
 * reply. A `/start <token>` from a minted deep link instead emits
 * `telegram.linked` (handled by the linked journey) and never reaches here.
 */
export const telegramOnboarding = defineJourney({
  meta: {
    id: "telegram-onboarding",
    name: "Telegram — Onboarding (/start)",
    enabled: true,
    trigger: { event: TelegramEvents.STARTED },
    entryLimit: "unlimited",
    suppress: hours(0),
  },

  run: async (user, _ctx) => {
    const chatId = user.properties.chatId
      ? String(user.properties.chatId)
      : null;
    if (!chatId) return;

    await sendConnectorAction({
      connectorId: "telegram",
      action: "sendMessage",
      args: {
        chatId,
        text:
          "👋 Welcome to Hogsend.\n\n" +
          "This bot is wired into a TypeScript lifecycle engine — send any " +
          "message and a journey replies in real time.\n\n" +
          "To connect this Telegram to your Hogsend contact, tap the " +
          "personalized connect link from your dashboard (one tap, no codes).",
      },
    });
  },
});
