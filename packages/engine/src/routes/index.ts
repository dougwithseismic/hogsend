import { OpenAPIHono } from "@hono/zod-openapi";
import type { AppEnv } from "../app.js";
import type { HogsendClient } from "../container.js";
import { requireApiKey, requireScope } from "../middleware/api-key.js";
import { requirePublishableOrIngest } from "../middleware/publishable-key.js";
import { createRateLimit } from "../middleware/rate-limit.js";
import { adminRouter } from "./admin/index.js";
import { campaignsRouter } from "./campaigns/index.js";
import { registerConnectorRoutes } from "./connectors/index.js";
import { contactsRouter } from "./contacts/index.js";
import { emailRouter } from "./email/index.js";
import { emailsRouter } from "./emails/index.js";
import { eventsRouter } from "./events/index.js";
import { feedRouter } from "./feed/index.js";
import { flagsRouter } from "./flags/index.js";
import { groupsRouter } from "./groups/index.js";
import { healthRouter } from "./health.js";
import { listsRouter } from "./lists/index.js";
import { trackingRouter } from "./tracking/index.js";
import { shortLinkRouter } from "./tracking/short.js";
import { vanityRouter } from "./tracking/vanity.js";
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

  // ---- Browser-reachable subset (publishable OR secret-ingest) ----
  // Registered BEFORE the secret-only prefix loop so these specific patterns
  // win Hono's match order. `requirePublishableOrIngest` accepts EITHER a
  // secret ingest-scoped key (unchanged) OR a pk_/ingest-public key (Origin-
  // allowlisted, fail-closed). Everything NOT listed here stays secret-only.
  //
  // `/events` has no subtree (only `POST /`), so the bare pattern is complete.
  v1.use("/events", requirePublishableOrIngest);
  // `/lists` catalog + the new static `/preferences` read + subscribe/unsub.
  v1.use("/lists", requirePublishableOrIngest);
  v1.use("/lists/preferences", requirePublishableOrIngest);
  v1.use("/lists/:id/subscribe", requirePublishableOrIngest);
  v1.use("/lists/:id/unsubscribe", requirePublishableOrIngest);
  // Feed: `GET /feed` list/stream + `POST /feed/mark`/`mark-all` — publishable OR
  // secret. Both the bare `/feed` (GET list) and the `/feed/*` subtree
  // (mark/mark-all/stream) are covered (Hono treats them as distinct patterns).
  // Recipient scoping is enforced server-side in `resolveFeedRecipient`, never
  // from the request.
  v1.use("/feed", requirePublishableOrIngest);
  v1.use("/feed/*", requirePublishableOrIngest);
  // Flags: `GET /v1/flags` is the BROWSER read (publishable OR secret-ingest).
  // Only the bare `/flags` pattern is browser-reachable; the `/flags/evaluate`
  // subtree is secret-only (guarded in the secret section below). Because a
  // bare `use("/flags")` matches ONLY the exact path (not the subtree), the two
  // tiers never overlap. Recipient scoping is server-side in
  // `resolveFeedRecipient`, never from the request.
  v1.use("/flags", requirePublishableOrIngest);
  // Bare `/contacts` is dual-purpose: PUT/POST = the publishable upsert;
  // DELETE = secret-only. Hono runs ALL matching `use`s, so a single guard must
  // branch by method rather than stacking two guards (which would 403 a valid
  // pk_ upsert via the secret guard). Any OTHER `/contacts/*` (incl. /find)
  // stays secret-only below.
  const contactsDeleteGuard = requireScope("ingest");
  v1.use("/contacts", async (c, next) => {
    if (c.req.method !== "DELETE") {
      return requirePublishableOrIngest(c, next);
    }
    // DELETE is secret-only: chain `requireApiKey` then `requireScope("ingest")`
    // exactly as the secret prefix loop does. `requireApiKey` only runs its
    // `next` on a successful auth (else it returns 401/expired), so use a flag
    // to detect that and surface its short-circuit response; otherwise hand off
    // to the scope guard (which itself returns its 403 or calls `next`).
    let authed = false;
    const res = await requireApiKey(c, async () => {
      authed = true;
    });
    if (!authed) return res;
    return contactsDeleteGuard(c, next);
  });

  // ---- Secret-only prefixes (unchanged behavior) ----
  // `/emails`, `/campaigns`: bare + subtree. A pk_ key hitting these fails
  // `requireScope("ingest")` (its `["ingest-public"]` scope is neither `ingest`
  // nor `full-admin`) → 403, no escalation.
  //
  // NOTE: deliberately NO `/lists/*` OR `/contacts/*` secret catch-all. Hono
  // runs ALL matching `use`s, AND a `/<prefix>/*` `use` ALSO matches the bare
  // `/<prefix>` path — so a `/contacts/*` guard would re-run on the bare
  // `/contacts` upsert and 403 a valid pk_ key AFTER the method-branch
  // publishable guard above already accepted it (the exact `/lists/*` collision
  // we avoid the same way). The only secret-only `/contacts` subtree route is
  // `GET /contacts/find`, so guard it EXPLICITLY; the bare-`/contacts`
  // method-branch guard above is the sole authority on the bare path (DELETE is
  // secret-only there, PUT/POST publishable). Any FUTURE secret-only
  // `/contacts/<x>` or `/lists/<x>` route must mount its own
  // `requireApiKey + requireScope("ingest")` (fail-closed by construction).
  //
  // `/groups` is the same shape: the ENTIRE surface (group property writes,
  // membership mutations, AND reads) is operator data, so it is secret-only. A
  // browser (pk_) key never touches `/v1/groups`; it associates groups ONLY by
  // attaching a `groups` map to an ingested event on the publishable
  // `/v1/events` route (association-only, no property write).
  for (const base of ["/emails", "/campaigns", "/groups"]) {
    v1.use(base, requireApiKey, requireScope("ingest"));
    v1.use(`${base}/*`, requireApiKey, requireScope("ingest"));
  }
  v1.use("/contacts/find", requireApiKey, requireScope("ingest"));
  // `POST /v1/flags/evaluate` is the SERVER SDK read — secret-only, exactly like
  // the other secret data-plane routes. The bare `/flags` (browser GET) is
  // guarded separately above; guard ONLY the `/evaluate` path here so the two
  // tiers stay disjoint. A pk_ key hitting this fails `requireScope("ingest")`.
  v1.use("/flags/evaluate", requireApiKey, requireScope("ingest"));
  // Register the email rate-limit ONCE. The wildcard pattern `/emails/*` matches
  // BOTH the bare `POST /v1/emails` and any subtree, so a single registration
  // covers the whole emails surface. Registering both bare AND wildcard with the
  // SAME stateful instance double-counts every send (two sliding-window entries
  // per request), halving the effective per-key budget (decision #16 / risk 15).
  v1.use("/emails/*", emailRateLimit);

  v1.route("/contacts", contactsRouter);
  v1.route("/events", eventsRouter);
  v1.route("/feed", feedRouter);
  v1.route("/flags", flagsRouter);
  v1.route("/emails", emailsRouter);
  v1.route("/lists", listsRouter);
  v1.route("/campaigns", campaignsRouter);
  v1.route("/groups", groupsRouter);

  app.route("/v1", v1);

  // Vanity link redirect — root-mounted so the operator-facing short URL is
  // `${API_PUBLIC_URL}/l/:slug`. Unauthenticated like the rest of the tracking
  // surface (vanity links land in chats/posts/print).
  app.route("/", vanityRouter);

  // SMS short link redirect — root-mounted so the texted URL stays short
  // (`${SMS_LINK_HOST ?? API_PUBLIC_URL}/s/:code`); every character counts
  // against the GSM-7 segment budget. Unauthenticated like /l.
  app.route("/", shortLinkRouter);

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
