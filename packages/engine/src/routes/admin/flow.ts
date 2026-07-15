import { ATTRIBUTION_MODELS } from "@hogsend/attribution";
import { contacts, journeyStates } from "@hogsend/db";
import { createRoute, OpenAPIHono, z } from "@hono/zod-openapi";
import { and, count, eq, inArray, isNull, or, sql } from "drizzle-orm";
import { streamSSE } from "hono/streaming";
import type { AppEnv } from "../../app.js";
import type { HogsendClient } from "../../container.js";
import {
  type ContactAtNode,
  listRecentContactsAtNode,
  listStuckContacts,
} from "../../lib/flow-dwell.js";
import { FLOW_TRANSITIONS_CHANNEL } from "../../lib/flow-live.js";
import { computeFlowMap } from "../../lib/flow-map.js";
import { journeyIdFromNode } from "../../lib/flow-topology.js";
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

/**
 * A per-currency money list converted into the operator's base currency
 * (#496's FX lens). Mirrors the groups route's `revenueBaseOf` law exactly:
 * null when the lens is off OR any currency present lacks a rate — a partial
 * sum would LIE (display the node as smaller than it is). Empty list with
 * the lens on = 0.
 */
function moneyBaseOf(
  entries: { amount: number; currency: string }[],
  rates: Record<string, number> | null,
): number | null {
  if (!rates) return null;
  let sum = 0;
  for (const entry of entries) {
    const rate = rates[entry.currency];
    if (rate === undefined) return null;
    sum += entry.amount * rate;
  }
  return sum;
}

