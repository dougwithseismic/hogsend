import { createServer } from "node:http";
import {
  bootstrapAdminFromEnv,
  bootstrapApiKeyFromEnv,
  createApp,
  createHogsendClient,
  getEngineSchemaVersion,
  getPostHog,
  getRedisIfConnected,
  reportApiReady,
} from "@hogsend/engine";
import { mcpRoutes } from "@hogsend/mcp";
import { discordActions } from "@hogsend/plugin-discord";
import {
  telegramActions,
  telegramColdConnect,
  telegramConnector,
} from "@hogsend/plugin-telegram";
import { serve } from "@hono/node-server";
import { buckets } from "./buckets/index.js";
import { conversions } from "./conversions/index.js";
import {
  buildDiscordConnector,
  discordColdConnect,
  discordDestination,
  seedDiscordDerived,
  setDiscordDb,
} from "./discord.js";
import { templates } from "./emails/index.js";
import { flags } from "./flags/index.js";
import { funnels } from "./funnels.js";
import { Events, Templates } from "./journeys/constants/index.js";
import { journeys } from "./journeys/index.js";
import { lists } from "./lists/index.js";
import { smsTemplates } from "./sms/index.js";
import { webhookSources } from "./webhook-sources/index.js";

const discordConnector = buildDiscordConnector();

const client = createHogsendClient({
  journeys,
  conversions,
  flags,
  buckets,
  lists,
  funnels,
  email: { templates },
  // Feeds the Studio journey-graph route the app's `as const` constant maps so
  // `Templates.X`/`Events.X` member expressions in journey source resolve to
  // their real values (exact email previews + stable, join-safe node ids).
  journeyConstants: { templates: Templates, events: Events },
  // SMS channel — Twilio provider is auto-built from TWILIO_* env; with no creds
  // the SMS service is an inert stub and sendSms throws an actionable error.
  sms: { templates: smsTemplates },
  // Discord INBOUND connector (gateway transport) — only when configured. The
  // engine's `/v1/connectors/discord/{oauth,interactions,ingress}` + admin
  // connect-info/member-link routes dispatch into it from the registry.
  connectors: [
    ...(discordConnector ? [discordConnector] : []),
    // Telegram INBOUND connector (webhook transport) — served at
    // POST /v1/webhooks/telegram. Always registered; sends are token-gated.
    telegramConnector,
  ],
  // Journey-callable outbound actions — Telegram sendMessage/dm + Discord
  // grant/remove role + dmMember (Discord actions registered only when the
  // connector is configured, so the lifecycle/gamification journeys can act).
  connectorActions: [
    ...telegramActions,
    ...(discordConnector ? discordActions : []),
  ],
  // Discord OUTBOUND destination — always registered (config-driven per
  // webhook_endpoint), so lifecycle events can fan out to a Discord channel.
  destinations: [discordDestination],
});

// The Discord connector callbacks (saveDerived/resolveContact) capture the
// container db + identity service lazily — wire them now that the client (and
// its db/identity) exist. `client.identity` is what `resolveContact` uses so the
// `/link` contact-merge propagates a PostHog merge through the engine path (§7).
setDiscordDb(client.db, client.identity);

// Env-only deploys never run `hogsend connect discord`, so the derived
// credential lacks `discordAppId` and Studio's install button / member-link
// route stay disabled even though DISCORD_APPLICATION_ID is set. Seed it from
// env (read-merge-write, idempotent) ONLY when Discord is actually configured,
// so a Discord-less deploy never creates an empty derived row. `index.ts` is
// top-level `await`, and the seed only runs at boot, so this is safe here.
if (discordConnector) {
  await seedDiscordDerived(client.db);
}

