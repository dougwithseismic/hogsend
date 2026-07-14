import { ATTRIBUTION_MODELS } from "@hogsend/attribution";
import { createRoute, OpenAPIHono, z } from "@hono/zod-openapi";
import type { AppEnv } from "../../app.js";
import { computeFlowMap } from "../../lib/flow-map.js";

/**
 * GET /v1/admin/flow — the control room's flow map: how contacts actually
 * moved through the product in a window, as nodes + edges.
 *
 * `mode=curated` (default) classifies events through the registry-backed
 * topology: journeys, funnel stages, the builtin revenue node — each carrying
 * heat (conversion + revenue) and dwell (the pile-up), and journeys carrying a
 * live enrollment count. `mode=raw` is the escape hatch: top event-name
 * prefixes, no registry, `heat`/`dwell`/`live` null.
 *
 * `lanes` stays declared-and-empty until P3.
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
  /** Contacts currently here (journey enrollments); null in raw mode. */
  live: z.number().nullable(),
  /** Conversion + revenue overlay (attributed and direct stay separate). */
  heat: z
    .object({
      conversionRate: z.number().nullable(),
      attributedRevenue: z.array(flowMoneySchema),
      directRevenue: z.array(flowMoneySchema),
    })
    .nullable(),
  /** Pile-up: contacts idle here past the threshold. */
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
      /** Registry-backed nodes + heat + dwell; `raw` is the prefix fallback. */
      mode: z.enum(["curated", "raw"]).default("curated"),
      /** Attribution model behind `heat.attributedRevenue`. */
      model: z.enum(ATTRIBUTION_MODELS).default("linear"),
      /** Idle hours before a contact counts as stuck on a node. */
      dwellThresholdHours: z.coerce.number().int().min(1).max(720).default(48),
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
    const { db, flowTopology } = c.get("container");
    const { windowDays, mode, model, dwellThresholdHours } =
      c.req.valid("query");
    const flow = await computeFlowMap({
      db,
      windowDays,
      mode,
      topology: flowTopology,
      model,
      dwellThresholdHours,
    });
    return c.json(flow, 200);
  },
);
