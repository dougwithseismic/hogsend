import {
  type ConnectorCtx,
  type ConnectorHandlers,
  type DefinedConnector,
  defineConnector,
  type IngestEvent,
} from "@hogsend/engine";
import {
  handleInteraction,
  type LinkMintResult,
  type LinkRedeemResult,
  type VerifyAttemptResult,
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
 * The NON-KEY Discord metadata object merged under `contacts.properties.discord`
 * (the engine deep-merges this single sub-object — see `DEEP_MERGE_KEYS` in
 * `lib/contacts.ts` — so each event need only carry the fields IT knows; absent
 * fields are preserved from prior events). `discord_id` stays the sole identity
 * key (the `discordId` on the IngestEvent); this object is decorative only.
 *
 * `last_seen` is DERIVED Hogsend-side (stamped from `occurredAt`, NEVER read
 * from Discord), so it is always present; everything else is omitted when the
 * source dispatch doesn't carry it. `null` is never emitted (it would CLEAR the
 * sub-key under the engine's null-strip), so a `global_name`/`avatar` Discord
 * reports as `null` is simply left off.
 */
function discordMetadata(opts: {
  id: string;
  lastSeen: Date;
  username?: string | null;
  globalName?: string | null;
  avatar?: string | null;
  joinedAt?: string | null;
  roles?: string[];
}): Record<string, unknown> {
  const meta: Record<string, unknown> = {
    id: opts.id,
    last_seen: opts.lastSeen.toISOString(),
  };
  if (typeof opts.username === "string") meta.username = opts.username;
  if (typeof opts.globalName === "string") meta.global_name = opts.globalName;
  if (typeof opts.avatar === "string") meta.avatar = opts.avatar;
  if (typeof opts.joinedAt === "string") meta.joined_at = opts.joinedAt;
  if (opts.roles && opts.roles.length > 0) meta.roles = opts.roles;
  return meta;
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
            discord: discordMetadata({
              id: d.author.id,
              username: d.author.username,
              globalName: d.author.global_name,
              avatar: d.author.avatar,
              lastSeen: occurredAt,
            }),
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
            discord: discordMetadata({ id: d.user_id, lastSeen: occurredAt }),
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
            discord: discordMetadata({
              id: d.user.id,
              username: d.user.username,
              globalName: d.user.global_name,
              avatar: d.user.avatar,
              joinedAt: d.joined_at ?? occurredAt.toISOString(),
              roles: d.roles,
              lastSeen: occurredAt,
            }),
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
            discord: discordMetadata({ id: d.user.id, lastSeen: occurredAt }),
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
   * Resolve / merge the member-linked contact. The consumer wires this to the
   * engine's identity-attach helper `client.identity.linkContact({ discordId:
   * patch.discordId, email: patch.email, contactProperties:
   * patch.contactProperties })` — routing the raw snowflake through the `discord`
   * identity Kind so the `discord_id` column is load-bearing. `email` is the
   * AUTHORITATIVE address the link was issued for (from the engine-verified
   * state), NOT the OAuth-reported Discord email.
   *
   * Use `client.identity.linkContact` (NOT bare `resolveOrCreateContact`): on a
   * successful `/link` contact-merge it propagates the analytics merge through
   * the SAME engine emission ingest uses (§7), folding the discord-keyed loser
   * into the canonical (email/external) survivor so Discord-platform events stop
   * landing on a separate PostHog person. `resolveOrCreateContact` alone merges
   * the rows but emits no PostHog merge.
   */
  resolveContact: (patch: {
    discordId: string;
    email?: string;
    contactId?: string;
    contactProperties: Record<string, unknown>;
  }) => Promise<void>;
  /**
   * Mint a single-use `/link` code for `(discordUserId, email)`. The CONSUMER
   * wires this to the engine's `createLinkCode({ db, connectorId: "discord", … })`
   * so the anti-email-bomb throttle (per invoking user AND per target email,
   * counted on mint) runs BEFORE the mint and an over-cap request returns
   * `{ ok:false, reason:"throttled" }` without minting. A thrown error (DB down)
   * MUST propagate so the loop fails CLOSED (no unthrottled send).
   */
  mintCode: (args: {
    discordUserId: string;
    email: string;
  }) => Promise<LinkMintResult>;
  /**
   * Email a `/link`-minted code via Hogsend. The CONSUMER wires this to a
   * TRANSACTIONAL send (`category: "transactional"`, `skipPreferenceCheck: true`)
   * so a verification code is NEVER dropped by unsubscribe/frequency suppression
   * (routing it through the journey-category `sendEmail` would silently drop it
   * for unsubscribed users — see the spec's transactional-bypass correction).
   */
  sendLinkCode: (args: { email: string; code: string }) => Promise<void>;
  /**
   * Redeem a `/verify` code for the bound email. The CONSUMER wires this to the
   * engine's `redeemLinkCode({ db, connectorId: "discord", platformUserId, code })`
   * — single-use (atomic claim), TTL-enforced, and identity-bound (the engine
   * re-checks `platformUserId` with a constant-time compare).
   */
  redeemCode: (args: {
    discordUserId: string;
    code: string;
  }) => Promise<LinkRedeemResult>;
  /**
   * OPTIONAL anti-guessing throttle for `/verify`, checked BEFORE redeem (caps
   * brute-force `/verify` traffic per Discord user). BEST-EFFORT, fail-OPEN: a
   * throttle-store outage MUST NOT block a legitimate redeem — the per-mint caps
   * + the redeem identity-binding are the real backstops, so a missed throttle
   * never enables cross-account guessing. Omit to apply no per-attempt cap
   * (redeem is still single-use + identity-bound).
   */
  recordVerifyAttempt?: (args: {
    discordUserId: string;
  }) => Promise<VerifyAttemptResult>;
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

      let payload: Parameters<typeof handleInteraction>[0];
      try {
        payload = JSON.parse(args.rawBody) as Parameters<
          typeof handleInteraction
        >[0];
      } catch {
        return { kind: "unauthorized" };
      }

      // The ed25519 verify above gates EVERYTHING. handleInteraction runs the
      // /link→/verify identify loop (PING→PONG + unknown commands fall through
      // to a deferred ack). The route 200s the returned body verbatim — which IS
      // Discord's interaction response (an immediate ephemeral reply for
      // /verify; a type-5 ephemeral ack for /link, whose real work + @original
      // PATCH happen out of band inside handleInteraction).
      const response = await handleInteraction(payload, {
        applicationId: config.applicationId,
        mintCode: config.mintCode,
        sendLinkCode: config.sendLinkCode,
        redeemCode: config.redeemCode,
        recordVerifyAttempt: config.recordVerifyAttempt,
        resolveContact: (patch) =>
          config.resolveContact({
            discordId: patch.discordId,
            email: patch.email,
            // The /verify attach is identity-only; richer Discord metadata
            // arrives via the gateway events. resolveOrCreateContact needs only
            // discordId + email to bind the identity.
            contactProperties: {},
          }),
        logger: args.ctx.logger,
      });
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
        // CSRF-only — no contact binding. Capture the granted guild id. The
        // exchange `redirect_uri` byte-matches the bare authorize redirect (no
        // `flow` query — the signed-state `purpose` already disambiguated).
        const token = await exchangeDiscordCode({
          applicationId: config.applicationId,
          clientSecret: config.clientSecret,
          code,
          redirectUri: config.redirectUri,
        });
        await config.saveDerived({
          ...(token.guild?.id ? { discordGuildId: token.guild.id } : {}),
        });
        // Install is the OPERATOR flow — keep redirecting to Studio.
        return { kind: "redirect", location: config.studioIntegrationsUrl };
      } else if (intent.purpose === "member_link") {
        // Attach the Discord identity to the BOUND contact. The authoritative
        // email is `intent.email` (the address the link was ISSUED for), NOT
        // the OAuth-reported `user.email` — using the latter as a resolution
        // key is the grafting vector. Exchange `redirect_uri` byte-matches the
        // bare authorize redirect (no `flow` query).
        const token = await exchangeDiscordCode({
          applicationId: config.applicationId,
          clientSecret: config.clientSecret,
          code,
          redirectUri: config.redirectUri,
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
        // Member-link is the END-USER flow — never land them in Studio. Serve a
        // self-contained branded success page instead.
        return {
          kind: "html",
          status: 200,
          body: linkSuccessPage(intent.email ?? ""),
        };
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

/**
 * Minimal HTML escape for the ONE interpolated value (the linked email). The
 * email rides in a server-minted + server-verified signed state, so it is not
 * attacker-controlled today — but escaping it keeps the served page XSS-safe if
 * state-minting ever loosens. Covers the five HTML-significant characters.
 */
function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

/**
 * The branded OAuth-fallback success page served to END-USERS after a
 * member-link callback (NEVER a Studio redirect — Studio is operator-only). A
 * self-contained dark page (no external assets), `noindex`. When `email` is
 * empty (the signed state carried none) it renders a generic success line.
 */
function linkSuccessPage(email: string): string {
  const safeEmail = escapeHtml(email);
  const linkedLine = safeEmail
    ? `We linked <strong>${safeEmail}</strong> to your Discord account.`
    : "We linked your email to your Discord account.";
  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <meta name="robots" content="noindex" />
    <title>Discord linked</title>
    <style>
      :root { color-scheme: dark; }
      * { box-sizing: border-box; }
      body {
        margin: 0;
        min-height: 100vh;
        display: flex;
        align-items: center;
        justify-content: center;
        background: #09090b;
        color: #fafafa;
        font-family: ui-sans-serif, system-ui, -apple-system, "Segoe UI",
          Roboto, Helvetica, Arial, sans-serif;
        padding: 24px;
      }
      .card {
        max-width: 440px;
        width: 100%;
        text-align: center;
        background: rgba(255, 255, 255, 0.04);
        border: 1px solid rgba(255, 255, 255, 0.1);
        border-radius: 16px;
        padding: 40px 32px;
      }
      .badge {
        width: 56px;
        height: 56px;
        margin: 0 auto 20px;
        border-radius: 9999px;
        display: flex;
        align-items: center;
        justify-content: center;
        background: rgba(88, 101, 242, 0.15);
        color: #818cf8;
        font-size: 28px;
      }
      h1 { font-size: 20px; margin: 0 0 8px; font-weight: 600; }
      p { margin: 0; color: rgba(250, 250, 250, 0.7); line-height: 1.6; }
      .hint { margin-top: 16px; font-size: 13px; color: rgba(250, 250, 250, 0.5); }
    </style>
  </head>
  <body>
    <main class="card">
      <div class="badge" aria-hidden="true">&#10003;</div>
      <h1>You're all set</h1>
      <p>${linkedLine}</p>
      <p class="hint">You can close this tab and head back to Discord.</p>
    </main>
  </body>
</html>`;
}
