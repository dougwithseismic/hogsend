import { createServer } from "node:http";
import {
  createApp,
  createHogsendClient,
  getEngineSchemaVersion,
  getPostHog,
  getRedisIfConnected,
} from "@hogsend/engine";
import { serve } from "@hono/node-server";
import { buckets } from "./buckets/index.js";
import { templates } from "./emails/index.js";
import { journeys } from "./journeys/index.js";
import { webhookSources } from "./webhook-sources/index.js";

const client = createHogsendClient({ journeys, buckets, email: { templates } });

// Refuse to serve when the database schema is behind what this build requires.
// `preDeployCommand` runs migrations before boot, so reaching here out of sync
// means the migration was skipped or didn't finish — fail loudly now instead of
// 500ing later on the first query that hits a missing column. A database that is
// *ahead* of this build is fine (forward-compatible).
// Set SKIP_SCHEMA_CHECK=true to bypass in emergencies.
//
// Gating policy (two-track migrations): the ENGINE track gates boot — the
// running build hard-requires its bundled engine schema, so a behind-engine DB
// is a fatal misconfiguration. The CLIENT track does NOT gate boot — you own it,
// may legitimately deploy app code ahead of an additive client migration, and a
// pending client migration must not take the whole API down. Client-track drift
// is surfaced (non-fatally) via `/v1/health` (`schema.client.inSync:false` ⇒
// status `migration_pending`), your responsibility to resolve.
if (process.env.SKIP_SCHEMA_CHECK !== "true") {
  const schema = await getEngineSchemaVersion(client.db);
  if (!schema.inSync) {
    client.logger.error(
      `Database schema is out of date: this build requires ${schema.required}, ` +
        `database is at ${schema.applied ?? "(empty)"}. ` +
        `Pending migration(s): ${schema.pending.join(", ") || "(unknown — is the DB reachable?)"}. ` +
        "Run `pnpm db:migrate`, or set SKIP_SCHEMA_CHECK=true to bypass.",
    );
    await client.dbClient.end({ timeout: 5 });
    process.exit(1);
  }
  client.logger.info(`Database schema in sync at ${schema.applied}`);
}

const app = createApp(client, { webhookSources });
const { logger, env } = client;

const server = serve(
  { fetch: app.fetch, port: env.PORT, createServer },
  (info) => {
    logger.info(`Server running on http://localhost:${info.port}`);
    logger.info(`API docs at http://localhost:${info.port}/docs`);
    logger.info(`OpenAPI spec at http://localhost:${info.port}/openapi.json`);
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
