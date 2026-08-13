import { describe, expect, it } from "vitest";
import { durationToMs } from "../duration.js";
import { AccountLinkCallbackError } from "./account-link.js";
import {
  AccountLinkTokenRefreshError,
  oauth2Link,
  parseSteamClaimedId,
  STEAM_OPENID_ENDPOINT,
  steamOpenIdLink,
  steamReturnTo,
} from "./account-link-presets.js";

// ---------------------------------------------------------------------------
// Test doubles
//
// Every test drives an INJECTED fetch. Nothing in this file touches the network
// and nothing here needs a real Steam or Twitch credential, which is the whole
// point of `HandleCallbackArgs.fetchImpl`.
// ---------------------------------------------------------------------------

interface RecordedCall {
  url: string;
  method: string;
  headers: Record<string, string>;
  body: string;
}

interface StubReply {
  status?: number;
  json?: unknown;
  text?: string;
}

/** A fetch stub that records every call and replays scripted replies in order. */
function stubFetch(replies: StubReply[]): {
  fetchImpl: typeof fetch;
  calls: RecordedCall[];
} {
  const calls: RecordedCall[] = [];
  let i = 0;
  const fetchImpl = (async (
    input: string | URL | Request,
    init?: RequestInit,
  ) => {
    const headers: Record<string, string> = {};
    for (const [k, v] of Object.entries(
      (init?.headers ?? {}) as Record<string, string>,
    )) {
      headers[k.toLowerCase()] = v;
    }
    calls.push({
      url: String(input),
      method: init?.method ?? "GET",
      headers,
      body:
        typeof init?.body === "string" ? init.body : String(init?.body ?? ""),
    });
    const reply = replies[i++] ?? { status: 200, json: {} };
    const body =
      reply.text ?? JSON.stringify(reply.json ?? {}, null, 0) ?? "{}";
    return new Response(body, { status: reply.status ?? 200 });
  }) as unknown as typeof fetch;
  return { fetchImpl, calls };
}

/** Assert-and-read a recorded call, so "no call happened" fails loudly. */
function callAt(calls: RecordedCall[], index: number): RecordedCall {
  const call = calls[index];
  if (!call) throw new Error(`expected a recorded fetch call at [${index}]`);
  return call;
}

const TWITCH = {
  meta: { id: "twitch", name: "Twitch" },
  authorizeEndpoint: "https://id.twitch.tv/oauth2/authorize",
  tokenEndpoint: "https://id.twitch.tv/oauth2/token",
  clientId: "cid_123",
  clientSecret: "csecret_456",
  scopes: ["user:read:email"],
  userInfo: {
    url: "https://api.twitch.tv/helix/users",
    headers: { "Client-Id": "cid_123" },
    map: (json: unknown) => {
      const [first] = (json as { data: { id: string; login: string }[] }).data;
      if (!first) throw new Error("helix returned no user");
      return { providerUserId: first.id, username: first.login };
    },
  },
};

const HELIX_USER = { data: [{ id: "141981764", login: "twitchdev" }] };

// ---------------------------------------------------------------------------
// T3 — oauth2Link()
// ---------------------------------------------------------------------------

