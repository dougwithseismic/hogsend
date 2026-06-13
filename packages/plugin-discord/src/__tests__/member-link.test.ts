import { describe, expect, it } from "vitest";
import { memberLinkToContactPatch } from "../connect/member-link.js";
import type { DiscordCurrentUser } from "../connect/oauth.js";

/**
 * The member-link reducer maps a `/users/@me` pull → a contact patch. It must:
 *  - route the snowflake through `discordId` (the sole identity KEY),
 *  - populate the NON-KEY `properties.discord` metadata object,
 *  - keep `isDiscordLinked` + the verified-only `discordEmail` as TOP-LEVEL
 *    flags (anti-graft: the Discord email is never a resolution key).
 */
describe("memberLinkToContactPatch", () => {
  it("emits a nested discord metadata object + discordId key", () => {
    const user: DiscordCurrentUser = {
      id: "u1",
      username: "alice",
      global_name: "Alice",
      avatar: "hash1",
      email: "alice@example.com",
      verified: true,
    };
    const patch = memberLinkToContactPatch({ user });

    expect(patch.discordId).toBe("u1");
    const discord = patch.contactProperties.discord as Record<string, unknown>;
    expect(discord).toEqual({
      id: "u1",
      username: "alice",
      global_name: "Alice",
      avatar: "hash1",
    });
    // A link is an identity attach, not activity — no last_seen stamped here.
    expect(discord.last_seen).toBeUndefined();
    expect(patch.contactProperties.isDiscordLinked).toBe(true);
  });

  it("stores a VERIFIED Discord email as a non-key flag only", () => {
    const patch = memberLinkToContactPatch({
      user: { id: "u2", email: "v@example.com", verified: true },
    });
    expect(patch.contactProperties.discordEmail).toBe("v@example.com");
  });

  it("DROPS an unverified Discord email (anti-graft)", () => {
    const patch = memberLinkToContactPatch({
      user: { id: "u3", email: "u@example.com", verified: false },
    });
    expect(patch.contactProperties.discordEmail).toBeUndefined();
    // The id still routes through the identity key.
    expect(patch.discordId).toBe("u3");
  });

  it("omits absent optional metadata fields (no null clobber)", () => {
    const patch = memberLinkToContactPatch({ user: { id: "u4" } });
    const discord = patch.contactProperties.discord as Record<string, unknown>;
    expect(discord).toEqual({ id: "u4" });
  });
});
