import assert from "node:assert/strict";
import test from "node:test";
import { AccountLinkCallbackError } from "@hogsend/core";
import { fakeFetch } from "./__fixtures__/fake-fetch.js";
import twitchFixtures from "./__fixtures__/twitch.json" with { type: "json" };
import { mapTwitchUser, twitchAccountLink } from "./twitch.js";

const CONFIG = {
  clientId: "fixture-client-id",
  clientSecret: "fixture-secret",
};
const REDIRECT_URI = "https://api.example.com/v1/accounts/twitch/callback";

function provider() {
  return twitchAccountLink(CONFIG);
}

test("authorizeUrl carries scope=user:read:email and force_verify", async () => {
  const url = new URL(
    await provider().authorizeUrl({
      state: "signed-state",
      redirectUri: REDIRECT_URI,
      codeChallenge: "challenge-abc",
    }),
  );
  assert.equal(
    url.origin + url.pathname,
    "https://id.twitch.tv/oauth2/authorize",
  );
  assert.equal(url.searchParams.get("response_type"), "code");
  assert.equal(url.searchParams.get("client_id"), CONFIG.clientId);
  assert.equal(url.searchParams.get("redirect_uri"), REDIRECT_URI);
  assert.equal(url.searchParams.get("scope"), "user:read:email");
  assert.equal(url.searchParams.get("state"), "signed-state");
  assert.equal(url.searchParams.get("code_challenge"), "challenge-abc");
  assert.equal(url.searchParams.get("code_challenge_method"), "S256");
  assert.equal(url.searchParams.get("force_verify"), "true");
});

test("the Helix profile call sends both Authorization and Client-Id", async () => {
  const { fetchImpl, calls } = fakeFetch({
    "POST https://id.twitch.tv/oauth2/token": {
      body: { access_token: "helix-access-token", refresh_token: "r1" },
    },
    "GET https://api.twitch.tv/helix/users": { body: twitchFixtures.users },
  });

  await provider().handleCallback({
    query: { code: "auth-code", state: "signed-state" },
    redirectUri: REDIRECT_URI,
    codeVerifier: "verifier-abc",
    fetchImpl,
  });

  const helix = calls.find((c) => c.url.startsWith("https://api.twitch.tv/"));
  assert.ok(helix, "no Helix call recorded");
  assert.equal(helix.headers.authorization, "Bearer helix-access-token");
  assert.equal(helix.headers["client-id"], CONFIG.clientId);
});

test("mapTwitchUser maps data[0] to a LinkedIdentity", () => {
  const identity = mapTwitchUser(twitchFixtures.users);
  // The IMMUTABLE numeric id, never login/display_name.
  assert.equal(identity.providerUserId, "141981764");
  assert.equal(identity.username, "TwitchDev");
  assert.match(identity.avatarUrl ?? "", /^https:\/\/static-cdn\.jtvnw\.net\//);
});

test("mapTwitchUser never sets verifiedEmail and stores twitch_email instead", () => {
  const identity = mapTwitchUser(twitchFixtures.users);
  assert.equal(identity.verifiedEmail, undefined);
  assert.equal("verifiedEmail" in identity, false);
  assert.equal(identity.properties?.twitch_email, "not-real@email.com");
});

test("mapTwitchUser throws when data is empty", () => {
  assert.throws(
    () => mapTwitchUser(twitchFixtures.usersEmpty),
    (err: unknown) =>
      err instanceof AccountLinkCallbackError &&
      err.reason === "exchange_failed",
  );
});

test("the full handleCallback runs through the injected fetchImpl with no network", async () => {
  const { fetchImpl, calls } = fakeFetch({
    "POST https://id.twitch.tv/oauth2/token": {
      body: {
        access_token: "helix-access-token",
        refresh_token: "r1",
        expires_in: 3600,
        scope: "user:read:email",
      },
    },
    "GET https://api.twitch.tv/helix/users": { body: twitchFixtures.users },
  });

  const identity = await provider().handleCallback({
    query: { code: "auth-code", state: "signed-state" },
    redirectUri: REDIRECT_URI,
    codeVerifier: "verifier-abc",
    fetchImpl,
  });

  // Exactly the two expected calls, both through the fake — an unmatched
  // route would have thrown, so nothing reached the global fetch.
  assert.deepEqual(
    calls.map(
      (c) => `${c.method} ${new URL(c.url).origin}${new URL(c.url).pathname}`,
    ),
    [
      "POST https://id.twitch.tv/oauth2/token",
      "GET https://api.twitch.tv/helix/users",
    ],
  );
  // The exchange carried the PKCE verifier and the byte-exact redirect_uri.
  const exchange = new URLSearchParams(calls[0]?.body ?? "");
  assert.equal(exchange.get("code"), "auth-code");
  assert.equal(exchange.get("code_verifier"), "verifier-abc");
  assert.equal(exchange.get("redirect_uri"), REDIRECT_URI);

  assert.equal(identity.providerUserId, "141981764");
  assert.equal(identity.verifiedEmail, undefined);
  // storeTokens: the grant rides on the identity for the engine to seal.
  assert.equal(identity.tokens?.accessToken, "helix-access-token");
  assert.equal(identity.tokens?.refreshToken, "r1");
});

test("a 401 from /helix/users throws exchange_failed with no response body in the message", async () => {
  const leakyBody = { error: "Unauthorized", message: "SECRET-LEAK-MARKER" };
  const { fetchImpl } = fakeFetch({
    "POST https://id.twitch.tv/oauth2/token": {
      body: { access_token: "helix-access-token" },
    },
    "GET https://api.twitch.tv/helix/users": { status: 401, body: leakyBody },
  });

  await assert.rejects(
    () =>
      provider().handleCallback({
        query: { code: "auth-code" },
        redirectUri: REDIRECT_URI,
        codeVerifier: "verifier-abc",
        fetchImpl,
      }),
    (err: unknown) => {
      assert.ok(err instanceof AccountLinkCallbackError);
      assert.equal(err.reason, "exchange_failed");
      // Status + host only. Never the body, never a token, never the secret.
      assert.match(err.message, /api\.twitch\.tv responded 401/);
      assert.doesNotMatch(err.message, /SECRET-LEAK-MARKER/);
      assert.doesNotMatch(err.message, /helix-access-token/);
      assert.doesNotMatch(err.message, /fixture-secret/);
      return true;
    },
  );
});
