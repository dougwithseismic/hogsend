import {
  type DefinedConnectorAction,
  defineConnectorAction,
} from "@hogsend/engine";
import { DISCORD_PROVIDER_ID } from "../constants.js";
import { botFetch, resolveDiscordId } from "./rest.js";

export interface DmMemberArgs {
  /** Recipient: email, external id, or raw discord snowflake. */
  member: string;
  /** Message content (Discord markdown). */
  content: string;
}

export interface DmResult {
  messageId: string | null;
  /** False when unresolved OR the user's DMs are closed (a soft, non-throwing failure). */
  delivered: boolean;
}

/**
 * Direct-message a member (resolved contact → discord_id). A closed-DM / no
 * shared-guild rejection is a SOFT failure (`delivered: false`, logged) rather
 * than a throw — a single un-DMable recipient must not fail a journey.
 */
export const dmMember: DefinedConnectorAction<DmMemberArgs, DmResult> =
  defineConnectorAction({
    connectorId: DISCORD_PROVIDER_ID,
    name: "dmMember",
    description:
      "Send a direct message to a member (resolved contact → discord_id).",
    async run(args, ctx) {
      const id = await resolveDiscordId(ctx, args.member);
      if (!id) {
        ctx.logger.warn("discord dmMember: recipient unresolved", {
          member: args.member,
        });
        return { messageId: null, delivered: false };
      }
      try {
        // Open (or fetch) the 1:1 DM channel, then post into it.
        const dm = (await botFetch("/users/@me/channels", {
          method: "POST",
          body: { recipient_id: id },
        })) as { id?: string } | null;
        if (!dm?.id) return { messageId: null, delivered: false };
        const res = (await botFetch(`/channels/${dm.id}/messages`, {
          method: "POST",
          body: { content: args.content },
        })) as { id?: string } | null;
        return { messageId: res?.id ?? null, delivered: Boolean(res?.id) };
      } catch (err) {
        // Closed DMs / no shared guild → Discord 403. Soft-fail.
        ctx.logger.warn("discord dmMember: delivery failed", {
          error: err instanceof Error ? err.message : String(err),
        });
        return { messageId: null, delivered: false };
      }
    },
  });