describe("oauth2Link — authorizeUrl", () => {
  it("builds an authorize url with pkce", () => {
    const provider = oauth2Link({ ...TWITCH, usePkce: true });
    const url = new URL(
      provider.authorizeUrl({
        state: "st_abc",
        redirectUri: "https://api.test/v1/accounts/twitch/callback",
        codeChallenge: "chal_xyz",
      }) as string,
    );
    expect(url.origin + url.pathname).toBe(
      "https://id.twitch.tv/oauth2/authorize",
    );
    expect(url.searchParams.get("response_type")).toBe("code");
    expect(url.searchParams.get("client_id")).toBe("cid_123");
    expect(url.searchParams.get("redirect_uri")).toBe(
      "https://api.test/v1/accounts/twitch/callback",
    );
    expect(url.searchParams.get("state")).toBe("st_abc");
    expect(url.searchParams.get("code_challenge")).toBe("chal_xyz");
    expect(url.searchParams.get("code_challenge_method")).toBe("S256");
  });

  it("omits pkce params when disabled", () => {
    const provider = oauth2Link(TWITCH);
    const url = new URL(
      provider.authorizeUrl({
        state: "st_abc",
        redirectUri: "https://api.test/cb",
        codeChallenge: "chal_xyz",
      }) as string,
    );
    expect(url.searchParams.get("code_challenge")).toBeNull();
    expect(url.searchParams.get("code_challenge_method")).toBeNull();
    expect(provider.capabilities?.pkce).toBeUndefined();
  });

  it("joins scopes on a single space and carries authorizeParams", () => {
    const provider = oauth2Link({
      ...TWITCH,
      scopes: ["user:read:email", "channel:read:subscriptions"],
      authorizeParams: { force_verify: "true" },
    });
    const url = new URL(
      provider.authorizeUrl({
        state: "s",
        redirectUri: "https://api.test/cb",
      }) as string,
    );
    expect(url.searchParams.get("scope")).toBe(
      "user:read:email channel:read:subscriptions",
    );
    expect(url.searchParams.get("force_verify")).toBe("true");
  });

  it("refuses to build a pkce url without a challenge", () => {
    const provider = oauth2Link({ ...TWITCH, usePkce: true });
    expect(() =>
      provider.authorizeUrl({ state: "s", redirectUri: "https://api.test/cb" }),
    ).toThrow(/codeChallenge/);
  });
});

