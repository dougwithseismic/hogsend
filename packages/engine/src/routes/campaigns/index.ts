import { campaigns } from "@hogsend/db";
import { getTemplateNames, type TemplateName } from "@hogsend/email";
import { createRoute, OpenAPIHono, z } from "@hono/zod-openapi";
import { and, desc, eq, inArray, sql } from "drizzle-orm";
import type { AppEnv } from "../../app.js";
import { errorSchema } from "../../lib/schemas.js";
import { sendCampaignTask } from "../../workflows/send-campaign.js";

/**
 * How far in the past a `sendAt` may lie and still be accepted (treated as an
 * immediate send). Anything staler is a 400 — a client submitting last week's
 * timestamp almost certainly did not mean "blast right now".
 */
const SEND_AT_PAST_TOLERANCE_MS = 60 * 1000;

const createCampaignSchema = z
  .object({
    name: z.string().min(1).optional(),
    list: z.string().min(1).optional(),
    bucket: z.string().min(1).optional(),
    template: z.string().min(1),
    props: z.record(z.string(), z.unknown()).optional(),
    from: z.string().optional(),
    subject: z.string().optional(),
    /**
     * Optional future send instant (ISO 8601). Present → the campaign is
     * created `scheduled` and delivered at that instant (Hatchet scheduled run,
     * with the reaper sweep as backstop). Absent → immediate enqueue.
     */
    sendAt: z.string().datetime({ offset: true }).optional(),
    /**
     * Optional client idempotency key. A retried create with the same key
     * resolves to the EXISTING campaign instead of spawning a second broadcast
     * (which would double-send to the same recipients). The `Idempotency-Key`
     * header wins over this body field (mirrors /v1/emails + /v1/events).
     */
    idempotencyKey: z.string().min(1).optional(),
  })
  // EXACTLY ONE of list|bucket — XOR. Both-or-neither is a 400.
  .refine((b) => (b.list ? 1 : 0) + (b.bucket ? 1 : 0) === 1, {
    message: "Exactly one of `list` or `bucket` is required",
  });

const createResponseSchema = z.object({
  campaignId: z.string(),
  status: z.string(),
  scheduledAt: z.string().nullable().optional(),
});

export const campaignSchema = z.object({
  id: z.string(),
  name: z.string(),
  status: z.string(),
  audienceKind: z.string(),
  audienceId: z.string(),
  templateKey: z.string(),
  totalRecipients: z.number(),
  sentCount: z.number(),
  skippedCount: z.number(),
  failedCount: z.number(),
  scheduledAt: z.string().nullable(),
  canceledAt: z.string().nullable(),
  startedAt: z.string().nullable(),
  completedAt: z.string().nullable(),
  createdAt: z.string(),
});

type CampaignRow = typeof campaigns.$inferSelect;

export function serializeCampaign(
  campaign: CampaignRow,
): z.infer<typeof campaignSchema> {
  return {
    id: campaign.id,
    name: campaign.name,
    status: campaign.status,
    audienceKind: campaign.audienceKind,
    audienceId: campaign.audienceId,
    templateKey: campaign.templateKey,
    totalRecipients: campaign.totalRecipients,
    sentCount: campaign.sentCount,
    skippedCount: campaign.skippedCount,
    failedCount: campaign.failedCount,
    scheduledAt: campaign.scheduledAt?.toISOString() ?? null,
    canceledAt: campaign.canceledAt?.toISOString() ?? null,
    startedAt: campaign.startedAt?.toISOString() ?? null,
    completedAt: campaign.completedAt?.toISOString() ?? null,
    createdAt: campaign.createdAt.toISOString(),
  };
}

