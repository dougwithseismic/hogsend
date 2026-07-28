import { importJobs } from "@hogsend/db";
import { createRoute, OpenAPIHono, z } from "@hono/zod-openapi";
import { eq } from "drizzle-orm";
import type { AppEnv } from "../../app.js";
import { errorSchema } from "../../lib/schemas.js";
import {
  IDENTITY_ALIAS_BACKFILL_FORMAT,
  identityAliasBackfillTask,
  identityAliasParity,
} from "../../workflows/identity-alias-backfill.js";

// PRD 02 T3/T4 — the identity-table admin surface: trigger/poll the alias
// backfill, and the read-only parity verifier that gates trusting alias-first
// resolution. Mirrors the `/contacts/import` job-trigger + status-poll pattern
// in `bulk.ts`. Behind `requireAdmin` like the rest of `/v1/admin`.

const triggerRoute = createRoute({
  method: "post",
  path: "/identity/alias-backfill",
  tags: ["Admin — Identity"],
  summary: "Run the contact_aliases backfill",
  description:
    "Fills contact_aliases with a row per identity key of every live " +
    "contact (chunked, idempotent, resumable — safe to re-run). The worker " +
    "also enqueues this once at boot; this route forces a re-run, e.g. after " +
    "a failed job or to re-verify. `dryRun: true` classifies and counts " +
    "without writing.",
  request: {
    body: {
      content: {
        "application/json": {
          schema: z.object({ dryRun: z.boolean().default(false) }),
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
      description: "Backfill job queued",
    },
  },
});

const statusRoute = createRoute({
  method: "get",
  path: "/identity/alias-backfill/{jobId}",
  tags: ["Admin — Identity"],
  summary: "Get alias-backfill job status",
  description:
    "processedRows = live contacts scanned; failedRows = pairs whose " +
    "(kind, value) is claimed by a DIFFERENT contact (the divergence metric, " +
    "not an error count). The full breakdown is in the worker log line.",
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
      description: "Backfill job details",
    },
    404: {
      content: { "application/json": { schema: errorSchema } },
      description: "Job not found",
    },
  },
});

const parityRoute = createRoute({
  method: "get",
  path: "/identity/alias-parity",
  tags: ["Admin — Identity"],
  summary: "Alias vs column resolution parity, per kind",
  description:
    "Read-only. `diverged` MUST be 0 before trusting alias-first " +
    "resolution — a non-zero value is a data bug to fix on its own. " +
    "`aliasDead` is expected (handled by the live-target rule); `aliasOnly` " +
    "is the merge/promote population and, after PRD 03, the point of the " +
    "table.",
  responses: {
    200: {
      content: {
        "application/json": {
          schema: z.object({
            kinds: z.array(
              z.object({
                kind: z.string(),
                diverged: z.number(),
                aliasDead: z.number(),
                aliasOnly: z.number(),
              }),
            ),
          }),
        },
      },
      description: "Parity counts per alias kind",
    },
  },
});

export const identityRouter = new OpenAPIHono<AppEnv>()
  .openapi(triggerRoute, async (c) => {
    const { db, logger } = c.get("container");
    const body = c.req.valid("json") ?? { dryRun: false };

    const [job] = await db
      .insert(importJobs)
      .values({
        fileName: IDENTITY_ALIAS_BACKFILL_FORMAT,
        format: IDENTITY_ALIAS_BACKFILL_FORMAT,
        status: "pending",
      })
      .returning({ id: importJobs.id });
    if (!job) throw new Error("Failed to create backfill job");

    // Fire-and-forget 202 + status poll (the bulk.ts contract). A failed
    // enqueue marks the durable row `failed` so pollers get a terminal state.
    void identityAliasBackfillTask
      .runNoWait({ jobId: job.id, dryRun: body.dryRun })
      .catch(async (error: unknown) => {
        const message = error instanceof Error ? error.message : String(error);
        logger.warn("identity/alias-backfill: task enqueue failed", {
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
          logger.warn("identity/alias-backfill: could not mark job failed", {
            jobId: job.id,
            error: dbError instanceof Error ? dbError.message : String(dbError),
          });
        }
      });

    return c.json({ jobId: job.id, status: "pending" }, 202);
  })
  .openapi(statusRoute, async (c) => {
    const { db } = c.get("container");
    const { jobId } = c.req.valid("param");

    const rows = await db
      .select()
      .from(importJobs)
      .where(eq(importJobs.id, jobId))
      .limit(1);
    const job = rows[0];
    if (!job || job.format !== IDENTITY_ALIAS_BACKFILL_FORMAT) {
      return c.json({ error: "Backfill job not found" }, 404);
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
  .openapi(parityRoute, async (c) => {
    const { db } = c.get("container");
    const kinds = await identityAliasParity(db);
    return c.json({ kinds }, 200);
  });
