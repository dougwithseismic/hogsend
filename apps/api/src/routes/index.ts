import { OpenAPIHono } from "@hono/zod-openapi";
import type { AppEnv } from "../app.js";
import { adminRouter } from "./admin/index.js";
import { emailRouter } from "./email/index.js";
import { healthRouter } from "./health.js";
import { ingestRouter } from "./ingest.js";
import { posthogWebhookRouter } from "./webhooks/posthog.js";
import { resendWebhookRouter } from "./webhooks/resend.js";

export function registerRoutes(app: OpenAPIHono<AppEnv>) {
  const v1 = new OpenAPIHono<AppEnv>();

  v1.route("/health", healthRouter);
  v1.route("/ingest", ingestRouter);
  v1.route("/email", emailRouter);
  v1.route("/admin", adminRouter);
  v1.route("/webhooks", posthogWebhookRouter);
  v1.route("/webhooks", resendWebhookRouter);

  app.route("/v1", v1);
}
