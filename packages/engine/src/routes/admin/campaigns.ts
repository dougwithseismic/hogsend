/**
 * Admin-plane campaigns routes for Studio (session-cookie auth via the parent
 * adminRouter's `requireAdmin`; Studio cannot use the hsk_-keyed data-plane
 * routes). Observe + cancel only — campaigns are AUTHORED in code
 * (`defineCampaign()`) or via the data-plane `POST /v1/campaigns`, never from
 * Studio. The list/get/cancel semantics mirror `routes/campaigns/index.ts`
 * exactly (same serializer, same cancel CAS).
 */
import { campaigns } from "@hogsend/db";
import { createRoute, OpenAPIHono, z } from "@hono/zod-openapi";
import { and, desc, eq, inArray } from "drizzle-orm";
import type { AppEnv } from "../../app.js";
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
  .openapi(cancelRouteDef, async (c) => {
    const { db } = c.get("container");
    const { id } = c.req.valid("param");

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
