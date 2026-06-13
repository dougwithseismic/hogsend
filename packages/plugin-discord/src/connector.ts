import {
  type ConnectorCtx,
  type ConnectorHandlers,
  type DefinedConnector,
  defineConnector,
  type IngestEvent,
} from "@hogsend/engine";
import {
  handleInteraction,
  verifyInteractionSignature,
} from "./connect/interactions.js";
import { memberLinkToContactPatch } from "./connect/member-link.js";
import {
  type DiscordCurrentUser,
  exchangeDiscordCode,
  getCurrentUser,
} from "./connect/oauth.js";
import { DISCORD_EPOCH, DISCORD_PROVIDER_ID } from "./constants.js";
import { DiscordEvents } from "./events.js";
import type {
  DiscordGuildMemberAdd,
  DiscordMessageCreate,
  DiscordPresenceUpdate,
  DiscordReactionAdd,
} from "./types.js";

/**
 * An {@link IngestEvent} carrying the Discord-identity key. The engine's
 * `IngestEvent` gains an optional `discordId` in the schema+identity pass
 * (spec §3.4); until that lands this intersection keeps the transform
 * type-checking AND is forward-compatible (the intersection collapses to the
 * widened `IngestEvent` once `discordId` is native).
 */
type DiscordIngestEvent = IngestEvent & { discordId?: string };

/**
 * Discord identity → Hogsend contact key, namespaced so snowflakes never
 * collide with another platform's numeric ids.
 */
function discordUserKey(discordUserId: string): string {
  return `discord:${discordUserId}`;
}

/** Discord snowflake → Date (ms timestamp = bits 22+ over the Discord epoch). */
function snowflakeToDate(id: string): Date {
  return new Date(Number((BigInt(id) >> 22n) + DISCORD_EPOCH));
}

/**
 * The Discord INBOUND connector (gateway transport). Its transform is the
 * transport-invariant heart: a raw Gateway dispatch (wrapped `{ __t, d }` by
 * the gateway worker's ingress client) → an {@link IngestEvent} | null.
 *
 * Design notes (binding §2.4):
 *  - MESSAGE_CONTENT gating is surfaced as `hasContent` (the bot needs the
 *    privileged intent to read text; we never assume it).
 *  - `lastSeenDiscordAt` is DERIVED Hogsend-side (stamped here, NEVER read from
 *    Discord) on every inbound message/reaction/presence.
 *  - presence "active" is DERIVED by collapsing every non-offline status.
 *  - bot/system/webhook noise is dropped (returns null).
 *  - each event carries a deterministic `idempotencyKey` so the at-least-once
 *    Gateway (RESUME replays) dedups in `user_events`.
 */
