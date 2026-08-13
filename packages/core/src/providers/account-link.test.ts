import { describe, expect, expectTypeOf, it } from "vitest";
import { hours } from "../duration.js";
import {
  ACCOUNT_LINK_HOOK_TIMEOUT_MS,
  ACCOUNT_LINK_ID_RE,
  AccountLinkCallbackError,
  type AccountLinkHooks,
  type AccountLinkProvider,
  type AfterLinkContext,
  type AfterUnlinkContext,
  type BeforeLinkContext,
  type BeforeLinkVerdict,
  defineAccountLink,
  type LinkedIdentity,
  type LinkTokens,
  RESERVED_ACCOUNT_LINK_IDS,
} from "./account-link.js";

/**
 * A minimal well-formed provider. Each test clones it and breaks exactly one
 * thing, so a failure names the guard under test.
 */
const base = (): AccountLinkProvider => ({
  meta: { id: "twitch", name: "Twitch" },
  authorizeUrl: ({ state }) => `https://example.test/auth?state=${state}`,
  handleCallback: async () => ({ providerUserId: "12345" }),
});

describe("defineAccountLink — identity factory", () => {
  it("returns the provider unchanged when valid", () => {
    const provider = base();
    expect(defineAccountLink(provider)).toBe(provider);
  });

  it("rejects a non-conforming id", () => {
    expect(() =>
      defineAccountLink({ ...base(), meta: { id: "Steam!", name: "Steam" } }),
    ).toThrow(/Steam!/);
    expect(() =>
      defineAccountLink({ ...base(), meta: { id: "1steam", name: "Steam" } }),
    ).toThrow(/1steam/);
    expect(() =>
      defineAccountLink({ ...base(), meta: { id: "", name: "Steam" } }),
    ).toThrow();
    expect(() =>
      defineAccountLink({
        ...base(),
        meta: { id: "a".repeat(33), name: "Steam" },
      }),
    ).toThrow();
  });

  it("accepts an id at the 32-character limit", () => {
    expect(() =>
      defineAccountLink({
        ...base(),
        meta: { id: `a${"b".repeat(31)}`, name: "Long" },
      }),
    ).not.toThrow();
  });

  it("rejects a reserved id", () => {
    for (const id of RESERVED_ACCOUNT_LINK_IDS) {
      expect(() =>
        defineAccountLink({ ...base(), meta: { id, name: id } }),
      ).toThrow(new RegExp(`reserved.*${id}|${id}.*reserved`, "i"));
    }
  });

  it("rejects onConflict under multiple:true", () => {
    expect(() =>
      defineAccountLink({ ...base(), onConflict: "reject" }),
    ).toThrow(/onConflict/);
    expect(() =>
      defineAccountLink({ ...base(), multiple: true, onConflict: "replace" }),
    ).toThrow(/onConflict/);
  });

  it("accepts onConflict under multiple:false", () => {
    expect(() =>
      defineAccountLink({ ...base(), multiple: false, onConflict: "reject" }),
    ).not.toThrow();
  });

  it("rejects refresh without capabilities.tokens", () => {
    expect(() =>
      defineAccountLink({
        ...base(),
        refresh: async (tokens) => tokens,
      }),
    ).toThrow(/refresh/);
  });

  it("rejects revoke without capabilities.tokens", () => {
    expect(() =>
      defineAccountLink({
        ...base(),
        revoke: async () => {},
      }),
    ).toThrow(/revoke/);
  });

  it("accepts refresh and revoke when capabilities.tokens is true", () => {
    expect(() =>
      defineAccountLink({
        ...base(),
        capabilities: { tokens: true },
        refresh: async (tokens) => tokens,
        revoke: async () => {},
      }),
    ).not.toThrow();
  });

  it("rejects a non-positive sync.every", () => {
    expect(() =>
      defineAccountLink({
        ...base(),
        sync: { every: { hours: 0 }, read: async () => ({}) },
      }),
    ).toThrow(/every/);
    expect(() =>
      defineAccountLink({
        ...base(),
        sync: { every: { hours: -1 }, read: async () => ({}) },
      }),
    ).toThrow(/every/);
  });

  it("rejects sync without a read function", () => {
    expect(() =>
      defineAccountLink({
        ...base(),
        sync: { every: hours(24) } as unknown as AccountLinkProvider["sync"],
      }),
    ).toThrow(/read/);
  });

  it("accepts a positive sync.every with a read function", () => {
    expect(() =>
      defineAccountLink({
        ...base(),
        sync: {
          every: hours(24),
          read: async () => ({ steam_playtime_2wk: 4 }),
        },
      }),
    ).not.toThrow();
  });
});

