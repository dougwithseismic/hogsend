import {
  type DefinedConnectorAction,
  defineConnectorAction,
} from "@hogsend/engine";
import { TELEGRAM_PROVIDER_ID } from "../constants.js";
import { resolveTelegramChatId, tgFetch } from "./rest.js";

export interface DmArgs {
  /** Recipient: a contact email / external id, or a raw Telegram chat id. */
  to: string;
  /** Message text. */
  text: string;
  parseMode?: "MarkdownV2" | "HTML";
}

export interface DmResult {
  messageId: number | null;
  /** False when the recipient is unresolved OR Telegram rejected (e.g. blocked). */
  delivered: boolean;
}

/**
 * Direct-message a contact on Telegram (resolved contact → chat id). Use this
 * when a NON-Telegram event (an app/email event) should reach the user on
 * Telegram; for a Telegram-triggered journey the chat id is already on
 * `user.properties.chatId`, so `sendMessage` is more direct.
 */
export const dm: DefinedConnectorAction<DmArgs, DmResult> =
  defineConnectorAction({
    connectorId: TELEGRAM_PROVIDER_ID,
    name: "dm",
    description:
      "Direct-message a contact on Telegram (resolved contact → chat id).",
    async run(args, ctx) {
      const chatId = await resolveTelegramChatId(ctx, args.to);
      if (!chatId) {
        ctx.logger.warn("telegram dm: recipient unresolved", { to: args.to });
        return { messageId: null, delivered: false };
      }
      const res = await tgFetch("sendMessage", {
        chat_id: chatId,
        text: args.text,
        ...(args.parseMode ? { parse_mode: args.parseMode } : {}),
      });
      if (!res.ok) {
        ctx.logger.warn("telegram dm: delivery failed", {
          errorCode: res.error_code ?? null,
          description: res.description ?? null,
        });
        return { messageId: null, delivered: false };
      }
      return { messageId: res.result?.message_id ?? null, delivered: true };
    },
  });