export const discordConnector: DefinedConnector = defineConnector({
  meta: {
    id: DISCORD_PROVIDER_ID,
    name: "Discord",
    transport: "gateway",
    description:
      "Inbound Discord activity (messages, reactions, joins, presence) → " +
      "IngestEvent, via a long-lived Gateway worker.",
  },
  // Gateway connectors hold NO inboundVerify. The outbound bot token is pulled
  // from the derived credential at worker boot (StoredCredentialRef).
  credential: { providerId: DISCORD_PROVIDER_ID, kind: "derived" },

  // raw = { __t: <dispatch type>, d: <Discord `d` payload> } wrapped by the
  // gateway worker's ingress client. ctx.transport === "gateway".
  async transform(
    raw: unknown,
    ctx: ConnectorCtx,
  ): Promise<IngestEvent | null> {
    const envelope = raw as { __t: keyof typeof DiscordEvents; d: unknown };
    switch (envelope.__t) {
      case "MESSAGE_CREATE": {
        const d = envelope.d as DiscordMessageCreate;
        if (d.author?.bot || d.webhook_id) return null;
        const occurredAt = snowflakeToDate(d.id);
        const event: DiscordIngestEvent = {
          event: DiscordEvents.MESSAGE_CREATE,
          userId: discordUserKey(d.author.id),
          discordId: d.author.id,
          eventProperties: {
            source: "discord",
            channelId: d.channel_id,
            guildId: d.guild_id ?? null,
            messageId: d.id,
            hasContent: typeof d.content === "string" && d.content.length > 0,
          },
          contactProperties: {
            discordUserId: d.author.id,
            discordUsername: d.author.username,
            lastSeenDiscordAt: occurredAt.toISOString(),
          },
          occurredAt,
          idempotencyKey: `discord:msg:${d.id}`,
        };
        return event;
      }
      case "MESSAGE_REACTION_ADD": {
        const d = envelope.d as DiscordReactionAdd;
        const occurredAt = new Date();
        const event: DiscordIngestEvent = {
          event: DiscordEvents.MESSAGE_REACTION_ADD,
          userId: discordUserKey(d.user_id),
          discordId: d.user_id,
          eventProperties: {
            source: "discord",
            channelId: d.channel_id,
            guildId: d.guild_id ?? null,
            messageId: d.message_id,
            emoji: d.emoji?.name ?? null,
          },
          contactProperties: {
            discordUserId: d.user_id,
            lastSeenDiscordAt: occurredAt.toISOString(),
          },
          occurredAt,
          idempotencyKey:
            `discord:react:${d.message_id}:${d.user_id}:` +
            `${d.emoji?.name ?? ""}`,
        };
        return event;
      }
      case "GUILD_MEMBER_ADD": {
        const d = envelope.d as DiscordGuildMemberAdd;
        if (!d.user || d.user.bot) return null;
        const occurredAt = new Date();
        const event: DiscordIngestEvent = {
          event: DiscordEvents.GUILD_MEMBER_ADD,
          userId: discordUserKey(d.user.id),
          discordId: d.user.id,
          eventProperties: {
            source: "discord",
            guildId: d.guild_id,
            joinedAt: d.joined_at ?? occurredAt.toISOString(),
          },
          contactProperties: {
            discordUserId: d.user.id,
            discordUsername: d.user.username,
            discordJoinedGuildAt: d.joined_at ?? occurredAt.toISOString(),
          },
          occurredAt,
          idempotencyKey: `discord:join:${d.guild_id}:${d.user.id}`,
        };
        return event;
      }
      case "PRESENCE_UPDATE": {
        const d = envelope.d as DiscordPresenceUpdate;
        if (!d.user?.id || d.status === "offline" || d.status === undefined) {
          return null;
        }
        const occurredAt = new Date();
        const event: DiscordIngestEvent = {
          event: DiscordEvents.PRESENCE_UPDATE,
          userId: discordUserKey(d.user.id),
          discordId: d.user.id,
          eventProperties: {
            source: "discord",
            guildId: d.guild_id ?? null,
            status: d.status,
          },
          contactProperties: {
            discordUserId: d.user.id,
            lastSeenDiscordAt: occurredAt.toISOString(),
          },
          occurredAt,
          idempotencyKey:
            `discord:presence:${d.user.id}:` +
            `${Math.floor(occurredAt.getTime() / 60_000)}`,
        };
        return event;
      }
      default:
        ctx.logger.debug("discord connector: unmapped dispatch", {
          dispatch: envelope.__t,
        });
        return null;
    }
  },
});

/**
 * Config for {@link createDiscordConnector} — the boot-time factory that
 * populates the generic-route handlers (`oauthCallback` + `interactions`) with
 * the env the plugin must NOT read directly. The consumer injects the engine's
 * public credential/identity helpers as `saveDerived`/`resolveContact` so the
 * plugin stays free of engine internals.
 */
export interface CreateDiscordConnectorConfig {
  applicationId: string;
  clientSecret: string;
  publicKeyHex: string;
  /** …/v1/connectors/discord/oauth/callback (without the `flow` query). */
  redirectUri: string;
  /** Persist server-derived Discord config (kind="derived"). */
  saveDerived: (patch: Record<string, unknown>) => Promise<void>;
  /**
   * Resolve / merge the member-linked contact (the consumer wires this to the
   * engine's `resolveOrCreateContact`). The ONLY correct wiring is
   * `resolveOrCreateContact({ discordId: patch.discordId, email: patch.email,
   * contactProperties: patch.contactProperties })` — routing the raw snowflake
   * through the `discord` identity Kind so the `discord_id` column is
   * load-bearing. `email` is the AUTHORITATIVE address the link was issued for
   * (from the engine-verified state), NOT the OAuth-reported Discord email.
   */
  resolveContact: (patch: {
    discordId: string;
    email?: string;
    contactId?: string;
    contactProperties: Record<string, unknown>;
  }) => Promise<void>;
  /** Where to send the browser after a successful install/link. */
  studioIntegrationsUrl: string;
}