describe("ACCOUNT_LINK_ID_RE / RESERVED_ACCOUNT_LINK_IDS", () => {
  it("accepts lowercase ids and rejects the rest", () => {
    expect(ACCOUNT_LINK_ID_RE.test("steam")).toBe(true);
    expect(ACCOUNT_LINK_ID_RE.test("twitch_tv")).toBe(true);
    expect(ACCOUNT_LINK_ID_RE.test("epic-games")).toBe(true);
    expect(ACCOUNT_LINK_ID_RE.test("Steam")).toBe(false);
    expect(ACCOUNT_LINK_ID_RE.test("_steam")).toBe(false);
    expect(ACCOUNT_LINK_ID_RE.test("steam.io")).toBe(false);
  });

  it("reserves the route segments and the cross-subsystem ids", () => {
    expect([...RESERVED_ACCOUNT_LINK_IDS]).toEqual([
      "me",
      "import",
      "link-url",
      "manage",
      "callback",
      "start",
      "email",
      "sms",
    ]);
  });
});

describe("AccountLinkCallbackError", () => {
  it("carries the three-value reason union and is an Error", () => {
    const err = new AccountLinkCallbackError("denied", "player backed out");
    expect(err).toBeInstanceOf(Error);
    expect(err.name).toBe("AccountLinkCallbackError");
    expect(err.reason).toBe("denied");
    expect(err.message).toBe("player backed out");
    expectTypeOf(err.reason).toEqualTypeOf<
      "denied" | "exchange_failed" | "state_invalid"
    >();
  });
});

describe("type contract", () => {
  it("pins providerUserId as a required string on LinkedIdentity", () => {
    expectTypeOf<LinkedIdentity["providerUserId"]>().toEqualTypeOf<string>();
  });

  it("keeps tokens optional and access-token-shaped", () => {
    expectTypeOf<LinkedIdentity["tokens"]>().toEqualTypeOf<
      LinkTokens | undefined
    >();
    expectTypeOf<LinkTokens["accessToken"]>().toEqualTypeOf<string>();
  });
});

// ---------------------------------------------------------------------------
// Hooks contract
//
// No runtime behaviour lives in this package (the store invokes the hooks; the
// posture is tested in the engine), so these are type-level assertions plus the
// one constant. They are enforced by `tsc --noEmit`, which type-checks `src`
// including this file — a widened field or a dropped narrowing turns them red
// there even though vitest alone cannot see them.
// ---------------------------------------------------------------------------