describe("oauth2Link — handleCallback", () => {
  it("maps access_denied to denied without any network call", async () => {
    const provider = oauth2Link(TWITCH);
    const { fetchImpl, calls } = stubFetch([]);
    await expect(
      provider.handleCallback({
        query: { error: "access_denied" },
        redirectUri: "https://api.test/cb",
        fetchImpl,
      }),
    ).rejects.toMatchObject({ reason: "denied" });
    expect(calls).toHaveLength(0);
  });

  it("maps any *_denied error to denied and other errors to exchange_failed", async () => {
    const provider = oauth2Link(TWITCH);
    const { fetchImpl } = stubFetch([]);
    await expect(
      provider.handleCallback({
        query: { error: "user_denied" },
        redirectUri: "https://api.test/cb",
        fetchImpl,
      }),
    ).rejects.toMatchObject({ reason: "denied" });
    await expect(
      provider.handleCallback({
        query: { error: "server_error" },
        redirectUri: "https://api.test/cb",
        fetchImpl,
      }),
    ).rejects.toMatchObject({ reason: "exchange_failed" });
  });

  it("maps a 500 exchange to exchange_failed", async () => {
    const provider = oauth2Link(TWITCH);
    const { fetchImpl } = stubFetch([{ status: 500, text: "boom" }]);
    await expect(
      provider.handleCallback({
        query: { code: "c" },
        redirectUri: "https://api.test/cb",
        fetchImpl,
      }),
    ).rejects.toMatchObject({ reason: "exchange_failed" });
  });

  it("never leaks the response body into the error message", async () => {
    const provider = oauth2Link(TWITCH);
    const leaky = JSON.stringify({
      error: "invalid_request",
      access_token: "SECRET_TOKEN_VALUE",
    });
    const { fetchImpl } = stubFetch([{ status: 400, text: leaky }]);
    const err = await provider
      .handleCallback({
        query: { code: "c" },
        redirectUri: "https://api.test/cb",
        fetchImpl,
      })
      .then(() => undefined)
      .catch((e: unknown) => e as AccountLinkCallbackError);
    expect(err).toBeInstanceOf(AccountLinkCallbackError);
    expect(err?.message).not.toContain("SECRET_TOKEN_VALUE");
    expect(err?.message).not.toContain(leaky);
    // Status + endpoint host are the only diagnostics that are safe to keep.
    expect(err?.message).toContain("400");
    expect(err?.message).toContain("id.twitch.tv");
  });

  it("sends code_verifier on exchange", async () => {
    const provider = oauth2Link({ ...TWITCH, usePkce: true });
    const { fetchImpl, calls } = stubFetch([
      { json: { access_token: "at_1" } },
      { json: HELIX_USER },
    ]);
    await provider.handleCallback({
      query: { code: "code_1" },
      redirectUri: "https://api.test/cb",
      codeVerifier: "ver_1",
      fetchImpl,
    });
    const body = new URLSearchParams(callAt(calls, 0).body);
    expect(callAt(calls, 0).method).toBe("POST");
    expect(callAt(calls, 0).headers["content-type"]).toBe(
      "application/x-www-form-urlencoded",
    );
    expect(body.get("grant_type")).toBe("authorization_code");
    expect(body.get("code")).toBe("code_1");
    expect(body.get("redirect_uri")).toBe("https://api.test/cb");
    expect(body.get("code_verifier")).toBe("ver_1");
  });

  it("sends userInfo.headers on the userinfo request", async () => {
    const provider = oauth2Link(TWITCH);
    const { fetchImpl, calls } = stubFetch([
      { json: { access_token: "at_1" } },
      { json: HELIX_USER },
    ]);
    const identity = await provider.handleCallback({
      query: { code: "c" },
      redirectUri: "https://api.test/cb",
      fetchImpl,
    });
    expect(callAt(calls, 1).url).toBe("https://api.twitch.tv/helix/users");
    expect(callAt(calls, 1).headers["client-id"]).toBe("cid_123");
    expect(callAt(calls, 1).headers.authorization).toBe("Bearer at_1");
    expect(identity).toEqual({
      providerUserId: "141981764",
      username: "twitchdev",
    });
  });

  it("userInfo.headers cannot override the Authorization header", async () => {
    const provider = oauth2Link({
      ...TWITCH,
      userInfo: {
        ...TWITCH.userInfo,
        headers: { "Client-Id": "cid_123", Authorization: "Bearer ATTACKER" },
      },
    });
    const { fetchImpl, calls } = stubFetch([
      { json: { access_token: "at_1" } },
      { json: HELIX_USER },
    ]);
    await provider.handleCallback({
      query: { code: "c" },
      redirectUri: "https://api.test/cb",
      fetchImpl,
    });
    expect(callAt(calls, 1).headers.authorization).toBe("Bearer at_1");
  });

  it("maps a non-2xx userinfo response to exchange_failed", async () => {
    const provider = oauth2Link(TWITCH);
    const { fetchImpl } = stubFetch([
      { json: { access_token: "at_1" } },
      { status: 401, text: "unauthorized" },
    ]);
    await expect(
      provider.handleCallback({
        query: { code: "c" },
        redirectUri: "https://api.test/cb",
        fetchImpl,
      }),
    ).rejects.toMatchObject({ reason: "exchange_failed" });
  });

  it("attaches tokens only when storeTokens is on", async () => {
    const bare = oauth2Link(TWITCH);
    const sealed = oauth2Link({ ...TWITCH, storeTokens: true });
    const a = stubFetch([
      { json: { access_token: "at_1", refresh_token: "rt_1" } },
      { json: HELIX_USER },
    ]);
    const b = stubFetch([
      {
        json: {
          access_token: "at_1",
          refresh_token: "rt_1",
          expires_in: 3600,
          scope: "user:read:email",
        },
      },
      { json: HELIX_USER },
    ]);
    const withoutTokens = await bare.handleCallback({
      query: { code: "c" },
      redirectUri: "https://api.test/cb",
      fetchImpl: a.fetchImpl,
    });
    const withTokens = await sealed.handleCallback({
      query: { code: "c" },
      redirectUri: "https://api.test/cb",
      fetchImpl: b.fetchImpl,
    });
    expect(withoutTokens.tokens).toBeUndefined();
    expect(withTokens.tokens?.accessToken).toBe("at_1");
    expect(withTokens.tokens?.refreshToken).toBe("rt_1");
    expect(withTokens.tokens?.scopes).toEqual(["user:read:email"]);
    expect(withTokens.tokens?.expiresAt).toMatch(/^\d{4}-/);
  });
});

