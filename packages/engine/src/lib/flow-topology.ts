/**
 * Flow-map topology — the shared vocabulary every phase of the control room
 * agrees on, PLUS (P2) the registry-backed classifier that decides which node
 * an event belongs to.
 *
 * A flow node is one place a contact can *be* in the growth machine (a surface
 * they touched, a journey they're enrolled in, a funnel stage they've reached);
 * a tier is the lifecycle column it lives in.
 *
 * The classifier is compiled TWICE from the SAME ordered rule list:
 * - {@link FlowTopology.classifyEvent} — TS, for the per-event live path (P4).
 * - {@link FlowTopology.classifierSql} — a SQL `CASE`, for the windowed
 *   aggregate query (flow-map / flow-dwell).
 * They MUST agree on every input — the parity test (`admin-flow-curated.test.ts`)
 * runs a table of synthetic events through both and asserts identical node ids.
 * If you add a rule, add it to both compilations in the same position.
 *
 * Precedence (FIRST MATCH WINS):
 *   1. `properties.journeyId` naming a registered journey → that journey's node.
 *      (The tracked mailer + tracking pipeline stamp this on every engagement
 *      event, so an open/click classifies to the journey that sent it — not to
 *      whatever surface the link happened to point at.)
 *   2. A funnel stage's exact trigger event → that stage's node. (The
 *      transition's `where` refinement is deliberately NOT evaluated here: the
 *      map answers "which stage does this event belong to", and a conditional
 *      trigger still belongs to its stage even when the condition fails.)
 *   3. — P3 seam: `defineSurface` exact/prefix/source rules slot in HERE, above
 *      revenue and below funnels. Keep the seam in both compilations. —
 *   4. A positive `value` → the builtin `revenue` node.
 *   5. Nothing → NULL (the event is dropped from the map).
 */
import type { DefinedFunnel, JourneyMeta } from "@hogsend/core";
import type { JourneyRegistry } from "@hogsend/core/registry";
import { type SQL, sql } from "drizzle-orm";
import type { FunnelRegistry } from "./funnel-registry.js";
import type { Logger } from "./logger.js";

/** Lifecycle column a node is drawn in — the flow map's x-axis. */
export type SurfaceTier =
  | "acquisition"
  | "activation"
  | "retention"
  | "revenue";

/** What a node *is* — decides its icon + drill-down in Studio. */
export type FlowNodeKind = "surface" | "journey" | "funnelStage" | "builtin";

export interface FlowNode {
  id: string;
  kind: FlowNodeKind;
  name: string;
  tier: SurfaceTier;
}

/** The builtin money node — every valued event nothing else claims lands here. */
export const REVENUE_NODE_ID = "revenue";

const JOURNEY_PREFIX = "journey:";

/** Node id for a registered journey. */
export function journeyNodeId(journeyId: string): string {
  return `${JOURNEY_PREFIX}${journeyId}`;
}

/** The journey id behind a journey node id (undefined for any other node). */
export function journeyIdFromNode(nodeId: string): string | undefined {
  return nodeId.startsWith(JOURNEY_PREFIX)
    ? nodeId.slice(JOURNEY_PREFIX.length)
    : undefined;
}

/** Node id for one stage of one funnel. */
export function funnelStageNodeId(funnelId: string, stageId: string): string {
  return `funnel:${funnelId}:${stageId}`;
}

/** The `user_events`-shaped row the classifier reads (both compilations). */
export interface ClassifiableEvent {
  event: string;
  source: string | null;
  properties?: Record<string, unknown> | null;
  value: number | null;
}

