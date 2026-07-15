/**
 * The flow map — `user_events` projected into a node/edge graph of how
 * contacts actually move through the product (the data behind Studio's
 * control room, `GET /v1/admin/flow`).
 *
 * Two classifiers over ONE projection:
 * - `mode: "curated"` (the default) — nodes come from the registries via
 *   {@link FlowTopology}: every journey, every funnel stage, the builtin
 *   `revenue` node. A registered node with no traffic still renders (zeroed),
 *   because "nobody is in this journey" is itself the answer.
 * - `mode: "raw"` — the escape hatch: nodes are the top event-name prefixes in
 *   the window (`docs.opened` → `docs`). No registry, no heat, no dwell. Useful
 *   when nothing is registered yet, or to see traffic the topology drops.
 *
 * Design notes that matter:
 * - ONE SQL statement for the projection, every value bound (never interpolated).
 * - The transition sequence is computed AFTER unmapped events are dropped, so
 *   A → (noise) → B still reads as A → B.
 * - Consecutive events on the same node collapse (`prev <> node_id`), so a
 *   contact reading three docs pages is one `docs` node, not a self-loop.
 * - Curated mode costs three window scans (projection, heat, dwell) plus one
 *   indexed `journey_states` group-by. They run concurrently, and the 5s memo
 *   means N pollers cost one round.
 */
import type { AttributionModel } from "@hogsend/attribution";
import { type Database, journeyStates } from "@hogsend/db";
import { and, count, inArray, isNull, sql } from "drizzle-orm";
import { computeNodeDwell } from "./flow-dwell.js";
import {
  type FlowNode,
  type FlowTopology,
  journeyIdFromNode,
  journeyNodeId,
} from "./flow-topology.js";

/**
 * Above this many events in the window we halve the window rather than scan
 * (the projection is a full window scan — a year of a busy install is not a
 * request-time query). Reported honestly via `meta.truncated`. Two honest
 * limits: the halving floor is 1 day, so an install writing >2M rows/day
 * still scans them all; and at the cap the doubly-referenced `win` CTE
 * materializes (~hundreds of MB past work_mem → temp files) — and with
 * `laneBy` set, `seq` becomes doubly-referenced too (edge_rows + edge_lane_raw)
 * and materializes as a SECOND temp-file CTE. Installs at that scale get a
 * Timescale continuous aggregate — the named follow-up, not a request-time fix.
 */
const FLOW_ROW_CAP = 2_000_000;

/** Raw mode keeps the map legible: the N loudest prefixes, everything else is dropped. */
const RAW_TOP_PREFIXES = 15;

/** Poll-collapsing memo — the map moves on a 30s Studio poll, not per request. */
const FLOW_CACHE_TTL_MS = 5_000;

/** Attribution model used for `heat.attributedRevenue` unless the caller picks one. */
const DEFAULT_ATTRIBUTION_MODEL: AttributionModel = "linear";

/** Idle time before a contact counts as stuck on a node. */
const DEFAULT_DWELL_THRESHOLD_HOURS = 48;

export type FlowMapMode = "curated" | "raw";

/** Acquisition-lane dimension (first-touch `campaign.arrived` utm value). */
export type FlowLaneBy = "utm_campaign" | "utm_source";

export interface FlowMapOptions {
  db: Database;
  windowDays: number;
  mode: FlowMapMode;
  /** Required for `curated` — without it the map falls back to raw. */
  topology?: FlowTopology;
  /** Attribution model behind `heat.attributedRevenue`. Default `linear`. */
  model?: AttributionModel;
  /** Idle hours before a contact is "stuck" on a node. Default 48. */
  dwellThresholdHours?: number;
  /**
   * Colour the map by acquisition lane — each contact's FIRST-touch
   * `campaign.arrived` utm value (contacts with none = `organic`). Undefined =
   * lanes off (zero extra cost; `edges.lanes` null, `lanes` []).
   */
  laneBy?: FlowLaneBy;
}

/** An amount in one currency — amounts in different currencies NEVER sum. */
export interface FlowMoney {
  amount: number;
  currency: string;
}

/**
 * Per-node conversion + revenue overlay. `attributedRevenue` comes from the
 * attribution ledger (this node's share of conversions it touched);
 * `directRevenue` is the sum of valued events AT the node. They answer
 * different questions and are never added together.
 */