describe("oauth2Link — refresh and revoke", () => {
  it("omits refresh when storeTokens is false", () => {
    expect(oauth2Link(TWITCH).refresh).toBeUndefined();
    expect(oauth2Link({ ...TWITCH, storeTokens: true }).refresh).toBeTypeOf(
      "function",
    );
    expect(oauth2Link(TWITCH).capabilities?.tokens).toBeUndefined();
  });

  it("omits revoke unless a revokeEndpoint AND storeTokens are set", () => {
    expect(
      oauth2Link({
        ...TWITCH,
        revokeEndpoint: "https://id.twitch.tv/oauth2/revoke",
      }).revoke,
    ).toBeUndefined();
    expect(oauth2Link({ ...TWITCH, storeTokens: true }).revoke).toBeUndefined();
    expect(
      oauth2Link({
        ...TWITCH,
        storeTokens: true,
        revokeEndpoint: "https://id.twitch.tv/oauth2/revoke",
      }).revoke,
    ).toBeTypeOf("function");
  });

  it("refresh flags invalid_grant", async () => {
    const provider = oauth2Link({ ...TWITCH, storeTokens: true });
    const { fetchImpl } = stubFetch([
      {
        status: 400,
        text: JSON.stringify({
          error: "invalid_grant",
          hint: "SECRET_TOKEN_VALUE",
        }),
      },
    ]);
    const err = await provider
      .refresh?.({ accessToken: "at_1", refreshToken: "rt_1" }, fetchImpl)
      .catch((e: unknown) => e as AccountLinkTokenRefreshError);
    expect(err).toBeInstanceOf(AccountLinkCallbackError);
    expect(err).toBeInstanceOf(AccountLinkTokenRefreshError);
    expect((err as AccountLinkTokenRefreshError).reason).toBe(
      "exchange_failed",
    );
    expect((err as AccountLinkTokenRefreshError).invalidGrant).toBe(true);
    // The branch must be readable WITHOUT string-matching a body, and the body
    // must not reach the message.
    expect((err as Error).message).not.toContain("SECRET_TOKEN_VALUE");
  });

  it("refresh reports a non-invalid_grant failure with invalidGrant false", async () => {
    const provider = oauth2Link({ ...TWITCH, storeTokens: true });
    const { fetchImpl } = stubFetch([{ status: 503, text: "upstream down" }]);
    const err = await provider
      .refresh?.({ accessToken: "at_1", refreshToken: "rt_1" }, fetchImpl)
      .catch((e: unknown) => e as AccountLinkTokenRefreshError);
    expect((err as AccountLinkTokenRefreshError).invalidGrant).toBe(false);
  });

  it("refresh posts grant_type=refresh_token and returns the new grant", async () => {
    const provider = oauth2Link({ ...TWITCH, storeTokens: true });
    const { fetchImpl, calls } = stubFetch([
      { json: { access_token: "at_2", refresh_token: "rt_2", expires_in: 60 } },
    ]);
    const next = await provider.refresh?.(
      { accessToken: "at_1", refreshToken: "rt_1" },
      fetchImpl,
    );
    const body = new URLSearchParams(callAt(calls, 0).body);
    expect(body.get("grant_type")).toBe("refresh_token");
    expect(body.get("refresh_token")).toBe("rt_1");
    expect(next?.accessToken).toBe("at_2");
    expect(next?.refreshToken).toBe("rt_2");
  });

  it("refresh without a refresh token fails closed", async () => {
    const provider = oauth2Link({ ...TWITCH, storeTokens: true });
    const { fetchImpl, calls } = stubFetch([]);
    const err = await provider
      .refresh?.({ accessToken: "at_1" }, fetchImpl)
      .catch((e: unknown) => e as AccountLinkTokenRefreshError);
    expect((err as AccountLinkTokenRefreshError).invalidGrant).toBe(true);
    expect(calls).toHaveLength(0);
  });

  it("revoke posts the token and swallows a provider non-2xx", async () => {
    const provider = oauth2Link({
      ...TWITCH,
      storeTokens: true,
      revokeEndpoint: "https://id.twitch.tv/oauth2/revoke",
    });
    const { fetchImpl, calls } = stubFetch([{ status: 400, text: "expired" }]);
    await expect(
      provider.revoke?.({ accessToken: "at_1" }, fetchImpl),
    ).resolves.toBeUndefined();
    expect(callAt(calls, 0).url).toBe("https://id.twitch.tv/oauth2/revoke");
    expect(new URLSearchParams(callAt(calls, 0).body).get("token")).toBe(
      "at_1",
    );
  });
});

