import { emailPreferences, importJobs } from "@hogsend/db";
import { createRoute, OpenAPIHono, z } from "@hono/zod-openapi";
import { and, count, desc, eq, gt, or, type SQL } from "drizzle-orm";
import type { AppEnv } from "../../app.js";
import { serializePrefs } from "../../lib/contacts.js";
import { errorSchema } from "../../lib/schemas.js";
import { importSuppressionsTask } from "../../workflows/import-suppressions.js";

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

const importSuppressionsRoute = createRoute({
  method: "post",
  path: "/import",
  tags: ["Admin — Suppressions"],
  summary: "Bulk import a suppression list",
  description:
    "Queues an async import of unsubscribes / bounces / complaints into email_preferences. " +
    "Rows: email (required), reason (unsubscribed | bounced | complained, default unsubscribed), externalId (optional). " +
    "Historical imports do NOT emit per-row contact.unsubscribed events.",
  request: {
    body: {
      content: {
        "application/json": {
          schema: z.object({
            format: z.enum(["csv", "json"]),
            data: z.string().min(1),
            fileName: z.string().optional(),
          }),
        },
      },
    },
  },
  responses: {
    202: {
      content: {
        "application/json": {
          schema: z.object({
            jobId: z.string(),
            status: z.string(),
          }),
        },
      },
      description: "Import job queued",
    },
  },
});

const importStatusRoute = createRoute({
  method: "get",
  path: "/import/{jobId}",
  tags: ["Admin — Suppressions"],
  summary: "Get suppression import job status",
  request: {
    params: z.object({ jobId: z.string().uuid() }),
  },
  responses: {
    200: {
      content: {
        "application/json": {
          schema: z.object({
            id: z.string(),
            status: z.string(),
            totalRows: z.number().nullable(),
            processedRows: z.number(),
            failedRows: z.number(),
            errors: z
              .array(z.object({ row: z.number(), error: z.string() }))
              .nullable(),
            createdAt: z.string(),
            updatedAt: z.string(),
          }),
        },
      },
      description: "Import job details",
    },
    404: {
      content: { "application/json": { schema: errorSchema } },
      description: "Import job not found",
    },
  },
});

export const suppressionsRouter = new OpenAPIHono<AppEnv>()
  .openapi(listSuppressionsRoute, async (c) => {
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
  })
  .openapi(importSuppressionsRoute, async (c) => {
    const { db, logger } = c.get("container");
    const body = c.req.valid("json");

    const [job] = await db
      .insert(importJobs)
      .values({
        format: body.format,
        fileName: body.fileName ?? null,
      })
      .returning();

    if (!job) throw new Error("Failed to create import job");

    // Enqueue fire-and-forget (mirrors the outbound emit spine): the 202 means
    // "queued", so a slow/unreachable broker never blocks the response. A
    // failed enqueue is logged; the job row stays `pending` and is visible via
    // the status route.
    void importSuppressionsTask
      .runNoWait({ jobId: job.id, data: body.data, format: body.format })
      .catch((error: unknown) => {
        logger.warn("suppressions/import: task enqueue failed", {
          jobId: job.id,
          error: error instanceof Error ? error.message : String(error),
        });
      });

    return c.json({ jobId: job.id, status: "pending" }, 202);
  })
  .openapi(importStatusRoute, async (c) => {
    const { db } = c.get("container");
    const { jobId } = c.req.valid("param");

    const rows = await db
      .select()
      .from(importJobs)
      .where(eq(importJobs.id, jobId))
      .limit(1);

    const job = rows[0];
    if (!job) {
      return c.json({ error: "Import job not found" }, 404);
    }

    return c.json(
      {
        id: job.id,
        status: job.status,
        totalRows: job.totalRows,
        processedRows: job.processedRows,
        failedRows: job.failedRows,
        errors: job.errors as Array<{ row: number; error: string }> | null,
        createdAt: job.createdAt.toISOString(),
        updatedAt: job.updatedAt.toISOString(),
      },
      200,
    );
  });
