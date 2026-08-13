import assert from "node:assert/strict";
import test from "node:test";
import {
  AccountLinkCallbackError,
  hours,
  STEAM_OPENID_ENDPOINT,
  steamReturnTo,
} from "@hogsend/core";
import { fakeFetch } from "./__fixtures__/fake-fetch.js";
import steamFixtures from "./__fixtures__/steam.json" with { type: "json" };
import { steamAccountLink } from "./steam.js";

const REALM = "https://api.example.com";
const CALLBACK = "https://api.example.com/v1/accounts/steam/callback";
const STATE = "signed-state-token";
// The redirectUri the callback route presents = the return_to it minted
// (state included) — handleCallback compares the echo byte-for-byte.
const RETURN_TO = steamReturnTo(CALLBACK, STATE);
const STEAM_ID = "76561197960435530";

/** A well-formed positive assertion; tests override fields to break it. */
function provenQuery(
  overrides: Record<string, string> = {},
): Record<string, string> {
  return {
    "openid.ns": "http://specs.openid.net/auth/2.0",
    "openid.mode": "id_res",
    "openid.op_endpoint": STEAM_OPENID_ENDPOINT,
    "openid.claimed_id": `https://steamcommunity.com/openid/id/${STEAM_ID}`,
    "openid.identity": `https://steamcommunity.com/openid/id/${STEAM_ID}`,
    "openid.return_to": RETURN_TO,
    "openid.response_nonce": "2026-08-13T00:00:00Znonce",
    "openid.assoc_handle": "1234567890",
    "openid.signed":
      "signed,op_endpoint,claimed_id,identity,return_to,response_nonce,assoc_handle",
    "openid.sig": "fixture-signature",
    state: STATE,
    ...overrides,
  };
}

const CHECK_AUTH_ROUTE = `POST ${STEAM_OPENID_ENDPOINT}`;
const SUMMARIES_ROUTE =
  "GET https://api.steampowered.com/ISteamUser/GetPlayerSummaries/v2/";

test("authorizeUrl carries identifier_select, the configured realm and a return_to containing the state", async () => {
  const url = new URL(
    await steamAccountLink({ realm: REALM }).authorizeUrl({
      state: STATE,
      redirectUri: CALLBACK,
    }),
  );
  assert.equal(url.origin + url.pathname, STEAM_OPENID_ENDPOINT);
  assert.equal(url.searchParams.get("openid.mode"), "checkid_setup");
  assert.equal(
    url.searchParams.get("openid.claimed_id"),
    "http://specs.openid.net/auth/2.0/identifier_select",
  );
  assert.equal(
    url.searchParams.get("openid.identity"),
    "http://specs.openid.net/auth/2.0/identifier_select",
  );
  assert.equal(url.searchParams.get("openid.realm"), REALM);
  const returnTo = url.searchParams.get("openid.return_to");
  assert.ok(returnTo);
  assert.equal(new URL(returnTo).searchParams.get("state"), STATE);
});

test("a proven callback yields a 17-digit providerUserId, no verifiedEmail and no tokens", async () => {
  const { fetchImpl, calls } = fakeFetch({
    [CHECK_AUTH_ROUTE]: { text: steamFixtures.checkAuthenticationValid },
  });

  const identity = await steamAccountLink({ realm: REALM }).handleCallback({
    query: provenQuery(),
    redirectUri: RETURN_TO,
    fetchImpl,
  });

  assert.match(identity.providerUserId, /^\d{17}$/);
  assert.equal(identity.providerUserId, STEAM_ID);
  assert.equal(identity.verifiedEmail, undefined);
  assert.equal(identity.tokens, undefined);

  // The proof round-trip went to Steam's HARDCODED endpoint (never a
  // callback-supplied op_endpoint) with the mode rewritten.
  assert.equal(calls.length, 1);
  assert.equal(calls[0]?.url, STEAM_OPENID_ENDPOINT);
  const body = new URLSearchParams(calls[0]?.body ?? "");
  assert.equal(body.get("openid.mode"), "check_authentication");
  assert.equal(body.get("openid.sig"), "fixture-signature");
});

test("an is_valid:false answer is exchange_failed, not a link", async () => {
  const { fetchImpl } = fakeFetch({
    [CHECK_AUTH_ROUTE]: { text: steamFixtures.checkAuthenticationInvalid },
  });
  await assert.rejects(
    () =>
      steamAccountLink({ realm: REALM }).handleCallback({
        query: provenQuery(),
        redirectUri: RETURN_TO,
        fetchImpl,
      }),
    (err: unknown) =>
      err instanceof AccountLinkCallbackError &&
      err.reason === "exchange_failed",
  );
});