// ---------------------------------------------------------------------------
// T4 — steamOpenIdLink()
// ---------------------------------------------------------------------------

const REALM = "https://api.test";
const RETURN_TO = steamReturnTo(
  "https://api.test/v1/accounts/steam/callback",
  "st_abc",
);

/** A well-formed positive assertion, as Steam actually sends it. */
function steamCallback(overrides: Record<string, string> = {}) {
  return {
    "openid.ns": "http://specs.openid.net/auth/2.0",
    "openid.mode": "id_res",
    "openid.op_endpoint": STEAM_OPENID_ENDPOINT,
    "openid.claimed_id":
      "https://steamcommunity.com/openid/id/76561197960287930",
    "openid.identity": "https://steamcommunity.com/openid/id/76561197960287930",
    "openid.return_to": RETURN_TO,
    "openid.response_nonce": "2026-08-13T10:00:00Zabcd",
    "openid.assoc_handle": "1234567890",
    "openid.signed":
      "signed,op_endpoint,claimed_id,identity,return_to,response_nonce,assoc_handle",
    "openid.sig": "c2ln",
    ...overrides,
  };
}

const VALID = { text: "ns:http://specs.openid.net/auth/2.0\nis_valid:true\n" };
const INVALID = {
  text: "ns:http://specs.openid.net/auth/2.0\nis_valid:false\n",
};

describe("parseSteamClaimedId", () => {
  it("returns the steamid64 for a well-formed claimed_id", () => {
    expect(
      parseSteamClaimedId(
        "https://steamcommunity.com/openid/id/76561197960287930",
      ),
    ).toBe("76561197960287930");
  });

  it("rejects another host, a wrong-length id and an unanchored suffix", () => {
    expect(
      parseSteamClaimedId("https://evil.example/openid/id/76561197960287930"),
    ).toBeNull();
    expect(
      parseSteamClaimedId(
        "http://steamcommunity.com/openid/id/76561197960287930",
      ),
    ).toBeNull();
    expect(
      parseSteamClaimedId("https://steamcommunity.com/openid/id/1234567890"),
    ).toBeNull();
    // The unanchored-pattern attack: a substring match would accept this.
    expect(
      parseSteamClaimedId(
        "https://evil.example/?x=https://steamcommunity.com/openid/id/76561197960287930",
      ),
    ).toBeNull();
    expect(
      parseSteamClaimedId(
        "https://steamcommunity.com/openid/id/76561197960287930/../..",
      ),
    ).toBeNull();
  });
});

