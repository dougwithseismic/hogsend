import {
  type DefinedConnectorAction,
  defineConnectorAction,
} from "@hogsend/engine";
import { TELEGRAM_PROVIDER_ID } from "../constants.js";
import { tgFetch } from "./rest.js";

export interface SendMessageArgs {
  /** Telegram chat id to send to (string or number; a private chat == user id). */
  chatId: string | number;
  /** Message text. */
  text: string;
  /** Optional Telegram parse mode. */
  parseMode?: "MarkdownV2" | "HTML";
  /** Optional reply markup (inline keyboard, etc.), passed through verbatim. */
  replyMarkup?: Record<string, unknown>;
}

export interface SendMessageResult {
  messageId: number | null;
  delivered: boolean;
}

/** Send a text message to a Telegram chat by id (Bot API `sendMessage`). */
export const sendMessage: DefinedConnectorAction<
  SendMessageArgs,
  SendMessageResult
> = defineConnectorAction({
  connectorId: TELEGRAM_PROVIDER_ID,
  name: "sendMessage",
  description: "Send a text message to a Telegram chat (Bot API).",
  async run(args, ctx) {
    const res = await tgFetch("sendMessage", {
      chat_id: args.chatId,
      text: args.text,
      ...(args.parseMode ? { parse_mode: args.parseMode } : {}),
      ...(args.replyMarkup ? { reply_markup: args.replyMarkup } : {}),
    });
    if (!res.ok) {
      ctx.logger.warn("telegram sendMessage failed", {
        chatId: String(args.chatId),
        errorCode: res.error_code ?? null,
        description: res.description ?? null,
      });
      return { messageId: null, delivered: false };
    }
    return { messageId: res.result?.message_id ?? null, delivered: true };
  },
});
