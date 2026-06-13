import type { DiscordCurrentUser } from "./oauth.js";

/**
 * The shape a per-member link reduces to: the args for a single
 * `resolveOrCreateContact({ email?, discordId })` call (the consumer's
 * `resolveContact` callback forwards it). No bespoke merge path — the engine's
 * existing identity machinery folds the Discord-only contact onto the
 * email/identified one (or fills `discord_id` in when only the email resolves).
 */
export interface DiscordMemberLink {
  /** The Discord user the member linked. */
  user: DiscordCurrentUser;
}

export interface MemberLinkContactPatch {
  /**
   * The RAW Discord snowflake — routed through the engine's `discord` identity
   * Kind via `resolveOrCreateContact({ discordId })`, which makes the
   * `discord_id` column load-bearing. NOT a `discord:`-prefixed `userId`: that
   * stuffed the snowflake into `external_id`, leaving `discord_id` always NULL.
   */
  discordId: string;
  contactProperties: Record<string, unknown>;
}

/**
 * Map a member-link OAuth result → a contact patch.
 *
 * SECURITY — the Discord-reported email is NEVER a resolution/merge KEY here:
 * the authoritative email is the one the link was ISSUED for (carried in the
 * engine-verified `state.email`), so the connector passes THAT to
 * `resolveContact`, not whatever Discord returns. The Discord-reported email is
 * stored ONLY as a non-key `contactProperty` (`discordEmail`), and ONLY when
 * Discord reports it present AND `verified === true` — an unverified email is
 * dropped entirely. This closes the grafting/account-takeover vector where an
 * attacker sets a Discord email matching a victim's contact to merge into it.
 *
 * `isDiscordLinked` is stamped `true` here — a successful per-member link is the
 * ONLY thing that sets it (an unlinked Discord-only contact never gets it).
 */
export function memberLinkToContactPatch(
  link: DiscordMemberLink,
): MemberLinkContactPatch {
  const { user } = link;
  const verifiedEmail =
    user.verified === true &&
    typeof user.email === "string" &&
    user.email.length > 0
      ? user.email
      : undefined;

  const contactProperties: Record<string, unknown> = {
    discordUserId: user.id,
    isDiscordLinked: true,
  };
  if (typeof user.username === "string") {
    contactProperties.discordUsername = user.username;
  }
  // Non-key property only — NEVER a resolution key (anti-graft, see above).
  if (verifiedEmail) {
    contactProperties.discordEmail = verifiedEmail;
  }

  return {
    discordId: user.id,
    contactProperties,
  };
}