/**
 * The connector type the route dispatch sees — the base connector WITH
 * `handlers` GUARANTEED present (the bare `discordConnector` has none, so the
 * route's `connector.handlers?.oauthCallback` must type-narrow against a value
 * that advertises them).
 */
export type DiscordConnectorWithHandlers = DefinedConnector & {
  handlers: Required<ConnectorHandlers>;
};

/**
 * Build a connect-ready Discord connector: a clone of {@link discordConnector}
 * with `handlers.oauthCallback` + `handlers.interactions` populated from the
 * injected config. Returned as a `DefinedConnector` whose type advertises
 * `handlers` so the generic engine routes dispatch into it.
 */
export function createDiscordConnector(
  config: CreateDiscordConnectorConfig,
): DiscordConnectorWithHandlers {
  const handlers: Required<ConnectorHandlers> = {
    async interactions(args) {
      const signatureHex = args.headers["x-signature-ed25519"] ?? "";
      const timestamp = args.headers["x-signature-timestamp"] ?? "";
      const ok = verifyInteractionSignature({
        publicKeyHex: config.publicKeyHex,
        signatureHex,
        timestamp,
        rawBody: args.rawBody,
      });
      if (!ok) return { kind: "unauthorized" };

      let payload: { type?: number };
      try {
        payload = JSON.parse(args.rawBody) as { type?: number };
      } catch {
        return { kind: "unauthorized" };
      }

      const response = handleInteraction(payload);
      // PING → PONG, and every other (deferred) ack is a non-event handshake.
      // TODO(discord-gateway): route non-PING interactions (slash commands /
      // components) to a registered handler instead of a bare deferred ack.
      return { kind: "ack", body: response };
    },

    async oauthCallback(args) {
      const code = args.query.code;
      // The ENGINE already verified `state` (CSRF + member-link binding) before
      // dispatch and hands the decoded intent in as `args.state`. The plugin
      // does NOT re-verify it. Still fail closed if Discord returned no code.
      const intent = args.state;
      if (!code) {
        return {
          kind: "json",
          status: 400,
          body: { error: "missing_oauth_code" },
        };
      }

      if (intent.purpose === "install") {
        // CSRF-only — no contact binding. Capture the granted guild id.
        const token = await exchangeDiscordCode({
          applicationId: config.applicationId,
          clientSecret: config.clientSecret,
          code,
          redirectUri: appendFlow(config.redirectUri, "install"),
        });
        await config.saveDerived({
          ...(token.guild?.id ? { discordGuildId: token.guild.id } : {}),
        });
        return { kind: "redirect", location: config.studioIntegrationsUrl };
      } else if (intent.purpose === "member_link") {
        // Attach the Discord identity to the BOUND contact. The authoritative
        // email is `intent.email` (the address the link was ISSUED for), NOT
        // the OAuth-reported `user.email` — using the latter as a resolution
        // key is the grafting vector.
        const token = await exchangeDiscordCode({
          applicationId: config.applicationId,
          clientSecret: config.clientSecret,
          code,
          redirectUri: appendFlow(config.redirectUri, "member"),
        });
        const user: DiscordCurrentUser = await getCurrentUser(
          token.access_token,
        );
        const patch = memberLinkToContactPatch({ user });
        await config.resolveContact({
          discordId: patch.discordId,
          email: intent.email,
          contactId: intent.contactId,
          contactProperties: patch.contactProperties,
        });
        return { kind: "redirect", location: config.studioIntegrationsUrl };
      }

      // Exhaustive: any other purpose is unsupported by this connector — never
      // exchange the code (no silent fall-through into the member-link path).
      return {
        kind: "json",
        status: 400,
        body: { error: "unsupported_oauth_purpose" },
      };
    },
  };

  return defineConnector({
    meta: discordConnector.meta,
    credential: discordConnector.credential,
    schema: discordConnector.schema,
    transform: discordConnector.transform,
    handlers,
  }) as DiscordConnectorWithHandlers;
}

/** Append the `flow` query param to the redirect URI (byte-match the authorize). */
function appendFlow(redirectUri: string, flow: "install" | "member"): string {
  const url = new URL(redirectUri);
  url.searchParams.set("flow", flow);
  return url.toString();
}
