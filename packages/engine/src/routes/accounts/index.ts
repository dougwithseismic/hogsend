import { OpenAPIHono } from "@hono/zod-openapi";
import type { AppEnv } from "../../app.js";
import { registerAccountLinkCallbackRoute } from "./callback.js";
import { registerAccountsImportRoute } from "./import-links.js";
import {
  registerAccountsListRoute,
  registerAccountsLookupRoute,
  registerAccountsUnlinkRoute,
} from "./lookup.js";
import {
  registerAccountsMeRevokeRoute,
  registerAccountsMeRoute,
} from "./me.js";
import {
  registerAccountsLinkUrlRoute,
  registerAccountsMintLinkRoute,
} from "./mint.js";
import { registerAccountLinkStartRoute } from "./start.js";

/**
 * The `/v1/accounts/*` router: PRD 07's two PUBLIC hosted-flow routes and PRD
 * 09's api-key data plane, in ONE router.
 *
 * **`/start` and `/callback` are unauthenticated BY CONSTRUCTION** — they are
 * browser redirect targets and carry no `Authorization` header — and mounting
 * them here does NOT put them outside the api-key data plane. Hono runs EVERY
 * matching `use`, and `app.route("/v1", v1)` flattens the middleware into one
 * router, so a guard registered on the two-segment param pattern
 * `/accounts/:provider/:providerUserId` ALSO matches `/accounts/steam/start`
 * and `/accounts/steam/callback`. As originally specified that made the entire
 * hosted OAuth flow dead: 401 with no key, or 403 with a `pk_` one.
 *
 * DECISIONS §15.1 settles it — `routes/index.ts` registers ONE guard on that
 * pattern that BRANCHES INTERNALLY, mirroring the method-branching `/contacts`
 * guard. Moving these routes to a different mount point does not dodge it and
 * must not be attempted. The tests that pin this assert NEITHER 401 NOR 403,
 * not merely "not 401": a blanket guard 403s (from the scope check) rather than
 * 401s, so a "not 401" assertion would ship the broken route green.
 *
 * ## Registration order is LITERALS FIRST, and it is load-bearing
 *
 * `/{provider}/{providerUserId}` matches `/steam/callback` (with
 * `providerUserId = "callback"`) and `/me/revoke` (with `provider = "me"`), so
 * a later registration would be captured by the earlier one — the hosted
 * callback would 404, or worse be answered by the reverse lookup as an unknown
 * pair, and the primary player revoke would never run. Every id that could
 * collide (`me`, `import`, `link-url`, `manage`, `start`, `callback`) is in
 * `RESERVED_ACCOUNT_LINK_IDS`, so no real provider can reach these branches by
 * accident.
 *
 * The router itself re-applies NO auth — the prefix guards in
 * `routes/index.ts` own that, exactly as `routes/groups/index.ts:250-255`
 * documents for `/v1/groups`.
 */
export function createAccountsRouter(): OpenAPIHono<AppEnv> {
  const router = new OpenAPIHono<AppEnv>();

  // (1) Literals, browser tier first.
  registerAccountsMeRoute(router);
  registerAccountsMeRevokeRoute(router);
  registerAccountsLinkUrlRoute(router);
  // (2) Literals, operator tier.
  registerAccountsImportRoute(router);
  registerAccountsMintLinkRoute(router);
  // (3) The bare collection.
  registerAccountsListRoute(router);
  // (4) PRD 07's hosted flow — BEFORE the two-segment param pattern.
  registerAccountLinkStartRoute(router);
  registerAccountLinkCallbackRoute(router);
  // (5) The parameterised operator routes, last.
  registerAccountsLookupRoute(router);
  registerAccountsUnlinkRoute(router);

  return router;
}
