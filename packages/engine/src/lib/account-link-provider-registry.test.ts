import assert from "node:assert/strict";
import test from "node:test";
import type { AccountLinkProvider } from "@hogsend/core";
import { AccountLinkProviderRegistry } from "./account-link-provider-registry.js";

// Hand-built stubs on purpose (the PRD 05 "Seams" note): the registry cares
// only about `meta.id`, so a minimal object exercises it end to end without
// touching defineAccountLink's authoring guards (tested in @hogsend/core).
function stubProvider(id: string, name = id): AccountLinkProvider {
  return {
    meta: { id, name },
    authorizeUrl: () => `https://example.com/authorize?provider=${id}`,
    handleCallback: async () => ({ providerUserId: `${id}-user` }),
  };
}

test("register replaces a provider of the same id (last-writer-wins)", () => {
  const first = stubProvider("steam", "first");
  const second = stubProvider("steam", "second");
  const registry = new AccountLinkProviderRegistry([first, second]);
  assert.equal(registry.count(), 1);
  assert.equal(registry.get("steam"), second);
});

test("get returns undefined for an unknown id", () => {
  const registry = new AccountLinkProviderRegistry([stubProvider("steam")]);
  assert.equal(registry.get("twitch"), undefined);
});

test("register throws on a provider with no meta.id", () => {
  const registry = new AccountLinkProviderRegistry();
  const noMeta = { ...stubProvider("x"), meta: undefined };
  const emptyId = stubProvider("");
  assert.throws(
    () => registry.register(noMeta as unknown as AccountLinkProvider),
    TypeError,
  );
  assert.throws(() => registry.register(emptyId), TypeError);
  assert.equal(registry.count(), 0);
});

test("getAll preserves insertion order of distinct ids", () => {
  const steam = stubProvider("steam");
  const twitch = stubProvider("twitch");
  const custom = stubProvider("battlenet");
  const registry = new AccountLinkProviderRegistry([steam, twitch, custom]);
  assert.deepEqual(
    registry.getAll().map((p) => p.meta.id),
    ["steam", "twitch", "battlenet"],
  );
  assert.deepEqual(registry.ids(), ["steam", "twitch", "battlenet"]);
});
