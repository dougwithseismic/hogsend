import { describe, expect, it } from "vitest";
import type { z } from "zod";
import type {
  AccountLinkCapabilities,
  AccountLinkHooks,
  AccountLinkMeta,
  AccountLinkProvider,
  AccountSyncArgs,
  AfterLinkContext,
  AfterUnlinkContext,
  AuthorizeUrlArgs,
  BeforeLinkContext,
  BeforeLinkResult,
  BeforeLinkVerdict,
  HandleCallbackArgs,
  LinkedIdentity,
  LinkTokens,
  OAuth2LinkConfig,
  SteamOpenIdLinkConfig,
} from "../index.js";
// The barrel, exercised exactly as a consumer sees it (`@hogsend/core` resolves
// to this file). A public name that never reaches here is not public.
import * as core from "../index.js";
import {
  accountLinkProviderIdSchema,
  accountLinkVersionSchema,
  linkedIdentitySchema,
  linkMethodSchema,
  type linkTokensSchema,
  providerUserIdSchema,
  unlinkReasonSchema,
} from "./account-link.schema.js";

// ---------------------------------------------------------------------------
// Drift guards
//
// A schema that validates something a TYPE already expresses can drift away
// from it silently: add a field to `LinkedIdentity` and the wire validator
// quietly strips it forever. These are exact, BIDIRECTIONAL equality checks, so
// a change to either side fails `tsc` until both move together. They are
// compile-time only — `tsc --noEmit` is where they bite; vitest merely keeps
// them in a file that is always type-checked.
// ---------------------------------------------------------------------------

type Equals<A, B> =
  (<T>() => T extends A ? 1 : 2) extends <T>() => T extends B ? 1 : 2
    ? true
    : false;

/**
 * Fails to COMPILE unless its type argument is exactly `true`. The constraint
 * is the whole assertion; the runtime call is a no-op that keeps the check in a
 * file the type-checker always visits.
 */
function expectExactType<_T extends true>() {
  // Intentionally empty: the `extends true` constraint IS the assertion.
}

describe("schema/type drift", () => {
  it("keeps linkedIdentitySchema exactly congruent with LinkedIdentity", () => {
    expectExactType<
      Equals<z.infer<typeof linkedIdentitySchema>, LinkedIdentity>
    >();
    expectExactType<Equals<z.infer<typeof linkTokensSchema>, LinkTokens>>();
    expect(true).toBe(true);
  });

  it("keeps the enums exactly congruent with the hook context unions", () => {
    expectExactType<
      Equals<z.infer<typeof linkMethodSchema>, AfterLinkContext["method"]>
    >();
    expectExactType<
      Equals<z.infer<typeof unlinkReasonSchema>, AfterUnlinkContext["reason"]>
    >();
    expect(true).toBe(true);
  });
});

describe("accountLinkProviderIdSchema", () => {
  it("accepts a conforming provider id", () => {
    expect(accountLinkProviderIdSchema.parse("steam")).toBe("steam");
    expect(accountLinkProviderIdSchema.parse("epic_games-2")).toBe(
      "epic_games-2",
    );
  });

  it("rejects an id that is not a legal path segment", () => {
    expect(accountLinkProviderIdSchema.safeParse("Steam").success).toBe(false);
    expect(accountLinkProviderIdSchema.safeParse("1steam").success).toBe(false);
    expect(accountLinkProviderIdSchema.safeParse("st eam").success).toBe(false);
    expect(accountLinkProviderIdSchema.safeParse("").success).toBe(false);
    expect(accountLinkProviderIdSchema.safeParse("a".repeat(33)).success).toBe(
      false,
    );
  });
});

describe("providerUserIdSchema", () => {
  it("accepts a steamid64", () => {
    expect(providerUserIdSchema.parse("76561198000000000")).toBe(
      "76561198000000000",
    );
  });

  it("rejects an empty or over-long id", () => {
    expect(providerUserIdSchema.safeParse("").success).toBe(false);
    expect(providerUserIdSchema.safeParse("x".repeat(256)).success).toBe(false);
  });
});