export interface FlowTopology {
  /** Every node the classifier can emit, registry order (journeys → funnels → revenue). */
  nodes(): FlowNode[];
  /** One node by id (undefined when nothing registered it). */
  node(id: string): FlowNode | undefined;
  /** TS compilation of the classifier. */
  classifyEvent(event: ClassifiableEvent): string | null;
  /** SQL compilation of the classifier — a `CASE` over a `user_events` row. */
  classifierSql(): SQL;
  /**
   * The node a funnel's attributed revenue attaches to: its won-milestone
   * stage, else its last stage. Undefined for an unknown funnel.
   */
  revenueNodeFor(funnelId: string): string | undefined;
  /**
   * Nodes where "still here" means CONVERTED, not stuck: the builtin revenue
   * node and every stage at-or-after a funnel's won milestone. Dwell excludes
   * these by default. Deliberately NOT the whole revenue *tier*: a
   * quoted-milestone stage sits in the revenue column for display, but a
   * quote with no signature is the most actionable pile-up there is.
   */
  conversionDestinationNodeIds(): string[];
}

export interface BuildFlowTopologyOptions {
  registry: JourneyRegistry;
  funnels: FunnelRegistry;
  /** Boot-time collision warnings go here. Silent when omitted. */
  logger?: Logger;
}

/**
 * Which tier a funnel stage lives in: everything is `activation` UNTIL the
 * money stages — the quoted milestone, and every stage at-or-after the won
 * milestone (a post-sale stage like `onboarded` is still revenue-side, not a
 * fresh activation step).
 */
function stageTier(funnel: DefinedFunnel, stageId: string): SurfaceTier {
  const { stages, quotedStage, soldStage } = funnel.ladder;
  if (stageId === quotedStage) return "revenue";
  if (soldStage) {
    const soldRank = stages.indexOf(soldStage);
    const rank = stages.indexOf(stageId);
    if (soldRank >= 0 && rank >= soldRank) return "revenue";
  }
  return "activation";
}

/** "contract_signed" → "Contract signed" — the stage id is the only label we have. */
function humanize(id: string): string {
  const spaced = id.replace(/[_-]+/g, " ").trim();
  return spaced.charAt(0).toUpperCase() + spaced.slice(1);
}

/**
 * Build the classifier + node set from the live registries. Called once per
 * process by `createHogsendClient` (both API and worker), after both registries
 * exist.
 */
