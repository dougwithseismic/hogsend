import { ATTRIBUTION_MODELS } from "@hogsend/attribution";
import { createRoute, OpenAPIHono, z } from "@hono/zod-openapi";
import { streamSSE } from "hono/streaming";
import type { AppEnv } from "../../app.js";
import { FLOW_TRANSITIONS_CHANNEL } from "../../lib/flow-live.js";
import { computeFlowMap } from "../../lib/flow-map.js";
import { getRedis } from "../../lib/redis.js";

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
 * `laneBy` (P3) colours the map by acquisition lane (first-touch
 * `campaign.arrived` utm value): edges gain a `lanes` breakdown and the response
 * a top-level `lanes` summary. Omit it and lanes stay off (`edges.lanes` null).
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
      /**
       * Colour the map by acquisition lane — each contact's first-touch
       * `campaign.arrived` utm value. Omit for no lanes (edges.lanes null).
       */
      laneBy: z.enum(["utm_campaign", "utm_source"]).optional(),
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

/**
 * GET /v1/admin/flow/stream — the LIVE layer (P4). An SSE stream of flow
 * transitions over `flow:transitions` (Redis pub/sub via a DEDICATED subscriber
 * connection). Each event pushed through `ingestEvent` that classifies to a
 * node publishes one transition; Studio rides the matching rail with a bright
 * particle. Auth + rate-limit + audit come from the parent `adminRouter`.
 */
const streamRoute = createRoute({
  method: "get",
  path: "/stream",
  tags: ["Admin"],
  summary: "SSE stream of live flow transitions",
  description:
    "Server-Sent Events over `flow:transitions` (Redis pub/sub via a DEDICATED subscriber connection). Emits a `ready` event carrying the current topology node ids (deploy-skew detection), then one `transition` event per classified ingest, plus a `ping` heartbeat every 25s. Closes the subscriber on disconnect.",
  responses: {
    200: { description: "SSE stream" },
  },
});

export const adminFlowRouter = new OpenAPIHono<AppEnv>()
  .openapi(flowRoute, async (c) => {
    const { db, flowTopology } = c.get("container");
    const { windowDays, mode, model, dwellThresholdHours, laneBy } =
      c.req.valid("query");
    const flow = await computeFlowMap({
      db,
      windowDays,
      mode,
      topology: flowTopology,
      model,
      dwellThresholdHours,
      laneBy,
    });
    return c.json(flow, 200);
  })
  .openapi(streamRoute, async (c) => {
    const { flowTopology } = c.get("container");
    // Snapshot the current node ids so Studio can detect deploy-skew (a stream
    // referencing a node the loaded map doesn't carry → refetch).
    const nodeIds = flowTopology.nodes().map((n) => n.id);

    return streamSSE(c, async (stream) => {
      // DEDICATED subscriber connection — NEVER `.subscribe()` on the shared
      // getRedis() singleton (it would poison the rate-limiter/auth/cache).
      const sub = getRedis().duplicate();
      let closed = false;
      const teardown = async () => {
        if (closed) return;
        closed = true;
        try {
          await sub.unsubscribe(FLOW_TRANSITIONS_CHANNEL);
        } catch {
          // best-effort
        }
        // Close the duplicate; no leak.
        sub.disconnect();
      };
      stream.onAbort(() => {
        void teardown();
      });

      sub.on("message", (_ch, msg) => {
        // writeSSE rejects after close — swallow.
        void stream
          .writeSSE({ event: "transition", data: msg })
          .catch(() => {});
      });
      // A dead subscriber must KILL the stream, not leave it pinging: the
      // client's watchdog only sees frames, and a healthy-looking ping loop
      // over a dead subscription would silently deliver nothing forever.
      // Closing lets the client reconnect onto a fresh subscriber.
      sub.on("end", () => {
        void teardown();
      });
      sub.on("error", () => {
        // ioredis retries internally first; "error" alone isn't fatal — but
        // combined with "end" (gave up) the teardown above fires. Swallow to
        // keep an unhandled-error crash out of the stream.
      });

      try {
        await sub.subscribe(FLOW_TRANSITIONS_CHANNEL);
        await stream.writeSSE({
          event: "ready",
          data: JSON.stringify({ nodes: nodeIds }),
        });
        // Keep-alive heartbeat until aborted or torn down (a dead subscriber
        // tears down — see above — so the client reconnects instead of
        // trusting pings from a stream that can no longer deliver).
        while (!stream.aborted && !closed) {
          await stream.sleep(25_000);
          if (stream.aborted || closed) break;
          await stream.writeSSE({ event: "ping", data: "{}" }).catch(() => {});
        }
      } finally {
        await teardown();
      }
    });
  });