// Refuse to serve when the database schema is behind what this build requires.
// `preDeployCommand` runs migrations before boot, so reaching here out of sync
// means the migration was skipped or didn't finish — fail loudly now instead of
// 500ing later on the first query that hits a missing column. A database that is
// *ahead* of this build is fine (forward-compatible; see docs/UPGRADING.md).
// Set SKIP_SCHEMA_CHECK=true to bypass in emergencies.
//
// Gating policy (two-track migrations): the ENGINE track gates boot — the
// running build hard-requires its bundled engine schema, so a behind-engine DB
// is a fatal misconfiguration. The CLIENT track does NOT gate boot — the client
// owns it, may legitimately deploy app code ahead of an additive client
// migration, and a pending client migration must not take the whole API down.
// Client-track drift is surfaced (non-fatally) via `/v1/health`
// (`schema.client.inSync:false` ⇒ status `migration_pending`), the operator's
// responsibility to resolve. `getEngineSchemaVersion` is the back-compat
// equivalent of the old `getSchemaVersion`, so behavior here is unchanged.
let schemaApplied: string | null = null;
if (process.env.SKIP_SCHEMA_CHECK !== "true") {
  const schema = await getEngineSchemaVersion(client.db);
  if (!schema.inSync) {
    client.logger.error(
      `Database schema is out of date: this build requires ${schema.required}, ` +
        `database is at ${schema.applied ?? "(empty)"}. ` +
        `Pending migration(s): ${schema.pending.join(", ") || "(unknown — is the DB reachable?)"}. ` +
        "Run `pnpm --filter @hogsend/db db:migrate`, or set SKIP_SCHEMA_CHECK=true to bypass.",
    );
    await client.dbClient.end({ timeout: 5 });
    process.exit(1);
  }
  schemaApplied = schema.applied ?? null;
}

// First-admin bootstrap (replaces the old web setup-token land-grab). With
// public sign-up disabled, an operator brings up a fresh deploy by setting
// STUDIO_ADMIN_EMAIL (+ optional STUDIO_ADMIN_PASSWORD): on a zero-user DB the
// API mints that admin here and prints a generated password ONCE if none was
// supplied. Idempotent (no-op once any user exists) and never fatal — runs in
// the API process only (not the worker) so two boots can't race the create.
await bootstrapAdminFromEnv({ client });

// First-key bootstrap (data-plane sibling of the admin bootstrap): a template
// deploy never runs the local `pnpm bootstrap`, so on a TRULY empty api_keys
// table the engine mints one ingest-scoped key and prints it ONCE to the log.
// Idempotent (no-op once any key exists), opt out with
// HOGSEND_BOOTSTRAP_API_KEY=false. API process only — never the worker.
await bootstrapApiKeyFromEnv({ client });

const app = createApp(client, {
  webhookSources,
  // Cold-connect pages: GET /connect/<id> (page) + POST .../exchange, each
  // mounted by the engine `createColdConnect()` primitive (basePath derived from
  // its own connectorId, so the two never collide). The Discord page is mounted
  // only when the connector is configured — its `/link` flow emails the confirm
  // link, and a click that hit an unmounted page would 404.
  routes: [
    telegramColdConnect.routes,
    ...(discordConnector ? [discordColdConnect.routes] : []),
    // Hosted MCP server at POST /v1/mcp (admin-gated, stateless). Lets
    // claude.ai connectors / any Streamable-HTTP MCP client author + observe
    // Journey Blueprints with the operator's admin API key. This is the
    // documented consumer mount pattern (`@hogsend/mcp` → createApp `routes`).
    mcpRoutes(),
  ],
});
const { logger, env } = client;

const server = serve(
  { fetch: app.fetch, port: env.PORT, createServer },
  (info) => {
    // Engine-owned boot output: branded banner in an interactive `pnpm dev`,
    // a single structured `ready` log line everywhere else.
    reportApiReady({ client, port: info.port, schemaVersion: schemaApplied });
  },
) as ReturnType<typeof createServer>;

server.requestTimeout = 30_000;
server.headersTimeout = 60_000;
server.keepAliveTimeout = 72_000;

async function shutdown(signal: string) {
  logger.info(`${signal} received, shutting down gracefully`);
  server.close(async () => {
    await Promise.allSettled([
      client.dbClient.end({ timeout: 5 }),
      getPostHog()?.shutdown(),
      getRedisIfConnected()?.quit(),
    ]);
    logger.info("Server closed");
    process.exit(0);
  });
  setTimeout(() => {
    logger.error("Forced shutdown after timeout");
    process.exit(1);
  }, 10_000);
}

process.on("SIGTERM", () => shutdown("SIGTERM"));
process.on("SIGINT", () => shutdown("SIGINT"));
