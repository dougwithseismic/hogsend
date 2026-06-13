import { randomBytes } from "node:crypto";
import { contacts, type Database } from "@hogsend/db";
import { createRoute, OpenAPIHono, z } from "@hono/zod-openapi";
import { and, count, isNotNull, isNull } from "drizzle-orm";
import type { AppEnv } from "../../app.js";
import { getDestinationRegistry } from "../../destinations/registry-singleton.js";
import { signConnectorState } from "../../lib/connector-state.js";
import { getDiscordGatewayHeartbeat } from "../../lib/discord-gateway-heartbeat.js";
import {
  getDerivedCredential,
  getProviderCredential,
  ProviderCredentialDecryptError,
} from "../../lib/provider-credentials.js";
import { errorSchema } from "../../lib/schemas.js";
import { isLoopbackPublicUrl } from "./analytics.js";

/**
 * Admin connector/destination catalog — the GENERIC, provider-neutral half of
 * the connect flow that Studio's `/integrations` page reads. Mounted at
 * `/v1/admin/connectors`, inheriting `requireAdmin` + `rateLimit` +
 * `auditMiddleware` from the admin router root.
 *
 * - `GET /` enumerates every code-registered inbound connector + outbound
 *   destination, joined to stored-credential META (kind + updatedAt). Token
 *   material NEVER surfaces — this is observe-and-connect, the same INVARIANT
 *   the provider-credentials router holds.
 * - `GET /discord/connect-info` projects the Discord-specific env/credential
 *   signal the CLI + Studio need to drive the connect flow. Pure projection —
 *   it reads the registry + derived-credential meta + env, nothing more.
 *
 * The Discord-SPECIFIC mutating routes (`secrets`/`wire`) are CONSUMER-mounted
 * (the engine ships no Discord code) — see the consolidated spec §4.2.
 */

const transportSchema = z.enum(["webhook", "gateway", "poll"]);

const credentialMetaSchema = z
  .object({
    connected: z.boolean(),
    kind: z.enum(["oauth", "derived"]).optional(),
    updatedAt: z.string().optional(),
  })
  .nullable();

const integrationSchema = z.object({
  id: z.string(),
  name: z.string(),
  transport: transportSchema,
  hasConnector: z.boolean(),
  hasDestination: z.boolean(),
  description: z.string().optional(),
  credential: credentialMetaSchema,
  webhook: z
    .object({ url: z.string(), secretConfigured: z.boolean() })
    .optional(),
  gateway: z
    .object({
      // Tri-state: true = a guild id is known (bot is in a server); null =
      // unknown (worker reports no guild AND no derived guild). Never a false
      // "not installed" for a working env-only deploy.
      botInstalled: z.boolean().nullable(),
      guildId: z.string().nullable(),
      intents: z.number().nullable(),
      workerHealthy: z.boolean(),
      workerLastSeenAt: z.string().nullable(),
      linkedMembers: z.number(),
      unlinkedMembers: z.number(),
    })
    .optional(),
});

const listRoute = createRoute({
  method: "get",
  path: "/",
  tags: ["Admin — Connectors"],
  summary: "List code-registered connectors + destinations with connect state",
  responses: {
    200: {
      content: {
        "application/json": {
          schema: z.object({ integrations: z.array(integrationSchema) }),
        },
      },
      description:
        "Every code-registered inbound connector + outbound destination, " +
        "joined to stored-credential meta. Tokens never surface.",
    },
    401: {
      content: { "application/json": { schema: errorSchema } },
      description: "Missing or invalid admin credentials",
    },
  },
});

const connectInfoSchema = z.object({
  providerId: z.literal("discord"),
  apiPublicUrl: z.string(),
  redirectUri: z.string(),
  interactionsUrl: z.string(),
  ingressSecretConfigured: z.boolean(),
  credentialStored: z.boolean(),
  guildId: z.string().nullable(),
  // Tri-state — null = unknown (no guild from worker or derived credential).
  botInstalled: z.boolean().nullable(),
  /** True when a fresh gateway-worker heartbeat is present (Worker Online). */
  workerOnline: z.boolean(),
  workerLastSeenAt: z.string().nullable(),
  apiPublicUrlReachable: z.boolean(),
  /**
   * The one-click bot-install URL, built SERVER-SIDE from the stored Discord
   * application id (the `client_id` — not a secret). `null` until the secrets
   * are pasted via `hogsend connect discord`, so Studio shows the
   * "Connect via CLI" callout instead of an invite button.
   */
  installUrl: z.string().nullable(),
});