describe("steamOpenIdLink — authorizeUrl", () => {
  it("builds a checkid_setup url with the realm", () => {
    const provider = steamOpenIdLink({ realm: REALM });
    const url = new URL(
      provider.authorizeUrl({
        state: "st_abc",
        redirectUri: "https://api.test/v1/accounts/steam/callback",
      }) as string,
    );
    expect(url.origin + url.pathname).toBe(STEAM_OPENID_ENDPOINT);
    expect(url.searchParams.get("openid.mode")).toBe("checkid_setup");
    expect(url.searchParams.get("openid.ns")).toBe(
      "http://specs.openid.net/auth/2.0",
    );
    expect(url.searchParams.get("openid.realm")).toBe(REALM);
    expect(url.searchParams.get("openid.claimed_id")).toBe(
      "http://specs.openid.net/auth/2.0/identifier_select",
    );
    expect(url.searchParams.get("openid.identity")).toBe(
      "http://specs.openid.net/auth/2.0/identifier_select",
    );
    // OpenID 2.0 has NO state parameter, so the state rides in return_to and
    // that value is the only channel binding this leg has.
    expect(url.searchParams.get("openid.return_to")).toBe(RETURN_TO);
    expect(new URL(RETURN_TO).searchParams.get("state")).toBe("st_abc");
  });

  it("defaults meta to steam and declares no token storage", () => {
    const provider = steamOpenIdLink({ realm: REALM, webApiKey: "k" });
    expect(provider.meta).toEqual({ id: "steam", name: "Steam" });
    // OpenID 2.0 issues no tokens, ever. Nothing may be sealed.
    expect(provider.capabilities?.tokens).toBeUndefined();
    expect(provider.refresh).toBeUndefined();
    expect(provider.revoke).toBeUndefined();
  });
});

