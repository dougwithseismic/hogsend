/**
 * Flow-map LIVE layer (P4) — every fresh, classified event publishes ONE flow
 * transition onto Redis pub/sub; the admin SSE route
 * (`GET /v1/admin/flow/stream`) fans it to Studio, which spawns a bright
 * one-shot particle along the matching rail within ~1s. This is what makes the
 * static map (P1–P3) ALIVE: each dot is a real contact moving right now.
 *
 * The transition is derived from the SAME registry-backed classifier the
 * windowed aggregate uses ({@link FlowTopology.classifyEvent}), so a live
 * particle can only ever ride an edge the aggregate would also draw. The
 * previous node is read atomically from a short-lived Redis key
 * (`flow:last:<userKey>`), so "where did this contact come from" survives across
 * API replicas and process restarts without a DB round-trip on the ingest hot
 * path.
 *
 * Hot-path discipline (unmapped events are the majority and MUST cost zero
 * network): the classifier runs FIRST, entirely in-process; only a classified
 * event touches Redis. A per-process token bucket caps PUBLISH volume so a burst
 * (a backfill, an import) can never flood the pub/sub channel — the state key is
 * still updated, only the notification is shed.
 */
import type { Redis } from "ioredis";
import { getFlowTopology } from "./flow-topology-singleton.js";
import type { Logger } from "./logger.js";
import { getRedis } from "./redis.js";

/** The single pub/sub channel every API/worker writes transitions onto. */
export const FLOW_TRANSITIONS_CHANNEL = "flow:transitions";

/** Redis key prefixes — short-lived per-contact live state. */
const LAST_NODE_PREFIX = "flow:last:";
const LANE_PREFIX = "flow:lane:";
/** Previous-node TTL: 30 days (a contact idle longer re-enters cold). */
const LAST_NODE_TTL_SEC = 2_592_000;
/**
 * Lane TTL: 90 days — an acquisition lane is a long-lived FIRST-touch fact
 * (SET NX; a re-arrival never overwrites it). Known approximation vs the
 * aggregate: the map's first-touch is scoped to the QUERY window, so a
 * contact whose first arrival aged out of the selected window can diverge.
 */
const LANE_TTL_SEC = 7_776_000;

/** The event whose `utm_campaign` seeds the per-contact acquisition lane. */
const CAMPAIGN_ARRIVED_EVENT = "campaign.arrived";

/**
 * One live flow transition — the wire shape Studio's stream layer consumes.
 * Carries NO email/PII beyond the contact + canonical key (parity with the
 * admin events route).
 */
export interface FlowTransitionMessage {
  v: 1;
  contactId: string;
  /** Resolved canonical key for the contact. */
  userId: string;
  /** null = cold cache → Studio spawns the particle AT the target node. */
  from: string | null;
  to: string;
  /** Normalized `utm_campaign` acquisition lane (btrim, empty→null). */
  lane: string | null;
  event: string;
  /** ISO timestamp of the originating event. */
  ts: string;
}

// ---------------------------------------------------------------------------
// Per-process token bucket — caps PUBLISH volume, never the state write.
// ---------------------------------------------------------------------------

/** Steady-state publishes/sec (also the burst capacity). */
const BUCKET_CAPACITY = 200;
const REFILL_PER_SEC = 200;
/** Warn about shed transitions at most this often. */
const DROP_WARN_INTERVAL_MS = 60_000;

let tokens = BUCKET_CAPACITY;
let lastRefillMs = Date.now();
let droppedSinceWarn = 0;
let lastDropWarnMs = 0;
/** Once-per-process warning for Redis < 6.2 (no SET ... GET support). */
let warnedLegacyRedis = false;

/** Refill by elapsed wall-clock, then try to spend one token. */
function takeToken(): boolean {
  const now = Date.now();
  const elapsedSec = (now - lastRefillMs) / 1000;
  if (elapsedSec > 0) {
    tokens = Math.min(BUCKET_CAPACITY, tokens + elapsedSec * REFILL_PER_SEC);
    lastRefillMs = now;
  }
  if (tokens >= 1) {
    tokens -= 1;
    return true;
  }
  return false;
}

/**
 * Reset the module-level rate-limit state. TEST-ONLY — keeps a flood assertion
 * deterministic regardless of what ran before it.
 */
export function resetFlowLiveRateLimit(): void {
  tokens = BUCKET_CAPACITY;
  lastRefillMs = Date.now();
  droppedSinceWarn = 0;
  lastDropWarnMs = 0;
}

// ---------------------------------------------------------------------------
// Publish
// ---------------------------------------------------------------------------

export interface PublishFlowTransitionEvent {
  name: string;
  source: string | null;
  properties?: Record<string, unknown> | null;
  value: number | null;
  occurredAt: Date;
}

export interface PublishFlowTransitionOptions {
  logger: Logger;
  /** Resolved canonical contact key. */
  userKey: string;
  /** The contact's unforgeable row id (`contacts.id`). */
  contactId: string;
  event: PublishFlowTransitionEvent;
  /** Injectable for tests; defaults to the shared engine singleton. */
  redis?: Redis;
}