describe("accountLinkVersionSchema", () => {
  // The version is a Postgres bigint. It exceeds Number.MAX_SAFE_INTEGER, so it
  // crosses every boundary as a numeric STRING; a schema that accepted a JS
  // number would silently round exactly the large values a consumer's
  // `incoming > stored` guard exists to compare.
  it("accepts a bigint beyond Number.MAX_SAFE_INTEGER as a string", () => {
    expect(accountLinkVersionSchema.parse("9007199254740993")).toBe(
      "9007199254740993",
    );
  });

  it("rejects a number, a non-numeric string, and a negative version", () => {
    expect(accountLinkVersionSchema.safeParse(12).success).toBe(false);
    expect(accountLinkVersionSchema.safeParse("12.5").success).toBe(false);
    expect(accountLinkVersionSchema.safeParse("-1").success).toBe(false);
    expect(accountLinkVersionSchema.safeParse("v12").success).toBe(false);
    expect(accountLinkVersionSchema.safeParse("").success).toBe(false);
  });
});

describe("linkedIdentitySchema", () => {
  it("parses a full identity and is compatible with LinkedIdentity", () => {
    const parsed = linkedIdentitySchema.parse({
      providerUserId: "76561198000000000",
      username: "player_one",
      verifiedEmail: "player@example.com",
      avatarUrl: "https://avatars.example/1.png",
      properties: {
        steam_playtime_2wk: 120,
        steam_profile_public: true,
        steam_country: "GB",
        steam_last_game: null,
      },
    });
    const asIdentity: LinkedIdentity = parsed;
    expect(asIdentity.providerUserId).toBe("76561198000000000");
    expect(asIdentity.properties?.steam_playtime_2wk).toBe(120);
  });

  it("parses a bare identity (Steam yields no email and no tokens)", () => {
    expect(
      linkedIdentitySchema.parse({ providerUserId: "76561198000000000" }),
    ).toEqual({ providerUserId: "76561198000000000" });
  });

  it("rejects a missing or empty providerUserId", () => {
    expect(linkedIdentitySchema.safeParse({}).success).toBe(false);
    expect(linkedIdentitySchema.safeParse({ providerUserId: "" }).success).toBe(
      false,
    );
  });

  it("rejects a non-scalar property value", () => {
    // These land on `contacts.properties`, which journeys and buckets read as
    // scalars — a nested object has nowhere to go.
    expect(
      linkedIdentitySchema.safeParse({
        providerUserId: "1",
        properties: { nested: { a: 1 } },
      }).success,
    ).toBe(false);
    expect(
      linkedIdentitySchema.safeParse({
        providerUserId: "1",
        properties: { list: [1, 2] },
      }).success,
    ).toBe(false);
  });

  it("rejects a verifiedEmail that is not an email address", () => {
    expect(
      linkedIdentitySchema.safeParse({
        providerUserId: "1",
        verifiedEmail: "not-an-email",
      }).success,
    ).toBe(false);
  });

  it("rejects an avatarUrl that is not a url", () => {
    expect(
      linkedIdentitySchema.safeParse({
        providerUserId: "1",
        avatarUrl: "javascript:alert(1)",
      }).success,
    ).toBe(false);
  });
});