describe("BeforeLinkContext", () => {
  it("expresses the COLD path with no contact and no minting", () => {
    // The headline invariant: `contactId` is nullable so a fail-closed veto can
    // run BEFORE any write. A required string could only be satisfied by
    // minting a contact first (a ghost behind every rejected link) or by a
    // placeholder (lying to a security hook).
    const cold: BeforeLinkContext = {
      provider: "steam",
      identity: { providerUserId: "76561197960287930" },
      contactId: null,
      anonymousId: "anon_9f2c",
      userId: null,
      email: null,
    };
    expect(cold.contactId).toBeNull();
    expect(cold.anonymousId).toBe("anon_9f2c");
    expectTypeOf<BeforeLinkContext["contactId"]>().toEqualTypeOf<
      string | null
    >();
    expectTypeOf<BeforeLinkContext["anonymousId"]>().toEqualTypeOf<
      string | undefined
    >();
  });

  it("expresses the WARM path with a contested current owner", () => {
    const warm: BeforeLinkContext = {
      provider: "twitch",
      identity: { providerUserId: "12345", username: "player" },
      contactId: "ct_1",
      userId: "usr_ext_1",
      email: "player@example.test",
      currentOwnerContactId: "ct_2",
    };
    expect(warm.currentOwnerContactId).toBe("ct_2");
    expectTypeOf<BeforeLinkContext["currentOwnerContactId"]>().toEqualTypeOf<
      string | undefined
    >();
  });

  it("keeps userId and email nullable (the cold path has neither)", () => {
    expectTypeOf<BeforeLinkContext["userId"]>().toEqualTypeOf<string | null>();
    expectTypeOf<BeforeLinkContext["email"]>().toEqualTypeOf<string | null>();
  });

  it("carries the proven identity, not a provider-reported key", () => {
    expectTypeOf<
      BeforeLinkContext["identity"]
    >().toEqualTypeOf<LinkedIdentity>();
  });
});

describe("AfterLinkContext", () => {
  it("narrows contactId to a resolved string post-commit", () => {
    expectTypeOf<AfterLinkContext["contactId"]>().toEqualTypeOf<string>();
    const ctx: AfterLinkContext = {
      provider: "steam",
      identity: { providerUserId: "76561197960287930" },
      contactId: "ct_1",
      userId: "usr_ext_1",
      email: null,
      method: "oauth",
      relink: false,
      version: "9007199254740993",
      at: "2026-08-13T10:00:00.000Z",
    };
    expect(ctx.contactId).toBe("ct_1");
    // Post-commit contexts are still usable wherever a veto context is.
    expectTypeOf<AfterLinkContext>().toExtend<BeforeLinkContext>();

    // @ts-expect-error contactId is no longer nullable post-commit
    const nulled: AfterLinkContext = { ...ctx, contactId: null };
    expect(nulled.contactId).toBeNull();
  });

  it("types version as a STRING, never a JS number", () => {
    expectTypeOf<AfterLinkContext["version"]>().toEqualTypeOf<string>();
    // A bigint past Number.MAX_SAFE_INTEGER survives the round trip only as a
    // string; `9007199254740993` as a number silently becomes ...992.
    expect(BigInt("9007199254740993") > BigInt("9007199254740992")).toBe(true);
  });

  it("refuses a numeric version at the type level", () => {
    const ctx = {
      provider: "steam",
      identity: { providerUserId: "1" },
      contactId: "ct_1",
      userId: null,
      email: null,
      method: "oauth",
      relink: false,
      // @ts-expect-error version is a bigint-as-string, never a number
      version: 7,
      at: "2026-08-13T10:00:00.000Z",
    } satisfies AfterLinkContext;
    expect(typeof ctx.version).toBe("number");
  });

  it("pins the method union", () => {
    expectTypeOf<AfterLinkContext["method"]>().toEqualTypeOf<
      "oauth" | "import"
    >();
    expectTypeOf<AfterLinkContext["relink"]>().toEqualTypeOf<boolean>();
  });
});