export interface FlowNodeHeat {
  conversionRate: number | null;
  attributedRevenue: FlowMoney[];
  directRevenue: FlowMoney[];
}

/** The pile-up: contacts whose LAST classified node is this one, idle past threshold. */
export interface FlowNodeDwell {
  stuckContacts: number;
  thresholdHours: number;
  oldestLastSeenAt: string | null;
  p50HoursStuck: number | null;
}

/** P3 — one acquisition lane (first-touch utm_campaign/utm_source value). */
export interface FlowLane {
  id: string;
  count: number;
}

export interface FlowMapNode extends FlowNode {
  /** Distinct contacts who hit this node in the window. */
  contacts: number;
  /** Events attributed to this node in the window. */
  events: number;
  /** Contacts currently ON this node — journey nodes only (live enrollments). */
  live: number | null;
  /** Conversion + revenue overlay (curated mode only). */
  heat: FlowNodeHeat | null;
  /** Pile-up stats (curated mode only). */
  dwell: FlowNodeDwell | null;
}

export interface FlowMapEdge {
  from: string;
  to: string;
  /** Total transitions (a contact may traverse an edge more than once). */
  transitions: number;
  /** Distinct contacts who traversed it. */
  contacts: number;
  /** P3 — lane → transition count (top lanes + an `__other` rollup). */
  lanes: Record<string, number> | null;
}

export interface FlowMap {
  window: { days: number; from: string; to: string };
  nodes: FlowMapNode[];
  edges: FlowMapEdge[];
  /** P3 — lanes seen in the window, with contact counts. */
  lanes: FlowLane[];
  meta: {
    /** True when the row cap forced a smaller window than asked for. */
    truncated: boolean;
    effectiveWindowDays: number;
    generatedAt: string;
  };
}

type NodeRow = { id: string; contacts: number; events: number };
type EdgeRow = {
  from: string;
  to: string;
  transitions: number;
  contacts: number;
  /** Present only when `laneBy` is set (lane → transition count). */
  lanes?: Record<string, number>;
};
type LaneRow = { id: string; count: number };

type FlowCacheEntry = {
  /** Stamped when the query RESOLVES — a pending entry has no age. */
  at: number;
  settled: boolean;
  promise: Promise<FlowMap>;
};

const flowCache = new Map<string, FlowCacheEntry>();

/**
 * Project the event history into the flow graph. Memoized for
 * `FLOW_CACHE_TTL_MS` on the normalized options, so a room full of open
 * Studio tabs polling the same window costs one query.
 *
 * Two subtleties that exist because the projection can be SLOW on a busy
 * install (it's a full window scan):
 * - An in-flight promise is served regardless of age. TTL-from-kickoff would
 *   stop coalescing the moment a query outlives the TTL, and every poll
 *   after that would stack ANOTHER identical scan on a DB that is already
 *   struggling — the exact stampede the memo exists to prevent.
 * - Eviction is identity-checked: a slow failure must only evict ITS OWN
 *   entry, never a fresher one that replaced it.
 */
/** Cache identity for a topology object (containers differ across tests). */
let topologySeq = 0;
const topologyIds = new WeakMap<FlowTopology, number>();
function topologyId(topology: FlowTopology): number {
  let id = topologyIds.get(topology);
  if (id === undefined) {
    topologySeq += 1;
    id = topologySeq;
    topologyIds.set(topology, id);
  }
  return id;
}

/** Settled entries a key sweep never visits again must not pin memory forever. */
const FLOW_CACHE_MAX_ENTRIES = 64;

