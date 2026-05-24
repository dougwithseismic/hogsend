import { OpenAPIHono } from "@hono/zod-openapi";
import type { AppEnv } from "../app.js";
import { healthRouter } from "./health.js";

export function registerRoutes(app: OpenAPIHono<AppEnv>) {
  const v1 = new OpenAPIHono<AppEnv>();

  v1.route("/health", healthRouter);

  app.route("/v1", v1);
}
