import assert from "node:assert/strict";
import test, { mock } from "node:test";
import type { AccountLinkHooks, BeforeLinkContext } from "@hogsend/core";
import { ACCOUNT_LINK_HOOK_TIMEOUT_MS } from "@hogsend/core";
import { runBeforeLink } from "./account-link-hooks.js";

/**
 * PRD 07 T7. `beforeLink` is the ONE fail-closed hook in the feature: a throw,
 * a timeout and an explicit `{ allow: false }` all collapse to the same veto.
 * DECISIONS §6.7 — a veto hook that fails open is not a veto hook.
 */

const WARM_CTX: BeforeLinkContext = {
  provider: "steam",
  identity: { providerUserId: "76561197960435530", username: "player" },
  contactId: "11111111-2222-3333-4444-555555555555",
  userId: "player-1",
  email: "player@example.com",
};

const logger = {
  info() {},
  warn() {},
  error() {},
  debug() {},
} as unknown as Parameters<typeof runBeforeLink>[0]["logger"];

const run = (hooks: AccountLinkHooks, ctx: BeforeLinkContext = WARM_CTX) =>
  runBeforeLink({ hooks, ctx, logger });

test("an absent beforeLink allows", async () => {
  assert.deepEqual(await run({}), { allow: true });
});

test("a beforeLink returning void allows", async () => {
  // A side-effect-only hook must not have to remember to return.
  assert.deepEqual(
    await run({
      beforeLink() {
        /* observes only */
      },
    }),
    { allow: true },
  );
});

test("an { allow: true } beforeLink allows", async () => {
  assert.deepEqual(
    await run({
      async beforeLink() {
        return { allow: true };
      },
    }),
    {
      allow: true,
    },
  );
});

test("an { allow: false } beforeLink vetoes", async () => {
  assert.deepEqual(
    await run({
      async beforeLink() {
        return { allow: false, reason: "player is banned" };
      },
    }),
    { allow: false, reason: "vetoed" },
  );
});

test("a throwing beforeLink vetoes", async () => {
  assert.deepEqual(
    await run({
      async beforeLink() {
        throw new Error("consumer DB is down");
      },
    }),
    { allow: false, reason: "vetoed" },
  );
});

test("a synchronous (non-promise) beforeLink is honoured", async () => {
  assert.deepEqual(
    await run({
      beforeLink() {
        return { allow: false };
      },
    }),
    { allow: false, reason: "vetoed" },
  );
  assert.deepEqual(
    await run({
      beforeLink() {
        return { allow: true };
      },
    }),
    { allow: true },
  );
});

test("a synchronously THROWING beforeLink vetoes", async () => {
  // A sync throw escapes before any promise exists, so it must be caught
  // around the CALL, not just on the returned promise.
  assert.deepEqual(
    await run({
      beforeLink() {
        throw new Error("sync boom");
      },
    }),
    { allow: false, reason: "vetoed" },
  );
});

test("a beforeLink that never resolves vetoes at 5s", async () => {
  mock.timers.enable({ apis: ["setTimeout"] });
  try {
    const pending = run({
      beforeLink() {
        return new Promise<never>(() => {
          /* never settles */
        });
      },
    });
    mock.timers.tick(ACCOUNT_LINK_HOOK_TIMEOUT_MS);
    assert.deepEqual(await pending, { allow: false, reason: "vetoed" });
  } finally {
    mock.timers.reset();
  }
});

test("the hook sees the cold context verbatim: contactId null, anonymousId set", async () => {
  const seen: BeforeLinkContext[] = [];
  const coldCtx: BeforeLinkContext = {
    provider: "steam",
    identity: { providerUserId: "76561197960435530" },
    contactId: null,
    anonymousId: "anon-xyz",
    userId: null,
    email: null,
  };
  await run(
    {
      beforeLink(ctx) {
        seen.push(ctx);
      },
    },
    coldCtx,
  );
  assert.equal(seen.length, 1);
  assert.deepEqual(seen[0], coldCtx);
});

test("this module exports runBeforeLink and nothing after-shaped", async () => {
  // DECISIONS §15.4: the store is the SOLE invoker of afterLink/afterUnlink. A
  // second bounded runner living here is exactly how they end up firing twice.
  const module = await import("./account-link-hooks.js");
  assert.deepEqual(Object.keys(module), ["runBeforeLink"]);
});
