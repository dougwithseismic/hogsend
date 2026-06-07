import { OpenAPIHono } from "@hono/zod-openapi";
import type { AppEnv } from "../app.js";
import { requireApiKey, requireScope } from "../middleware/api-key.js";
import { createRateLimit } from "../middleware/rate-limit.js";
import type { DefinedWebhookSource } from "../webhook-sources/define-webhook-source.js";
import { adminRouter } from "./admin/index.js";
import { contactsRouter } from "./contacts/index.js";
import { emailRouter } from "./email/index.js";
import { emailsRouter } from "./emails/index.js";
import { eventsRouter } from "./events/index.js";
import { healthRouter } from "./health.js";
import { listsRouter } from "./lists/index.js";
import { trackingRouter } from "./tracking/index.js";
import { registerWebhookRoutes } from "./webhooks/index.js";

export interface RegisterRoutesOptions {
  webhookSources: DefinedWebhookSource[];
}

// Conservative per-key email budget. `/v1/emails` MUST use a distinct prefix so
// transactional sends don't share the sliding-window budget with contact
// upserts / event ingest (open risk #15). 30/min/key is well under the
// contact-upsert default (100/min) — an integration loop sending more than that
// is almost certainly a runaway.
const EMAIL_RATE_LIMIT_MAX = 30;

export function registerRoutes(
  app: OpenAPIHono<AppEnv>,
  opts: RegisterRoutesOptions,
) {
  const v1 = new OpenAPIHono<AppEnv>();

  // Open routes: health + tracking pixels/redirects are intentionally
  // unauthenticated (links land in recipient inboxes), and the admin router
  // owns its own `requireAdmin` guard.
  v1.route("/health", healthRouter);
  v1.route("/email", emailRouter);
  v1.route("/admin", adminRouter);
  v1.route("/t", trackingRouter);

  // The guarded data plane (D5 / decision #16). ONE sub-app applies
  // `requireApiKey` → `requireScope("ingest")` for the whole data plane
  // (`/contacts`, `/events`, `/emails`, `/lists`); the child routers do NOT
  // re-apply auth. `/emails/*` layers the per-key email rate-limit on top, in
  // strict order auth → scope → rateLimit (never a shared "anonymous" bucket).
  const dataPlane = new OpenAPIHono<AppEnv>();
  dataPlane.use("*", requireApiKey);
  dataPlane.use("*", requireScope("ingest"));
  dataPlane.use(
    "/emails/*",
    createRateLimit({ prefix: "ratelimit:emails", max: EMAIL_RATE_LIMIT_MAX }),
  );

  dataPlane.route("/contacts", contactsRouter);
  dataPlane.route("/events", eventsRouter);
  dataPlane.route("/emails", emailsRouter);
  dataPlane.route("/lists", listsRouter);

  v1.route("/", dataPlane);

  app.route("/v1", v1);

  // Webhooks (built-in Resend + injected content sources) are registered on the
  // app at absolute paths.
  registerWebhookRoutes(app, { webhookSources: opts.webhookSources });
}