export function computeFlowMap(opts: FlowMapOptions): Promise<FlowMap> {
  // Every parameter that changes the NUMBERS is in the key (model and
  // threshold as much as window and mode) — and so is the EFFECTIVE mode: a
  // curated request with no topology degrades to raw and must never share an
  // entry with a real curated map. The topology's identity is keyed too, so
  // two containers in one process (test suites) can't serve each other.
  const curated =
    opts.mode === "curated" && opts.topology ? opts.topology : undefined;
  const key = JSON.stringify({
    windowDays: opts.windowDays,
    mode: curated ? "curated" : "raw",
    topology: curated ? topologyId(curated) : null,
    model: opts.model ?? DEFAULT_ATTRIBUTION_MODEL,
    dwellThresholdHours:
      opts.dwellThresholdHours ?? DEFAULT_DWELL_THRESHOLD_HOURS,
    laneBy: opts.laneBy ?? null,
  });
  const now = Date.now();
  const hit = flowCache.get(key);
  if (hit && (!hit.settled || now - hit.at < FLOW_CACHE_TTL_MS)) {
    return hit.promise;
  }

  // Bound the cache: an admin sweeping thresholds/models mints fresh keys per
  // request, and a settled entry for a never-repeated key would otherwise pin
  // a full FlowMap for the process lifetime. Evict oldest-settled first;
  // pending entries are never evicted (they are the stampede guard).
  if (flowCache.size >= FLOW_CACHE_MAX_ENTRIES) {
    for (const [staleKey, entry] of flowCache) {
      if (entry.settled) {
        flowCache.delete(staleKey);
        if (flowCache.size < FLOW_CACHE_MAX_ENTRIES) break;
      }
    }
  }

  const entry: FlowCacheEntry = {
    at: now,
    settled: false,
    promise: runFlowMap(opts).then(
      (result) => {
        entry.at = Date.now();
        entry.settled = true;
        return result;
      },
      (err: unknown) => {
        // Never memoize a failure — but only evict our own entry.
        if (flowCache.get(key) === entry) flowCache.delete(key);
        throw err;
      },
    ),
  };
  flowCache.set(key, entry);
  return entry.promise;
}

/**
 * Shrink the window until the scan is bounded. An index-only count on
 * `occurred_at` is cheap; halving converges in a handful of steps (90 → 1).
 */
async function resolveWindow(
  db: Database,
  windowDays: number,
): Promise<{ effectiveWindowDays: number; truncated: boolean }> {
  let effectiveWindowDays = windowDays;
  while (effectiveWindowDays > 1) {
    const rows = await db.execute<{ total: string }>(sql`
      select count(*)::bigint as total
      from user_events
      where occurred_at >= now() - make_interval(days => ${effectiveWindowDays}::int)
    `);
    const total = Number(rows[0]?.total ?? 0);
    if (total <= FLOW_ROW_CAP) break;
    effectiveWindowDays = Math.max(1, Math.floor(effectiveWindowDays / 2));
  }
  return {
    effectiveWindowDays,
    truncated: effectiveWindowDays !== windowDays,
  };
}

/**
 * The projection itself: classify → drop the unclassified → per-contact
 * sequence → edges + node totals. The only thing that differs between raw and
 * curated is the `node_id` expression handed in here.
 */
