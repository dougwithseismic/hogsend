import {
  type DefinedConnectorAction,
  defineConnectorAction,
} from "@hogsend/engine";
import { DISCORD_PROVIDER_ID } from "../constants.js";
import { botFetch, resolveDiscordId } from "./rest.js";

export interface GrantRoleArgs {
  /** The guild to grant the role in. */
  guildId: string;
  /** Recipient: email, external id, or raw discord snowflake. */
  member: string;
  /** The role id to add. */
  roleId: string;
}

export interface GrantRoleResult {
  /**
   * False when the member is unresolved OR Discord rejected the add (a soft,
   * non-throwing failure — e.g. a permission/hierarchy 403).
   */
  granted: boolean;
}

/**
 * Grant a guild role to a member (resolved contact → discord_id). The role-grant
 * half of the community-gamification loop (count an engagement event in a
 * journey → grant a role + DM).
 *
 * IDEMPOTENT — Discord's `PUT .../roles/{roleId}` returns 204 whether or not the
 * member already had the role, so re-granting is safe. An unresolved member or a
 * permission/hierarchy rejection (403) is a SOFT failure (`granted: false`,
 * logged) rather than a throw, so a single un-grantable member never fails a
 * journey.
 *
 * Operational: the bot needs the MANAGE_ROLES permission AND its own highest
 * role must sit ABOVE every role it grants, or Discord 403s.
 */
export const grantRole: DefinedConnectorAction<GrantRoleArgs, GrantRoleResult> =
  defineConnectorAction({
    connectorId: DISCORD_PROVIDER_ID,
    name: "grantRole",
    description:
      "Grant a guild role to a member (resolved contact → discord_id).",
    async run(args, ctx) {
      const id = await resolveDiscordId(ctx, args.member);
      if (!id) {
        ctx.logger.warn("discord grantRole: member unresolved", {
          member: args.member,
        });
        return { granted: false };
      }
      try {
        await botFetch(
          `/guilds/${args.guildId}/members/${id}/roles/${args.roleId}`,
          { method: "PUT" },
        );
        return { granted: true };
      } catch (err) {
        ctx.logger.warn("discord grantRole: grant failed", {
          error: err instanceof Error ? err.message : String(err),
        });
        return { granted: false };
      }
    },
  });
