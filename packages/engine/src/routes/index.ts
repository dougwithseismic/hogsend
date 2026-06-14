import { OpenAPIHono } from "@hono/zod-openapi";
import type { AppEnv } from "../app.js";
import type { HogsendClient } from "../container.js";
import { requireApiKey, requireScope } from "../middleware/api-key.js";
import { createRateLimit } from "../middleware/rate-limit.js";
import { adminRouter } from "./admin/index.js";
import { campaignsRouter } from "./campaigns/index.js";
import { registerConnectorRoutes } from "./connectors/index.js";
import { contactsRouter } from "./contacts/index.js";
import { emailRouter } from "./email/index.js";
import { emailsRouter } from "./emails/index.js";
import { eventsRouter } from "./events/index.js";
import { healthRouter } from "./health.js";
import { listsRouter } from "./lists/index.js";
import { trackingRouter } from "./tracking/index.js";
import { registerWebhookRoutes } from "./webhooks/index.js";

export interface RegisterRoutesOptions {
  container: HogsendClient;
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

  // The guarded data plane (D5 / decision #16): `requireApiKey` →
  // `requireScope("ingest")` on `/contacts`, `/events`, `/emails`, `/lists`.
  // Each prefix is guarded EXPLICITLY rather than via a root-mounted catch-all
  // sub-app — a sub-app at "/" with `use("*")` also intercepts sibling paths
  // (e.g. `/v1/webhooks`) and 401s them before they reach their own handlers.
  // Both the bare path and its `/*` subtree are covered (Hono treats them as
  // distinct match patterns). `/emails` layers the per-key email rate-limit on
  // top, in strict order auth → scope → rateLimit.
  const emailRateLimit = createRateLimit({
    prefix: "ratelimit:emails",
    max: EMAIL_RATE_LIMIT_MAX,
  });
  for (const base of [
    "/contacts",
    "/events",
    "/emails",
    "/lists",
    "/campaigns",
  ]) {
    v1.use(base, requireApiKey, requireScope("ingest"));
    v1.use(`${base}/*`, requireApiKey, requireScope("ingest"));
  }
  // Register the email rate-limit ONCE. The wildcard pattern `/emails/*` matches
  // BOTH the bare `POST /v1/emails` and any subtree, so a single registration
  // covers the whole emails surface. Registering both bare AND wildcard with the
  // SAME stateful instance double-counts every send (two sliding-window entries
  // per request), halving the effective per-key budget (decision #16 / risk 15).
  v1.use("/emails/*", emailRateLimit);

  v1.route("/contacts", contactsRouter);
  v1.route("/events", eventsRouter);
  v1.route("/emails", emailsRouter);
  v1.route("/lists", listsRouter);
  v1.route("/campaigns", campaignsRouter);

  app.route("/v1", v1);

  // Generic connector dispatch (oauth/interactions/ingress) — the static
  // `connectors/` prefix is registered BEFORE the `:sourceId` webhook catch-all
  // so it wins path matching. These routes self-authenticate (oauth state +
  // code, ed25519 signatures, the shared ingress secret) and are intentionally
  // OUTSIDE the api-key data plane — see registerConnectorRoutes.
  registerConnectorRoutes(app);

  // Webhooks (built-in Resend + injected content sources) are registered on the
  // app at absolute paths. The webhook route sources its connectors from the
  // container's unified registry (transport === "webhook"), NOT from a passed
  // array.
  registerWebhookRoutes(app, {
    webhookConnectors:
      opts.container.connectorRegistry.getByTransport("webhook"),
  });
}
