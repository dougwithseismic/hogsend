import type { OpenAPIHono } from "@hono/zod-openapi";
import type { AppEnv } from "../../app.js";
import type { DefinedWebhookSource } from "../../webhook-sources/define-webhook-source.js";
import { resendWebhookRouter } from "./resend.js";
import { registerWebhookSourceRoutes } from "./sources.js";

export interface RegisterWebhookRoutesOptions {
  webhookSources: DefinedWebhookSource[];
}

export function registerWebhookRoutes(
  app: OpenAPIHono<AppEnv>,
  opts: RegisterWebhookRoutesOptions,
) {
  app.route("/v1/webhooks", resendWebhookRouter);
  registerWebhookSourceRoutes(app, opts.webhookSources);
}
