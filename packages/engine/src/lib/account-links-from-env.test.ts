import assert from "node:assert/strict";
import test from "node:test";
import { hours } from "@hogsend/core";
import { accountLinksFromEnv } from "./account-links-from-env.js";

// `accountLinksFromEnv` is pure — it reads only the fields below off the env
// OBJECT it is handed, so the suite builds plain literals instead of stubbing
// process.env (env.ts itself is imported as a TYPE only; nothing here trips
// its import-time validation).
type EngineEnv = Parameters<typeof accountLinksFromEnv>[0];

function makeEnv(overrides: Partial<EngineEnv> = {}): EngineEnv {
  return {
    API_PUBLIC_URL: "https://api.example.com",
    ...overrides,
  } as EngineEnv;
}

function ids(env: EngineEnv): string[] {
  return accountLinksFromEnv(env).providers.map((p) => p.meta.id);
}

test("builds steam and ONLY steam from an otherwise empty env", () => {
  const result = accountLinksFromEnv(makeEnv());
  assert.deepEqual(
    result.providers.map((p) => p.meta.id),
    ["steam"],
  );
  assert.deepEqual(result.warnings, []);
});

test("builds twitch when both vars are set", () => {
  const result = accountLinksFromEnv(
    makeEnv({
      ACCOUNT_LINK_TWITCH_CLIENT_ID: "cid",
      ACCOUNT_LINK_TWITCH_CLIENT_SECRET: "csecret",
    }),
  );
  assert.deepEqual(
    result.providers.map((p) => p.meta.id),
    ["steam", "twitch"],
  );
  assert.deepEqual(result.warnings, []);
});

test("omits twitch and warns naming ACCOUNT_LINK_TWITCH_CLIENT_SECRET when only the id is set", () => {
  const result = accountLinksFromEnv(
    makeEnv({ ACCOUNT_LINK_TWITCH_CLIENT_ID: "cid" }),
  );
  assert.deepEqual(
    result.providers.map((p) => p.meta.id),
    ["steam"],
  );
  assert.equal(result.warnings.length, 1);
  assert.match(
    result.warnings[0] ?? "",
    /ACCOUNT_LINK_TWITCH_CLIENT_SECRET is unset/,
  );
});

test("omits twitch and warns naming ACCOUNT_LINK_TWITCH_CLIENT_ID when only the secret is set", () => {
  const result = accountLinksFromEnv(
    makeEnv({ ACCOUNT_LINK_TWITCH_CLIENT_SECRET: "csecret" }),
  );
  assert.deepEqual(
    result.providers.map((p) => p.meta.id),
    ["steam"],
  );
  assert.equal(result.warnings.length, 1);
  assert.match(
    result.warnings[0] ?? "",
    /ACCOUNT_LINK_TWITCH_CLIENT_ID is unset/,
  );
});

test("registers steam with no web api key and omits the sync capability", () => {
  const result = accountLinksFromEnv(makeEnv());
  const steam = result.providers.find((p) => p.meta.id === "steam");
  // The widen-not-enable proof: the provider EXISTS without the key…
  assert.ok(steam, "steam must register with no STEAM_WEB_API_KEY");
  // …and only the sync capability is missing.
  assert.equal(steam.sync, undefined);
});

test("attaches the steam sync capability when STEAM_WEB_API_KEY is set", () => {
  const result = accountLinksFromEnv(makeEnv({ STEAM_WEB_API_KEY: "wak" }));
  const steam = result.providers.find((p) => p.meta.id === "steam");
  assert.ok(steam);
  assert.equal(typeof steam.sync?.read, "function");
  assert.deepEqual(steam.sync?.every, hours(24));
});

test("passes API_PUBLIC_URL, trailing slash stripped, as the Steam realm", async () => {
  const result = accountLinksFromEnv(
    makeEnv({ API_PUBLIC_URL: "https://api.example.com/" }),
  );
  const steam = result.providers.find((p) => p.meta.id === "steam");
  assert.ok(steam);
  const url = new URL(
    await steam.authorizeUrl({
      state: "s",
      redirectUri: "https://api.example.com/v1/accounts/steam/callback",
    }),
  );
  assert.equal(url.searchParams.get("openid.realm"), "https://api.example.com");
});

test("builds no discord provider under any env", () => {
  const fullyConfigured = makeEnv({
    ACCOUNT_LINK_TWITCH_CLIENT_ID: "cid",
    ACCOUNT_LINK_TWITCH_CLIENT_SECRET: "csecret",
    STEAM_WEB_API_KEY: "wak",
  });
  for (const env of [makeEnv(), fullyConfigured]) {
    assert.equal(ids(env).includes("discord"), false);
  }
});
