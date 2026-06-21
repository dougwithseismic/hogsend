import { hours } from "@hogsend/core";
import { defineJourney, sendConnectorAction } from "@hogsend/engine";
import { TelegramEvents } from "@hogsend/plugin-telegram";

/**
 * Telegram — Account Linked. Fires when a one-tap `/start <token>` deep link
 * binds a Telegram account to an email (the engine merged the Telegram identity
 * onto the email contact). Confirms the cross-channel link back in Telegram.
 */
export const telegramLinked = defineJourney({
  meta: {
    id: "telegram-linked",
    name: "Telegram — Account Linked",
    enabled: true,
    trigger: { event: TelegramEvents.LINKED },
    entryLimit: "unlimited",
    suppress: hours(0),
  },

  run: async (user, _ctx) => {
    const chatId = user.properties.chatId
      ? String(user.properties.chatId)
      : null;
    if (!chatId) return;

    const email = user.email ?? "your email";

    await sendConnectorAction({
      connectorId: "telegram",
      action: "sendMessage",
      args: {
        chatId,
        text:
          `✅ Linked your Telegram to ${email}.\n\n` +
          "Your community activity and email lifecycle are now one contact — " +
          "every journey can reach you on either channel.",
      },
    });
  },
});