async function project(
  db: Database,
  effectiveWindowDays: number,
  classifier: "raw" | FlowTopology,
  laneBy: FlowLaneBy | undefined,
): Promise<{ nodeRows: NodeRow[]; edgeRows: EdgeRow[]; laneRows: LaneRow[] }> {
  const nodeExpr =
    classifier === "raw"
      ? sql`split_part(event, '.', 1)`
      : classifier.classifierSql();

  // Raw mode's legibility cut: only the loudest prefixes survive. Curated mode
  // needs no cut — the registry IS the cut.
  const cut =
    classifier === "raw"
      ? sql`
        join (
          select node_id
          from win
          where node_id is not null and node_id <> ''
          group by node_id
          order by count(*) desc, node_id
          limit ${RAW_TOP_PREFIXES}
        ) t on t.node_id = w.node_id
      `
      : sql``;

  // Lanes (P3). Each contact's FIRST-touch `campaign.arrived` value in the
  // window (contacts with none default to `organic` at join time). `laneBy` is
  // one of two known literals, embedded via a switch — never raw input.
  const laneProp =
    laneBy === "utm_source"
      ? sql`properties ->> 'utm_source'`
      : sql`properties ->> 'utm_campaign'`;

  // The lane CTEs are present ONLY when `laneBy` is set; otherwise every lane
  // fragment collapses to empty SQL and the projection is structurally
  // identical to the P2 query — no extra CTE, join, or scan (edges carry no
  // `lanes`, the `lanes` column is `[]`).
  const contactLaneCte = laneBy
    ? sql`
      , contact_lane as (
        select distinct on (user_id)
          user_id,
          -- Trim + fold empty/whitespace-only utm to 'organic' — a stored ''
          -- (the /v1/events spine accepts it) must not mint an empty lane id.
          coalesce(nullif(btrim(${laneProp}), ''), 'organic') as lane
        from user_events
        where event = 'campaign.arrived'
          and occurred_at >= now() - make_interval(days => ${effectiveWindowDays}::int)
        order by user_id, occurred_at asc, id asc
      )`
    : sql``;

  // Global lane ranking FIRST (the top-24 the chip row shows) — so the per-edge
  // rollup below keeps a lane iff it survives the SAME cut. That alignment is
  // load-bearing: a chipped lane must carry its true count on every edge, never
  // hide inside an edge-local '__other'.
  const laneRankCtes = laneBy
    ? sql`
      -- Distinct CLASSIFIED contacts per lane (not just edge-crossers).
      , lane_totals as (
        select
          coalesce(cl.lane, 'organic') as lane,
          count(*)::int as count,
          row_number() over (
            order by count(*) desc, coalesce(cl.lane, 'organic') asc
          ) as rn
        from (select distinct user_id from classified) cc
        left join contact_lane cl on cl.user_id = cc.user_id
        group by coalesce(cl.lane, 'organic')
      ),
      -- The lanes that survive the top-24 cut — the membership set for BOTH the
      -- summary and every edge's rollup.
      lane_keep as (
        select lane from lane_totals where rn <= 24
      ),
      lane_rolled as (
        select
          case when rn <= 24 then lane else '__other' end as lane,
          sum(count)::int as count
        from lane_totals
        group by case when rn <= 24 then lane else '__other' end
      )`
    : sql``;

  const edgeLaneCtes = laneBy
    ? sql`
      , edge_lane_raw as (
        select
          s.prev as from_id,
          s.node_id as to_id,
          coalesce(cl.lane, 'organic') as lane,
          count(*)::int as transitions
        from seq s
        left join contact_lane cl on cl.user_id = s.user_id
        where s.prev is not null and s.prev <> s.node_id
        group by s.prev, s.node_id, coalesce(cl.lane, 'organic')
      ),
      -- Roll by GLOBAL membership (lane_keep), not a per-edge rank — so a lane
      -- in the chip row is never swept into an edge-local '__other'.
      edge_lane_rolled as (
        select from_id, to_id, keep_lane as lane, sum(transitions)::int as transitions
        from (
          select
            from_id,
            to_id,
            case when lane in (select lane from lane_keep) then lane else '__other' end as keep_lane,
            transitions
          from edge_lane_raw
        ) m
        group by from_id, to_id, keep_lane
      ),
      edge_lanes as (
        select
          from_id,
          to_id,
          json_object_agg(lane, transitions order by transitions desc, lane asc) as lanes
        from edge_lane_rolled
        group by from_id, to_id
      )`
    : sql``;

  const edgeLanesField = laneBy
    ? sql`, 'lanes', coalesce(el.lanes, '{}'::json)`
    : sql``;
  const edgeLanesJoin = laneBy
    ? sql`left join edge_lanes el on el.from_id = er.from_id and el.to_id = er.to_id`
    : sql``;
  const lanesColumn = laneBy
    ? sql`, coalesce(
        (
          select json_agg(
            json_build_object('id', lane, 'count', count)
            order by count desc, lane asc
          )
          from lane_rolled
        ),
        '[]'::json
      ) as lanes`
    : sql`, '[]'::json as lanes`;

  const rows = await db.execute<{
    nodes: NodeRow[];
    edges: EdgeRow[];
    lanes: LaneRow[];
  }>(sql`
    with win as (
      select
        user_id,
        occurred_at,
        id,
        ${nodeExpr} as node_id
      from user_events
      where occurred_at >= now() - make_interval(days => ${effectiveWindowDays}::int)
    ),
    classified as (
      select w.user_id, w.occurred_at, w.id, w.node_id
      from win w
      ${cut}
      where w.node_id is not null
    )
    ${contactLaneCte}${laneRankCtes},
    -- Per contact, what node did they come from? Computed over the classified
    -- set, so an unmapped event between two nodes doesn't break the edge.
    seq as (
      select
        user_id,
        node_id,
        lag(node_id) over (
          partition by user_id
          order by occurred_at, id
        ) as prev
      from classified
    ),
    edge_rows as (
      select
        prev as from_id,
        node_id as to_id,
        count(*)::int as transitions,
        count(distinct user_id)::int as contacts
      from seq
      -- prev <> node_id collapses a run of same-node events (three docs pages
      -- = one docs node) and kills self-loops.
      where prev is not null and prev <> node_id
      group by prev, node_id
    )
    ${edgeLaneCtes},
    node_rows as (
      select
        node_id as id,
        count(distinct user_id)::int as contacts,
        count(*)::int as events
      from classified
      group by node_id
    )
    select
      coalesce(
        (
          select json_agg(
            json_build_object('id', id, 'contacts', contacts, 'events', events)
            order by contacts desc, id
          )
          from node_rows
        ),
        '[]'::json
      ) as nodes,
      coalesce(
        (
          select json_agg(
            json_build_object(
              'from', er.from_id,
              'to', er.to_id,
              'transitions', er.transitions,
              'contacts', er.contacts
              ${edgeLanesField}
            )
            order by er.transitions desc, er.from_id, er.to_id
          )
          from edge_rows er
          ${edgeLanesJoin}
        ),
        '[]'::json
      ) as edges
      ${lanesColumn}
  `);

  const row = rows[0];
  return {
    nodeRows: row?.nodes ?? [],
    edgeRows: row?.edges ?? [],
    laneRows: row?.lanes ?? [],
  };
}

