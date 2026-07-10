import {
  buildListRegistry,
  defineConnectorAction,
  defineList,
  IN_APP_LIST_ID,
  ListRegistry,
  resetListRegistry,
  synthesizeChannelLists,
} from "@hogsend/engine";
import { afterAll, describe, expect, it } from "vitest";

// These are PURE unit tests over the channel-list model, registry, and
// polarity — no DB, no container. `buildListRegistry` installs a process
// singleton as a side effect; every assertion reads the RETURNED registry
// (never `getListRegistry()`), so the singleton is irrelevant here. We still
// reset it once at the end so no channel metas leak to a later suite that
// happens to read the singleton.
afterAll(() => {
  resetListRegistry();
});

// A member-directed action mints a channel for its connector; an ops-directed
// one (no `audience`) never does.
const discordDm = defineConnectorAction({
  connectorId: "discord",
  name: "dmMember",
  audience: {
    kind: "member",
    ref: (args: { userId: string }) => args.userId,
  },
  run: async () => ({ ok: true }),
});
const discordDmReminder = defineConnectorAction({
  connectorId: "discord",
  name: "dmMemberReminder",
  audience: {
    kind: "member",
    ref: (args: { userId: string }) => args.userId,
  },
  run: async () => ({ ok: true }),
});
const discordOps = defineConnectorAction({
  connectorId: "discord",
  name: "postChannelMessage",
  run: async () => ({ ok: true }),
});
const telegramDm = defineConnectorAction({
  connectorId: "telegram",
  name: "dmMember",
  audience: {
    kind: "member",
    ref: (args: { chatId: string }) => `telegram:${args.chatId}`,
  },
  run: async () => ({ ok: true }),
});
const slackOps = defineConnectorAction({
  connectorId: "slack",
  name: "postChannelMessage",
  run: async () => ({ ok: true }),
});

describe("synthesizeChannelLists", () => {
  it("always yields the in-app channel first, even with zero actions", () => {
    const channels = synthesizeChannelLists([]);
    expect(channels).toHaveLength(1);
    const inApp = channels[0];
    expect(inApp).toMatchObject({
      id: IN_APP_LIST_ID,
      name: "In-app feed",
      defaultOptIn: true,
      enabled: true,
      kind: "channel",
    });
  });

  it("mints a connector channel iff at least one action declares a member audience", () => {
    const withMember = synthesizeChannelLists([discordDm]).map((c) => c.id);
    expect(withMember).toContain("discord");

    // A connector whose ONLY registered action is ops-directed gets no channel.
    const opsOnly = synthesizeChannelLists([slackOps]).map((c) => c.id);
    expect(opsOnly).toEqual([IN_APP_LIST_ID]);
    expect(opsOnly).not.toContain("slack");
  });

  it("never mints a channel for an action without a member audience", () => {
    const channels = synthesizeChannelLists([discordOps]);
    expect(channels.map((c) => c.id)).toEqual([IN_APP_LIST_ID]);
  });

  it("de-dupes two member actions on one connector to a single channel", () => {
    const channels = synthesizeChannelLists([discordDm, discordDmReminder]);
    const discordChannels = channels.filter((c) => c.id === "discord");
    expect(discordChannels).toHaveLength(1);
  });

  it("keeps stable first-appearance order and capitalizes names", () => {
    const channels = synthesizeChannelLists([
      telegramDm,
      discordOps, // no audience → mints nothing
      discordDm,
    ]);
    expect(channels.map((c) => c.id)).toEqual([
      IN_APP_LIST_ID,
      "telegram",
      "discord",
    ]);
    expect(channels.map((c) => c.name)).toEqual([
      "In-app feed",
      "Telegram",
      "Discord",
    ]);
    for (const c of channels) {
      expect(c).toMatchObject({
        defaultOptIn: true,
        enabled: true,
        kind: "channel",
      });
    }
  });
});