describe("steamOpenIdLink — handleCallback", () => {
  it("returns the steamid64 after a valid check_authentication round trip", async () => {
    const provider = steamOpenIdLink({ realm: REALM });
    const { fetchImpl, calls } = stubFetch([VALID]);
    const identity = await provider.handleCallback({
      query: steamCallback(),
      redirectUri: RETURN_TO,
      fetchImpl,
    });
    expect(identity.providerUserId).toBe("76561197960287930");
    expect(identity.tokens).toBeUndefined();
    expect(identity.verifiedEmail).toBeUndefined();
    const body = new URLSearchParams(callAt(calls, 0).body);
    expect(body.get("openid.mode")).toBe("check_authentication");
    expect(body.get("openid.sig")).toBe("c2ln");
    expect(body.get("openid.claimed_id")).toBe(
      "https://steamcommunity.com/openid/id/76561197960287930",
    );
  });

  it("maps openid.mode=cancel to denied", async () => {
    const provider = steamOpenIdLink({ realm: REALM });
    const { fetchImpl, calls } = stubFetch([]);
    await expect(
      provider.handleCallback({
        query: { "openid.mode": "cancel" },
        redirectUri: RETURN_TO,
        fetchImpl,
      }),
    ).rejects.toMatchObject({ reason: "denied" });
    expect(calls).toHaveLength(0);
  });

  it("throws exchange_failed when is_valid is false", async () => {
    const provider = steamOpenIdLink({ realm: REALM });
    const { fetchImpl } = stubFetch([INVALID]);
    await expect(
      provider.handleCallback({
        query: steamCallback(),
        redirectUri: RETURN_TO,
        fetchImpl,
      }),
    ).rejects.toMatchObject({ reason: "exchange_failed" });
  });

  it("rejects a claimed_id on another host", async () => {
    const provider = steamOpenIdLink({ realm: REALM });
    const { fetchImpl, calls } = stubFetch([VALID]);
    await expect(
      provider.handleCallback({
        query: steamCallback({
          "openid.claimed_id":
            "https://evil.example/openid/id/76561197960287930",
        }),
        redirectUri: RETURN_TO,
        fetchImpl,
      }),
    ).rejects.toMatchObject({ reason: "state_invalid" });
    expect(calls).toHaveLength(0);
  });

  it("rejects a claimed_id with a non-17-digit id", async () => {
    const provider = steamOpenIdLink({ realm: REALM });
    const { fetchImpl, calls } = stubFetch([VALID]);
    await expect(
      provider.handleCallback({
        query: steamCallback({
          "openid.claimed_id": "https://steamcommunity.com/openid/id/123",
        }),
        redirectUri: RETURN_TO,
        fetchImpl,
      }),
    ).rejects.toMatchObject({ reason: "state_invalid" });
    expect(calls).toHaveLength(0);
  });

  it("rejects an unanchored claimed_id suffix attack", async () => {
    const provider = steamOpenIdLink({ realm: REALM });
    const { fetchImpl, calls } = stubFetch([VALID]);
    await expect(
      provider.handleCallback({
        query: steamCallback({
          "openid.claimed_id":
            "https://evil.example/?x=https://steamcommunity.com/openid/id/76561197960287930",
        }),
        redirectUri: RETURN_TO,
        fetchImpl,
      }),
    ).rejects.toMatchObject({ reason: "state_invalid" });
    expect(calls).toHaveLength(0);
  });

  it("does not call the web api when the claimed_id is malformed", async () => {
    // With a web api key the happy path makes TWO calls (verify + profile). A
    // malformed claimed_id must make ZERO: the platform is never touched on
    // behalf of an id we could not parse.
    const provider = steamOpenIdLink({ realm: REALM, webApiKey: "wk_1" });
    const { fetchImpl, calls } = stubFetch([VALID, { json: {} }]);
    await expect(
      provider.handleCallback({
        query: steamCallback({ "openid.claimed_id": "not-a-url" }),
        redirectUri: RETURN_TO,
        fetchImpl,
      }),
    ).rejects.toMatchObject({ reason: "state_invalid" });
    expect(calls).toHaveLength(0);
  });

  // -------------------------------------------------------------------------
  // The two security cases. Each is mutation-guarded: deleting the guard in
  // account-link-presets.ts must turn the test RED.
  // -------------------------------------------------------------------------

  it("posts check_authentication to steamcommunity.com even when op_endpoint names another host", async () => {
    // GUARD: the round trip exists to ask STEAM whether an assertion it
    // supposedly issued is genuine. If the callback names who answers that
    // question, an attacker points op_endpoint at a server they control, it
    // replies is_valid:true to their own forged assertion, and they own any
    // steamid64 they care to type.
    const provider = steamOpenIdLink({ realm: REALM });
    const { fetchImpl, calls } = stubFetch([VALID]);
    await expect(
      provider.handleCallback({
        query: steamCallback({
          "openid.op_endpoint": "https://evil.example/openid/login",
        }),
        redirectUri: RETURN_TO,
        fetchImpl,
      }),
    ).rejects.toMatchObject({ reason: "state_invalid" });
    // Rejected BEFORE anything left the process.
    expect(calls).toHaveLength(0);
  });

  it("never posts to an attacker-named op_endpoint even if the rejection is bypassed", async () => {
    // The second half of the same guard, stated as a positive: the POST target
    // is a module constant, so even an op_endpoint that merely differs in case
    // or trailing slash cannot redirect the verification.
    const provider = steamOpenIdLink({ realm: REALM });
    const { fetchImpl, calls } = stubFetch([VALID]);
    await provider.handleCallback({
      query: steamCallback(),
      redirectUri: RETURN_TO,
      fetchImpl,
    });
    expect(calls).toHaveLength(1);
    expect(new URL(callAt(calls, 0).url).origin).toBe(
      "https://steamcommunity.com",
    );
    expect(callAt(calls, 0).url).toBe(STEAM_OPENID_ENDPOINT);
  });

  it("accepts a callback that omits op_endpoint entirely", async () => {
    // The guard rejects a MISMATCH, not an absence: op_endpoint is not the
    // source of truth, so its absence changes nothing.
    const provider = steamOpenIdLink({ realm: REALM });
    const query = steamCallback();
    delete (query as Record<string, string>)["openid.op_endpoint"];
    const { fetchImpl, calls } = stubFetch([VALID]);
    const identity = await provider.handleCallback({
      query,
      redirectUri: RETURN_TO,
      fetchImpl,
    });
    expect(identity.providerUserId).toBe("76561197960287930");
    expect(callAt(calls, 0).url).toBe(STEAM_OPENID_ENDPOINT);
  });

  it("rejects a return_to that does not match the presented one", async () => {
    // GUARD: OpenID 2.0 has no `state` parameter, so return_to is the ONLY
    // channel binding. An assertion minted for another return_to is a
    // cross-flow replay.
    const provider = steamOpenIdLink({ realm: REALM });
    const { fetchImpl, calls } = stubFetch([VALID]);
    await expect(
      provider.handleCallback({
        query: steamCallback({
          "openid.return_to": steamReturnTo(
            "https://api.test/v1/accounts/steam/callback",
            "st_OTHER",
          ),
        }),
        redirectUri: RETURN_TO,
        fetchImpl,
      }),
    ).rejects.toMatchObject({ reason: "state_invalid" });
    expect(calls).toHaveLength(0);
  });

  it("compares return_to byte-exactly, not by prefix", async () => {
    const provider = steamOpenIdLink({ realm: REALM });
    const { fetchImpl, calls } = stubFetch([VALID]);
    await expect(
      provider.handleCallback({
        query: steamCallback({ "openid.return_to": `${RETURN_TO}&extra=1` }),
        redirectUri: RETURN_TO,
        fetchImpl,
      }),
    ).rejects.toMatchObject({ reason: "state_invalid" });
    expect(calls).toHaveLength(0);
  });
});

