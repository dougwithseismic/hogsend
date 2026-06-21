import {
  type DefinedConnectorAction,
  defineConnectorAction,
} from "@hogsend/engine";
import { DISCORD_PROVIDER_ID } from "../constants.js";
import { botFetch, resolveDiscordId, type SendMessageResult } from "./rest.js";

export interface MentionMembersArgs {
  /** Target channel snowflake. */
  channelId: string;
  /** Recipients: emails, external ids, or raw discord snowflakes. */
  members: string[];
  /** Optional message appended after the mentions. */
  content?: string;
}

export interface MentionMembersResult extends SendMessageResult {
  /** The discord ids that resolved + were mentioned. */
  mentioned: string[];
  /** Refs that could not be resolved to a discord id (skipped). */
  unresolved: string[];
}

/** Post a message @-mentioning specific members (resolved contact → discord_id). */
export const mentionMembers: DefinedConnectorAction<
  MentionMembersArgs,
  MentionMembersResult
> = defineConnectorAction({
  connectorId: DISCORD_PROVIDER_ID,
  name: "mentionMembers",
  description:
    "Post a message @-mentioning specific members (resolved contact → discord_id).",
  async run(args, ctx) {
    const mentioned: string[] = [];
    const unresolved: string[] = [];
    for (const ref of args.members) {
      const id = await resolveDiscordId(ctx, ref);
      if (id) mentioned.push(id);
      else unresolved.push(ref);
    }
    if (mentioned.length === 0) {
      ctx.logger.warn("discord mentionMembers: no members resolved", {
        unresolved,
      });
      return { messageId: null, mentioned, unresolved };
    }
    const mentions = mentioned.map((id) => `<@${id}>`).join(" ");
    const content = args.content ? `${mentions} ${args.content}` : mentions;
    const res = (await botFetch(`/channels/${args.channelId}/messages`, {
      method: "POST",
      // Only the explicitly-resolved users may ping — never widen to everyone.
      body: { content, allowed_mentions: { users: mentioned } },
    })) as { id?: string } | null;
    return { messageId: res?.id ?? null, mentioned, unresolved };
  },
});

export interface MentionRoleArgs {
  /** Target channel snowflake. */
  channelId: string;
  /** Role snowflake to mention (a group of members). */
  roleId: string;
  /** Optional message appended after the mention. */
  content?: string;
}

/** Post a message @-mentioning a role (a group of members). */
export const mentionRole: DefinedConnectorAction<
  MentionRoleArgs,
  SendMessageResult
> = defineConnectorAction({
  connectorId: DISCORD_PROVIDER_ID,
  name: "mentionRole",
  description: "Post a message @-mentioning a role (group of members).",
  async run(args) {
    const content = args.content
      ? `<@&${args.roleId}> ${args.content}`
      : `<@&${args.roleId}>`;
    const res = (await botFetch(`/channels/${args.channelId}/messages`, {
      method: "POST",
      body: { content, allowed_mentions: { roles: [args.roleId] } },
    })) as { id?: string } | null;
    return { messageId: res?.id ?? null };
  },
});