const createRouteDef = createRoute({
  method: "post",
  path: "/",
  tags: ["Campaigns"],
  summary: "Create + enqueue (or schedule) a campaign",
  description:
    "Sends one template to every subscribed member of a list (or every active member of a bucket). Validates the template + audience, inserts the campaign, and either enqueues the durable `send-campaign` task immediately or — when `sendAt` is supplied — schedules it for that instant. Exactly one of `list` or `bucket` is required.",
  request: {
    body: {
      content: {
        "application/json": { schema: createCampaignSchema },
      },
    },
  },
  responses: {
    202: {
      content: {
        "application/json": { schema: createResponseSchema },
      },
      description: "Campaign created and enqueued",
    },
    400: {
      content: { "application/json": { schema: errorSchema } },
      description: "Invalid audience selector or unknown template",
    },
    404: {
      content: { "application/json": { schema: errorSchema } },
      description: "Unknown list or bucket id",
    },
  },
});

const getRouteDef = createRoute({
  method: "get",
  path: "/{id}",
  tags: ["Campaigns"],
  summary: "Get a campaign",
  request: {
    params: z.object({ id: z.string() }),
  },
  responses: {
    200: {
      content: {
        "application/json": { schema: campaignSchema },
      },
      description: "The campaign",
    },
    404: {
      content: { "application/json": { schema: errorSchema } },
      description: "Unknown campaign id",
    },
  },
});

const listRouteDef = createRoute({
  method: "get",
  path: "/",
  tags: ["Campaigns"],
  summary: "List campaigns",
  description:
    "Newest first. Filter with `status` (comma-separated, e.g. `scheduled,sending`).",
  request: {
    query: z.object({
      status: z.string().optional(),
      limit: z.coerce.number().int().min(1).max(200).default(50),
      offset: z.coerce.number().int().min(0).default(0),
    }),
  },
  responses: {
    200: {
      content: {
        "application/json": {
          schema: z.object({
            campaigns: z.array(campaignSchema),
            hasMore: z.boolean(),
          }),
        },
      },
      description: "Campaigns, newest first",
    },
  },
});

const cancelRouteDef = createRoute({
  method: "post",
  path: "/{id}/cancel",
  tags: ["Campaigns"],
  summary: "Cancel a campaign",
  description:
    "Cancels a `scheduled`, `queued`, or `sending` campaign. A mid-send cancel stops the blast at the next chunk boundary — recipients not yet dispatched are spared; already-dispatched sends are not recalled.",
  request: {
    params: z.object({ id: z.string() }),
  },
  responses: {
    200: {
      content: { "application/json": { schema: campaignSchema } },
      description: "The canceled campaign",
    },
    404: {
      content: { "application/json": { schema: errorSchema } },
      description: "Unknown campaign id",
    },
    409: {
      content: { "application/json": { schema: errorSchema } },
      description: "Campaign is in a terminal state and cannot be canceled",
    },
  },
});

