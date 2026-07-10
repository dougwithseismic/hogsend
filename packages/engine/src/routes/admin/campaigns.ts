/**
 * Admin-plane campaigns routes for Studio (session-cookie auth via the parent
 * adminRouter's `requireAdmin`; Studio cannot use the hsk_-keyed data-plane
 * routes). Observe + cancel only — campaigns are AUTHORED in code
 * (`defineCampaign()`) or via the data-plane `POST /v1/campaigns`, never from
 * Studio. The list/get/cancel semantics mirror `routes/campaigns/index.ts`
 * exactly (same serializer, same cancel CAS).
 */
import { type CampaignStep, durationToMs } from "@hogsend/core";
import { campaigns, emailSends } from "@hogsend/db";
import { createRoute, OpenAPIHono, z } from "@hono/zod-openapi";
import { and, count, desc, eq, inArray, like, max, sql } from "drizzle-orm";
import type { AppEnv } from "../../app.js";
import {
  campaignSendKeyPattern,
  campaignStepSendKeyPattern,
} from "../../lib/campaign-send-key.js";
import { errorSchema } from "../../lib/schemas.js";
import { campaignSchema, serializeCampaign } from "../campaigns/index.js";

const listRouteDef = createRoute({
  method: "get",
  path: "/",
  tags: ["Admin"],
  summary: "List campaigns (Studio)",
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

const getRouteDef = createRoute({
  method: "get",
  path: "/{id}",
  tags: ["Admin"],
  summary: "Get a campaign (Studio)",
  request: {
    params: z.object({ id: z.string() }),
  },
  responses: {
    200: {
      content: { "application/json": { schema: campaignSchema } },
      description: "The campaign",
    },
    404: {
      content: { "application/json": { schema: errorSchema } },
      description: "Unknown campaign id",
    },
  },
});

/**
 * One row of the per-step breakdown for a multi-step campaign: the step's
 * identity (`kind` + `templateKey` for send steps, `durationMs` for wait
 * steps) plus the same engagement aggregate as the campaign level, scoped to
 * the step's `campaign:<id>:<step>:%` idempotency-key pattern. Wait steps
 * deliver nothing, so their counts are zeroed.
 */
const campaignStepStatsSchema = z.object({
  index: z.number(),
  kind: z.string(),
  templateKey: z.string().nullable(),
  durationMs: z.number().nullable(),
  sends: z.number(),
  delivered: z.number(),
  opened: z.number(),
  clicked: z.number(),
  bounced: z.number(),
  complained: z.number(),
  failed: z.number(),
  lastSentAt: z.string().nullable(),
});

/**
 * Post-dispatch engagement for one campaign, aggregated from the `email_sends`
 * rows the blast wrote (attributed via the `campaign:<id>:…` idempotency
 * key — there is no campaign FK on email_sends). Complements the counters on
 * the campaign row itself: the row knows sent/skipped/failed at dispatch time,
 * this knows what happened to the mail AFTERWARDS (delivered/opened/clicked/
 * bounced/complained via first-party tracking + provider webhooks). Multi-step
 * campaigns additionally carry `steps` — one entry per step, in step order
 * (the campaign-level numbers are a superset of every step's).
 */
const campaignStatsSchema = z.object({
  sends: z.number(),
  delivered: z.number(),
  opened: z.number(),
  clicked: z.number(),
  bounced: z.number(),
  complained: z.number(),
  failed: z.number(),
  lastSentAt: z.string().nullable(),
  steps: z.array(campaignStepStatsSchema).optional(),
});

const statsRouteDef = createRoute({
  method: "get",
  path: "/{id}/stats",
  tags: ["Admin"],
  summary: "Get a campaign's delivery + engagement stats (Studio)",
  request: {
    params: z.object({ id: z.string() }),
  },
  responses: {
    200: {
      content: { "application/json": { schema: campaignStatsSchema } },
      description:
        "Engagement aggregated from the campaign's email sends, plus a per-step breakdown for multi-step campaigns",
    },
    404: {
      content: { "application/json": { schema: errorSchema } },
      description: "Unknown campaign id",
    },
  },
});

const cancelRouteDef = createRoute({
  method: "post",
  path: "/{id}/cancel",
  tags: ["Admin"],
  summary: "Cancel a campaign (Studio)",
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

export const adminCampaignsRouter = new OpenAPIHono<AppEnv>()
  .openapi(listRouteDef, async (c) => {
    const { db } = c.get("container");
    const { status, limit, offset } = c.req.valid("query");

    const statuses = status
      ?.split(",")
      .map((s) => s.trim())
      .filter(Boolean);

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
    if (!rows[0]) {
      return c.json({ error: `Unknown campaign: ${id}` }, 404);
    }
    return c.json(serializeCampaign(rows[0]), 200);
  })
  .openapi(statsRouteDef, async (c) => {
    const { db } = c.get("container");
    const { id } = c.req.valid("param");

    const rows = await db
      .select({ id: campaigns.id, steps: campaigns.steps })
      .from(campaigns)
      .where(eq(campaigns.id, id))
      .limit(1);
    const row = rows[0];
    if (!row) {
      return c.json({ error: `Unknown campaign: ${id}` }, 404);
    }

    // count(column) counts non-NULL values, so each engagement timestamp
    // doubles as its own tally. No campaign FK on email_sends — the LIKE on the
    // deterministic idempotency key is the attribution (admin-plane traffic, so
    // the prefix scan is acceptable without a dedicated index). Shared by the
    // campaign-level aggregate and the per-step breakdown.
    const aggregate = async (pattern: string) => {
      const agg = (
        await db
          .select({
            sends: count(),
            delivered: count(emailSends.deliveredAt),
            opened: count(emailSends.openedAt),
            clicked: count(emailSends.clickedAt),
            bounced: count(emailSends.bouncedAt),
            complained: count(emailSends.complainedAt),
            failed:
              sql<number>`count(*) filter (where ${emailSends.status} = 'failed')`.mapWith(
                Number,
              ),
            lastSentAt: max(emailSends.sentAt),
          })
          .from(emailSends)
          .where(like(emailSends.idempotencyKey, pattern))
      )[0];
      return {
        sends: agg?.sends ?? 0,
        delivered: agg?.delivered ?? 0,
        opened: agg?.opened ?? 0,
        clicked: agg?.clicked ?? 0,
        bounced: agg?.bounced ?? 0,
        complained: agg?.complained ?? 0,
        failed: agg?.failed ?? 0,
        lastSentAt: agg?.lastSentAt ? agg.lastSentAt.toISOString() : null,
      };
    };

    // The campaign-level pattern (`campaign:<id>:%`) is a superset of both
    // key formats, so these numbers are format-agnostic and unchanged for
    // legacy single-send rows.
    const campaignLevel = await aggregate(campaignSendKeyPattern(id));

    // Per-step breakdown, only when the row carries a steps blob (NULL =
    // legacy single-send — no `steps` in the response). Send-step aggregates
    // filter on the step-scoped pattern (`campaign:<id>:<k>:%` — multi-step
    // campaigns key ALL steps including 0 that way); wait steps deliver
    // nothing. One query per step is fine at the ≤10-step cap on the
    // admin plane.
    const blob = row.steps;
    if (!blob) {
      return c.json(campaignLevel, 200);
    }

    // db cannot import @hogsend/core, so the blob's elements are opaque
    // Record<string, unknown> there; the engine owns the narrowing.
    const defs = blob.steps as unknown as CampaignStep[];
    const steps: z.infer<typeof campaignStepStatsSchema>[] = [];
    for (const [index, step] of defs.entries()) {
      if (step.kind === "send") {
        steps.push({
          index,
          kind: step.kind,
          templateKey: step.template,
          durationMs: null,
          ...(await aggregate(campaignStepSendKeyPattern(id, index))),
        });
      } else {
        steps.push({
          index,
          kind: step.kind,
          templateKey: null,
          durationMs: durationToMs(step.duration),
          sends: 0,
          delivered: 0,
          opened: 0,
          clicked: 0,
          bounced: 0,
          complained: 0,
          failed: 0,
          lastSentAt: null,
        });
      }
    }

    return c.json({ ...campaignLevel, steps }, 200);
  })
  .openapi(cancelRouteDef, async (c) => {
    const { db } = c.get("container");
    const { id } = c.req.valid("param");

    // CAS mirroring the data-plane cancel exactly — allowed from
    // scheduled/queued/sending/waiting.
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
          inArray(campaigns.status, [
            "scheduled",
            "queued",
            "sending",
            "waiting",
          ]),
        ),
      )
      .returning();
    if (canceled[0]) {
      return c.json(serializeCampaign(canceled[0]), 200);
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
      { error: `Campaign is ${existing[0].status} and cannot be canceled` },
      409,
    );
  });