describe("AfterUnlinkContext", () => {
  it("carries the three unlink reasons and a string version", () => {
    expectTypeOf<AfterUnlinkContext["reason"]>().toEqualTypeOf<
      "player" | "api" | "relinked"
    >();
    expectTypeOf<AfterUnlinkContext["version"]>().toEqualTypeOf<string>();
    expectTypeOf<AfterUnlinkContext["contactId"]>().toEqualTypeOf<string>();
    expectTypeOf<
      AfterUnlinkContext["providerUserId"]
    >().toEqualTypeOf<string>();

    const ctx: AfterUnlinkContext = {
      provider: "steam",
      providerUserId: "76561197960287930",
      contactId: "ct_1",
      userId: "usr_ext_1",
      email: null,
      reason: "relinked",
      version: "42",
      at: "2026-08-13T10:00:00.000Z",
    };
    expect(ctx.reason).toBe("relinked");
  });

  it("refuses an unlisted reason and a numeric version", () => {
    const bad = {
      provider: "steam",
      providerUserId: "1",
      contactId: "ct_1",
      userId: null,
      email: null,
      // @ts-expect-error "expired" is not one of the three unlink reasons
      reason: "expired",
      // @ts-expect-error version is a bigint-as-string, never a number
      version: 42,
      at: "2026-08-13T10:00:00.000Z",
    } satisfies AfterUnlinkContext;
    expect(bad.reason).toBe("expired");
  });
});

describe("AccountLinkHooks", () => {
  it("lets a veto hook return nothing, a verdict, or a promise", () => {
    // A void return means ALLOW: the hook ran to completion and raised no
    // objection. Denial is only ever EXPLICIT (`{ allow: false }`) or a
    // failure (throw / timeout). Nothing accidental in either direction.
    const hooks: AccountLinkHooks = {
      beforeLink: () => {},
      afterLink: () => {},
      afterUnlink: async () => {},
    };
    expect(hooks.beforeLink?.({} as BeforeLinkContext)).toBeUndefined();

    const denies: AccountLinkHooks = {
      beforeLink: () => ({ allow: false, reason: "region blocked" }),
    };
    expect(denies.beforeLink?.({} as BeforeLinkContext)).toEqual({
      allow: false,
      reason: "region blocked",
    });

    const asyncAllows: AccountLinkHooks = {
      beforeLink: async () => ({ allow: true }),
    };
    expectTypeOf(asyncAllows.beforeLink).not.toBeUndefined();
  });

  it("pins the verdict shape and refuses a look-alike", () => {
    expectTypeOf<BeforeLinkVerdict["allow"]>().toEqualTypeOf<boolean>();
    expectTypeOf<BeforeLinkVerdict["reason"]>().toEqualTypeOf<
      string | undefined
    >();

    const hooks: AccountLinkHooks = {
      // @ts-expect-error a verdict is `{ allow }`, not an arbitrary object
      beforeLink: () => ({ ok: true }),
    };
    expect(hooks.beforeLink).toBeTypeOf("function");
  });

  it("passes the right context to each hook", () => {
    const seen: string[] = [];
    const hooks: AccountLinkHooks = {
      beforeLink: (ctx) => {
        expectTypeOf(ctx).toEqualTypeOf<BeforeLinkContext>();
        seen.push(ctx.provider);
      },
      afterLink: (ctx) => {
        expectTypeOf(ctx).toEqualTypeOf<AfterLinkContext>();
        seen.push(ctx.version);
      },
      afterUnlink: (ctx) => {
        expectTypeOf(ctx).toEqualTypeOf<AfterUnlinkContext>();
        seen.push(ctx.reason);
      },
    };
    hooks.beforeLink?.({ provider: "steam" } as BeforeLinkContext);
    hooks.afterLink?.({ version: "7" } as AfterLinkContext);
    hooks.afterUnlink?.({ reason: "player" } as AfterUnlinkContext);
    expect(seen).toEqual(["steam", "7", "player"]);
  });

  it("keeps every hook optional", () => {
    const none: AccountLinkHooks = {};
    expect(none.beforeLink).toBeUndefined();
    expect(none.afterLink).toBeUndefined();
    expect(none.afterUnlink).toBeUndefined();
  });
});

describe("ACCOUNT_LINK_HOOK_TIMEOUT_MS", () => {
  it("is the single 5s bound the engine and the docs both quote", () => {
    expect(ACCOUNT_LINK_HOOK_TIMEOUT_MS).toBe(5_000);
    expectTypeOf<typeof ACCOUNT_LINK_HOOK_TIMEOUT_MS>().toEqualTypeOf<5000>();
  });
});
