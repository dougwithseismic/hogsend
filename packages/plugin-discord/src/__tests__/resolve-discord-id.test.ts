import type {
  ConnectorActionCtx,
  ResolvedActionContact,
} from "@hogsend/engine";
import { describe, expect, it, vi } from "vitest";
import { resolveDiscordId } from "../actions/rest.js";

/**
 * Contract test for the plugin's `resolveDiscordId` — pure, no DB. The engine's
 * resolver (Fix B) is stubbed via `ctx.resolveContact`; this proves the plugin
 * trusts whatever canonical-key resolution the engine performs (incl. a uuid
 * `member: user.id` ref) and falls back to a bare snowflake correctly.
 */
function makeCtx(resolved: ResolvedActionContact | null): ConnectorActionCtx {
  return {
    db: {} as never,
    logger: {
      debug: vi.fn(),
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
    } as never,
    resolveContact: vi.fn().mockResolvedValue(resolved),
  };
}

function contact(over: Partial<ResolvedActionContact>): ResolvedActionContact {
  return {
    id: "00000000-0000-0000-0000-000000000000",
    email: null,
    discordId: null,
    externalId: null,
    properties: {},
    ...over,
  };
}

describe("resolveDiscordId (plugin contract)", () => {
  it("(1) returns the contact's discordId when the engine resolves a uuid-keyed ref", async () => {
    const ctx = makeCtx(contact({ discordId: "987654321098765432" }));
    await expect(
      resolveDiscordId(ctx, "00000000-0000-0000-0000-000000000abc"),
    ).resolves.toBe("987654321098765432");
  });

  it("(2) falls back to a bare snowflake ref when the engine resolves null", async () => {
    const ctx = makeCtx(null);
    await expect(resolveDiscordId(ctx, "222000111222000111")).resolves.toBe(
      "222000111222000111",
    );
  });

  it("(3) returns null for an unresolved (non-snowflake) uuid ref", async () => {
    const ctx = makeCtx(null);
    await expect(
      resolveDiscordId(ctx, "00000000-0000-0000-0000-000000000abc"),
    ).resolves.toBeNull();
  });

  it("(4) returns null when the resolved contact has discordId:null (e.g. an email-only ref)", async () => {
    const ctx = makeCtx(
      contact({ email: "user@example.com", discordId: null }),
    );
    await expect(resolveDiscordId(ctx, "user@example.com")).resolves.toBeNull();
  });
});
