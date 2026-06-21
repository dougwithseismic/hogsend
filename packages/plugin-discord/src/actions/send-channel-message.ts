import {
  type DefinedConnectorAction,
  defineConnectorAction,
} from "@hogsend/engine";
import { DISCORD_PROVIDER_ID } from "../constants.js";
import { botFetch, type SendMessageResult } from "./rest.js";

export interface SendChannelMessageArgs {
  /** Target channel snowflake. */
  channelId: string;
  /** Message content (Discord markdown). */
  content: string;
  /**
   * Discord `allowed_mentions` object. Defaults to `{ parse: [] }` — a message
   * that merely CONTAINS `<@id>` text should not ping by surprise; opt in
   * explicitly (or use `mentionMembers` / `broadcastToChannel`).
   */
  allowedMentions?: unknown;
}

/** Post a plain message to a Discord channel (no pings by default). */
export const sendChannelMessage: DefinedConnectorAction<
  SendChannelMessageArgs,
  SendMessageResult
> = defineConnectorAction({
  connectorId: DISCORD_PROVIDER_ID,
  name: "sendChannelMessage",
  description: "Post a message to a Discord channel (bot-REST).",
  async run(args) {
    const res = (await botFetch(`/channels/${args.channelId}/messages`, {
      method: "POST",
      body: {
        content: args.content,
        allowed_mentions: args.allowedMentions ?? { parse: [] },
      },
    })) as { id?: string } | null;
    return { messageId: res?.id ?? null };
  },
});
