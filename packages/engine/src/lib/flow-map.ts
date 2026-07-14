/**
 * The flow map — `user_events` projected into a node/edge graph of how
 * contacts actually move through the product (the data behind Studio's
 * control room, `GET /v1/admin/flow`).
 *
 * P1 ships `mode: "raw"`: nodes are the top event-name prefixes in the
 * window (`docs.opened` → `docs`), edges are contact-ordered transitions
 * between them. Curated mode (registry-backed surfaces/journeys/funnel
 * stages) lands in P2/P3 and slots in as a different classifier over the
 * same seq→edges/nodes projection.
 *
 * Design notes that matter:
 * - ONE SQL statement, every value bound (never interpolated).
 * - The transition sequence is computed AFTER unmapped events are dropped, so
 *   A → (noise) → B still reads as A → B.
 * - Consecutive events on the same node collapse (`prev <> node_id`), so a
 *   contact reading three docs pages is one `docs` node, not a self-loop.
 * - A 5s per-process memo means N pollers cost one query.
 */
import type { Database } from "@hogsend/db";
import { sql } from "drizzle-orm";
import type { FlowNode } from "./flow-topology.js";

/**
 * Above this many events in the window we halve the window rather than scan
 * (the projection is a full window scan — a year of a busy install is not a
 * request-time query). Reported honestly via `meta.truncated`. Two honest
 * limits: the halving floor is 1 day, so an install writing >2M rows/day
 * still scans them all; and at the cap the doubly-referenced `win` CTE
 * materializes (~hundreds of MB past work_mem → temp files). Installs at
 * that scale get a Timescale continuous aggregate — the named follow-up,
 * not a request-time fix.
 */
const FLOW_ROW_CAP = 2_000_000;

/** Raw mode keeps the map legible: the N loudest prefixes, everything else is dropped. */
const RAW_TOP_PREFIXES = 15;

/** Poll-collapsing memo — the map moves on a 30s Studio poll, not per request. */
const FLOW_CACHE_TTL_MS = 5_000;

/** P1 computes `raw` only; `curated` is accepted and treated as raw (P2 wires it). */
export type FlowMapMode = "curated" | "raw";

export interface FlowMapOptions {
  db: Database;
  windowDays: number;
  mode: FlowMapMode;
}

/** An amount in one currency — amounts in different currencies NEVER sum. */
export interface FlowMoney {
  amount: number;
  currency: string;
}

/**
 * P2 — per-node conversion + revenue overlay. `attributedRevenue` comes from
 * the attribution ledger; `directRevenue` is the sum of valued events at the
 * node. They answer different questions and are never added together.
 */
export interface FlowNodeHeat {
  conversionRate: number | null;
  attributedRevenue: FlowMoney[];
  directRevenue: FlowMoney[];
}

/** P2 — the pile-up: contacts whose LAST classified node is this one, idle past threshold. */
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
  /** P4 — contacts currently on this node (live SSE). */
  live: number | null;
  /** P2 — conversion + revenue overlay. */
  heat: FlowNodeHeat | null;
  /** P2 — pile-up stats. */
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
};

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
export function computeFlowMap(opts: FlowMapOptions): Promise<FlowMap> {
  const key = JSON.stringify({
    windowDays: opts.windowDays,
    mode: opts.mode,
  });
  const now = Date.now();
  const hit = flowCache.get(key);
  if (hit && (!hit.settled || now - hit.at < FLOW_CACHE_TTL_MS)) {
    return hit.promise;
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

/** P1 always runs the raw classifier — `mode` only keys the memo for now. */
async function runFlowMap({
  db,
  windowDays,
}: FlowMapOptions): Promise<FlowMap> {
  const { effectiveWindowDays, truncated } = await resolveWindow(
    db,
    windowDays,
  );

  const rows = await db.execute<{ nodes: NodeRow[]; edges: EdgeRow[] }>(sql`
    with win as (
      select
        user_id,
        occurred_at,
        id,
        split_part(event, '.', 1) as node_id
      from user_events
      where occurred_at >= now() - make_interval(days => ${effectiveWindowDays}::int)
    ),
    -- Legibility cut: only the loudest prefixes become nodes. Everything else
    -- classifies to nothing and is dropped BEFORE the sequence is built.
    top_prefixes as (
      select node_id
      from win
      where node_id <> ''
      group by node_id
      order by count(*) desc, node_id
      limit ${RAW_TOP_PREFIXES}
    ),
    classified as (
      select w.user_id, w.occurred_at, w.id, w.node_id
      from win w
      join top_prefixes t on t.node_id = w.node_id
    ),
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
    ),
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
              'from', from_id,
              'to', to_id,
              'transitions', transitions,
              'contacts', contacts
            )
            order by transitions desc, from_id, to_id
          )
          from edge_rows
        ),
        '[]'::json
      ) as edges
  `);

  const row = rows[0];
  const nodeRows = row?.nodes ?? [];
  const edgeRows = row?.edges ?? [];

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
    nodes: nodeRows.map((n) => ({
      id: n.id,
      // Raw mode has no registry to consult: every prefix is an unclassified
      // surface parked in the first tier. P2/P3 assign the real kind + tier.
      kind: "surface" as const,
      name: n.id,
      tier: "acquisition" as const,
      contacts: Number(n.contacts),
      events: Number(n.events),
      live: null,
      heat: null,
      dwell: null,
    })),
    edges: edgeRows.map((e) => ({
      from: e.from,
      to: e.to,
      transitions: Number(e.transitions),
      contacts: Number(e.contacts),
      lanes: null,
    })),
    lanes: [],
    meta: {
      truncated,
      effectiveWindowDays,
      generatedAt: to.toISOString(),
    },
  };
}
