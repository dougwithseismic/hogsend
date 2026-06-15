import { createRoute, OpenAPIHono, z } from "@hono/zod-openapi";
import type { AppEnv } from "../../app.js";
import {
  InvalidIdentityTokenError,
  validateIdentityToken,
} from "../../lib/identity-token.js";

/**
 * Exchange a redirect identity token (`hs_t`) for the distinct id, AND — when
 * the caller supplies its own browser anon id (`currentDistinctId`) and the
 * active analytics provider can merge — fire a SERVER-SIDE `alias` folding the
 * caller's own anon session INTO the token's canonical subject. Called by the
 * LANDING SITE's frontend (CORS is open app-wide) after the user arrives from a
 * tracked link.
 *
 * Possession of a fresh signed token IS the authorization (the same trust
 * model as unsubscribe links): tokens are signed with BETTER_AUTH_SECRET,
 * expire after an hour, and resolve to nothing but the canonical key + src.
 *
 * ANTI-HIJACK (MF-4): the route NEVER passes `currentDistinctId` as the
 * survivor and NEVER server-identifies it. A forwarded-token holder can, at
 * worst, fold THEIR OWN anon session into the subject — never overwrite the
 * subject, never become the subject, never name a victim's anon id (they don't
 * know it). A scanner following the redirect runs no posthog-js, so it supplies
 * no `currentDistinctId` and the merge no-ops — the exchange is inert for
 * headless prefetch.
 */
const identifyRoute = createRoute({
  method: "post",
  path: "/identify",
  tags: ["Tracking"],
  summary: "Exchange a redirect identity token + optionally alias the caller",
  request: {
    body: {
      content: {
        "application/json": {
          schema: z.object({
            token: z.string().min(1).max(2048),
            // The caller's OWN browser anon distinct id, to be folded INTO the
            // token subject. Optional — absent = legacy resolve-only behaviour.
            currentDistinctId: z.string().min(1).max(200).optional(),
          }),
        },
      },
    },
  },
  responses: {
    200: {
      description: "Resolved identity",
      content: {
        "application/json": {
          // ONE response schema across §6 (MF-5): `src` is the new field,
          // `emailSendId` retained for the one-minor deprecation window.
          schema: z.object({
            distinctId: z.string(),
            src: z.string(),
            emailSendId: z.string().optional(),
          }),
        },
      },
    },
    400: { description: "Invalid or expired token" },
  },
});

export const identifyRouter = new OpenAPIHono<AppEnv>().openapi(
  identifyRoute,
  async (c) => {
    const { token, currentDistinctId } = c.req.valid("json");
    const { env, analytics, logger } = c.get("container");

    let payload: ReturnType<typeof validateIdentityToken>;
    try {
      payload = validateIdentityToken({
        token,
        secret: env.BETTER_AUTH_SECRET,
      });
    } catch (err) {
      if (err instanceof InvalidIdentityTokenError) {
        return c.body(null, 400);
      }
      throw err;
    }

    // MF-5 — fire the alias FIRE-AND-FORGET (never await on the response path)
    // and respond synchronously. The token-proven canonical key is the survivor;
    // the caller's own session is the absorbed (anonymous) side. A provider
    // without `identityMerge` (or no provider) skips the merge cleanly — the
    // client falls back to its existing best-effort `posthog.identify`.
    if (
      currentDistinctId &&
      analytics?.capabilities.identityMerge &&
      analytics.mergeIdentities &&
      currentDistinctId !== payload.distinctId
    ) {
      try {
        analytics.mergeIdentities({
          distinctId: payload.distinctId,
          alias: currentDistinctId,
        });
      } catch (err) {
        // Best-effort — a provider error must never fail the exchange.
        logger.warn("identify: mergeIdentities failed", {
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }

    return c.json(
      {
        distinctId: payload.distinctId,
        src: payload.src,
        emailSendId: payload.emailSendId,
      },
      200,
    );
  },
);
