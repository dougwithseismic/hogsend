import { OpenAPIHono } from "@hono/zod-openapi";
import type { AppEnv } from "../app.js";
import { healthRouter } from "./health.js";
import { ingestRouter } from "./ingest.js";

export function registerRoutes(app: OpenAPIHono<AppEnv>) {
  const v1 = new OpenAPIHono<AppEnv>();

  v1.route("/health", healthRouter);
  v1.route("/ingest", ingestRouter);

  app.route("/v1", v1);
}
