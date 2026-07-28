import { importJobs } from "@hogsend/db";
import { createRoute, OpenAPIHono, z } from "@hono/zod-openapi";
import { eq } from "drizzle-orm";
import type { AppEnv } from "../../app.js";
import {
  CONTACT_ID_BACKFILL_FORMAT,
  contactIdBackfillTask,
} from "../../workflows/backfill-contact-id.js";

// PRD 04 T5 — the operator force-run for the `contact_id` reconcile sweep. The
// worker already enqueues it at boot and re-enqueues once the newest completed
// sweep goes stale (D6); this route forces one NOW, e.g. after a failed run or
// straight after a dual-write fix. Fire-and-forget 202 + a job id, mirroring
// `identity.ts`'s alias-backfill trigger. Behind `requireAdmin` with the rest
// of `/v1/admin`.

const backfillContactIdRoute = createRoute({
  method: "post",
  path: "/backfill-contact-id",
  tags: ["Admin — Maintenance"],
  summary: "Force a contact_id backfill sweep",
  description:
    "Fills `contact_id` on user_events / journey_states / " +
    "bucket_memberships / email_sends / email_preferences for rows whose " +
    "user_id is the canonical key of a live contact (or a stale key that " +
    "contact_aliases resolves). Chunked, paced and idempotent — every UPDATE " +
    "is guarded by `contact_id IS NULL`, so re-running is safe and cheap. " +
    "Rows whose key owns no live contact stay NULL by design (PRD 04 D5); " +
    "this job is NOT a repair tool for a wrong non-NULL value.",
  request: {
    body: {
      content: {
        "application/json": {
          schema: z.object({
            /** Overrides for the pacing rule — measure before deploying. */
            contactsPerChunk: z.number().int().min(1).optional(),
            rowsPerStatement: z.number().int().min(1).optional(),
            pauseMs: z.number().int().min(0).optional(),
          }),
        },
      },
      required: false,
    },
  },
  responses: {
    202: {
      content: {
        "application/json": {
          schema: z.object({ jobId: z.string(), status: z.string() }),
        },
      },
      description: "Backfill sweep queued",
    },
  },
});

export const maintenanceRouter = new OpenAPIHono<AppEnv>().openapi(
  backfillContactIdRoute,
  async (c) => {
    const { db, logger } = c.get("container");
    const body = c.req.valid("json") ?? {};

    const [job] = await db
      .insert(importJobs)
      .values({
        fileName: CONTACT_ID_BACKFILL_FORMAT,
        format: CONTACT_ID_BACKFILL_FORMAT,
        status: "pending",
      })
      .returning({ id: importJobs.id });
    if (!job) throw new Error("Failed to create backfill job");

    // Fire-and-forget 202 (the bulk.ts contract this mirrors). A failed enqueue
    // marks the durable row `failed` so it does not sit "pending" forever and
    // block the boot sweep's in-flight guard.
    void contactIdBackfillTask
      .runNoWait({
        jobId: job.id,
        contactsPerChunk: body.contactsPerChunk,
        rowsPerStatement: body.rowsPerStatement,
        pauseMs: body.pauseMs,
      })
      .catch(async (error: unknown) => {
        const message = error instanceof Error ? error.message : String(error);
        logger.warn("maintenance/backfill-contact-id: enqueue failed", {
          jobId: job.id,
          error: message,
        });
        try {
          await db
            .update(importJobs)
            .set({
              status: "failed",
              errors: [{ row: 0, error: `Task enqueue failed: ${message}` }],
              updatedAt: new Date(),
            })
            .where(eq(importJobs.id, job.id));
        } catch (dbError: unknown) {
          logger.warn(
            "maintenance/backfill-contact-id: could not mark job failed",
            {
              jobId: job.id,
              error:
                dbError instanceof Error ? dbError.message : String(dbError),
            },
          );
        }
      });

    return c.json({ jobId: job.id, status: "pending" }, 202);
  },
);
