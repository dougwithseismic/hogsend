import { createServer } from "node:http";
import { serve } from "@hono/node-server";
import { createApp } from "./app.js";
import { createContainer } from "./container.js";
import { getPostHog } from "./lib/posthog.js";
import { getRedisIfConnected } from "./lib/redis.js";

const container = createContainer();
const app = createApp(container);
const { logger, env } = container;

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
      container.dbClient.end({ timeout: 5 }),
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