export function buildFlowTopology({
  registry,
  funnels,
  logger,
}: BuildFlowTopologyOptions): FlowTopology {
  const nodes = new Map<string, FlowNode>();

  // 1 — journeys. Registered (not just enabled): a journey turned off today
  // still owns the events it stamped yesterday, and the window looks backwards.
  const journeyMetas: JourneyMeta[] = registry.getAll();
  const journeyIds = journeyMetas.map((m) => m.id);
  for (const meta of journeyMetas) {
    nodes.set(journeyNodeId(meta.id), {
      id: journeyNodeId(meta.id),
      kind: "journey",
      name: meta.name || meta.id,
      tier: "retention",
    });
  }

  // 2 — funnel stages, and the event→stage rules that reach them.
  const eventToNode = new Map<string, string>();
  const revenueNodes = new Map<string, string>();
  const conversionDestinations = new Set<string>([REVENUE_NODE_ID]);
  for (const funnel of funnels.getAll()) {
    const funnelId = funnel.meta.id;
    const funnelName = funnel.meta.name || funnelId;
    const addStage = (stageId: string) => {
      const id = funnelStageNodeId(funnelId, stageId);
      if (!nodes.has(id)) {
        nodes.set(id, {
          id,
          kind: "funnelStage",
          name: `${funnelName} · ${humanize(stageId)}`,
          tier: stageTier(funnel, stageId),
        });
      }
      return id;
    };

    for (const stageId of funnel.ladder.stages) addStage(stageId);
    // Attributed revenue lands on the won stage — else the last stage, which
    // is the closest thing to "the end of the ladder" a funnel without a
    // declared `won` milestone has.
    const wonStage =
      funnel.ladder.soldStage ??
      funnel.ladder.stages[funnel.ladder.stages.length - 1];
    if (wonStage) {
      revenueNodes.set(funnelId, funnelStageNodeId(funnelId, wonStage));
    }
    // A contact at-or-past the won milestone converted — those stages can
    // never be a pile-up. Stages BEFORE it (including quoted) absolutely can.
    if (funnel.ladder.soldStage) {
      const soldRank = funnel.ladder.stages.indexOf(funnel.ladder.soldStage);
      if (soldRank >= 0) {
        for (const stageId of funnel.ladder.stages.slice(soldRank)) {
          conversionDestinations.add(funnelStageNodeId(funnelId, stageId));
        }
      }
    }

    for (const transition of funnel.transitions) {
      // `lost` is not in the ladder (defineFunnel forbids it) but it IS a place
      // a contact ends up — mint it as a node so the classifier never emits an
      // id the node list doesn't carry.
      const nodeId = addStage(transition.stageId);
      const existing = eventToNode.get(transition.event);
      if (!existing) {
        eventToNode.set(transition.event, nodeId);
        continue;
      }
      // First match wins — in BOTH compilations (the SQL CASE is emitted in
      // this map's insertion order), so a collision is deterministic, not a
      // coin-flip. Still worth a boot warning: it means one stage never lights.
      if (existing !== nodeId) {
        logger?.warn(
          `flow map: event "${transition.event}" is claimed by two funnel stages ` +
            `("${existing}" and "${nodeId}") — the map classifies it to the first. ` +
            "Give each stage its own trigger event.",
        );
      }
    }
  }

  // Informational: a funnel trigger that also enrolls a journey. Not a bug (the
  // journey's OWN events carry `properties.journeyId` and classify to the
  // journey node) — but worth saying out loud, because the trigger event itself
  // is drawn on the funnel stage, not on the journey.
  for (const event of eventToNode.keys()) {
    if (registry.getByTriggerEvent(event).length > 0) {
      logger?.info(
        `flow map: "${event}" both triggers a journey and moves a funnel stage — ` +
          "the event is drawn on the funnel stage; the journey's own sends/opens " +
          "carry its journeyId and draw on the journey node.",
      );
    }
  }

  // 3 — the builtin money node.
  nodes.set(REVENUE_NODE_ID, {
    id: REVENUE_NODE_ID,
    kind: "builtin",
    name: "Revenue",
    tier: "revenue",
  });

  const journeyIdSet = new Set(journeyIds);

  return {
    nodes: () => [...nodes.values()],
    node: (id) => nodes.get(id),

    classifyEvent(event) {
      // (1) journey stamp
      const stamped = event.properties?.journeyId;
      if (typeof stamped === "string" && journeyIdSet.has(stamped)) {
        return journeyNodeId(stamped);
      }
      // (2) funnel stage trigger
      const stage = eventToNode.get(event.event);
      if (stage) return stage;
      // (3) P3 seam — surface exact / prefix / source rules go HERE.
      // (4) money. `user_events.value` is numeric(14,2), so the SQL
      // compilation sees the STORED (2dp-rounded) value — round here too, or
      // a live 0.004 would be revenue while the same stored row is not.
      if (event.value !== null && Math.round(event.value * 100) > 0) {
        return REVENUE_NODE_ID;
      }
      // (5) unclassified
      return null;
    },

    classifierSql() {
      const whens: SQL[] = [];
      if (journeyIds.length > 0) {
        // `jsonb_typeof(...) = 'string'` mirrors the TS `typeof jid === "string"`
        // guard exactly — without it a numeric `journeyId: 7` would stringify to
        // '7' in SQL and match a journey literally named "7" while TS rejected it.
        whens.push(
          sql`when jsonb_typeof(properties -> 'journeyId') = 'string'
                and properties ->> 'journeyId' in (${sql.join(
                  journeyIds.map((id) => sql`${id}`),
                  sql`, `,
                )})
              then ${JOURNEY_PREFIX}::text || (properties ->> 'journeyId')`,
        );
      }
      for (const [event, nodeId] of eventToNode) {
        whens.push(sql`when event = ${event} then ${nodeId}::text`);
      }
      // P3 seam — surface rules compile in HERE, in the same position as TS.
      whens.push(
        sql`when value is not null and value > 0 then ${REVENUE_NODE_ID}::text`,
      );
      return sql`case ${sql.join(whens, sql` `)} else null end`;
    },

    revenueNodeFor: (funnelId) => revenueNodes.get(funnelId),

    conversionDestinationNodeIds: () => [...conversionDestinations],
  };
}