describe("steamOpenIdLink — profile and sync", () => {
  it("emits no sync block without a web api key", () => {
    expect(steamOpenIdLink({ realm: REALM }).sync).toBeUndefined();
    const synced = steamOpenIdLink({ realm: REALM, webApiKey: "wk_1" });
    expect(synced.sync).toBeDefined();
    expect(durationToMs(synced.sync?.every ?? {})).toBe(24 * 3_600_000);
  });

  it("reads playtime into a namespaced scalar", async () => {
    const provider = steamOpenIdLink({ realm: REALM, webApiKey: "wk_1" });
    const { fetchImpl, calls } = stubFetch([
      {
        json: {
          response: {
            games: [{ playtime_2weeks: 120 }, { playtime_2weeks: 30 }],
          },
        },
      },
    ]);
    const props = await provider.sync?.read({
      providerUserId: "76561197960287930",
      fetchImpl,
    });
    expect(props).toEqual({ steam_playtime_2wk: 150 });
    expect(callAt(calls, 0).url).toContain(
      "IPlayerService/GetRecentlyPlayedGames",
    );
    expect(callAt(calls, 0).url).toContain("steamid=76561197960287930");
  });

  it("returns no playtime scalar when steam has nothing to report", async () => {
    const provider = steamOpenIdLink({ realm: REALM, webApiKey: "wk_1" });
    const { fetchImpl } = stubFetch([{ status: 500, text: "down" }]);
    await expect(
      provider.sync?.read({ providerUserId: "1", fetchImpl }),
    ).resolves.toEqual({});
  });

  it("decorates the identity with display-only profile fields", async () => {
    const provider = steamOpenIdLink({ realm: REALM, webApiKey: "wk_1" });
    const { fetchImpl, calls } = stubFetch([
      VALID,
      {
        json: {
          response: {
            players: [
              {
                steamid: "76561197960287930",
                personaname: "Robin",
                avatarfull: "https://avatars.test/robin.jpg",
              },
            ],
          },
        },
      },
    ]);
    const identity = await provider.handleCallback({
      query: steamCallback(),
      redirectUri: RETURN_TO,
      fetchImpl,
    });
    expect(identity).toEqual({
      providerUserId: "76561197960287930",
      username: "Robin",
      avatarUrl: "https://avatars.test/robin.jpg",
    });
    expect(callAt(calls, 1).url).toContain("ISteamUser/GetPlayerSummaries");
  });

  it("still links when the profile fetch fails (display data is not proof)", async () => {
    const provider = steamOpenIdLink({ realm: REALM, webApiKey: "wk_1" });
    const { fetchImpl } = stubFetch([VALID, { status: 500, text: "down" }]);
    const identity = await provider.handleCallback({
      query: steamCallback(),
      redirectUri: RETURN_TO,
      fetchImpl,
    });
    expect(identity).toEqual({ providerUserId: "76561197960287930" });
  });
});
