import assert from "node:assert/strict";
import test from "node:test";
import type { AccountLinkHooks, AccountLinkProvider } from "@hogsend/core";

// Env is set BEFORE the container import — env.ts validates at module scope.
// LOG_LEVEL=warn so the boot warnings under test are actually emitted. No
// DATABASE_URL connection is opened (`postgres()` is lazy) and boot side
// effects are skipped under NODE_ENV=test, so a full createHogsendClient()
// completes offline. Every ACCOUNT_LINK_* var is UNSET here — the env-set
// merge case lives in container.account-links.env.test.ts (its own process,
// because t3-env parses process.env exactly once per import).
process.env.NODE_ENV = "test";
process.env.LOG_LEVEL = "warn";
process.env.DATABASE_URL ??= "postgresql://test:test@localhost:5432/test";
process.env.BETTER_AUTH_SECRET ??=
  "test-secret-for-node-test-minimum-32-characters-long";
process.env.HATCHET_CLIENT_TOKEN ??=
  "eyJhbGciOiJFUzI1NiIsImtpZCI6InRlc3QifQ.eyJhdWQiOiJsb2NhbGhvc3QiLCJleHAiOjQ5MzMyNDA5ODMsImdycGNfYnJvYWRjYXN0X2FkZHJlc3MiOiJsb2NhbGhvc3Q6NzA3NyIsImlhdCI6MTc3OTY0MDk4MywiaXNzIjoibG9jYWxob3N0Iiwic2VydmVyX3VybCI6ImxvY2FsaG9zdCIsInN1YiI6InRlc3QtdGVuYW50LWlkIiwidG9rZW5faWQiOiJ0ZXN0LXRva2VuLWlkIn0.test";
for (const name of [
  "ACCOUNT_LINK_TWITCH_CLIENT_ID",
  "ACCOUNT_LINK_TWITCH_CLIENT_SECRET",
  "STEAM_WEB_API_KEY",
  "ACCOUNT_LINK_ALLOWED_ORIGINS",
]) {
  delete process.env[name];
}

const { createHogsendClient } = await import("./container.js");

function stubProvider(id: string, name = id): AccountLinkProvider {
  return {
    meta: { id, name },
    authorizeUrl: () => `https://example.com/authorize?provider=${id}`,
    handleCallback: async () => ({ providerUserId: `${id}-user` }),
  };
}

/**
 * Boot the container while capturing everything winston writes to stdout
 * (boot-time warns happen inside createHogsendClient, before any test could
 * spy on `client.logger`). Output is swallowed during the boot so the TAP
 * stream stays clean; the winston Console transport writes synchronously.
 */
function captureBoot<T>(fn: () => T): { value: T; out: string } {
  const original = process.stdout.write.bind(process.stdout);
  let out = "";
  process.stdout.write = ((chunk: unknown) => {
    out += String(chunk);
    return true;
  }) as typeof process.stdout.write;
  try {
    return { value: fn(), out };
  } finally {
    process.stdout.write = original;
  }
}

/** The account-link boot warnings under test, as greppable fragments. */
const ALLOWLIST_WARN = "no allowed origin is configured";
const DUP_WARN = "more than once";

function countOf(haystack: string, needle: string): number {
  return haystack.split(needle).length - 1;
}

test("registers steam unconditionally and {} hooks with no config", () => {
  // PRD 06: steam is an UNCONDITIONAL env preset — OpenID 2.0 needs no
  // credential, so a zero-config deploy still links Steam accounts.
  const { value: client, out } = captureBoot(() => createHogsendClient());
  assert.deepEqual(client.accountLinkProviders.ids(), ["steam"]);
  assert.deepEqual(client.accountLinkHooks, {});
  assert.deepEqual(client.accountLinkAllowedOrigins, []);
  // No half-configured provider ⇒ no env-builder warning; the duplicate-id
  // warn stays silent too. (The allowlist warn DOES fire — steam is
  // registered with no allowed origin — see the dedicated test below.)
  assert.equal(out.includes(DUP_WARN), false);
});

test("registers a consumer-supplied provider", () => {
  const steam = stubProvider("steam");
  const { value: client } = captureBoot(() =>
    createHogsendClient({
      accountLinks: {
        providers: [steam],
        allowedOrigins: ["https://play.example.com"],
      },
    }),
  );
  assert.equal(client.accountLinkProviders.count(), 1);
  assert.equal(client.accountLinkProviders.get("steam"), steam);
});

test("keeps the last of two consumer providers sharing an id, and warns once", () => {
  const first = stubProvider("twitch", "first");
  const second = stubProvider("twitch", "second");
  const { value: client, out } = captureBoot(() =>
    createHogsendClient({
      accountLinks: {
        providers: [first, second],
        allowedOrigins: ["https://play.example.com"],
      },
    }),
  );
  // 2 = the unconditional steam env preset + the (deduped) consumer twitch.
  assert.equal(client.accountLinkProviders.count(), 2);
  assert.equal(client.accountLinkProviders.get("twitch"), second);
  assert.equal(countOf(out, DUP_WARN), 1);
  // The warn names the duplicated id.
  assert.match(out, /"twitch"/);
});

test("a consumer provider of the same id overrides the env preset", () => {
  const steam = stubProvider("steam", "consumer-steam");
  const { value: client } = captureBoot(() =>
    createHogsendClient({
      accountLinks: {
        providers: [steam],
        allowedOrigins: ["https://play.example.com"],
      },
    }),
  );
  // Env presets merge FIRST, consumer last — last-writer-wins on meta.id, so
  // the registry holds the consumer's steam, not the env preset's.
  assert.equal(client.accountLinkProviders.count(), 1);
  assert.equal(client.accountLinkProviders.get("steam"), steam);
});

test("exposes accountLinkHooks verbatim", () => {
  const hooks: AccountLinkHooks = {
    beforeLink: () => ({ allow: false, reason: "test" }),
    afterLink: () => {},
  };
  const { value: client } = captureBoot(() =>
    createHogsendClient({ accountLinks: { hooks } }),
  );
  // Reference equality: held verbatim, not wrapped, not per-hook defaulted.
  assert.equal(client.accountLinkHooks, hooks);
  assert.equal(client.accountLinkHooks.beforeLink, hooks.beforeLink);
  assert.equal(client.accountLinkHooks.afterUnlink, undefined);
});

test("throws at boot on a malformed allowed origin", () => {
  assert.throws(
    () =>
      captureBoot(() =>
        createHogsendClient({
          accountLinks: {
            providers: [stubProvider("steam")],
            allowedOrigins: ["https://x.example.com/cb"],
          },
        }),
      ),
    /"https:\/\/x\.example\.com\/cb"/,
  );
});

test("warns when providers are registered but the allowlist is empty", () => {
  const { value: client, out } = captureBoot(() =>
    createHogsendClient({
      accountLinks: { providers: [stubProvider("steam")] },
    }),
  );
  assert.equal(client.accountLinkProviders.count(), 1);
  assert.deepEqual(client.accountLinkAllowedOrigins, []);
  assert.equal(countOf(out, ALLOWLIST_WARN), 1);
});

test("the empty-allowlist warn fires on a zero-config boot, because steam always registers", () => {
  // Consequence of the unconditional steam preset: `count() > 0` is now true
  // on EVERY boot, so a deploy with no allowed origin warns once. Pinned so a
  // future change to either side (the preset or the warn condition) is a
  // deliberate decision, not drift.
  const { out } = captureBoot(() => createHogsendClient({ accountLinks: {} }));
  assert.equal(countOf(out, ALLOWLIST_WARN), 1);
});
