import { describe, expect, it, vi } from "vitest";
import { discordConnector } from "../connector.js";
import { DiscordEvents } from "../events.js";

/**
 * The connector transform is pure (no db/network touched), so the ctx is a
 * stub: a no-op logger + a cast db. `transport: "gateway"` matches the ingress.
 */
const logger = {
  debug: vi.fn(),
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
};
const ctx = {
  db: {} as never,
  logger: logger as never,
  transport: "gateway" as const,
};

function wrap(t: keyof typeof DiscordEvents, d: unknown) {
  return { __t: t, d };
}

describe("discordConnector.transform", () => {
  it("maps MESSAGE_CREATE → discord.message_sent with derived lastSeen", async () => {
    const event = await discordConnector.transform(
      wrap("MESSAGE_CREATE", {
        // snowflake encoding a known epoch-ish timestamp
        id: "175928847299117063",
        channel_id: "c1",
        guild_id: "g1",
        content: "hi there",
        author: { id: "u1", username: "alice" },
      }),
      ctx,
    );
    expect(event).not.toBeNull();
    expect(event?.event).toBe(DiscordEvents.MESSAGE_CREATE);
    expect(event?.userId).toBe("discord:u1");
    // discordId is the snowflake (forward-compat IngestEvent field)
    expect((event as { discordId?: string })?.discordId).toBe("u1");
    expect(event?.eventProperties.hasContent).toBe(true);
    expect(event?.eventProperties.guildId).toBe("g1");
    // Nested NON-KEY metadata under contactProperties.discord (deep-merged
    // engine-side); discord_id stays the sole identity key.
    const meta = event?.contactProperties?.discord as Record<string, unknown>;
    expect(meta.id).toBe("u1");
    expect(meta.username).toBe("alice");
    expect(meta.last_seen).toBeTypeOf("string");
    expect(event?.idempotencyKey).toBe("discord:msg:175928847299117063");
    // occurredAt derived from the snowflake (not "now")
    expect(event?.occurredAt).toBeInstanceOf(Date);
  });

  it("hasContent=false when MESSAGE_CONTENT intent yields empty text", async () => {
    const event = await discordConnector.transform(
      wrap("MESSAGE_CREATE", {
        id: "175928847299117064",
        channel_id: "c1",
        content: "",
        author: { id: "u2" },
      }),
      ctx,
    );
    expect(event?.eventProperties.hasContent).toBe(false);
  });

  it("drops bot and webhook messages (returns null)", async () => {
    const bot = await discordConnector.transform(
      wrap("MESSAGE_CREATE", {
        id: "1",
        channel_id: "c1",
        author: { id: "b1", bot: true },
      }),
      ctx,
    );
    const hook = await discordConnector.transform(
      wrap("MESSAGE_CREATE", {
        id: "2",
        channel_id: "c1",
        webhook_id: "w1",
        author: { id: "x1" },
      }),
      ctx,
    );
    expect(bot).toBeNull();
    expect(hook).toBeNull();
  });

  it("maps MESSAGE_REACTION_ADD with deterministic idempotency key", async () => {
    const event = await discordConnector.transform(
      wrap("MESSAGE_REACTION_ADD", {
        user_id: "u9",
        channel_id: "c2",
        message_id: "m5",
        guild_id: "g2",
        emoji: { name: "🔥" },
      }),
      ctx,
    );
    expect(event?.event).toBe(DiscordEvents.MESSAGE_REACTION_ADD);
    expect(event?.userId).toBe("discord:u9");
    expect(event?.eventProperties.emoji).toBe("🔥");
    expect(event?.idempotencyKey).toBe("discord:react:m5:u9:🔥");
  });

  it("maps GUILD_MEMBER_ADD → discord.member_joined", async () => {
    const event = await discordConnector.transform(
      wrap("GUILD_MEMBER_ADD", {
        guild_id: "g3",
        joined_at: "2026-06-13T00:00:00.000Z",
        roles: ["r1", "r2"],
        user: {
          id: "u10",
          username: "bob",
          global_name: "Bob",
          avatar: "abc123",
        },
      }),
      ctx,
    );
    expect(event?.event).toBe(DiscordEvents.GUILD_MEMBER_ADD);
    expect(event?.userId).toBe("discord:u10");
    const meta = event?.contactProperties?.discord as Record<string, unknown>;
    expect(meta.id).toBe("u10");
    expect(meta.username).toBe("bob");
    expect(meta.global_name).toBe("Bob");
    expect(meta.avatar).toBe("abc123");
    expect(meta.joined_at).toBe("2026-06-13T00:00:00.000Z");
    expect(meta.roles).toEqual(["r1", "r2"]);
    expect(event?.idempotencyKey).toBe("discord:join:g3:u10");
  });

  it("drops a bot GUILD_MEMBER_ADD", async () => {
    const event = await discordConnector.transform(
      wrap("GUILD_MEMBER_ADD", {
        guild_id: "g3",
        user: { id: "bot1", bot: true },
      }),
      ctx,
    );
    expect(event).toBeNull();
  });

  it("collapses non-offline presence to discord.presence_active", async () => {
    const online = await discordConnector.transform(
      wrap("PRESENCE_UPDATE", { user: { id: "u11" }, status: "online" }),
      ctx,
    );
    expect(online?.event).toBe(DiscordEvents.PRESENCE_UPDATE);
    expect(online?.eventProperties.status).toBe("online");

    const offline = await discordConnector.transform(
      wrap("PRESENCE_UPDATE", { user: { id: "u11" }, status: "offline" }),
      ctx,
    );
    expect(offline).toBeNull();
  });

  it("logs + drops an unmapped dispatch", async () => {
    const event = await discordConnector.transform(
      { __t: "TYPING_START", d: {} },
      ctx,
    );
    expect(event).toBeNull();
    expect(logger.debug).toHaveBeenCalled();
  });

  it("declares gateway transport with a derived credential, no inboundVerify", () => {
    expect(discordConnector.meta.transport).toBe("gateway");
    expect(discordConnector.inboundVerify).toBeUndefined();
    expect(discordConnector.credential).toEqual({
      providerId: "discord",
      kind: "derived",
    });
  });
});
