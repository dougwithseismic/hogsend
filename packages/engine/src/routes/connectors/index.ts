import { createRoute, type OpenAPIHono, z } from "@hono/zod-openapi";
import type { AppEnv } from "../../app.js";
import type { DefinedConnector } from "../../connectors/define-connector.js";
import { getConnectorRegistry } from "../../connectors/registry-singleton.js";
import { verifyConnectorState } from "../../lib/connector-state.js";
import { headersToRecord } from "../../lib/headers.js";
import { ingestEvent } from "../../lib/ingestion.js";
import type { Logger } from "../../lib/logger.js";
import { getRedisIfConnected } from "../../lib/redis.js";
import { clientIpKey, createRateLimit } from "../../middleware/rate-limit.js";
import { safeEqual } from "../../webhook-sources/verify.js";

/**
 * Diagnose a registered-but-bare connector: a `transport: "gateway"` connector
 * present in the registry that ships NO `handlers` cannot answer the generic
 * oauth/interactions dispatch and would otherwise 404 silently (looking like an
 * unknown connector). Log a warning so a misconfigured bare-connector
 * registration (the bare `discordConnector` vs. `createDiscordConnector(...)`)
 * is diagnosable. A genuinely unknown id (no connector) stays a quiet 404.
 */
function warnBareGatewayConnector(
  logger: Logger,
  id: string,
  connector: DefinedConnector | undefined,
  surface: "oauthCallback" | "interactions",
): void {
  if (connector && (connector.meta.transport ?? "webhook") === "gateway") {
    logger.warn(
      "connector registered without handlers — gateway connector cannot " +
        `serve ${surface}; register the connect-ready factory (e.g. ` +
        "createDiscordConnector(config)) instead of the bare const",
      { connectorId: id, surface },
    );
  }
}

/**
 * The generic connector dispatch surface: oauth/interactions/ingress. These
 * routes are UNAUTHENTICATED at the api-key layer BY DESIGN — each
 * self-authenticates (oauth `state` + code exchange, ed25519 interaction
 * signatures, the shared ingress secret). Do NOT add a blanket api-key guard.
 *
 * Because they are public + self-verifying, an attacker can otherwise hammer
 * them to force an ed25519 verify / constant-time secret compare per request
 * (CPU amplification). So we layer an IP-keyed sliding-window rate limit on the
 * whole `/v1/connectors/*` subtree (distinct prefix → isolated budget, mirroring
 * the sign-up throttle in app.ts).
 */