export interface ComputeFlowHeatOptions {
  db: Database;
  topology: FlowTopology;
  windowDays: number;
  /** Attribution model. Default `linear`. */
  model?: AttributionModel;
}

type AttributedRow = {
  scope: "journey" | "funnel";
  key: string;
  currency: string;
  amount: number;
};
type DirectRow = { nodeId: string; currency: string; amount: number };
type ConvRow = { nodeId: string; contacts: number; converted: number };

/**
 * Per-node heat: what a node is WORTH and how well it converts.
 *
 * Exported standalone because #486 (signal-based selling) needs exactly this
 * half — it ranks intervention candidates by `stuckContacts × downstream
 * value`, and this is the right factor (`computeNodeDwell` is the left). Same
 * node ids on both sides.
 *
 * Three sources, deliberately never merged:
 * - `attributedRevenue` — the ledger's credit for conversions this journey /
 *   funnel TOUCHED, under one model. Fractional, path-aware.
 * - `directRevenue` — the money that landed AT the node (a valued event
 *   classified here). Whole, no model.
 * Summing them would double-count the same sale, so they stay separate arrays,
 * per currency, and the UI picks one to show.
 * - `conversionRate` — of the contacts who reached this node, what fraction
 *   converted at-or-after their first touch of it.
 */
