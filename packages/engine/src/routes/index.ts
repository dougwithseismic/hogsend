import { OpenAPIHono } from "@hono/zod-openapi";
import type { AppEnv } from "../app.js";
import type { DefinedWebhookSource } from "../webhook-sources/define-webhook-source.js";
import { adminRouter } from "./admin/index.js";
import { emailRouter } from "./email/index.js";
import { healthRouter } from "./health.js";
import { ingestRouter } from "./ingest.js";
import { trackingRouter } from "./tracking/index.js";
import { registerWebhookRoutes } from "./webhooks/index.js";

export interface RegisterRoutesOptions {
  webhookSources: DefinedWebhookSource[];
}

export function registerRoutes(
  app: OpenAPIHono<AppEnv>,
  opts: RegisterRoutesOptions,
) {
  const v1 = new OpenAPIHono<AppEnv>();

  v1.route("/health", healthRouter);
  v1.route("/ingest", ingestRouter);
  v1.route("/email", emailRouter);
  v1.route("/admin", adminRouter);
  v1.route("/t", trackingRouter);

  app.route("/v1", v1);

  // Webhooks (built-in Resend + injected content sources) are registered on the
  // app at absolute paths.
  registerWebhookRoutes(app, { webhookSources: opts.webhookSources });
}
