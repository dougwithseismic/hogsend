import { OpenAPIHono } from "@hono/zod-openapi";
import type { AppEnv } from "../../app.js";
import { registerReferralMeRoute } from "./me.js";
import {
  registerReferralReportRoute,
  registerReferralTreeRoute,
} from "./report.js";
import {
  registerReferralImportRoute,
  registerReferralTouchRoute,
} from "./touch.js";

/**
 * The `/v1/referrals/*` router (PRD 05 §7.2). TWO TIERS on one prefix:
 *
 * - `/me` is browser-reachable (publishable OR secret-ingest) and gated INSIDE
 *   its handler by a server-minted `userToken`;
 * - `/report`, `/tree/:contactId`, `/touch` and `/import` are secret-key only
 *   under the ORTHOGONAL `referrals` scope.
 *
 * The guards live in `routes/index.ts` and BRANCH rather than stack, for the
 * reason `routes/accounts/index.ts` documents at length: Hono runs EVERY
 * matching `use` and `route("/v1", v1)` flattens the middleware, so a blanket
 * `/referrals/*` guard would 401 the browser `/me` route. This router
 * re-applies NO auth of its own.
 *
 * Registration order is LITERALS FIRST. `/me` is a literal and `/tree/{...}`
 * is the only parameterised path, so they cannot collide today - but the order
 * is kept explicit so a future `/referrals/{id}` cannot capture `/me`.
 */
export function createReferralsRouter(): OpenAPIHono<AppEnv> {
  const router = new OpenAPIHono<AppEnv>();

  registerReferralMeRoute(router);
  registerReferralReportRoute(router);
  registerReferralTouchRoute(router);
  registerReferralImportRoute(router);
  registerReferralTreeRoute(router);

  return router;
}
