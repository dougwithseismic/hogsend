/**
 * Dwell — the pile-up. For each flow node: how many contacts have that node as
 * their LAST classified event and have been sitting there past a threshold.
 * "47 contacts stopped at `funnel:commercial:proposal` and nobody has heard
 * from them in three days" is the sentence this module exists to produce.
 *
 * ALSO the left factor of #486 (signal-based selling). That plan ranks
 * intervention candidates by `stuckContacts × downstream value`:
 * - THIS module owns the left factor (who is stuck, where, for how long).
 * - `computeFlowHeat` (flow-map.ts) owns the right factor (what a node is worth).
 * - Both are keyed by the SAME flow node ids, so they join with no adapter.
 * The RANK itself lives in NEITHER — it is a policy decision (which threshold,
 * which model, which tiers count), and baking it into a projection module would
 * make it un-tunable. #486 composes the two.
 */
import type { Database } from "@hogsend/db";
import { sql } from "drizzle-orm";
import type { FlowTopology } from "./flow-topology.js";

/** Default lookback for "what was their last node". */
const DEFAULT_WINDOW_DAYS = 30;
/** Default idle time before a contact counts as stuck. */
const DEFAULT_THRESHOLD_HOURS = 48;

const MAX_STUCK_CONTACTS = 200;
const DEFAULT_STUCK_CONTACTS = 50;

export interface DwellBucket {
  nodeId: string;
  stuckContacts: number;
  oldestLastSeenAt: Date;
  p50HoursStuck: number;
}

export interface ComputeDwellOptions {
  db: Database;
  topology: FlowTopology;
  /** Lookback for the last-node computation. Default 30 days. */
  windowDays?: number;
  /** Idle time before a contact is stuck. Default 48 hours. */
  thresholdHours?: number;
  /** Restrict to these nodes (intersected with the exclusion filter). */
  nodeIds?: string[];
  /**
   * Nodes where "still here" is a win, not a pile-up. Default: the topology's
   * conversion destinations (the builtin revenue node + at-or-after-won funnel
   * stages). Deliberately NOT the revenue *tier*: a quoted-milestone stage is
   * drawn in the revenue column, but a quote with no signature is exactly the
   * pile-up this module exists to surface.
   */
  excludeNodeIds?: string[];
}

export interface StuckContact {
  userId: string;
  lastSeenAt: Date;
  hoursStuck: number;
}

/** Which node ids this call is allowed to report on (exclusions ∩ nodeIds). */
function eligibleNodeIds(opts: ComputeDwellOptions): string[] {
  const excluded = new Set(
    opts.excludeNodeIds ?? opts.topology.conversionDestinationNodeIds(),
  );
  const requested = opts.nodeIds ? new Set(opts.nodeIds) : undefined;
  return opts.topology
    .nodes()
    .filter((n) => !excluded.has(n.id))
    .filter((n) => !requested || requested.has(n.id))
    .map((n) => n.id);
}

/**
 * The shared shape of both queries: classify the window, take each contact's
 * LAST classified event, keep the ones that have gone quiet since.
 *
 * `distinct on (user_id) … order by user_id, occurred_at desc, id desc` is the
 * last-event pick (the `id` tiebreak keeps two same-instant events stable). The
 * classifier runs BEFORE the pick, so an unclassified event after a classified
 * one does not reset the clock — a contact idling on `docs` with a stray
 * heartbeat event is still idling on `docs`.
 */
function stuckContactsCte(
  topology: FlowTopology,
  windowDays: number,
  thresholdHours: number,
  nodeIds: string[],
) {
  return sql`
    with classified as (
      select
        user_id,
        occurred_at,
        id,
        ${topology.classifierSql()} as node_id
      from user_events
      where occurred_at >= now() - make_interval(days => ${windowDays}::int)
    ),
    last_events as (
      select distinct on (user_id)
        user_id,
        node_id,
        occurred_at
      from classified
      where node_id is not null
      order by user_id, occurred_at desc, id desc
    ),
    stuck as (
      select
        user_id,
        node_id,
        occurred_at,
        extract(epoch from (now() - occurred_at)) / 3600.0 as hours_stuck
      from last_events
      where occurred_at < now() - make_interval(hours => ${thresholdHours}::int)
        and node_id in (${sql.join(
          nodeIds.map((id) => sql`${id}`),
          sql`, `,
        )})
    )
  `;
}

/**
 * Per-node pile-up over the window. Nodes with nobody stuck are simply absent
 * (the caller zero-fills from the registry).
 */
export async function computeNodeDwell(
  opts: ComputeDwellOptions,
): Promise<DwellBucket[]> {
  const windowDays = opts.windowDays ?? DEFAULT_WINDOW_DAYS;
  const thresholdHours = opts.thresholdHours ?? DEFAULT_THRESHOLD_HOURS;
  const nodeIds = eligibleNodeIds(opts);
  if (nodeIds.length === 0) return [];

  const rows = await opts.db.execute<{
    node_id: string;
    stuck_contacts: number;
    oldest_last_seen_at: Date;
    p50_hours_stuck: number;
  }>(sql`
    ${stuckContactsCte(opts.topology, windowDays, thresholdHours, nodeIds)}
    select
      node_id,
      count(*)::int as stuck_contacts,
      min(occurred_at) as oldest_last_seen_at,
      (percentile_cont(0.5) within group (order by hours_stuck))::float8
        as p50_hours_stuck
    from stuck
    group by node_id
    order by stuck_contacts desc, node_id
  `);

  return rows.map((row) => ({
    nodeId: row.node_id,
    stuckContacts: Number(row.stuck_contacts),
    oldestLastSeenAt: new Date(row.oldest_last_seen_at),
    p50HoursStuck: Number(row.p50_hours_stuck),
  }));
}

/**
 * The contacts behind one node's `stuckContacts` count, oldest first — the
 * drill-down (P5) and #486's outreach list. Same classification, same
 * threshold; a `nodeId` outside the tier filter yields an empty list rather
 * than a surprise.
 */
export async function listStuckContacts(
  opts: ComputeDwellOptions & { nodeId: string; limit?: number },
): Promise<StuckContact[]> {
  const windowDays = opts.windowDays ?? DEFAULT_WINDOW_DAYS;
  const thresholdHours = opts.thresholdHours ?? DEFAULT_THRESHOLD_HOURS;
  const limit = Math.min(
    Math.max(1, opts.limit ?? DEFAULT_STUCK_CONTACTS),
    MAX_STUCK_CONTACTS,
  );
  const eligible = eligibleNodeIds({ ...opts, nodeIds: [opts.nodeId] });
  if (eligible.length === 0) return [];

  const rows = await opts.db.execute<{
    user_id: string;
    occurred_at: Date;
    hours_stuck: number;
  }>(sql`
    ${stuckContactsCte(opts.topology, windowDays, thresholdHours, eligible)}
    select user_id, occurred_at, hours_stuck
    from stuck
    order by occurred_at asc
    limit ${limit}::int
  `);

  return rows.map((row) => ({
    userId: row.user_id,
    lastSeenAt: new Date(row.occurred_at),
    hoursStuck: Number(row.hours_stuck),
  }));
}