const connectInfoRoute = createRoute({
  method: "get",
  path: "/discord/connect-info",
  tags: ["Admin — Connectors"],
  summary: "Discord connection info for `hogsend connect discord` + Studio",
  responses: {
    200: {
      content: {
        "application/json": { schema: connectInfoSchema },
      },
      description:
        "Discord connect signal (redirect URI, interactions URL, readiness " +
        "flags, guild id) — secrets never appear, only their configured-ness",
    },
    401: {
      content: { "application/json": { schema: errorSchema } },
      description: "Missing or invalid admin credentials",
    },
  },
});

const memberLinkUrlRequestSchema = z.object({
  /** The contact the per-member link is issued FOR (authoritative binding). */
  contactId: z.string().min(1),
  /** The contact's email — the authoritative resolution key (anti-graft). */
  email: z.string().email(),
});

const memberLinkUrlResponseSchema = z.object({
  /** The full per-member Discord authorize URL, carrying the signed state. */
  url: z.string(),
});

const memberLinkUrlRoute = createRoute({
  method: "post",
  path: "/discord/member-link-url",
  tags: ["Admin — Connectors"],
  summary: "Mint a per-member Discord link URL bound to a contact (anti-graft)",
  request: {
    body: {
      content: {
        "application/json": { schema: memberLinkUrlRequestSchema },
      },
    },
  },
  responses: {
    200: {
      content: {
        "application/json": { schema: memberLinkUrlResponseSchema },
      },
      description:
        "Per-member Discord authorize URL whose signed state binds the " +
        "contact id + email the link is issued for",
    },
    409: {
      content: { "application/json": { schema: errorSchema } },
      description: "Discord application id not yet stored (connect first)",
    },
    401: {
      content: { "application/json": { schema: errorSchema } },
      description: "Missing or invalid admin credentials",
    },
  },
});

/**
 * Resolve a provider's stored-credential meta WITHOUT ever surfacing token
 * material. Prefers the oauth grant; falls back to the derived config. A
 * decrypt failure (secret rotated) is treated as "connected" — the operator
 * still needs to disconnect/reconnect, so the card must show it.
 */
async function resolveCredentialMeta(
  db: Database,
  providerId: string,
): Promise<z.infer<typeof credentialMetaSchema>> {
  try {
    const oauth = await getProviderCredential(db, providerId, "oauth");
    if (oauth) {
      return {
        connected: true,
        kind: "oauth",
        updatedAt: oauth.updatedAt.toISOString(),
      };
    }
  } catch (error) {
    if (error instanceof ProviderCredentialDecryptError) {
      return { connected: true, kind: "oauth" };
    }
    throw error;
  }

  try {
    const derived = await getDerivedCredential(db, providerId);
    if (derived) return { connected: true, kind: "derived" };
  } catch (error) {
    if (error instanceof ProviderCredentialDecryptError) {
      return { connected: true, kind: "derived" };
    }
    throw error;
  }

  return null;
}

