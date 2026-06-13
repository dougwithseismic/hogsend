import type { WebhookEndpointRow } from "@hogsend/engine";
import { afterEach, describe, expect, it, vi } from "vitest";
import { memberLinkToContactPatch } from "../connect/member-link.js";
import {
  buildBotInstallUrl,
  buildMemberLinkUrl,
  exchangeDiscordCode,
} from "../connect/oauth.js";
import { discordDestination } from "../destination.js";

/** Minimal endpoint row stub — only the fields the transform reads. */
function makeEndpoint(row: {
  url?: string | null;
  secret?: string | null;
  config?: Record<string, unknown>;
}): WebhookEndpointRow {
  return {
    url: row.url ?? null,
    secret: row.secret ?? null,
    config: row.config ?? {},
  } as unknown as WebhookEndpointRow;
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("buildBotInstallUrl", () => {
  it("carries scope, permissions, state, and the BARE redirect (no flow)", () => {
    const url = new URL(
      buildBotInstallUrl({
        applicationId: "app1",
        redirectUri:
          "https://api.example.com/v1/connectors/discord/oauth/callback",
        permissions: "8",
        state: "csrf-123",
        guildId: "g1",
      }),
    );
    expect(url.searchParams.get("client_id")).toBe("app1");
    expect(url.searchParams.get("scope")).toBe("bot applications.commands");
    expect(url.searchParams.get("permissions")).toBe("8");
    expect(url.searchParams.get("state")).toBe("csrf-123");
    expect(url.searchParams.get("guild_id")).toBe("g1");
    // The redirect is the bare callback — the signed-state `purpose` (not a
    // `flow` query) disambiguates install vs. member, and the exchange
    // `redirect_uri` must byte-match this value.
    expect(url.searchParams.get("redirect_uri")).toBe(
      "https://api.example.com/v1/connectors/discord/oauth/callback",
    );
  });
});

describe("buildMemberLinkUrl", () => {
  it("requests identify+email+membership scopes with the BARE redirect", () => {
    const url = new URL(
      buildMemberLinkUrl({
        applicationId: "app1",
        redirectUri:
          "https://api.example.com/v1/connectors/discord/oauth/callback",
        state: "csrf-bound-to-contact",
      }),
    );
    expect(url.searchParams.get("scope")).toBe(
      "identify email guilds.members.read",
    );
    expect(url.searchParams.get("state")).toBe("csrf-bound-to-contact");
    // Bare redirect — no `flow` query (signed-state `purpose` disambiguates).
    expect(url.searchParams.get("redirect_uri")).toBe(
      "https://api.example.com/v1/connectors/discord/oauth/callback",
    );
  });
});

describe("exchangeDiscordCode", () => {
  it("POSTs the form body and returns the token (with guild on install)", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(
        JSON.stringify({
          access_token: "at",
          token_type: "Bearer",
          expires_in: 604800,
          scope: "bot",
          guild: { id: "g99", name: "Test" },
        }),
        { status: 200 },
      ),
    );

    const token = await exchangeDiscordCode({
      applicationId: "app1",
      clientSecret: "secret",
      code: "code123",
      redirectUri:
        "https://api.example.com/v1/connectors/discord/oauth/callback",
    });

    expect(token.access_token).toBe("at");
    expect(token.guild?.id).toBe("g99");
    const call = fetchSpy.mock.calls[0];
    const init = call?.[1];
    expect((init?.headers as Record<string, string>)["Content-Type"]).toBe(
      "application/x-www-form-urlencoded",
    );
    expect(String(init?.body)).toContain("grant_type=authorization_code");
    expect(String(init?.body)).toContain("code=code123");
  });

  it("throws on a non-2xx token response", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response("bad request", { status: 400 }),
    );
    await expect(
      exchangeDiscordCode({
        applicationId: "a",
        clientSecret: "s",
        code: "c",
        redirectUri: "https://x/cb",
      }),
    ).rejects.toThrow(/token exchange failed \(400\)/);
  });
});

describe("memberLinkToContactPatch", () => {
  it("returns the RAW snowflake as discordId (no `discord:` prefix, no userId)", () => {
    const patch = memberLinkToContactPatch({
      user: {
        id: "u1",
        username: "alice",
        email: "alice@example.com",
        verified: true,
      },
    });
    expect(patch.discordId).toBe("u1");
    // The patch is NOT a resolution-key carrier for email — the snowflake is
    // routed through the `discord` identity Kind, never stuffed into userId.
    expect("userId" in patch).toBe(false);
    expect("email" in patch).toBe(false);
    expect(patch.contactProperties.isDiscordLinked).toBe(true);
    // Username now rides in the NON-KEY nested `discord` metadata object.
    const discord = patch.contactProperties.discord as Record<string, unknown>;
    expect(discord.id).toBe("u1");
    expect(discord.username).toBe("alice");
  });

  it("stores a present+verified email as a NON-KEY contactProperty (discordEmail)", () => {
    const patch = memberLinkToContactPatch({
      user: { id: "u1", email: "alice@example.com", verified: true },
    });
    // Stored as a property only — NEVER a resolution/merge key (anti-graft).
    expect(patch.contactProperties.discordEmail).toBe("alice@example.com");
  });

  it("OMITS a present-but-UNVERIFIED email entirely (anti account-takeover)", () => {
    const patch = memberLinkToContactPatch({
      user: { id: "u2", email: "victim@example.com", verified: false },
    });
    expect(patch.contactProperties.discordEmail).toBeUndefined();
    expect(patch.contactProperties.isDiscordLinked).toBe(true);
  });

  it("OMITS an absent email", () => {
    const patch = memberLinkToContactPatch({
      user: { id: "u3", email: null, verified: true },
    });
    expect(patch.contactProperties.discordEmail).toBeUndefined();
  });
});

describe("discordDestination.transform", () => {
  const logger = {} as never;

  it("prefers the incoming-webhook wire (no bot token), accepts 204", () => {
    const result = discordDestination.transform(
      { id: "e1", type: "email.sent", timestamp: "t", data: { to: "a@b.c" } },
      {
        logger,
        endpoint: makeEndpoint({
          config: { webhookUrl: "https://discord.com/api/webhooks/1/abc" },
        }),
      },
    );
    expect(result?.url).toBe("https://discord.com/api/webhooks/1/abc");
    expect(result?.isSuccess?.(204, "")).toBe(true);
    expect(JSON.parse(result?.body ?? "{}").content).toContain("email.sent");
  });

  it("falls back to bot-REST with the channel id + token", () => {
    const result = discordDestination.transform(
      { id: "e2", type: "email.opened", timestamp: "t", data: {} },
      {
        logger,
        endpoint: makeEndpoint({
          secret: "bot-token",
          config: { channelId: "chan1" },
        }),
      },
    );
    expect(result?.url).toContain("/channels/chan1/messages");
    expect(result?.headers.Authorization).toBe("Bot bot-token");
  });

  it("throws (config error → DLQ) when neither wire is configured", () => {
    expect(() =>
      discordDestination.transform(
        { id: "e3", type: "email.sent", timestamp: "t", data: {} },
        {
          logger,
          endpoint: makeEndpoint({ config: {} }),
        },
      ),
    ).toThrow(/needs config.webhookUrl/);
  });
});