describe("channel polarity (zero-behaviour-flip proof)", () => {
  const channels = synthesizeChannelLists([discordDm]);
  const withChannel = buildListRegistry([], undefined, channels);
  // An EMPTY registry: every id is unknown → legacy opt-in fallback.
  const empty = new ListRegistry();

  it("is subscribed by default (unless explicitly false) for a synthesized channel", () => {
    expect(withChannel.isSubscribed({}, "discord")).toBe(true);
    expect(withChannel.isSubscribed({ discord: false }, "discord")).toBe(false);
    expect(withChannel.isSubscribed({ discord: true }, "discord")).toBe(true);
  });

  it("yields IDENTICAL results to the unknown-id fallback of an empty registry", () => {
    // Registering the channel flips ZERO behaviour: the opt-out polarity of a
    // `defaultOptIn: true` channel is exactly the unknown-id fallback.
    expect(withChannel.isSubscribed({}, "discord")).toBe(
      empty.isSubscribed({}, "discord"),
    );
    expect(withChannel.isSubscribed({ discord: false }, "discord")).toBe(
      empty.isSubscribed({ discord: false }, "discord"),
    );
    expect(empty.isSubscribed({}, "discord")).toBe(true);
    expect(empty.isSubscribed({ discord: false }, "discord")).toBe(false);
  });
});

describe("buildListRegistry channel wiring", () => {
  const productUpdates = defineList({
    id: "product-updates",
    name: "Product updates",
    defaultOptIn: false,
  });
  const channels = synthesizeChannelLists([discordDm, telegramDm]);

  it("filters user lists via ENABLED_LISTS but registers channels unconditionally", () => {
    // ENABLED_LISTS excludes the user list, so it is NOT registered...
    const registry = buildListRegistry(
      [productUpdates],
      "some-other-list",
      channels,
    );
    expect(registry.has("product-updates")).toBe(false);
    // ...but the channels are still registered (the filter does not apply).
    expect(registry.has(IN_APP_LIST_ID)).toBe(true);
    expect(registry.has("discord")).toBe(true);
    expect(registry.has("telegram")).toBe(true);
  });

  it("registers a user list that the ENABLED_LISTS filter includes", () => {
    const registry = buildListRegistry(
      [productUpdates],
      "product-updates",
      channels,
    );
    expect(registry.has("product-updates")).toBe(true);
    expect(registry.has("discord")).toBe(true);
  });

  it("throws an actionable error when a registered user list collides with a channel", () => {
    const collidingList = defineList({
      id: "discord",
      name: "Discord digest",
      defaultOptIn: false,
    });
    expect(() =>
      buildListRegistry([collidingList], undefined, channels),
    ).toThrow(
      'List id "discord" collides with the auto-registered channel list for the "discord" connector. Rename your defineList id.',
    );
  });

  it("isChannel is true for channels, false for topics and unknown ids", () => {
    const registry = buildListRegistry([productUpdates], undefined, channels);
    expect(registry.isChannel(IN_APP_LIST_ID)).toBe(true);
    expect(registry.isChannel("discord")).toBe(true);
    expect(registry.isChannel("product-updates")).toBe(false);
    expect(registry.isChannel("does-not-exist")).toBe(false);
  });
});

describe("defineList reservation + kind", () => {
  it('rejects the reserved "in_app" id with the dedicated message', () => {
    expect(() =>
      defineList({ id: "in_app", name: "In app", defaultOptIn: true }),
    ).toThrow(
      'Reserved list id "in_app": it is the engine\'s in-app channel list, auto-registered for the notification feed.',
    );
  });

  it("rejects the reserved id case-insensitively (IN_APP)", () => {
    expect(() =>
      defineList({ id: "IN_APP", name: "In app", defaultOptIn: true }),
    ).toThrow(/it is the engine's in-app channel list/);
  });

  it('stamps kind "topic" on the resolved meta', () => {
    const list = defineList({
      id: "product-updates",
      name: "Product updates",
      defaultOptIn: false,
    });
    expect(list.meta.kind).toBe("topic");
  });
});