// The campaigns router does NOT re-apply auth internally — the data-plane prefix
// guards in `routes/index.ts` (decision #16) apply `requireApiKey` +
// `requireScope("ingest")` to `/v1/campaigns` (bare + `/*`) before requests
// reach this router.
export const campaignsRouter = new OpenAPIHono<AppEnv>()
  .openapi(createRouteDef, async (c) => {
    const { db, templates, listRegistry, bucketRegistry, logger } =
      c.get("container");
    const body = c.req.valid("json");

    // Parse + bound `sendAt` BEFORE any row is written. A stale timestamp is
    // rejected (not "blast right now"); within tolerance it degrades to an
    // immediate send.
    let scheduledAt: Date | null = null;
    if (body.sendAt) {
      const at = new Date(body.sendAt);
      if (at.getTime() < Date.now() - SEND_AT_PAST_TOLERANCE_MS) {
        return c.json({ error: `sendAt is in the past: ${body.sendAt}` }, 400);
      }
      scheduledAt = at;
    }
    const isScheduled =
      scheduledAt !== null && scheduledAt.getTime() > Date.now();

    // Fire the row's trigger: a punctual Hatchet scheduled run for a future
    // `scheduledAt`, else an immediate enqueue (runNoWait — `.run()` would
    // block this request until the whole blast completes). Best-effort,
    // swallowing a transient broker/transport failure: the campaign row is
    // already committed, so a failed dispatch is recovered by the reaper cron
    // (re-enqueue / due-scheduled promotion) rather than 500-ing the request
    // (which a keyless client would retry into a duplicate broadcast).
    const dispatch = async (row: {
      id: string;
      scheduledAt?: Date | null;
    }): Promise<void> => {
      try {
        const at = row.scheduledAt;
        if (at && at.getTime() > Date.now()) {
          await sendCampaignTask.schedule(at, { campaignId: row.id });
        } else {
          await sendCampaignTask.runNoWait({ campaignId: row.id });
        }
      } catch (err) {
        logger.warn(
          "POST /v1/campaigns: dispatch failed (reaper will recover)",
          {
            campaignId: row.id,
            error: err instanceof Error ? err.message : String(err),
          },
        );
      }
    };

    // Validate the template against the wired registry (mirrors /v1/emails).
    if (!getTemplateNames(templates).includes(body.template as TemplateName)) {
      return c.json({ error: `Unknown template: ${body.template}` }, 400);
    }

    // XOR is already enforced by the schema refine, so exactly one is present.
    const audienceKind = body.list ? "list" : "bucket";
    const audienceId = (body.list ?? body.bucket) as string;

    if (audienceKind === "list" && !listRegistry.has(audienceId)) {
      return c.json({ error: `Unknown list: ${audienceId}` }, 404);
    }
    if (audienceKind === "bucket" && !bucketRegistry.has(audienceId)) {
      return c.json({ error: `Unknown bucket: ${audienceId}` }, 404);
    }

    // Idempotency: the `Idempotency-Key` header wins over the body field
    // (mirrors /v1/emails + /v1/events). A retried create with the same key must
    // resolve to the SAME campaign — a fresh row would give the recipients a
    // different per-send idempotency key and double-send the blast.
    const headerKey = c.req.header("idempotency-key");
    const idempotencyKey = headerKey ?? body.idempotencyKey ?? null;

    if (idempotencyKey) {
      const existing = await db
        .select({
          id: campaigns.id,
          status: campaigns.status,
          scheduledAt: campaigns.scheduledAt,
        })
        .from(campaigns)
        .where(eq(campaigns.idempotencyKey, idempotencyKey))
        .limit(1);
      const prior = existing[0];
      if (prior) {
        // Re-dispatch is safe (terminal statuses short-circuit; the per-send
        // key dedups; an early fire of a still-future scheduled row skips), so
        // an idempotent retry both returns the existing campaign AND ensures
        // its trigger exists — covering a first attempt that committed the row
        // but failed to dispatch.
        await dispatch(prior);
        return c.json(
          {
            campaignId: prior.id,
            status: prior.status,
            scheduledAt: prior.scheduledAt?.toISOString() ?? null,
          },
          202,
        );
      }
    }

    const baseInsert = db.insert(campaigns).values({
      name: body.name ?? `Campaign to ${audienceKind} ${audienceId}`,
      status: isScheduled ? "scheduled" : "queued",
      audienceKind,
      audienceId,
      templateKey: body.template,
      props: (body.props ?? {}) as Record<string, unknown>,
      fromEmail: body.from ?? null,
      subject: body.subject ?? null,
      scheduledAt,
      idempotencyKey,
    });

    // With a key, swallow a concurrent-insert collision on the partial-unique
    // index (the select-then-insert above is not atomic) and resolve the winner.
    // The `targetWhere` predicate must match the PARTIAL unique index
    // (`WHERE idempotency_key IS NOT NULL`) or Postgres cannot infer the
    // conflict arbiter (42P10) and the keyed insert fails outright.
    const insertRows = idempotencyKey
      ? await baseInsert
          .onConflictDoNothing({
            target: campaigns.idempotencyKey,
            where: sql`idempotency_key is not null`,
          })
          .returning({ id: campaigns.id })
      : await baseInsert.returning({ id: campaigns.id });

    const campaignId = insertRows[0]?.id;
    if (!campaignId && idempotencyKey) {
      const winner = await db
        .select({
          id: campaigns.id,
          status: campaigns.status,
          scheduledAt: campaigns.scheduledAt,
        })
        .from(campaigns)
        .where(eq(campaigns.idempotencyKey, idempotencyKey))
        .limit(1);
      if (winner[0]) {
        await dispatch(winner[0]);
        return c.json(
          {
            campaignId: winner[0].id,
            status: winner[0].status,
            scheduledAt: winner[0].scheduledAt?.toISOString() ?? null,
          },
          202,
        );
      }
    }
    if (!campaignId) throw new Error("Failed to create campaign");

    // Fire the trigger. The campaign row is already committed, so a transient
    // dispatch failure (broker down) is NON-fatal: we still return 202 and the
    // reaper cron recovers the orphaned row. This keeps the request from
    // 500-ing AFTER a committed row, which a client would otherwise retry into
    // a duplicate (sans idempotency key).
    await dispatch({ id: campaignId, scheduledAt });

    return c.json(
      {
        campaignId,
        status: isScheduled ? "scheduled" : "queued",
        scheduledAt: scheduledAt?.toISOString() ?? null,
      },
      202,
    );
  })
  .openapi(listRouteDef, async (c) => {
    const { db } = c.get("container");
    const { status, limit, offset } = c.req.valid("query");

    const statuses = status
      ?.split(",")
      .map((s) => s.trim())
      .filter(Boolean);

    // Fetch one extra row to derive `hasMore` without a COUNT.
    const rows = await db
      .select()
      .from(campaigns)
      .where(
        statuses && statuses.length > 0
          ? inArray(campaigns.status, statuses)
          : undefined,
      )
      .orderBy(desc(campaigns.createdAt))
      .limit(limit + 1)
      .offset(offset);

    return c.json(
      {
        campaigns: rows.slice(0, limit).map(serializeCampaign),
        hasMore: rows.length > limit,
      },
      200,
    );
  })
  .openapi(getRouteDef, async (c) => {
    const { db } = c.get("container");
    const { id } = c.req.valid("param");

    const rows = await db
      .select()
      .from(campaigns)
      .where(eq(campaigns.id, id))
      .limit(1);
    const campaign = rows[0];
    if (!campaign) {
      return c.json({ error: `Unknown campaign: ${id}` }, 404);
    }

    return c.json(serializeCampaign(campaign), 200);
  })
  .openapi(cancelRouteDef, async (c) => {
    const { db } = c.get("container");
    const { id } = c.req.valid("param");

    // CAS: only a cancelable status transitions, so a concurrent completion
    // (or a second cancel) is never overwritten. The punctual Hatchet
    // scheduled run for a canceled campaign still fires but no-ops on the
    // terminal guard; a `sending` blast stops at its next chunk boundary.
    const canceled = await db
      .update(campaigns)
      .set({
        status: "canceled",
        canceledAt: new Date(),
        updatedAt: new Date(),
      })
      .where(
        and(
          eq(campaigns.id, id),
          inArray(campaigns.status, ["scheduled", "queued", "sending"]),
        ),
      )
      .returning();
    const row = canceled[0];
    if (row) {
      return c.json(serializeCampaign(row), 200);
    }

    const existing = await db
      .select()
      .from(campaigns)
      .where(eq(campaigns.id, id))
      .limit(1);
    if (!existing[0]) {
      return c.json({ error: `Unknown campaign: ${id}` }, 404);
    }
    return c.json(
      {
        error: `Campaign is ${existing[0].status} and cannot be canceled`,
      },
      409,
    );
  });
