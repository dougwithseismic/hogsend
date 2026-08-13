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
    // The schema defaults this to 900, so the parsed env ALWAYS carries it —
    // included here so every case proves the gate ignores it.
    ACCOUNT_LINK_STATE_TTL_SECONDS: 900,
    ...overrides,
  } as EngineEnv;
}

const OPTED_IN = { consumerOptedIn: true };

function ids(
  env: EngineEnv,
  options?: { consumerOptedIn?: boolean },
): string[] {
  return accountLinksFromEnv(env, options).providers.map((p) => p.meta.id);
}

// ---------------------------------------------------------------------------
// The intent gate
// ---------------------------------------------------------------------------

test("builds NO providers from a truly empty env", () => {
  // The inert-when-unconfigured posture: no ACCOUNT_LINK_* var, no
  // STEAM_WEB_API_KEY, no consumer option ⇒ nothing registers, so a bare
  // deploy exposes no /v1/accounts/* provider and warns about nothing.
  const result = accountLinksFromEnv(makeEnv());
  assert.deepEqual(result.providers, []);
  assert.deepEqual(result.warnings, []);
});

test("ACCOUNT_LINK_STATE_TTL_SECONDS alone is NOT intent", () => {
  // The var carries `.default(900)`, so it is ALWAYS truthy on the parsed
  // env. If it ever joined the intent check the gate would be vacuously true
  // on every deploy — the exact bug the gate exists to remove. An explicit
  // non-default value must not count either: setting a TTL tunes a flow, it
  // does not ask for one.
  const result = accountLinksFromEnv(
    makeEnv({ ACCOUNT_LINK_STATE_TTL_SECONDS: 1234 }),
  );
  assert.deepEqual(result.providers, []);
  assert.deepEqual(result.warnings, []);
});

test("builds steam from ACCOUNT_LINK_ALLOWED_ORIGINS alone", () => {
  // Env intent with no credential at all — an allowlist only exists for the
  // account-link flow, so setting it is asking for the feature.
  const result = accountLinksFromEnv(
    makeEnv({ ACCOUNT_LINK_ALLOWED_ORIGINS: "https://play.example.com" }),
  );
  assert.deepEqual(
    result.providers.map((p) => p.meta.id),
    ["steam"],
  );
  assert.deepEqual(result.warnings, []);
});

test("builds steam when the consumer passes an accountLinks option", () => {
  // Code intent: the container passes `consumerOptedIn` when ANY
  // `accountLinks` option was given to createHogsendClient — even `{}`.
  const result = accountLinksFromEnv(makeEnv(), OPTED_IN);
  assert.deepEqual(
    result.providers.map((p) => p.meta.id),
    ["steam"],
  );
  assert.deepEqual(result.warnings, []);
});

test("builds steam and ONLY steam from an otherwise empty env, once opted in", () => {
  // The zero-CREDENTIAL proof (steam needs no app registration, no client
  // id, no secret) — intent shown, nothing else configured.
  const result = accountLinksFromEnv(makeEnv(), OPTED_IN);
  assert.deepEqual(
    result.providers.map((p) => p.meta.id),
    ["steam"],
  );
  assert.deepEqual(result.warnings, []);
});

// ---------------------------------------------------------------------------
// Twitch
// ---------------------------------------------------------------------------

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

// ---------------------------------------------------------------------------
// Steam widen-not-enable
// ---------------------------------------------------------------------------

test("registers steam with no web api key and omits the sync capability", () => {
  const result = accountLinksFromEnv(makeEnv(), OPTED_IN);
  const steam = result.providers.find((p) => p.meta.id === "steam");
  // The widen-not-enable proof: the provider EXISTS without the key…
  assert.ok(steam, "steam must register with no STEAM_WEB_API_KEY");
  // …and only the sync capability is missing.
  assert.equal(steam.sync, undefined);
});

test("attaches the steam sync capability when STEAM_WEB_API_KEY is set", () => {
  // The key is itself env intent, so no opt-in is needed alongside it.
  const result = accountLinksFromEnv(makeEnv({ STEAM_WEB_API_KEY: "wak" }));
  const steam = result.providers.find((p) => p.meta.id === "steam");
  assert.ok(steam);
  assert.equal(typeof steam.sync?.read, "function");
  assert.deepEqual(steam.sync?.every, hours(24));
});

test("passes API_PUBLIC_URL, trailing slash stripped, as the Steam realm", async () => {
  const result = accountLinksFromEnv(
    makeEnv({ API_PUBLIC_URL: "https://api.example.com/" }),
    OPTED_IN,
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
    assert.equal(ids(env, OPTED_IN).includes("discord"), false);
  }
});
