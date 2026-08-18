import { referralTouches } from "@hogsend/db";
import { createRoute, type OpenAPIHono, z } from "@hono/zod-openapi";
import { and, eq, sql } from "drizzle-orm";
import type { AppEnv } from "../../app.js";
import { getReferralLink } from "../../lib/referral-link.js";
import {
  InvalidUserTokenError,
  verifyUserToken,
} from "../../lib/user-token.js";
import { resolveTokenContactId } from "../accounts/resolve.js";
import { referralIdQuery, resolveReferralId } from "./shared.js";

/**
 * `GET /v1/referrals/me` (PRD 05 §7.2) - the CALLER's own share link and
 * counts, `userToken`-gated, and NON-CONFIRMING exactly like
 * `GET /v1/accounts/me` (DECISIONS §6.9).
 *
 * An absent, malformed, expired or forged token takes the SAME code path as
 * "no referral is registered": `200 { link: null, stats: null }`. Anything else
 * would let a caller enumerate which of a customer's users exist.
 *
 * The mint is LAZY and idempotent: a signed-in user who has never shared gets a
 * link on first ask, and `getReferralLink` recovers it on every ask after.
 */

const meRoute = createRoute({
  method: "get",
  path: "/me",
  tags: ["Referrals"],
  summary: "The signed-in user's referral link and counts",
  description:
    "Publishable OR secret key, plus a server-minted `userToken` in the query string. Mints the caller's shared link lazily (idempotent). NON-CONFIRMING: an absent, forged, expired or unknown-user token returns `200 { link: null, stats: null }`, byte-identical to a deploy with no referral registered.",
  request: {
    query: z.object({
      userToken: z.string().optional(),
      referral: referralIdQuery,
    }),
  },
  responses: {
    200: {
      content: {
        "application/json": {
          schema: z.object({
            link: z
              .object({ url: z.string(), slug: z.string().nullable() })
              .nullable(),
            stats: z
              .object({
                touched: z.number(),
                bound: z.number(),
                qualified: z.number(),
              })
              .nullable(),
          }),
        },
      },
      description: "The caller's link + counts, or two nulls",
    },
  },
});

const EMPTY = { link: null, stats: null } as const;

export function registerReferralMeRoute(router: OpenAPIHono<AppEnv>) {
  router.openapi(meRoute, async (c) => {
    const container = c.get("container");
    const { db, env, referrals } = container;
    const query = c.req.valid("query");
    const referralId = resolveReferralId(query.referral);

    if (!query.userToken) return c.json(EMPTY, 200);
    if (!referrals.get(referralId)) return c.json(EMPTY, 200);

    let contactId: string | null = null;
    try {
      const { userId } = verifyUserToken({
        token: query.userToken,
        secret: env.BETTER_AUTH_SECRET,
      });
      contactId = await resolveTokenContactId(db, userId);
    } catch (err) {
      if (!(err instanceof InvalidUserTokenError)) throw err;
      contactId = null;
    }
    if (!contactId) return c.json(EMPTY, 200);

    const link = await getReferralLink({
      referral: referralId,
      contactId,
      container: {
        db,
        env: { API_PUBLIC_URL: env.API_PUBLIC_URL },
        referrals,
      },
    });

    const [counts] = await db
      .select({
        touched: sql<number>`count(*) filter (where ${referralTouches.status} <> 'rejected')::int`,
        bound: sql<number>`count(*) filter (where ${referralTouches.status} in ('bound', 'qualified'))::int`,
        qualified: sql<number>`count(*) filter (where ${referralTouches.status} = 'qualified')::int`,
      })
      .from(referralTouches)
      .where(
        and(
          eq(referralTouches.referralId, referralId),
          eq(referralTouches.referrerContactId, contactId),
        ),
      );

    return c.json(
      {
        link: { url: link.url, slug: link.slug },
        stats: {
          touched: Number(counts?.touched ?? 0),
          bound: Number(counts?.bound ?? 0),
          qualified: Number(counts?.qualified ?? 0),
        },
      },
      200,
    );
  });
}
