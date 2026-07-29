import { importJobs } from "@hogsend/db";
import { createRoute, OpenAPIHono, z } from "@hono/zod-openapi";
import { and, desc, eq } from "drizzle-orm";
import type { AppEnv } from "../../app.js";
import {
  CONTACT_ID_BACKFILL_FORMAT,
  contactIdBackfillTask,
  verifyContactIdBackfill,
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

// PRD 04 T6 — the invariant probe surfaced. Modelled on `identity.ts`'s
// alias-parity route: read-only, no body, counts only.

const verifyCountsSchema = z.object({
  missing: z.number(),
  duplicates: z.number(),
  mismatched: z.number(),
  orphaned: z.number(),
});

const verifyContactIdRoute = createRoute({
  method: "get",
  path: "/contact-id-verify",
  tags: ["Admin — Maintenance"],
  summary: "contact_id invariant probe — the read-flip readiness gate",
  description:
    "Read-only. Per table: `missing` = a live contact owns the row's user_id " +
    "(canonically OR via an external/anonymous contact_aliases row) but " +
    "contact_id is NULL; `mismatched` = contact_id points at a contact that " +
    "owns that user_id NEITHER way (including a pointer at no contact at " +
    "all) — the corruption detector an FK could never give, since an FK " +
    "proves the uuid exists while this proves it is the RIGHT uuid; " +
    "`orphaned` = contact_id is NULL and no live contact owns the key, which " +
    "is EXPECTED and permitted forever (PRD 04 D5) and is never a failure; " +
    "`duplicates` = a live contact owns the key but stamping the row would " +
    "violate a contact-scoped unique index (PRD 05 T3) because that contact " +
    "already holds a row for the same live journey / live bucket / address — " +
    "the backfill skips those on purpose rather than cancelling a live " +
    "enrollment, so they are a triage list, not a failure. " +
    "`flipReady` is true iff every table reports missing = mismatched = 0 — " +
    "that is the entry gate for the release that flips reads onto the " +
    "column. Judge it only once `lastSweepAt` is non-null: before a sweep " +
    "completes, `missing` is just pending backfill. " +
    "**Alert posture (D6):** when `flipReady` is false AND a sweep has " +
    "already completed, this route also emits a structured `error` log line " +
    "— the response stays 200, the log line is what alerting hooks. A " +
    "growing `missing` after the flip is live data loss, and a number in a " +
    "report nobody reads is not a control. " +
    "This is a full-table probe by nature; call it on demand, not on a timer.",
  responses: {
    200: {
      content: {
        "application/json": {
          schema: z.object({
            flipReady: z.boolean(),
            totals: verifyCountsSchema,
            tables: z.object({
              user_events: verifyCountsSchema,
              journey_states: verifyCountsSchema,
              bucket_memberships: verifyCountsSchema,
              email_sends: verifyCountsSchema,
              email_preferences: verifyCountsSchema,
            }),
            /** Newest completed sweep, or null if none has ever finished. */
            lastSweepAt: z.string().nullable(),
          }),
        },
      },
      description: "Per-table invariant counts + flip readiness",
    },
  },
});

export const maintenanceRouter = new OpenAPIHono<AppEnv>()
  .openapi(verifyContactIdRoute, async (c) => {
    const { db, logger } = c.get("container");

    // Read the sweep marker BEFORE the scans: it decides whether a hole is a
    // live signal or a pending-backfill artifact, and it should describe the
    // world as of the moment the probe started, not several full-table scans
    // later.
    const [sweep] = await db
      .select({ updatedAt: importJobs.updatedAt })
      .from(importJobs)
      .where(
        and(
          eq(importJobs.format, CONTACT_ID_BACKFILL_FORMAT),
          eq(importJobs.status, "completed"),
        ),
      )
      .orderBy(desc(importJobs.updatedAt))
      .limit(1);
    const lastSweepAt = sweep?.updatedAt ?? null;

    const result = await verifyContactIdBackfill({ db });

    // D6 (revised) — REPORT is not enough. A completed sweep plus a broken
    // invariant means the dual-write or the backfill has a hole that will not
    // heal itself, so say so at `error` level with the counts inline. The
    // request still succeeds: this endpoint's job is to answer, and the log
    // line is the control.
    if (!result.flipReady && lastSweepAt) {
      logger.error("contact_id invariant broken after a completed sweep", {
        route: "admin/maintenance/contact-id-verify",
        flipReady: false,
        totals: result.totals,
        tables: result.tables,
        lastSweepAt: lastSweepAt.toISOString(),
      });
    }

    return c.json(
      { ...result, lastSweepAt: lastSweepAt?.toISOString() ?? null },
      200,
    );
  })
  .openapi(backfillContactIdRoute, async (c) => {
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
  });
