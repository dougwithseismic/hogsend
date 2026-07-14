import { createRoute, OpenAPIHono, z } from "@hono/zod-openapi";
import type { AppEnv } from "../../app.js";
import { computeFlowMap } from "../../lib/flow-map.js";

/**
 * GET /v1/admin/flow — the control room's flow map: how contacts actually
 * moved through the product in a window, as nodes + edges.
 *
 * P1 serves raw mode (nodes = top event-name prefixes). The `live`, `heat`,
 * `dwell` and `lanes` fields are declared nullable and returned null: the
 * response contract is pinned here so Studio can render against the final
 * shape while later phases fill them in.
 */

const flowMoneySchema = z.object({
  amount: z.number(),
  currency: z.string(),
});

const flowNodeSchema = z.object({
  id: z.string(),
  kind: z.enum(["surface", "journey", "funnelStage", "builtin"]),
  name: z.string(),
  tier: z.enum(["acquisition", "activation", "retention", "revenue"]),
  contacts: z.number(),
  events: z.number(),
  /** P4 — contacts currently here. */
  live: z.number().nullable(),
  /** P2 — conversion + revenue overlay (attributed and direct stay separate). */
  heat: z
    .object({
      conversionRate: z.number().nullable(),
      attributedRevenue: z.array(flowMoneySchema),
      directRevenue: z.array(flowMoneySchema),
    })
    .nullable(),
  /** P2 — pile-up: contacts idle here past the threshold. */
  dwell: z
    .object({
      stuckContacts: z.number(),
      thresholdHours: z.number(),
      oldestLastSeenAt: z.string().nullable(),
      p50HoursStuck: z.number().nullable(),
    })
    .nullable(),
});

const flowEdgeSchema = z.object({
  from: z.string(),
  to: z.string(),
  transitions: z.number(),
  contacts: z.number(),
  /** P3 — lane → transition count (top lanes + `__other`). */
  lanes: z.record(z.string(), z.number()).nullable(),
});

const flowRoute = createRoute({
  method: "get",
  path: "/",
  tags: ["Admin"],
  summary: "Flow map — contact movement through the product",
  request: {
    query: z.object({
      windowDays: z.coerce.number().int().min(1).max(90).default(7),
      /**
       * P1 always computes `raw`; `curated` is accepted so clients can pin the
       * param now — P2 wires the registry-backed classifier behind it.
       */
      mode: z.enum(["curated", "raw"]).default("raw"),
    }),
  },
  responses: {
    200: {
      content: {
        "application/json": {
          schema: z.object({
            window: z.object({
              days: z.number(),
              from: z.string(),
              to: z.string(),
            }),
            nodes: z.array(flowNodeSchema),
            edges: z.array(flowEdgeSchema),
            /** P3 — lanes seen in the window, with contact counts. */
            lanes: z.array(z.object({ id: z.string(), count: z.number() })),
            meta: z.object({
              truncated: z.boolean(),
              effectiveWindowDays: z.number(),
              generatedAt: z.string(),
            }),
          }),
        },
      },
      description: "Nodes + edges for the window",
    },
  },
});

export const adminFlowRouter = new OpenAPIHono<AppEnv>().openapi(
  flowRoute,
  async (c) => {
    const { db } = c.get("container");
    const { windowDays, mode } = c.req.valid("query");
    const flow = await computeFlowMap({ db, windowDays, mode });
    return c.json(flow, 200);
  },
);