export async function computeFlowHeat(
  opts: ComputeFlowHeatOptions,
): Promise<Map<string, FlowNodeHeat>> {
  const { db, topology, windowDays } = opts;
  const model = opts.model ?? DEFAULT_ATTRIBUTION_MODEL;

  const [attributed, local] = await Promise.all([
    // Ledger credit, sliced by the two scope columns the flow map has nodes
    // for. Valueless credits (a conversion with no money) carry a null value
    // and are excluded — they'd contribute nothing but a phantom currency.
    // Ordered so the money arrays are deterministic across polls — GROUP BY
    // output order is unspecified, and Studio's identity-reuse compares the
    // arrays index-wise.
    db.execute<AttributedRow>(sql`
      select 'journey' as scope, journey_id as key, currency,
             sum(value)::float8 as amount
      from attribution_credits
      where model = ${model}
        and converted_at >= now() - make_interval(days => ${windowDays}::int)
        and journey_id is not null
        and value is not null
        and currency is not null
      group by journey_id, currency
      union all
      select 'funnel' as scope, funnel_id as key, currency,
             sum(value)::float8 as amount
      from attribution_credits
      where model = ${model}
        and converted_at >= now() - make_interval(days => ${windowDays}::int)
        and funnel_id is not null
        and value is not null
        and currency is not null
      group by funnel_id, currency
      order by 1, 2, 3
    `),
    db.execute<{ direct: DirectRow[]; conv: ConvRow[] }>(sql`
      with classified as (
        select
          user_id,
          occurred_at,
          value,
          currency,
          ${topology.classifierSql()} as node_id
        from user_events
        where occurred_at >= now() - make_interval(days => ${windowDays}::int)
      ),
      kept as (
        select * from classified where node_id is not null
      ),
      -- When did each contact FIRST reach each node? A conversion only counts
      -- for a node if it happened at-or-after that first touch — crediting a
      -- node for a sale that closed before the contact ever saw it is a lie.
      firsts as (
        select node_id, user_id, min(occurred_at) as first_at
        from kept
        group by node_id, user_id
      ),
      direct as (
        select node_id, currency, sum(value)::float8 as amount
        from kept
        where value is not null and currency is not null
        group by node_id, currency
      ),
      conv as (
        select
          f.node_id,
          count(*)::int as contacts,
          count(*) filter (
            where exists (
              select 1
              from conversions c
              where c.user_key = f.user_id
                and c.occurred_at >= f.first_at
            )
          )::int as converted
        from firsts f
        group by f.node_id
      )
      select
        coalesce(
          (
            select json_agg(json_build_object(
              'nodeId', node_id, 'currency', currency, 'amount', amount
            ) order by node_id, currency)
            from direct
          ),
          '[]'::json
        ) as direct,
        coalesce(
          (
            select json_agg(json_build_object(
              'nodeId', node_id, 'contacts', contacts, 'converted', converted
            ))
            from conv
          ),
          '[]'::json
        ) as conv
    `),
  ]);

  const heat = new Map<string, FlowNodeHeat>();
  const heatFor = (nodeId: string): FlowNodeHeat => {
    const existing = heat.get(nodeId);
    if (existing) return existing;
    const fresh: FlowNodeHeat = {
      conversionRate: null,
      attributedRevenue: [],
      directRevenue: [],
    };
    heat.set(nodeId, fresh);
    return fresh;
  };

  for (const row of attributed) {
    // A funnel's credit attaches to the stage where the money is won; a
    // journey's to the journey node. Credit for a journey/funnel that is no
    // longer registered has nowhere to land — drop it rather than mint a
    // ghost node.
    const nodeId =
      row.scope === "journey"
        ? journeyNodeId(row.key)
        : topology.revenueNodeFor(row.key);
    if (!nodeId || !topology.node(nodeId)) continue;
    heatFor(nodeId).attributedRevenue.push({
      amount: Number(row.amount),
      currency: row.currency,
    });
  }

  const { direct, conv } = local[0] ?? { direct: [], conv: [] };
  for (const row of direct) {
    heatFor(row.nodeId).directRevenue.push({
      amount: Number(row.amount),
      currency: row.currency,
    });
  }
  for (const row of conv) {
    const contacts = Number(row.contacts);
    if (contacts === 0) continue;
    heatFor(row.nodeId).conversionRate = Number(row.converted) / contacts;
  }

  return heat;
}

/** Contacts sitting in each journey right now (`active` + `waiting`). */
async function liveJourneyCounts(db: Database): Promise<Map<string, number>> {
  const rows = await db
    .select({ journeyId: journeyStates.journeyId, live: count() })
    .from(journeyStates)
    .where(
      and(
        inArray(journeyStates.status, ["active", "waiting"]),
        isNull(journeyStates.deletedAt),
      ),
    )
    .groupBy(journeyStates.journeyId);
  return new Map(rows.map((r) => [r.journeyId, Number(r.live)]));
}