const flowNodeSchema = z.object({
  id: z.string(),
  kind: z.enum(["surface", "journey", "funnelStage", "builtin"]),
  name: z.string(),
  tier: z.enum(["acquisition", "activation", "retention", "revenue"]),
  /** Surface rendering hint — "source" marks a traffic origin (slim chip). */
  display: z.enum(["source"]).optional(),
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
      /**
       * The same money through the operator's base-currency lens (#496).
       * Null = lens off or a currency lacks a rate (a partial sum would lie).
       */
      attributedRevenueBase: z.number().nullable(),
      directRevenueBase: z.number().nullable(),
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
            /** The operator's base-currency lens (#496); null = lens off. */
            fx: z
              .object({
                baseCurrency: z.string(),
                asOf: z.string().nullable(),
              })
              .nullable(),
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

/**
 * GET /v1/admin/flow/nodes/{nodeId}/contacts — the drill-down (P5). WHO is at a
 * node: the contacts whose last classified event in the window landed here,
 * stuck-first, each with email, last-seen, and hours idle. `stuckOnly=true`
 * narrows to the pile-up (past `dwellThresholdHours`); the default lists
 * everyone currently at the node. Journey nodes also carry the live enrollment
 * breakdown for a deep-link into the journey graph.
 *
 * `{nodeId}` is URL-encoded (node ids carry `:`); Hono decodes it. Registered
 * AFTER the static `/stream` + `/` routes, so no literal path is captured as a
 * param.
 */
const nodeContactSchema = z.object({
  userId: z.string(),
  contactId: z.string().nullable(),
  email: z.string().nullable(),
  lastSeenAt: z.string(),
  hoursIdle: z.number(),
  stuck: z.boolean(),
});

const nodeContactsRoute = createRoute({
  method: "get",
  path: "/nodes/{nodeId}/contacts",
  tags: ["Admin"],
  summary: "Contacts at a flow node (drill-down)",
  request: {
    params: z.object({ nodeId: z.string() }),
    query: z.object({
      // The DWELL lookback (30d default), decoupled from the map's 7d window.
      windowDays: z.coerce.number().int().min(1).max(90).default(30),
      dwellThresholdHours: z.coerce.number().int().min(1).max(720).default(48),
      // Repo idiom for boolean query params (z.coerce.boolean treats "false"
      // as true). Default off — the drill-down lists everyone at the node.
      stuckOnly: z.enum(["true", "false"]).default("false"),
      limit: z.coerce.number().int().min(1).max(200).default(50),
    }),
  },
  responses: {
    200: {
      content: {
        "application/json": {
          schema: z.object({
            node: z.object({
              id: z.string(),
              kind: z.enum(["surface", "journey", "funnelStage", "builtin"]),
              name: z.string(),
              tier: z.enum([
                "acquisition",
                "activation",
                "retention",
                "revenue",
              ]),
            }),
            contacts: z.array(nodeContactSchema),
            /** Enrollment breakdown for journey nodes; null otherwise. */
            journey: z
              .object({
                journeyId: z.string(),
                counts: z.object({
                  active: z.number(),
                  waiting: z.number(),
                  completed: z.number(),
                  failed: z.number(),
                  exited: z.number(),
                }),
              })
              .nullable(),
            meta: z.object({
              windowDays: z.number(),
              dwellThresholdHours: z.number(),
              stuckOnly: z.boolean(),
              limit: z.number(),
            }),
          }),
        },
      },
      description: "The contacts at this node, plus (for journeys) live counts",
    },
    404: {
      content: {
        "application/json": { schema: z.object({ error: z.string() }) },
      },
      description: "No such node in the current topology",
    },
  },
});

/** The five journey-state statuses the drill-down reports (held_out excluded). */
type JourneyCounts = {
  active: number;
  waiting: number;
  completed: number;
  failed: number;
  exited: number;
};

/**
 * Resolve each canonical user key to its live contact, batched — the same
 * precedence the events route's lateral encodes (external_id ?? anonymous_id ??
 * id), applied in JS so one OR-join can't fan a key out across the mis-keyed
 * contacts it happens to match. Highest-precedence match per key wins.
 */
async function resolveContacts(
  db: HogsendClient["db"],
  userIds: string[],
): Promise<Map<string, { id: string; email: string | null }>> {
  const best = new Map<
    string,
    { id: string; email: string | null; pref: number }
  >();
  if (userIds.length === 0) return new Map();

  const rows = await db
    .select({
      id: contacts.id,
      email: contacts.email,
      externalId: contacts.externalId,
      anonymousId: contacts.anonymousId,
    })
    .from(contacts)
    .where(
      and(
        or(
          inArray(contacts.externalId, userIds),
          inArray(contacts.anonymousId, userIds),
          inArray(sql`${contacts.id}::text`, userIds),
        ),
        isNull(contacts.deletedAt),
      ),
    );

  const consider = (
    key: string | null,
    pref: number,
    id: string,
    email: string | null,
  ) => {
    if (key === null) return;
    const cur = best.get(key);
    if (!cur || pref < cur.pref) best.set(key, { id, email, pref });
  };
  for (const row of rows) {
    consider(row.externalId, 0, row.id, row.email);
    consider(row.anonymousId, 1, row.id, row.email);
    consider(row.id, 2, row.id, row.email);
  }

  return new Map(
    [...best].map(([key, v]) => [key, { id: v.id, email: v.email }]),
  );
}

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
    // Base-currency decoration is PRESENTATION, applied per request over the
    // memoized map (never mutating it): the FX lens resolves per call, so a
    // base changed in Studio settings takes effect on the next poll while the
    // 5s memo keeps collapsing concurrent viewers.
    const fxSheet = await c.get("container").fx.getRatesToBase();
    const rates = fxSheet?.rates ?? null;
    return c.json(
      {
        ...flow,
        nodes: flow.nodes.map((node) => ({
          ...node,
          heat: node.heat
            ? {
                ...node.heat,
                attributedRevenueBase: moneyBaseOf(
                  node.heat.attributedRevenue,
                  rates,
                ),
                directRevenueBase: moneyBaseOf(node.heat.directRevenue, rates),
              }
            : null,
        })),
        fx: fxSheet
          ? { baseCurrency: fxSheet.baseCurrency, asOf: fxSheet.asOf }
          : null,
      },
      200,
    );
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
  })
  .openapi(nodeContactsRoute, async (c) => {
    const { db, flowTopology } = c.get("container");
    const { nodeId } = c.req.valid("param");
    const { windowDays, dwellThresholdHours, stuckOnly, limit } =
      c.req.valid("query");

    const node = flowTopology.node(nodeId);
    if (!node) {
      return c.json(
        {
          error: `No flow node "${nodeId}" in the current topology — it may have been renamed or its journey/funnel/surface deregistered.`,
        },
        404,
      );
    }

    const onlyStuck = stuckOnly === "true";
    // The lookback floors EXACTLY like the map's dwell computation
    // (flow-map.ts): dwell answers "who is here NOW", not "who moved in the
    // display window". Without the floor, clicking a card's "N stuck" badge
    // (computed over ≥30d) with a 1- or 7-day display window opens a panel
    // whose narrower scan can't see the very contacts the badge counted.
    const lookbackDays = Math.max(
      30,
      windowDays,
      Math.ceil(dwellThresholdHours / 24) + 1,
    );
    // Stuck path reuses the pile-up query with the conversion-destination
    // exclusion turned OFF: the operator explicitly asked about THIS node, so a
    // won stage's occupants are shown (the default exclusion is a ranking policy
    // for the aggregate map, not an access rule).
    const rows: ContactAtNode[] = onlyStuck
      ? (
          await listStuckContacts({
            db,
            topology: flowTopology,
            nodeId,
            windowDays: lookbackDays,
            thresholdHours: dwellThresholdHours,
            limit,
            excludeNodeIds: [],
          })
        ).map((s) => ({
          userId: s.userId,
          lastSeenAt: s.lastSeenAt,
          hoursIdle: s.hoursStuck,
          stuck: true,
        }))
      : await listRecentContactsAtNode({
          db,
          topology: flowTopology,
          nodeId,
          windowDays: lookbackDays,
          thresholdHours: dwellThresholdHours,
          limit,
        });

    const contactByKey = await resolveContacts(
      db,
      rows.map((r) => r.userId),
    );

    // Journey nodes carry the live enrollment breakdown (one grouped query,
    // live rows only). held_out is deliberately not surfaced here.
    const journeyId = journeyIdFromNode(nodeId);
    let journey: { journeyId: string; counts: JourneyCounts } | null = null;
    if (node.kind === "journey" && journeyId !== undefined) {
      const grouped = await db
        .select({ status: journeyStates.status, n: count() })
        .from(journeyStates)
        .where(
          and(
            eq(journeyStates.journeyId, journeyId),
            isNull(journeyStates.deletedAt),
          ),
        )
        .groupBy(journeyStates.status);
      const counts: JourneyCounts = {
        active: 0,
        waiting: 0,
        completed: 0,
        failed: 0,
        exited: 0,
      };
      for (const row of grouped) {
        if (Object.hasOwn(counts, row.status)) {
          counts[row.status as keyof JourneyCounts] = Number(row.n);
        }
      }
      journey = { journeyId, counts };
    }

    return c.json(
      {
        node: {
          id: node.id,
          kind: node.kind,
          name: node.name,
          tier: node.tier,
        },
        contacts: rows.map((r) => {
          const contact = contactByKey.get(r.userId);
          return {
            userId: r.userId,
            contactId: contact?.id ?? null,
            email: contact?.email ?? null,
            lastSeenAt: r.lastSeenAt.toISOString(),
            hoursIdle: r.hoursIdle,
            stuck: r.stuck,
          };
        }),
        journey,
        meta: {
          windowDays,
          dwellThresholdHours,
          stuckOnly: onlyStuck,
          limit,
        },
      },
      200,
    );
  });
