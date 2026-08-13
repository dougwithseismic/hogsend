import { OpenAPIHono } from "@hono/zod-openapi";
import type { AppEnv } from "../../app.js";
import { registerAccountLinkCallbackRoute } from "./callback.js";
import { registerAccountLinkStartRoute } from "./start.js";

/**
 * The `/v1/accounts/*` router. PRD 07 mounts the two PUBLIC hosted-flow routes
 * here; PRD 09 adds the api-key data plane to the same router.
 *
 * **`/start` and `/callback` are unauthenticated BY CONSTRUCTION** — they are
 * browser redirect targets and carry no `Authorization` header — and mounting
 * them here does NOT put them outside the api-key data plane. Hono runs EVERY
 * matching `use`, and `app.route("/v1", v1)` flattens the middleware into one
 * router, so a guard registered on the two-segment param pattern
 * `/accounts/:provider/:providerUserId` (PRD 09's data plane) ALSO matches
 * `/accounts/steam/start` and `/accounts/steam/callback`. As originally
 * specified that made the entire hosted OAuth flow dead: 401 with no key, or
 * 403 with a `pk_` one.
 *
 * DECISIONS §15.1 settles it — PRD 09 registers ONE guard on that pattern that
 * BRANCHES INTERNALLY, falling through with no guard when the second segment is
 * `start` or `callback`, mirroring the method-branching `/contacts` guard in
 * `routes/index.ts`. Moving these routes to a different mount point does not
 * dodge it and must not be attempted. The tests that pin this assert the ACTUAL
 * success status, not merely "not 401": a blanket guard 403s (from the scope
 * check) rather than 401s, so a "not 401" assertion would ship the broken route
 * green.
 */
export function createAccountsRouter(): OpenAPIHono<AppEnv> {
  const router = new OpenAPIHono<AppEnv>();
  registerAccountLinkStartRoute(router);
  registerAccountLinkCallbackRoute(router);
  return router;
}
