import type { IngestEvent } from "@hogsend/engine";
import { describe, expect, it, vi } from "vitest";
import { discordConnector } from "../connector.js";
import { DISCORD_REACTION_RECEIVED, DiscordEvents } from "../events.js";

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

/** Narrow a transform result that is expected to be a single event (or null). */
function single(
  r: IngestEvent | IngestEvent[] | null,
): (IngestEvent & { discordId?: string }) | null {
  if (Array.isArray(r))
    throw new Error("expected a single event, got an array");
  return r as (IngestEvent & { discordId?: string }) | null;
}

/** Narrow a transform result that is expected to be a fan-out array. */
function many(r: IngestEvent | IngestEvent[] | null): IngestEvent[] {
  if (!Array.isArray(r)) throw new Error("expected an array fan-out");
  return r;
}

describe("discordConnector.transform", () => {
  it("maps MESSAGE_CREATE → discord.message_sent with derived lastSeen", async () => {
    const event = single(
      await discordConnector.transform(
        wrap("MESSAGE_CREATE", {
          // snowflake encoding a known epoch-ish timestamp
          id: "175928847299117063",
          channel_id: "c1",
          guild_id: "g1",
          content: "hi there",
          author: { id: "u1", username: "alice" },
        }),
        ctx,
      ),
    );
    expect(event).not.toBeNull();
    expect(event?.event).toBe(DiscordEvents.MESSAGE_CREATE);
    expect(event?.userId).toBe("discord:u1");
    // discordId is the snowflake (forward-compat IngestEvent field)
    expect(event?.discordId).toBe("u1");
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
    const event = single(
      await discordConnector.transform(
        wrap("MESSAGE_CREATE", {
          id: "175928847299117064",
          channel_id: "c1",
          content: "",
          author: { id: "u2" },
        }),
        ctx,
      ),
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

  it("MESSAGE_REACTION_ADD without a known author → [reaction_added] only", async () => {
    const events = many(
      await discordConnector.transform(
        wrap("MESSAGE_REACTION_ADD", {
          user_id: "u9",
          channel_id: "c2",
          message_id: "m5",
          guild_id: "g2",
          emoji: { name: "🔥" },
        }),
        ctx,
      ),
    );
    expect(events).toHaveLength(1);
    const added = events[0] as IngestEvent;
    expect(added.event).toBe(DiscordEvents.MESSAGE_REACTION_ADD);
    expect(added.userId).toBe("discord:u9");
    expect(added.eventProperties.emoji).toBe("🔥");
    expect(added.eventProperties.targetAuthorKey).toBeNull();
    // :a suffix disambiguates the reactor side from the author (:r) side.
    expect(added.idempotencyKey).toBe("discord:react:m5:u9:🔥:a");
  });

  it("MESSAGE_REACTION_ADD with a known author → [added, received] dual-side", async () => {
    const events = many(
      await discordConnector.transform(
        wrap("MESSAGE_REACTION_ADD", {
          user_id: "reactor1",
          channel_id: "c2",
          message_id: "m5",
          guild_id: "g2",
          emoji: { name: "❤️" },
          __author: "author1",
        }),
        ctx,
      ),
    );
    expect(events).toHaveLength(2);
    const added = events[0] as IngestEvent & { discordId?: string };
    const received = events[1] as IngestEvent & { discordId?: string };
    // Reactor side carries the target author for distinct-people counting.
    expect(added.event).toBe(DiscordEvents.MESSAGE_REACTION_ADD);
    expect(added.userId).toBe("discord:reactor1");
    expect(added.eventProperties.targetAuthorId).toBe("author1");
    expect(added.eventProperties.targetAuthorKey).toBe("discord:author1");
    expect(added.idempotencyKey).toBe("discord:react:m5:reactor1:❤️:a");
    // Author side is keyed by discordId ONLY (attach-only, no canonical flip).
    expect(received.event).toBe(DISCORD_REACTION_RECEIVED);
    expect(received.userId).toBeUndefined();
    expect(received.discordId).toBe("author1");
    expect(received.eventProperties.reactorKey).toBe("discord:reactor1");
    // The author's own snowflake rides on the payload so a cold-created author
    // can still be granted/DM'd by the raw id.
    expect(received.eventProperties.authorId).toBe("author1");
    expect(received.idempotencyKey).toBe("discord:react:m5:reactor1:❤️:r");
    // The two idempotency keys never collide.
    expect(added.idempotencyKey).not.toBe(received.idempotencyKey);
  });

  it("drops the author side for a self-reaction → [added] only", async () => {
    const events = many(
      await discordConnector.transform(
        wrap("MESSAGE_REACTION_ADD", {
          user_id: "u9",
          channel_id: "c2",
          message_id: "m5",
          emoji: { name: "👍" },
          __author: "u9",
        }),
        ctx,
      ),
    );
    expect(events).toHaveLength(1);
    expect((events[0] as IngestEvent).event).toBe(
      DiscordEvents.MESSAGE_REACTION_ADD,
    );
  });

  it("maps MESSAGE_REACTION_REMOVE → single reactor-keyed discord.reaction_removed", async () => {
    const event = single(
      await discordConnector.transform(
        wrap("MESSAGE_REACTION_REMOVE", {
          user_id: "u9",
          channel_id: "c2",
          message_id: "m5",
          emoji: { name: "🔥" },
        }),
        ctx,
      ),
    );
    expect(event?.event).toBe(DiscordEvents.MESSAGE_REACTION_REMOVE);
    expect(event?.userId).toBe("discord:u9");
    expect(event?.idempotencyKey).toBe("discord:unreact:m5:u9:🔥");
  });

  it("maps GUILD_MEMBER_ADD → discord.member_joined", async () => {
    const event = single(
      await discordConnector.transform(
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
      ),
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
    const online = single(
      await discordConnector.transform(
        wrap("PRESENCE_UPDATE", { user: { id: "u11" }, status: "online" }),
        ctx,
      ),
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
      { __t: "TYPING_START", d: {} } as never,
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
