import { emailPreferences } from "@hogsend/db";
import { createRoute, OpenAPIHono, z } from "@hono/zod-openapi";
import { and, count, desc, eq, gt, or, type SQL } from "drizzle-orm";
import type { AppEnv } from "../../app.js";
import { serializePrefs } from "../../lib/contacts.js";

// Maps the requested suppression type to a predicate over email_preferences.
// `complained` has no dedicated column — a complaint sets `suppressed` without
// incrementing `bounceCount` (see mailer `handleComplaint`), so we identify it
// as suppressed-but-not-bounced.
//
// IMPORTANT: the `email_preferences` table holds a row for (nearly) every
// contact, most of whom are NOT suppressed. The "All" view must therefore
// restrict to recipients suppressed in *some* way — returning `undefined`
// here would drop the WHERE clause entirely and list every contact.
function typeFilter(
  type: "bounced" | "unsubscribed" | "complained" | undefined,
): SQL | undefined {
  switch (type) {
    case "bounced":
      return gt(emailPreferences.bounceCount, 0);
    case "unsubscribed":
      return eq(emailPreferences.unsubscribedAll, true);
    case "complained":
      return and(
        eq(emailPreferences.suppressed, true),
        eq(emailPreferences.bounceCount, 0),
      );
    default:
      // "All" = the union of every suppression reason.
      return or(
        eq(emailPreferences.suppressed, true),
        eq(emailPreferences.unsubscribedAll, true),
        gt(emailPreferences.bounceCount, 0),
      );
  }
}

const suppressionSchema = z.object({
  id: z.string(),
  userId: z.string(),
  email: z.string(),
  unsubscribedAll: z.boolean(),
  suppressed: z.boolean(),
  bounceCount: z.number(),
  categories: z.record(z.string(), z.boolean()),
  suppressedAt: z.string().nullable(),
  lastBounceAt: z.string().nullable(),
});

const listSuppressionsRoute = createRoute({
  method: "get",
  path: "/",
  tags: ["Admin — Suppressions"],
  summary: "List suppressed / bounced / unsubscribed recipients",
  request: {
    query: z.object({
      type: z.enum(["bounced", "unsubscribed", "complained"]).optional(),
      limit: z.coerce.number().min(1).max(200).default(50),
      offset: z.coerce.number().min(0).default(0),
    }),
  },
  responses: {
    200: {
      content: {
        "application/json": {
          schema: z.object({
            suppressions: z.array(suppressionSchema),
            total: z.number(),
            limit: z.number(),
            offset: z.number(),
          }),
        },
      },
      description: "Suppression list",
    },
  },
});

export const suppressionsRouter = new OpenAPIHono<AppEnv>().openapi(
  listSuppressionsRoute,
  async (c) => {
    const { db } = c.get("container");
    const { type, limit, offset } = c.req.valid("query");

    const where = typeFilter(type);

    const [rows, totalRows] = await Promise.all([
      db
        .select()
        .from(emailPreferences)
        .where(where)
        .orderBy(desc(emailPreferences.updatedAt))
        .limit(limit)
        .offset(offset),
      db.select({ count: count() }).from(emailPreferences).where(where),
    ]);

    return c.json(
      {
        suppressions: rows.map((row) => serializePrefs(row)),
        total: totalRows[0]?.count ?? 0,
        limit,
        offset,
      },
      200,
    );
  },
);