export function registerConnectorRoutes(app: OpenAPIHono<AppEnv>) {
  const connectorRateLimit = createRateLimit({
    prefix: "ratelimit:connectors",
    windowMs: 60_000,
    max: 60,
    keyFn: clientIpKey,
  });
  // `/ingress` is authed by the shared ingress secret (hit once per event by the
  // trusted gateway worker); `/interactions` is authed by Discord's ed25519
  // signature + a timestamp replay window. BOTH arrive from a SMALL set of source
  // IPs (the worker behind a tunnel; Discord's interaction egress), so per-IP
  // keying would collapse a whole community onto ONE 60/min bucket and 429 the
  // very /link & /verify loop we ship (Discord renders a 429 as "the application
  // did not respond"). The IP limit is sized for the public, self-verifying OAuth
  // callback — keep it there only; the ed25519 verify + replay window already
  // gate /interactions, and the constant-time secret compare gates /ingress.
  app.use("/v1/connectors/*", async (c, next) => {
    const p = c.req.path;
    if (p.endsWith("/ingress") || p.endsWith("/interactions")) return next();
    return connectorRateLimit(c, next);
  });

  // --- OAuth callback: GET|POST /v1/connectors/:id/oauth/callback -----------
  // GET handles the browser redirect-URI return (most OAuth flows); a POST
  // variant is mounted too for connectors that prefer it. Both dispatch to
  // handlers.oauthCallback.
  for (const method of ["get", "post"] as const) {
    app.openapi(
      createRoute({
        method,
        path: "/v1/connectors/{id}/oauth/callback",
        tags: ["Connectors"],
        request: { params: z.object({ id: z.string() }) },
        responses: {
          200: { description: "OAuth handled" },
          302: { description: "Redirect" },
          400: { description: "Missing / invalid / expired state" },
          404: { description: "Unknown connector / no oauth handler" },
        },
      }),
      async (c) => {
        const { id } = c.req.valid("param");
        const { db, logger, env } = c.get("container");
        const connector = getConnectorRegistry().get(id);
        if (!connector?.handlers?.oauthCallback) {
          warnBareGatewayConnector(logger, id, connector, "oauthCallback");
          return c.json({ error: "Unknown connector" }, 404);
        }
        const url = new URL(c.req.url);
        const query = Object.fromEntries(url.searchParams.entries());

        // The ENGINE owns CSRF state GENERICALLY: this callback lands
        // UNAUTHENTICATED, so a forged callback (login-CSRF / grafting an
        // identity onto an arbitrary contact) is only prevented by a
        // server-minted, server-verified signed `state`. Verify BEFORE
        // dispatching — a missing/invalid/expired state never reaches the
        // connector handler (no code exchange, no contact binding).
        const stateCheck = verifyConnectorState(
          query.state ?? "",
          env.BETTER_AUTH_SECRET,
        );
        if (!stateCheck.valid || !stateCheck.intent) {
          logger.warn("connector oauth callback: invalid state", {
            connectorId: id,
            reason: stateCheck.reason,
          });
          return c.json({ error: "Invalid state" }, 400);
        }
        // Bind the state to THIS connector: `BETTER_AUTH_SECRET` signs every
        // connector's state, so a state minted for connector A is
        // signature-valid here too. Reject a state whose `connectorId` does not
        // match this route's `:id` (cross-connector state replay).
        if (stateCheck.intent.connectorId !== id) {
          logger.warn("connector oauth callback: state connector mismatch", {
            routeConnectorId: id,
            stateConnectorId: stateCheck.intent.connectorId,
          });
          return c.json({ error: "Invalid state" }, 400);
        }

        // SINGLE-USE: the signed state is otherwise TTL-replayable — a captured
        // callback URL works until `exp`. Burn the per-mint nonce on first use:
        // a `SET … NX EX` succeeds exactly once, so a second callback carrying the
        // same nonce (NX fails → `null`) is rejected as a replay. The TTL matches
        // the max state window (900s) so the used-marker outlives any valid state.
        // Redis-less deploys (self-host without redis, tests) fall back to
        // TTL-only single-validity — we never block a callback on a cache miss.
        const redis = getRedisIfConnected();
        if (redis) {
          const usedKey = `connector:state:used:${stateCheck.intent.nonce}`;
          const claimed = await redis.set(usedKey, "1", "EX", 900, "NX");
          if (claimed !== "OK") {
            logger.warn("connector oauth callback: state replay rejected", {
              connectorId: id,
            });
            return c.json({ error: "Invalid state" }, 400);
          }
        }

        let body: unknown;
        try {
          body = method === "post" ? await c.req.json() : undefined;
        } catch {
          body = undefined;
        }
        const result = await connector.handlers.oauthCallback({
          query,
          body,
          state: stateCheck.intent,
          ctx: { db, logger, env, apiPublicUrl: env.API_PUBLIC_URL },
        });
        if (result.kind === "redirect") {
          return c.redirect(result.location, 302);
        }
        if (result.kind === "html") {
          // Serve a self-contained branded page as text/html (a raw HTML
          // string through the `json` kind would be JSON-quoted in the browser).
          return c.html(result.body, result.status === 400 ? 400 : 200);
        }
        // `c.json`'s typed status union only accepts the route's declared
        // literals — branch on the concrete status instead of casting a runtime
        // number to a literal.
        if (result.status === 404) {
          return c.json(result.body as object, 404);
        }
        return c.json(result.body as object, 200);
      },
    );
  }

  // --- Interactions: POST /v1/connectors/:id/interactions -------------------
  app.openapi(
    createRoute({
      method: "post",
      path: "/v1/connectors/{id}/interactions",
      tags: ["Connectors"],
      request: { params: z.object({ id: z.string() }) },
      responses: {
        200: { description: "Interaction acknowledged / ingested" },
        401: { description: "Bad platform signature" },
        404: { description: "Unknown connector / no interactions handler" },
      },
    }),
    async (c) => {
      const { id } = c.req.valid("param");
      const { db, logger, env, registry, hatchet } = c.get("container");
      const connector = getConnectorRegistry().get(id);
      if (!connector?.handlers?.interactions) {
        warnBareGatewayConnector(logger, id, connector, "interactions");
        return c.json({ error: "Unknown connector" }, 404);
      }
      const rawBody = await c.req.text(); // EXACT bytes — ed25519 covers them
      const headers = headersToRecord(c.req.raw.headers);
      const result = await connector.handlers.interactions({
        rawBody,
        headers,
        ctx: { db, logger, env, apiPublicUrl: env.API_PUBLIC_URL },
      });
      if (result.kind === "unauthorized") {
        return c.json({ error: "Invalid signature" }, 401);
      }
      if (result.kind === "ingest") {
        await ingestEvent({
          db,
          registry,
          hatchet,
          logger,
          event: result.event,
        });
        return c.json({ ok: true }, 200);
      }
      // `kind: "ack"` — a non-event handshake the connector already answered.
      return c.json((result.body ?? { ok: true }) as object, 200);
    },
  );

  // --- Gateway ingress: POST /v1/connectors/:id/ingress ---------------------
  // The long-lived gateway worker POSTs raw platform events here behind the
  // shared internal secret; the route runs the connector's transform so ALL
  // transform logic stays in the connector and the worker is dumb.
  app.openapi(
    createRoute({
      method: "post",
      path: "/v1/connectors/{id}/ingress",
      tags: ["Connectors"],
      request: { params: z.object({ id: z.string() }) },
      responses: {
        200: { description: "Ingested / skipped" },
        401: { description: "Bad internal secret" },
        404: { description: "Unknown gateway connector" },
      },
    }),
    async (c) => {
      const { id } = c.req.valid("param");
      const connector = getConnectorRegistry().get(id);
      if (!connector || (connector.meta.transport ?? "webhook") !== "gateway") {
        return c.json({ error: "Unknown gateway connector" }, 404);
      }
      const { db, logger, env, registry, hatchet } = c.get("container");
      const expected = env.CONNECTOR_INGRESS_SECRET;
      const provided = c.req.header("x-hogsend-ingress-secret");
      // Fail CLOSED: an unconfigured ingress secret cannot be relayed into.
      // `safeEqual` length-guards before the constant-time compare, so a length
      // mismatch returns false rather than throwing.
      if (!expected || !provided || !safeEqual(provided, expected)) {
        return c.json({ error: "Unauthorized" }, 401);
      }
      const payload = await c.req.json();
      const event = await connector.transform(payload, {
        db,
        logger,
        transport: "gateway",
      });
      if (!event) return c.json({ ok: true, skipped: true }, 200);
      const result = await ingestEvent({
        db,
        registry,
        hatchet,
        logger,
        event,
      });
      // INTENTIONALLY `result.exits.length` (a number) — a deliberate
      // divergence from the `/v1/webhooks/:sourceId` route, which returns the
      // ExitResult[] ARRAY for back-compat. Do NOT unify the two.
      return c.json(
        { ok: true, event: event.event, exits: result.exits.length },
        200,
      );
    },
  );
}
