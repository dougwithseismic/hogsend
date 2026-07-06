import { contacts, emailSends, importJobs, userEvents } from "@hogsend/db";
import { createRoute, OpenAPIHono, z } from "@hono/zod-openapi";
import { and, desc, eq, gte, inArray, isNull, lte } from "drizzle-orm";
import type { AppEnv } from "../../app.js";
import { contactSearchFilter } from "../../lib/contacts.js";
import { ingestEvent } from "../../lib/ingestion.js";
import { errorSchema } from "../../lib/schemas.js";
import { importContactsTask } from "../../workflows/import-contacts.js";

// --- Import ---

const importRoute = createRoute({
  method: "post",
  path: "/contacts/import",
  tags: ["Admin — Bulk"],
  summary: "Bulk import contacts",
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
  path: "/contacts/import/{jobId}",
  tags: ["Admin — Bulk"],
  summary: "Get import job status",
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

// --- Export ---

const exportRoute = createRoute({
  method: "get",
  path: "/contacts/export",
  tags: ["Admin — Bulk"],
  summary: "Export contacts as CSV or JSON",
  request: {
    query: z.object({
      format: z.enum(["csv", "json"]).default("json"),
      search: z.string().optional(),
      limit: z.coerce.number().min(1).max(100000).default(10000),
    }),
  },
  responses: {
    200: {
      content: {
        "application/json": {
          schema: z.object({
            contacts: z.array(z.record(z.string(), z.unknown())),
          }),
        },
      },
      description: "Exported contacts",
    },
  },
});

// --- Replay ---

const replayRoute = createRoute({
  method: "post",
  path: "/events/replay",
  tags: ["Admin — Bulk"],
  summary: "Replay events through ingestion pipeline",
  request: {
    body: {
      content: {
        "application/json": {
          schema: z.object({
            eventIds: z.array(z.string().uuid()).optional(),
            filter: z
              .object({
                event: z.string().optional(),
                userId: z.string().optional(),
                from: z.string().datetime().optional(),
                to: z.string().datetime().optional(),
              })
              .optional(),
            limit: z.number().min(1).max(1000).default(100),
          }),
        },
      },
    },
  },
  responses: {
    200: {
      content: {
        "application/json": {
          schema: z.object({
            replayed: z.number(),
            errors: z.number(),
          }),
        },
      },
      description: "Replay results",
    },
    400: {
      content: {
        "application/json": { schema: errorSchema },
      },
      description: "No replay selection (eventIds or filter) provided",
    },
  },
});

// --- Resend Email ---

const resendRoute = createRoute({
  method: "post",
  path: "/emails/{id}/resend",
  tags: ["Admin — Bulk"],
  summary: "Resend a failed email",
  request: {
    params: z.object({ id: z.string().uuid() }),
  },
  responses: {
    202: {
      content: {
        "application/json": {
          schema: z.object({
            emailId: z.string(),
            status: z.string(),
          }),
        },
      },
      description: "Email resend queued",
    },
    404: {
      content: { "application/json": { schema: errorSchema } },
      description: "Email not found",
    },
    409: {
      content: { "application/json": { schema: errorSchema } },
      description: "Email not in a resendable state",
    },
  },
});

// --- Batch Enroll ---

const batchEnrollRoute = createRoute({
  method: "post",
  path: "/journeys/{id}/enroll/batch",
  tags: ["Admin — Bulk"],
  summary: "Batch enroll users into a journey",
  request: {
    params: z.object({ id: z.string() }),
    body: {
      content: {
        "application/json": {
          schema: z.object({
            users: z
              .array(
                z.object({
                  userId: z.string().min(1),
                  userEmail: z.string().email(),
                  properties: z.record(z.string(), z.unknown()).optional(),
                }),
              )
              .min(1)
              .max(500),
          }),
        },
      },
    },
  },
  responses: {
    200: {
      content: {
        "application/json": {
          schema: z.object({
            enrolled: z.number(),
            skipped: z.number(),
            results: z.array(
              z.object({
                userId: z.string(),
                enrolled: z.boolean(),
              }),
            ),
          }),
        },
      },
      description: "Batch enrollment results",
    },
    404: {
      content: { "application/json": { schema: errorSchema } },
      description: "Journey not found",
    },
  },
});

export const bulkRouter = new OpenAPIHono<AppEnv>()
  .openapi(importRoute, async (c) => {
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

    // Fire-and-forget (`runNoWait`, not the old awaited `run`): the route's
    // contract is a 202 "queued" — awaiting the task to completion before
    // responding defeated the async job + status-poll design on large imports.
    // Mirrors the outbound emit spine: a failed enqueue is logged and the job
    // row stays `pending` (visible via the status route).
    void importContactsTask
      .runNoWait({ jobId: job.id, data: body.data, format: body.format })
      .catch((error: unknown) => {
        logger.warn("contacts/import: task enqueue failed", {
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
  })
  .openapi(exportRoute, async (c) => {
    const { db } = c.get("container");
    const { format, search, limit } = c.req.valid("query");

    const conditions = [isNull(contacts.deletedAt)];
    if (search) {
      const filter = contactSearchFilter(search);
      if (filter) conditions.push(filter);
    }

    const where = and(...conditions);

    const rows = await db
      .select()
      .from(contacts)
      .where(where)
      .orderBy(desc(contacts.createdAt))
      .limit(limit);

    if (format === "csv") {
      const header = "externalId,email,properties,firstSeenAt,lastSeenAt";
      const csvRows = rows.map(
        (r) =>
          `${r.externalId ?? ""},${r.email ?? ""},${JSON.stringify(r.properties ?? {}).replace(/,/g, ";")},${r.firstSeenAt.toISOString()},${r.lastSeenAt.toISOString()}`,
      );
      const csv = [header, ...csvRows].join("\n");

      return new Response(csv, {
        status: 200,
        headers: {
          "Content-Type": "text/csv",
          "Content-Disposition": 'attachment; filename="contacts.csv"',
        },
      }) as never;
    }

    return c.json(
      {
        contacts: rows.map((r) => ({
          id: r.id,
          externalId: r.externalId,
          email: r.email,
          properties: r.properties ?? {},
          firstSeenAt: r.firstSeenAt.toISOString(),
          lastSeenAt: r.lastSeenAt.toISOString(),
          createdAt: r.createdAt.toISOString(),
        })),
      },
      200,
    );
  })
  .openapi(replayRoute, async (c) => {
    const { db, registry, hatchet, logger } = c.get("container");
    const body = c.req.valid("json");

    let events: Array<typeof userEvents.$inferSelect>;

    if (body.eventIds?.length) {
      events = await db
        .select()
        .from(userEvents)
        .where(inArray(userEvents.id, body.eventIds));
    } else {
      const conditions = [];
      if (body.filter?.event) {
        conditions.push(eq(userEvents.event, body.filter.event));
      }
      if (body.filter?.userId) {
        conditions.push(eq(userEvents.userId, body.filter.userId));
      }
      if (body.filter?.from) {
        conditions.push(gte(userEvents.occurredAt, new Date(body.filter.from)));
      }
      if (body.filter?.to) {
        conditions.push(lte(userEvents.occurredAt, new Date(body.filter.to)));
      }

      // Refuse an unscoped replay. With no `eventIds` and no filter the WHERE
      // would collapse to `undefined`, silently re-pushing the most-recent
      // `limit` events back through the full ingestion pipeline (re-triggering
      // journeys, re-evaluating exits). Require an explicit selection.
      if (conditions.length === 0) {
        return c.json(
          {
            error:
              "Replay requires `eventIds` or at least one `filter` field (event, userId, from, to).",
          },
          400,
        );
      }

      events = await db
        .select()
        .from(userEvents)
        .where(and(...conditions))
        .orderBy(desc(userEvents.occurredAt))
        .limit(body.limit);
    }

    let replayed = 0;
    let errors = 0;

    const BATCH_SIZE = 25;
    for (let i = 0; i < events.length; i += BATCH_SIZE) {
      const batch = events.slice(i, i + BATCH_SIZE);
      const results = await Promise.allSettled(
        batch.map((event) =>
          ingestEvent({
            db,
            registry,
            hatchet,
            logger,
            event: {
              event: event.event,
              userId: event.userId,
              userEmail: "",
              // Stored `user_events.properties` is the event-property bag (D2).
              eventProperties:
                (event.properties as Record<string, unknown>) ?? {},
              source: "import",
            },
          }),
        ),
      );
      for (const result of results) {
        if (result.status === "fulfilled") replayed++;
        else errors++;
      }
    }

    return c.json({ replayed, errors }, 200);
  })
  .openapi(resendRoute, async (c) => {
    const { db } = c.get("container");
    const { id } = c.req.valid("param");

    const rows = await db
      .select()
      .from(emailSends)
      .where(eq(emailSends.id, id))
      .limit(1);

    const email = rows[0];
    if (!email) {
      return c.json({ error: "Email not found" }, 404);
    }

    if (!["failed", "bounced"].includes(email.status)) {
      return c.json({ error: "Email is not in a resendable state" }, 409);
    }

    if (!email.templateKey) {
      return c.json(
        { error: "Cannot resend: no template key to re-render from" },
        409,
      );
    }

    const [newSend] = await db
      .insert(emailSends)
      .values({
        journeyStateId: email.journeyStateId,
        templateKey: email.templateKey,
        fromEmail: email.fromEmail,
        toEmail: email.toEmail,
        subject: email.subject,
        category: email.category,
        status: "queued",
      })
      .returning();

    if (!newSend) throw new Error("Failed to create email send");

    const { sendEmailTask } = await import("../../workflows/send-email.js");
    await sendEmailTask.run({
      to: email.toEmail,
      subject: email.subject,
      html: "",
      from: email.fromEmail,
    });

    return c.json({ emailId: newSend.id, status: "queued" }, 202);
  })
  .openapi(batchEnrollRoute, async (c) => {
    const { db, registry, hatchet, logger } = c.get("container");
    const { id } = c.req.valid("param");
    const body = c.req.valid("json");

    const journey = registry.get(id);
    if (!journey) {
      return c.json({ error: "Journey not found" }, 404);
    }

    const results: Array<{ userId: string; enrolled: boolean }> = [];
    let enrolled = 0;
    let skipped = 0;

    const BATCH_SIZE = 25;
    for (let i = 0; i < body.users.length; i += BATCH_SIZE) {
      const batch = body.users.slice(i, i + BATCH_SIZE);
      const settled = await Promise.allSettled(
        batch.map((user) =>
          ingestEvent({
            db,
            registry,
            hatchet,
            logger,
            event: {
              event: journey.trigger.event,
              userId: user.userId,
              userEmail: user.userEmail,
              // Public batch-enroll request field stays `properties`
              // (decision #14); maps to the event-property bag (D2).
              eventProperties: user.properties ?? {},
              source: "import",
            },
          }),
        ),
      );
      for (const [j, result] of settled.entries()) {
        const user = batch[j];
        if (!user) continue;
        if (result.status === "fulfilled") {
          enrolled++;
          results.push({ userId: user.userId, enrolled: true });
        } else {
          skipped++;
          results.push({ userId: user.userId, enrolled: false });
        }
      }
    }

    return c.json({ enrolled, skipped, results }, 200);
  });