async function runFlowMap({
  db,
  windowDays,
  mode,
  topology,
  model,
  dwellThresholdHours,
  laneBy,
}: FlowMapOptions): Promise<FlowMap> {
  const { effectiveWindowDays, truncated } = await resolveWindow(
    db,
    windowDays,
  );
  const thresholdHours = dwellThresholdHours ?? DEFAULT_DWELL_THRESHOLD_HOURS;
  // A curated request with no topology (a container-less caller) degrades to
  // raw rather than throwing — an honest raw map beats an empty one.
  const curated = mode === "curated" ? topology : undefined;

  // Dwell answers "who is stuck NOW", not "who moved in the display window" —
  // its lookback is deliberately DECOUPLED from the map window. Coupling them
  // makes threshold >= window a structurally empty band (24h window + 48h
  // threshold = nobody can ever be stuck), and drops contacts from the
  // pile-up precisely when they've been stuck longest. Floor: the module's
  // 30-day default, the display window if larger, and always at least one day
  // past the threshold so the band is never empty.
  const dwellLookbackDays = Math.max(
    30,
    effectiveWindowDays,
    Math.ceil(thresholdHours / 24) + 1,
  );

  const [{ nodeRows, edgeRows, laneRows }, heat, dwell, live] =
    await Promise.all([
      project(db, effectiveWindowDays, curated ?? "raw", laneBy),
      curated
        ? computeFlowHeat({
            db,
            topology: curated,
            windowDays: effectiveWindowDays,
            model,
          })
        : undefined,
      curated
        ? computeNodeDwell({
            db,
            topology: curated,
            windowDays: dwellLookbackDays,
            thresholdHours,
          })
        : undefined,
      curated ? liveJourneyCounts(db) : undefined,
    ]);

  const dwellByNode = new Map((dwell ?? []).map((d) => [d.nodeId, d]));
  const observed = new Map(nodeRows.map((n) => [n.id, n]));

  // Curated mode draws EVERY registered node, traffic or not: "nobody entered
  // this journey in 7 days" is the most useful thing the map can say, and it
  // can only say it if the node is on the canvas. Node ids observed in the
  // window but absent from the registry (impossible today — the classifier only
  // emits registry ids — but a future classifier could) are kept too, as
  // unclassified surfaces.
  const ids = curated
    ? [...new Set([...curated.nodes().map((n) => n.id), ...observed.keys()])]
    : [...observed.keys()];

  const nodes: FlowMapNode[] = ids.map((id) => {
    const registered = curated?.node(id);
    const row = observed.get(id);
    const d = dwellByNode.get(id);
    const journeyId = journeyIdFromNode(id);
    return {
      id,
      // Raw mode has no registry to consult: every prefix is an unclassified
      // surface parked in the first tier.
      kind: registered?.kind ?? "surface",
      name: registered?.name ?? id,
      // The lifecycle badge is optional metadata — an unregistered (raw-mode)
      // node honestly has none.
      ...(registered?.tier !== undefined ? { tier: registered.tier } : {}),
      ...(registered?.display !== undefined
        ? { display: registered.display }
        : {}),
      contacts: Number(row?.contacts ?? 0),
      events: Number(row?.events ?? 0),
      // Live counts exist only where "currently in it" is a real state: a
      // journey enrollment. A funnel stage's live population IS its dwell.
      live:
        registered?.kind === "journey" && journeyId !== undefined
          ? (live?.get(journeyId) ?? 0)
          : null,
      // One convention, applied whole: in curated mode every node carries a
      // heat + dwell OBJECT (zeroed when there's no data — "measured, nothing
      // there"); in raw mode both are null ("not measured").
      heat: heat
        ? (heat.get(id) ?? {
            conversionRate: null,
            attributedRevenue: [],
            directRevenue: [],
          })
        : null,
      dwell: curated
        ? {
            stuckContacts: d?.stuckContacts ?? 0,
            thresholdHours,
            oldestLastSeenAt: d?.oldestLastSeenAt?.toISOString() ?? null,
            p50HoursStuck: d?.p50HoursStuck ?? null,
          }
        : null,
    };
  });

  // Busiest first, ties broken by id — a stable order across polls (the Studio
  // layout pins row slots off the first order it sees).
  nodes.sort((a, b) => b.contacts - a.contacts || a.id.localeCompare(b.id));

  const to = new Date();
  const from = new Date(
    to.getTime() - effectiveWindowDays * 24 * 60 * 60 * 1000,
  );

  return {
    // `days` echoes what was asked for; `from` reflects what was actually
    // scanned (they differ only when the row cap truncated the window).
    window: {
      days: windowDays,
      from: from.toISOString(),
      to: to.toISOString(),
    },
    nodes,
    edges: edgeRows.map((e) => ({
      from: e.from,
      to: e.to,
      transitions: Number(e.transitions),
      contacts: Number(e.contacts),
      // `laneBy` off → project returns no `lanes` key → null (lanes off).
      lanes: e.lanes ?? null,
    })),
    lanes: laneRows.map((l) => ({ id: l.id, count: Number(l.count) })),
    meta: {
      truncated,
      effectiveWindowDays,
      generatedAt: to.toISOString(),
    },
  };
}
