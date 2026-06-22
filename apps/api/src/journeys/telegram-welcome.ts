import { hours } from "@hogsend/core";
import { defineJourney, sendConnectorAction } from "@hogsend/engine";
import { TelegramEvents } from "@hogsend/plugin-telegram";

/**
 * Telegram — Welcome / Echo. Fires on every inbound Telegram message and replies
 * in real time, so the bot feels alive: an inbound platform event → a TypeScript
 * journey → an outbound message, all in your repo. `unlimited` so each message
 * gets a reply; the chat id rides on the trigger event's properties.
 */
export const telegramWelcome = defineJourney({
  meta: {
    id: "telegram-welcome",
    name: "Telegram — Welcome / Echo",
    enabled: true,
    trigger: { event: TelegramEvents.MESSAGE },
    entryLimit: "unlimited",
    suppress: hours(0),
  },

  run: async (user, _ctx) => {
    const chatId = user.properties.chatId
      ? String(user.properties.chatId)
      : null;
    if (!chatId) return;

    const said = user.properties.text ? String(user.properties.text) : "";

    await sendConnectorAction({
      connectorId: "telegram",
      action: "sendMessage",
      args: {
        chatId,
        text:
          "👋 You're connected to Hogsend. This reply is a TypeScript journey " +
          "reacting to your message in real time." +
          (said ? `\n\nYou said: “${said}”` : ""),
      },
    });
  },
});