export const adminConnectorsRouter = new OpenAPIHono<AppEnv>()
  .openapi(listRoute, async (c) => {
    const { db, env, connectorRegistry } = c.get("container");
    const apiPublicUrl = env.API_PUBLIC_URL.replace(/\/+$/, "");

    const connectors = connectorRegistry.getAll();
    const destinations = getDestinationRegistry().getAll();

    // Union the two faces by id — a platform (Discord) can be BOTH an inbound
    // connector and an outbound destination, and reads as one integration card.
    const ids = new Set<string>();
    for (const connector of connectors) ids.add(connector.meta.id);
    for (const destination of destinations) ids.add(destination.meta.id);

    const integrations = await Promise.all(
      [...ids].map(async (id) => {
        const connector = connectors.find((x) => x.meta.id === id);
        const destination = destinations.find((x) => x.meta.id === id);
        const transport = connector?.meta.transport ?? "webhook";
        const credential = await resolveCredentialMeta(db, id);

        const base = {
          id,
          name: connector?.meta.name ?? destination?.meta.name ?? id,
          transport,
          hasConnector: Boolean(connector),
          hasDestination: Boolean(destination),
          description:
            connector?.meta.description ?? destination?.meta.description,
          credential,
        };

        // Webhook-transport connectors expose their inbound URL + whether the
        // verify secret is configured (a `match` source with no env secret is
        // OPEN; surface that as not-configured so the operator notices).
        if (connector && transport === "webhook") {
          const auth = connector.inboundVerify;
          const secretConfigured = auth
            ? Boolean(
                env[auth.envKey as keyof typeof env] as string | undefined,
              )
            : false;
          return {
            ...base,
            webhook: {
              url: `${apiPublicUrl}/v1/webhooks/${id}`,
              secretConfigured,
            },
          };
        }

        // Gateway-transport connectors (Discord) expose bot-install + member
        // link counts + a REAL worker-liveness signal (the gateway worker
        // publishes a TTL'd Redis heartbeat — §4). guildId/intents live in the
        // derived credential OR the live heartbeat.
        if (connector && transport === "gateway") {
          // The Discord derived fields are an ADDITIVE widening of
          // DerivedCredentialPayload (spec §4.1) — read through a loose record
          // so this compiles before/after that widening lands.
          const derived = (await getDerivedCredential(db, id).catch(
            () => null,
          )) as Record<string, unknown> | null;
          const heartbeat = await getDiscordGatewayHeartbeat();

          const derivedGuildId =
            typeof derived?.discordGuildId === "string"
              ? derived.discordGuildId
              : null;
          // Prefer the live worker-observed guild; fall back to the stored one.
          const guildId = heartbeat.guildId ?? derivedGuildId;
          // Prefer the LIVE worker-reported intents (the derived credential never
          // carries discordIntents — install writes only the guild id); fall back
          // to the derived value for forward-compat if it ever IS written.
          const derivedIntents =
            typeof derived?.discordIntents === "number"
              ? derived.discordIntents
              : null;
          const intents = heartbeat.intents ?? derivedIntents;
          // Tri-state: a guild id (either source) confirms the bot is in a
          // server; otherwise unknown (null), NOT a false "not installed".
          const botInstalled: boolean | null = guildId ? true : null;

          // linkedMembers = contacts that have BOTH a discord_id and an email
          // (a member completed the per-member link); unlinkedMembers =
          // discord-keyed contacts with no email yet. Both scope to live rows.
          const [linkedRows, totalRows] = await Promise.all([
            db
              .select({ value: count() })
              .from(contacts)
              .where(
                and(
                  isNotNull(contacts.discordId),
                  isNotNull(contacts.email),
                  isNull(contacts.deletedAt),
                ),
              ),
            db
              .select({ value: count() })
              .from(contacts)
              .where(
                and(isNotNull(contacts.discordId), isNull(contacts.deletedAt)),
              ),
          ]);
          const linkedMembers = linkedRows[0]?.value ?? 0;
          const totalMembers = totalRows[0]?.value ?? 0;

          return {
            ...base,
            gateway: {
              botInstalled,
              guildId,
              intents,
              // REAL worker liveness — a fresh gateway-worker heartbeat in Redis.
              workerHealthy: heartbeat.alive,
              workerLastSeenAt: heartbeat.lastSeenAt ?? null,
              linkedMembers,
              unlinkedMembers: Math.max(0, totalMembers - linkedMembers),
            },
          };
        }

        return base;
      }),
    );

    integrations.sort((a, b) => a.name.localeCompare(b.name));
    return c.json({ integrations }, 200);
  })
  .openapi(connectInfoRoute, async (c) => {
    const { db, env } = c.get("container");
    const apiPublicUrl = env.API_PUBLIC_URL.replace(/\/+$/, "");

    const derived = (await getDerivedCredential(db, "discord").catch(
      () => null,
    )) as Record<string, unknown> | null;
    const heartbeat = await getDiscordGatewayHeartbeat();
    // Prefer the live worker-observed guild; fall back to the stored one.
    const guildId =
      heartbeat.guildId ??
      (typeof derived?.discordGuildId === "string"
        ? derived.discordGuildId
        : null);
    const appId =
      typeof derived?.discordAppId === "string" ? derived.discordAppId : null;

    const redirectUri = `${apiPublicUrl}/v1/connectors/discord/oauth/callback`;

    // The one-click install link is built server-side from the stored Discord
    // application id (`client_id`, NOT a secret). Scopes install the bot +
    // register slash commands. The `redirect_uri` is the bare callback (NO
    // `flow` query — the signed-state `purpose` disambiguates install vs.
    // member, and the exchange `redirect_uri` byte-matches this value).
    //
    // The install URL is SERVER-MINTED with a signed CSRF `state` — this is the
    // SINGLE canonical install URL (Studio button + CLI both consume it). The
    // unauthenticated oauth callback refuses to exchange a code without a valid
    // state, so the URL would be useless (and the install un-completable)
    // without it. `install` state is CSRF-only — it binds no contact.
    let installUrl: string | null = null;
    if (appId) {
      const state = signConnectorState(
        {
          purpose: "install",
          connectorId: "discord",
          nonce: randomBytes(16).toString("base64url"),
        },
        env.BETTER_AUTH_SECRET,
        600,
      );
      const params = new URLSearchParams({
        client_id: appId,
        response_type: "code",
        scope: "bot applications.commands",
        redirect_uri: redirectUri,
      });
      installUrl =
        `https://discord.com/oauth2/authorize?${params.toString()}` +
        `&state=${encodeURIComponent(state)}`;
    }

    return c.json(
      {
        providerId: "discord" as const,
        apiPublicUrl,
        redirectUri,
        interactionsUrl: `${apiPublicUrl}/v1/connectors/discord/interactions`,
        ingressSecretConfigured: Boolean(env.CONNECTOR_INGRESS_SECRET),
        credentialStored: derived !== null,
        guildId,
        // Tri-state — a guild id (live or derived) confirms install; else null.
        botInstalled: guildId ? true : null,
        workerOnline: heartbeat.alive,
        workerLastSeenAt: heartbeat.lastSeenAt ?? null,
        apiPublicUrlReachable: !isLoopbackPublicUrl(apiPublicUrl),
        installUrl,
      },
      200,
    );
  })
  .openapi(memberLinkUrlRoute, async (c) => {
    const { db, env } = c.get("container");
    const { contactId, email } = c.req.valid("json");
    const apiPublicUrl = env.API_PUBLIC_URL.replace(/\/+$/, "");

    const derived = (await getDerivedCredential(db, "discord").catch(
      () => null,
    )) as Record<string, unknown> | null;
    const appId =
      typeof derived?.discordAppId === "string" ? derived.discordAppId : null;
    if (!appId) {
      return c.json({ error: "discord_not_connected" }, 409);
    }

    // Bind the EXACT contact + email the link is issued for. The oauth callback
    // attaches the Discord identity to THIS contact (never to whatever email
    // Discord reports — the graft vector). 15-minute TTL.
    const state = signConnectorState(
      {
        purpose: "member_link",
        connectorId: "discord",
        contactId,
        email,
        nonce: randomBytes(16).toString("base64url"),
      },
      env.BETTER_AUTH_SECRET,
      900,
    );

    // Mirror the plugin's `buildMemberLinkUrl` contract inline — the engine
    // ships no Discord code, so it cannot import the plugin, but the authorize
    // URL shape is stable: member-link scopes + the signed state. The
    // `redirect_uri` is the bare callback (NO `flow` query — the signed-state
    // `purpose` disambiguates, and the exchange `redirect_uri` byte-matches).
    const redirectUri = `${apiPublicUrl}/v1/connectors/discord/oauth/callback`;

    const url = new URL("https://discord.com/api/oauth2/authorize");
    url.searchParams.set("client_id", appId);
    url.searchParams.set("scope", "identify email guilds.members.read");
    url.searchParams.set("response_type", "code");
    url.searchParams.set("redirect_uri", redirectUri);
    url.searchParams.set("state", state);
    url.searchParams.set("prompt", "consent");

    return c.json({ url: url.toString() }, 200);
  });
