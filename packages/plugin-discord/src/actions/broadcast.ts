import {
  type DefinedConnectorAction,
  defineConnectorAction,
} from "@hogsend/engine";
import { DISCORD_PROVIDER_ID } from "../constants.js";
import { botFetch, type SendMessageResult } from "./rest.js";

export interface BroadcastToChannelArgs {
  /** Target channel snowflake. */
  channelId: string;
  /** Message content (Discord markdown). */
  content: string;
  /**
   * Whether `@everyone` / `@here` in the content actually ping. Default `true`
   * (a broadcast is announcement-shaped); set `false` to ping roles only.
   */
  pingEveryone?: boolean;
}

/** Broadcast to a channel, ALLOWING @everyone/@here + role pings to fire. */
export const broadcastToChannel: DefinedConnectorAction<
  BroadcastToChannelArgs,
  SendMessageResult
> = defineConnectorAction({
  connectorId: DISCORD_PROVIDER_ID,
  name: "broadcastToChannel",
  description:
    "Broadcast a message to a Discord channel, allowing @everyone/@role pings.",
  async run(args) {
    const allowed =
      args.pingEveryone === false
        ? { parse: ["roles"] }
        : { parse: ["everyone", "roles"] };
    const res = (await botFetch(`/channels/${args.channelId}/messages`, {
      method: "POST",
      body: { content: args.content, allowed_mentions: allowed },
    })) as { id?: string } | null;
    return { messageId: res?.id ?? null };
  },
});
