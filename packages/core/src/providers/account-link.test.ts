import { describe, expect, expectTypeOf, it } from "vitest";
import { hours } from "../duration.js";
import {
  ACCOUNT_LINK_ID_RE,
  AccountLinkCallbackError,
  type AccountLinkProvider,
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