/**
 * Classify one fresh event and, if it maps to a flow node, publish the
 * transition (from the contact's previous node) onto {@link
 * FLOW_TRANSITIONS_CHANNEL}. Cheap-first: an unmapped event returns before ANY
 * Redis I/O. Best-effort by contract — callers wrap this in their own
 * try/catch; a Redis fault must never fail the ingest.
 */
export async function publishFlowTransition(
  opts: PublishFlowTransitionOptions,
): Promise<void> {
  // A bare-script process never built a container → no topology → no-op.
  const topology = getFlowTopology();
  if (!topology) return;

  // (0) Lane capture happens BEFORE the classify gate: `campaign.arrived` is
  //     usually UNMAPPED (few installs declare a `campaign.` surface), but the
  //     windowed aggregate still reads its utm value from the DB — the live
  //     path must cache it under the same rule or live particles would carry
  //     `lane: null` for contacts the map correctly attributes. FIRST-touch
  //     (SET NX): the aggregate takes each contact's first in-window arrival,
  //     so a re-arrival must not overwrite the cached lane.
  const laneKey = `${LANE_PREFIX}${opts.userKey}`;
  let arrivedLane: string | null = null;
  if (opts.event.name === CAMPAIGN_ARRIVED_EVENT) {
    const raw = opts.event.properties?.utm_campaign;
    const lane = typeof raw === "string" ? raw.trim() : "";
    if (lane) arrivedLane = lane;
  }

  // (1) In-process classify — free, and the majority verdict is "unmapped".
  const toNode = topology.classifyEvent({
    event: opts.event.name,
    source: opts.event.source,
    properties: opts.event.properties ?? null,
    value: opts.event.value,
  });
  if (toNode === null) {
    // Unmapped events cost zero Redis I/O — with the one deliberate
    // exception above: an unmapped campaign.arrived still caches its lane.
    if (arrivedLane !== null) {
      const client = opts.redis ?? getRedis();
      await client.set(laneKey, arrivedLane, "EX", LANE_TTL_SEC, "NX");
    }
    return;
  }

  const client = opts.redis ?? getRedis();
  const lastKey = `${LAST_NODE_PREFIX}${opts.userKey}`;

  // (2) ONE pipeline: atomically read+write the previous node (SET ... GET),
  //     first-touch-cache an arriving lane (SET NX), and ALWAYS read the
  //     authoritative lane back — the cached first-touch value wins over this
  //     event's own utm, and a bare campaign.arrived (no utm) still rides
  //     under the contact's cached lane. The state writes happen even when
  //     the publish is later shed, so the from-node never goes stale.
  const pipeline = client.pipeline();
  // Index 0 — the SET ... GET whose returned value is the previous node.
  pipeline.set(lastKey, toNode, "EX", LAST_NODE_TTL_SEC, "GET");
  if (arrivedLane !== null) {
    pipeline.set(laneKey, arrivedLane, "EX", LANE_TTL_SEC, "NX");
  }
  // Always last — the post-NX read is the first-touch truth.
  pipeline.get(laneKey);

  const results = (await pipeline.exec()) ?? [];
  const setResult = results[0];
  const prevNode = (setResult?.[1] as string | null | undefined) ?? null;

  // SET ... GET needs Redis >= 6.2. ioredis surfaces a per-command error (not
  // a throw), which the `?? null` would silently launder into an eternal
  // cold-cache — warn ONCE so a BYO Redis 6.0 install knows why every live
  // particle spawns at its target with no rail to ride.
  if (setResult?.[0] && !warnedLegacyRedis) {
    warnedLegacyRedis = true;
    opts.logger.warn(
      "flow-live: Redis rejected SET ... GET (needs Redis >= 6.2) — live " +
        "from-nodes are unavailable on this Redis; particles will spawn " +
        "at their target node only.",
      { error: setResult[0].message },
    );
  }

  // (3) Self-transition — the aggregate collapses these, so must the live path.
  if (prevNode === toNode) return;

  const laneResult = results[results.length - 1];
  const lane = (laneResult?.[1] as string | null | undefined) ?? null;

  const message: FlowTransitionMessage = {
    v: 1,
    contactId: opts.contactId,
    userId: opts.userKey,
    from: prevNode,
    to: toNode,
    lane,
    event: opts.event.name,
    ts: opts.event.occurredAt.toISOString(),
  };

  // (4) Rate-limit the NOTIFICATION only. A shed message still updated state
  //     above; we just skip the pub/sub fan-out and account for the drop.
  if (!takeToken()) {
    droppedSinceWarn += 1;
    const now = Date.now();
    if (now - lastDropWarnMs >= DROP_WARN_INTERVAL_MS) {
      lastDropWarnMs = now;
      opts.logger.warn("flow-live: rate limit — dropping flow transitions", {
        dropped: droppedSinceWarn,
        channel: FLOW_TRANSITIONS_CHANNEL,
      });
      droppedSinceWarn = 0;
    }
    return;
  }

  await client.publish(FLOW_TRANSITIONS_CHANNEL, JSON.stringify(message));
}
