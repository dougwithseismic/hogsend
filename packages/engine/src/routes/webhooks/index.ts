import type { OpenAPIHono } from "@hono/zod-openapi";
import type { AppEnv } from "../../app.js";
import type { DefinedConnector } from "../../connectors/define-connector.js";
import { registerEmailProviderRoutes } from "./email-provider.js";
import { resendWebhookRouter } from "./resend.js";
import { registerSmsProviderRoutes } from "./sms-provider.js";
import { registerWebhookSourceRoutes } from "./sources.js";
import { registerVoiceProviderRoutes } from "./voice-provider.js";

export interface RegisterWebhookRoutesOptions {
  webhookConnectors: DefinedConnector[]; // pre-filtered to transport "webhook"
}

export function registerWebhookRoutes(
  app: OpenAPIHono<AppEnv>,
  opts: RegisterWebhookRoutesOptions,
) {
  // Order is load-bearing for Hono path matching:
  //  1. the thin `/v1/webhooks/resend` alias (static),
  //  2. the `/v1/webhooks/email/:providerId` id-dispatched route (static
  //     `email/` prefix — MUST come before the catch-all),
  //  3. the `/v1/webhooks/sms/:providerId` id-dispatched route (static `sms/`
  //     prefix — MUST come before the catch-all),
  //  4. the `/v1/webhooks/voice/:providerId` id-dispatched route (static
  //     `voice/` prefix — MUST come before the catch-all),
  //  5. the `/v1/webhooks/:sourceId` consumer-source catch-all (LAST).
  app.route("/v1/webhooks", resendWebhookRouter);
  registerEmailProviderRoutes(app);
  registerSmsProviderRoutes(app);
  registerVoiceProviderRoutes(app);
  registerWebhookSourceRoutes(app, opts.webhookConnectors);
}
