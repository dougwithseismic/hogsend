import { campaigns } from "@hogsend/db";
import { getTemplateNames, type TemplateName } from "@hogsend/email";
import { createRoute, OpenAPIHono, z } from "@hono/zod-openapi";
import { eq } from "drizzle-orm";
import type { AppEnv } from "../../app.js";
import { errorSchema } from "../../lib/schemas.js";
import { sendCampaignTask } from "../../workflows/send-campaign.js";

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
});

const campaignSchema = z.object({
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
  startedAt: z.string().nullable(),
  completedAt: z.string().nullable(),
  createdAt: z.string(),
});

const createRouteDef = createRoute({
  method: "post",
  path: "/",
  tags: ["Campaigns"],
  summary: "Create + enqueue a campaign",
  description:
    "Sends one template to every subscribed member of a list (or every active member of a bucket). Validates the template + audience, inserts a `queued` campaign, and enqueues the durable `send-campaign` task. Exactly one of `list` or `bucket` is required.",
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

// The campaigns router does NOT re-apply auth internally — the data-plane prefix
// guards in `routes/index.ts` (decision #16) apply `requireApiKey` +
// `requireScope("ingest")` to `/v1/campaigns` (bare + `/*`) before requests
// reach this router.
export const campaignsRouter = new OpenAPIHono<AppEnv>()
  .openapi(createRouteDef, async (c) => {
    const { db, templates, listRegistry, bucketRegistry, logger } =
      c.get("container");
    const body = c.req.valid("json");

    // Enqueue the durable send task, swallowing a transient broker/transport
    // failure: the campaign row is already committed in `queued`, so a failed
    // enqueue is recovered by the reaper cron re-enqueueing the orphan rather
    // than 500-ing the request (which a keyless client would retry into a
    // duplicate broadcast).
    const enqueue = async (campaignId: string): Promise<void> => {
      try {
        await sendCampaignTask.run({ campaignId });
      } catch (err) {
        logger.warn("POST /v1/campaigns: enqueue failed (reaper will retry)", {
          campaignId,
          error: err instanceof Error ? err.message : String(err),
        });
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
        .select({ id: campaigns.id, status: campaigns.status })
        .from(campaigns)
        .where(eq(campaigns.idempotencyKey, idempotencyKey))
        .limit(1);
      const prior = existing[0];
      if (prior) {
        // Re-enqueue is safe (terminal-`sent` short-circuits; the per-send key
        // dedups), so an idempotent retry both returns the existing campaign AND
        // ensures it is running — covering a first attempt that committed the
        // row but failed to enqueue.
        await enqueue(prior.id);
        return c.json({ campaignId: prior.id, status: prior.status }, 202);
      }
    }

    const baseInsert = db.insert(campaigns).values({
      name: body.name ?? `Campaign to ${audienceKind} ${audienceId}`,
      status: "queued",
      audienceKind,
      audienceId,
      templateKey: body.template,
      props: (body.props ?? {}) as Record<string, unknown>,
      fromEmail: body.from ?? null,
      subject: body.subject ?? null,
      idempotencyKey,
    });

    // With a key, swallow a concurrent-insert collision on the partial-unique
    // index (the select-then-insert above is not atomic) and resolve the winner.
    const insertRows = idempotencyKey
      ? await baseInsert
          .onConflictDoNothing({ target: campaigns.idempotencyKey })
          .returning({ id: campaigns.id })
      : await baseInsert.returning({ id: campaigns.id });

    const campaignId = insertRows[0]?.id;
    if (!campaignId && idempotencyKey) {
      const winner = await db
        .select({ id: campaigns.id, status: campaigns.status })
        .from(campaigns)
        .where(eq(campaigns.idempotencyKey, idempotencyKey))
        .limit(1);
      if (winner[0]) {
        await enqueue(winner[0].id);
        return c.json(
          { campaignId: winner[0].id, status: winner[0].status },
          202,
        );
      }
    }
    if (!campaignId) throw new Error("Failed to create campaign");

    // Enqueue the durable task. The campaign row is already committed in
    // `queued`, so a transient enqueue failure (broker down) is NON-fatal: we
    // still return 202 and the reaper cron re-enqueues the orphaned `queued`
    // row. This keeps the request from 500-ing AFTER a committed row, which a
    // client would otherwise retry into a duplicate (sans idempotency key).
    await enqueue(campaignId);

    return c.json({ campaignId, status: "queued" }, 202);
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

    return c.json(
      {
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
        startedAt: campaign.startedAt ? campaign.startedAt.toISOString() : null,
        completedAt: campaign.completedAt
          ? campaign.completedAt.toISOString()
          : null,
        createdAt: campaign.createdAt.toISOString(),
      },
      200,
    );
  });
