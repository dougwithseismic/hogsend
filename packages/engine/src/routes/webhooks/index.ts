import type { OpenAPIHono } from "@hono/zod-openapi";
import type { AppEnv } from "../../app.js";
import type { DefinedWebhookSource } from "../../webhook-sources/define-webhook-source.js";
import { registerEmailProviderRoutes } from "./email-provider.js";
import { resendWebhookRouter } from "./resend.js";
import { registerWebhookSourceRoutes } from "./sources.js";

export interface RegisterWebhookRoutesOptions {
  webhookSources: DefinedWebhookSource[];
}

export function registerWebhookRoutes(
  app: OpenAPIHono<AppEnv>,
  opts: RegisterWebhookRoutesOptions,
) {
  // Order is load-bearing for Hono path matching:
  //  1. the thin `/v1/webhooks/resend` alias (static),
  //  2. the `/v1/webhooks/email/:providerId` id-dispatched route (static
  //     `email/` prefix — MUST come before the catch-all),
  //  3. the `/v1/webhooks/:sourceId` consumer-source catch-all (LAST).
  app.route("/v1/webhooks", resendWebhookRouter);
  registerEmailProviderRoutes(app);
  registerWebhookSourceRoutes(app, opts.webhookSources);
}