describe("linkMethodSchema / unlinkReasonSchema", () => {
  it("accepts the contract's values", () => {
    expect(linkMethodSchema.parse("oauth")).toBe("oauth");
    expect(linkMethodSchema.parse("import")).toBe("import");
    for (const reason of ["player", "api", "relinked"] as const) {
      expect(unlinkReasonSchema.parse(reason)).toBe(reason);
    }
  });

  it("rejects anything else", () => {
    expect(linkMethodSchema.safeParse("manual").success).toBe(false);
    expect(unlinkReasonSchema.safeParse("erased").success).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Barrel
//
// A third party must be able to author a provider with nothing but
// `@hogsend/core`, so every name in the contract has to reach the package
// barrel. Types are checked by the `import type` block at the top of this file
// (a missing one fails `tsc`); values are checked here.
// ---------------------------------------------------------------------------

describe("@hogsend/core barrel", () => {
  it("exports every public account-link value", () => {
    // Static property access on purpose: a missing name is a COMPILE error
    // here as well as a failing assertion, so a barrel regression cannot slip
    // through as a skipped iteration.
    const publicValues = {
      defineAccountLink: core.defineAccountLink,
      oauth2Link: core.oauth2Link,
      steamOpenIdLink: core.steamOpenIdLink,
      parseSteamClaimedId: core.parseSteamClaimedId,
      steamReturnTo: core.steamReturnTo,
      AccountLinkCallbackError: core.AccountLinkCallbackError,
      AccountLinkTokenRefreshError: core.AccountLinkTokenRefreshError,
      ACCOUNT_LINK_ID_RE: core.ACCOUNT_LINK_ID_RE,
      ACCOUNT_LINK_HOOK_TIMEOUT_MS: core.ACCOUNT_LINK_HOOK_TIMEOUT_MS,
      RESERVED_ACCOUNT_LINK_IDS: core.RESERVED_ACCOUNT_LINK_IDS,
      STEAM_OPENID_ENDPOINT: core.STEAM_OPENID_ENDPOINT,
      STEAM_CLAIMED_ID_RE: core.STEAM_CLAIMED_ID_RE,
      accountLinkProviderIdSchema: core.accountLinkProviderIdSchema,
      accountLinkVersionSchema: core.accountLinkVersionSchema,
      linkedIdentitySchema: core.linkedIdentitySchema,
      linkTokensSchema: core.linkTokensSchema,
      linkMethodSchema: core.linkMethodSchema,
      unlinkReasonSchema: core.unlinkReasonSchema,
      providerUserIdSchema: core.providerUserIdSchema,
    };
    for (const [name, value] of Object.entries(publicValues)) {
      expect(value, `missing from the barrel: ${name}`).toBeDefined();
    }
  });

  it("keeps the presets' internals OFF the barrel", () => {
    // Deliberately private: they are implementation detail, and an exported
    // Steam endpoint/base that a caller could reach for invites exactly the
    // "make it configurable" mistake `STEAM_OPENID_ENDPOINT`'s doc comment
    // forbids.
    for (const name of [
      "resolveFetch",
      "endpointFailure",
      "readJson",
      "STEAM_API_BASE",
      "OPENID_NS",
      "OPENID_IDENTIFIER_SELECT",
      "linkPropertyValueSchema",
    ]) {
      expect(name in core, `should not be public: ${name}`).toBe(false);
    }
  });

  it("wires the barrel to the real implementations", () => {
    const provider: AccountLinkProvider = core.defineAccountLink({
      meta: { id: "acme", name: "Acme" } satisfies AccountLinkMeta,
      capabilities: { tokens: false } satisfies AccountLinkCapabilities,
      authorizeUrl: ({ state, redirectUri }: AuthorizeUrlArgs) =>
        `https://acme.test/auth?state=${state}&r=${redirectUri}`,
      handleCallback: async (_args: HandleCallbackArgs) =>
        ({ providerUserId: "1" }) satisfies LinkedIdentity,
    });
    expect(provider.meta.id).toBe("acme");
    expect(
      core.parseSteamClaimedId("https://steamcommunity.com/openid/id/1"),
    ).toBeNull();
    expect(core.ACCOUNT_LINK_HOOK_TIMEOUT_MS).toBe(5_000);
  });
});

// Type-only usages, so an unexported type fails `tsc --noEmit` rather than
// lingering as an unused import.
type _Surface = [
  AccountLinkHooks,
  AccountSyncArgs,
  AfterLinkContext,
  AfterUnlinkContext,
  BeforeLinkContext,
  BeforeLinkResult,
  BeforeLinkVerdict,
  LinkTokens,
  OAuth2LinkConfig,
  SteamOpenIdLinkConfig,
];
