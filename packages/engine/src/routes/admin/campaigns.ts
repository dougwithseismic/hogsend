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
import {
  and,
  count,
  desc,
  eq,
  inArray,
  like,
  max,
  type SQL,
  sql,
} from "drizzle-orm";
import type { AppEnv } from "../../app.js";
import { campaignStepSendKeyPattern } from "../../lib/campaign-send-key.js";
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
 * steps) plus the same engagement aggregate as the campaign level. The step
 * number only lives in the `campaign:<id>:<step>:%` idempotency-key format,
 * so step rows anchor on that pattern (scoped to the campaign_id FK first) —
 * which also means suppressed sends (no key) can never attribute to a step,
 * so step rows carry no `skipped` (it lives at the campaign level only).
 * Wait steps deliver nothing, so their counts are zeroed.
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
 * rows the blast wrote — attributed via the indexed `campaign_id` column
 * (stamped at send time, backfilled from legacy idempotency keys by migration
 * 0051), NOT by parsing the key: suppressed sends write no key at all, so a
 * key scan can never see them. Complements the counters on the campaign row
 * itself: the row knows sent/skipped/failed at dispatch time, this knows what
 * happened to the mail AFTERWARDS (delivered/opened/clicked/bounced/complained
 * via first-party tracking + provider webhooks) plus the policy-suppressed
 * rows (status `suppressed`) as `skipped`. Multi-step campaigns additionally
 * carry `steps` — one entry per step, in step order (the campaign-level
 * numbers are a superset of every step's).
 */
const campaignStatsSchema = z.object({
  sends: z.number(),
  delivered: z.number(),
  opened: z.number(),
  clicked: z.number(),
  bounced: z.number(),
  complained: z.number(),
  failed: z.number(),
  skipped: z.number(),
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
    // doubles as its own tally. Attribution is the indexed `campaign_id`
    // column (stamped on every campaign row including suppressed sends;
    // legacy rows backfilled by migration 0051). The status column carries
    // the dispatch verdict: policy-gated rows are `suppressed` (the `skipped`
    // bucket), everything else was a dispatch attempt (`sends`), and `failed`
    // means failed AT dispatch — a provider failure releases its idempotency
    // key, so key-nullness deliberately plays no part here. Shared by the
    // campaign-level aggregate and the per-step breakdown.
    const aggregate = async (where: SQL | undefined) => {
      const agg = (
        await db
          .select({
            sends:
              sql<number>`count(*) filter (where ${emailSends.status} <> 'suppressed')`.mapWith(
                Number,
              ),
            delivered: count(emailSends.deliveredAt),
            opened: count(emailSends.openedAt),
            clicked: count(emailSends.clickedAt),
            bounced: count(emailSends.bouncedAt),
            complained: count(emailSends.complainedAt),
            failed:
              sql<number>`count(*) filter (where ${emailSends.status} = 'failed')`.mapWith(
                Number,
              ),
            skipped:
              sql<number>`count(*) filter (where ${emailSends.status} = 'suppressed')`.mapWith(
                Number,
              ),
            lastSentAt: max(emailSends.sentAt),
          })
          .from(emailSends)
          .where(where)
      )[0];
      return {
        sends: agg?.sends ?? 0,
        delivered: agg?.delivered ?? 0,
        opened: agg?.opened ?? 0,
        clicked: agg?.clicked ?? 0,
        bounced: agg?.bounced ?? 0,
        complained: agg?.complained ?? 0,
        failed: agg?.failed ?? 0,
        skipped: agg?.skipped ?? 0,
        lastSentAt: agg?.lastSentAt ? agg.lastSentAt.toISOString() : null,
      };
    };

    // Campaign-level: the FK matches every row of both key formats AND the
    // keyless suppressed rows, so these numbers are format-agnostic and
    // unchanged for legacy single-send rows.
    const campaignLevel = await aggregate(eq(emailSends.campaignId, id));

    // Per-step breakdown, only when the row carries a steps blob (NULL =
    // legacy single-send — no `steps` in the response). The step number only
    // exists inside the key, so send-step aggregates still filter on the
    // step-scoped pattern (`campaign:<id>:<k>:%` — multi-step campaigns key
    // ALL steps including 0 that way), anchored on the indexed FK first; wait
    // steps deliver nothing. The step queries are independent, so they run
    // concurrently.
    const blob = row.steps;
    if (!blob) {
      return c.json(campaignLevel, 200);
    }

    // db cannot import @hogsend/core, so the blob's elements are opaque
    // Record<string, unknown> there; the engine owns the narrowing.
    const defs = blob.steps as unknown as CampaignStep[];
    const steps: z.infer<typeof campaignStepStatsSchema>[] = await Promise.all(
      defs.map(async (step, index) => {
        if (step.kind === "send") {
          // Suppressed rows write no key, so they can never match the
          // step-scoped pattern — the always-zero `skipped` is dropped from
          // step rows rather than reported as a dead field.
          const { skipped: _campaignOnly, ...stepStats } = await aggregate(
            and(
              eq(emailSends.campaignId, id),
              like(
                emailSends.idempotencyKey,
                campaignStepSendKeyPattern(id, index),
              ),
            ),
          );
          return {
            index,
            kind: step.kind,
            templateKey: step.template,
            durationMs: null,
            ...stepStats,
          };
        }
        return {
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
        };
      }),
    );

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
