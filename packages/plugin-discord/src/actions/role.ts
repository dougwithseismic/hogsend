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

export interface RemoveRoleArgs {
  /** The guild to remove the role in. */
  guildId: string;
  /** Recipient: email, external id, or raw discord snowflake. */
  member: string;
  /** The role id to remove. */
  roleId: string;
}

export interface RemoveRoleResult {
  /**
   * False when the member is unresolved OR Discord rejected the remove (a soft,
   * non-throwing failure — e.g. a permission/hierarchy 403).
   */
  removed: boolean;
}

/**
 * Remove a guild role from a member (resolved contact → discord_id) — the
 * counterpart to {@link grantRole} used by tenure ladders (e.g. demote Stranger
 * on `/link`, demote Piglet on graduating to Hog).
 *
 * IDEMPOTENT — Discord's `DELETE .../roles/{roleId}` returns 204 whether or not
 * the member currently has the role, so it is safe to call unconditionally. An
 * unresolved member or a permission/hierarchy rejection (403) is a SOFT failure
 * (`removed: false`, logged) rather than a throw. Same MANAGE_ROLES + role
 * hierarchy requirement as `grantRole`.
 */
export const removeRole: DefinedConnectorAction<
  RemoveRoleArgs,
  RemoveRoleResult
> = defineConnectorAction({
  connectorId: DISCORD_PROVIDER_ID,
  name: "removeRole",
  description:
    "Remove a guild role from a member (resolved contact → discord_id).",
  async run(args, ctx) {
    const id = await resolveDiscordId(ctx, args.member);
    if (!id) {
      ctx.logger.warn("discord removeRole: member unresolved", {
        member: args.member,
      });
      return { removed: false };
    }
    try {
      await botFetch(
        `/guilds/${args.guildId}/members/${id}/roles/${args.roleId}`,
        { method: "DELETE" },
      );
      return { removed: true };
    } catch (err) {
      ctx.logger.warn("discord removeRole: remove failed", {
        error: err instanceof Error ? err.message : String(err),
      });
      return { removed: false };
    }
  },
});