test("a web api key adds the GetPlayerSummaries profile pull", async () => {
  const { fetchImpl, calls } = fakeFetch({
    [CHECK_AUTH_ROUTE]: { text: steamFixtures.checkAuthenticationValid },
    [SUMMARIES_ROUTE]: { body: steamFixtures.playerSummaries },
  });

  const identity = await steamAccountLink({
    realm: REALM,
    webApiKey: "fixture-web-api-key",
  }).handleCallback({
    query: provenQuery(),
    redirectUri: RETURN_TO,
    fetchImpl,
  });

  assert.equal(identity.providerUserId, STEAM_ID);
  assert.equal(identity.username, "Robin");
  assert.equal(identity.avatarUrl, "https://avatars.steamstatic.com/full.jpg");
  const summaries = calls.find((c) => c.url.includes("GetPlayerSummaries"));
  assert.ok(summaries);
  const url = new URL(summaries.url);
  assert.equal(url.searchParams.get("steamids"), STEAM_ID);
});

test("a failing GetPlayerSummaries still yields a proven identity with no username", async () => {
  const { fetchImpl } = fakeFetch({
    [CHECK_AUTH_ROUTE]: { text: steamFixtures.checkAuthenticationValid },
    [SUMMARIES_ROUTE]: { status: 500, body: { error: "upstream down" } },
  });

  const identity = await steamAccountLink({
    realm: REALM,
    webApiKey: "fixture-web-api-key",
  }).handleCallback({
    query: provenQuery(),
    redirectUri: RETURN_TO,
    fetchImpl,
  });

  // A cosmetic pull must never fail a proven link.
  assert.equal(identity.providerUserId, STEAM_ID);
  assert.equal(identity.username, undefined);
  assert.equal(identity.avatarUrl, undefined);
});

test("sync is present because a web api key is configured, and its every is hours(24)", () => {
  const withKey = steamAccountLink({ realm: REALM, webApiKey: "k" });
  assert.equal(typeof withKey.sync?.read, "function");
  assert.deepEqual(withKey.sync?.every, hours(24));
  // The widen-not-enable proof from the provider side: no key, no sync — but
  // the provider itself still exists and links.
  const withoutKey = steamAccountLink({ realm: REALM });
  assert.equal(withoutKey.sync, undefined);
  assert.equal(withoutKey.capabilities?.tokens, undefined);
});

test("the security assertions hold end to end", async () => {
  const provider = steamAccountLink({ realm: REALM });

  // Foreign op_endpoint: refused BEFORE any network call — the round-trip is
  // never posted to a verifier the attacker names.
  {
    const { fetchImpl, calls } = fakeFetch({});
    await assert.rejects(
      () =>
        provider.handleCallback({
          query: provenQuery({
            "openid.op_endpoint": "https://evil.example.com/openid/login",
          }),
          redirectUri: RETURN_TO,
          fetchImpl,
        }),
      (err: unknown) =>
        err instanceof AccountLinkCallbackError &&
        err.reason === "state_invalid",
    );
    assert.equal(calls.length, 0);
  }

  // Mismatched return_to: a cross-flow replay, refused before any network.
  {
    const { fetchImpl, calls } = fakeFetch({});
    await assert.rejects(
      () =>
        provider.handleCallback({
          query: provenQuery({
            "openid.return_to": steamReturnTo(CALLBACK, "other-state"),
          }),
          redirectUri: RETURN_TO,
          fetchImpl,
        }),
      (err: unknown) =>
        err instanceof AccountLinkCallbackError &&
        err.reason === "state_invalid",
    );
    assert.equal(calls.length, 0);
  }

  // mode=cancel: the player's own "no" is denied, never state_invalid.
  {
    const { fetchImpl, calls } = fakeFetch({});
    await assert.rejects(
      () =>
        provider.handleCallback({
          query: { "openid.mode": "cancel", state: STATE },
          redirectUri: RETURN_TO,
          fetchImpl,
        }),
      (err: unknown) =>
        err instanceof AccountLinkCallbackError && err.reason === "denied",
    );
    assert.equal(calls.length, 0);
  }

  // Malformed claimed_id (prefix smuggling): parsed and refused pre-network.
  {
    const { fetchImpl, calls } = fakeFetch({});
    await assert.rejects(
      () =>
        provider.handleCallback({
          query: provenQuery({
            "openid.claimed_id": `https://evil.example/?x=https://steamcommunity.com/openid/id/${STEAM_ID}`,
          }),
          redirectUri: RETURN_TO,
          fetchImpl,
        }),
      (err: unknown) =>
        err instanceof AccountLinkCallbackError &&
        err.reason === "state_invalid",
    );
    assert.equal(calls.length, 0);
  }
});
