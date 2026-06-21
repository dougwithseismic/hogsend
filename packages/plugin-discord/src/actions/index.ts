import type { DefinedConnectorAction } from "@hogsend/engine";
import { broadcastToChannel } from "./broadcast.js";
import { dmMember } from "./dm.js";
import { mentionMembers, mentionRole } from "./mention.js";
import { sendChannelMessage } from "./send-channel-message.js";

/**
 * Every Discord OUTBOUND action — pass to
 * `createHogsendClient({ connectorActions: discordActions })`, then invoke from a
 * journey via the standalone `sendConnectorAction({ connectorId: "discord", … })`.
 * All are bot-REST (token only), socket-free, and independent of the inbound
 * gateway runtime.
 */
export const discordActions: DefinedConnectorAction[] = [
  sendChannelMessage,
  broadcastToChannel,
  mentionMembers,
  mentionRole,
  dmMember,
];

export {
  type BroadcastToChannelArgs,
  broadcastToChannel,
} from "./broadcast.js";
export { type DmMemberArgs, type DmResult, dmMember } from "./dm.js";
export {
  type MentionMembersArgs,
  type MentionMembersResult,
  type MentionRoleArgs,
  mentionMembers,
  mentionRole,
} from "./mention.js";
export type { SendMessageResult } from "./rest.js";
export {
  type SendChannelMessageArgs,
  sendChannelMessage,
} from "./send-channel-message.js";
