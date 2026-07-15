/**
 * Flow-map topology — the shared vocabulary every phase of the control room
 * agrees on, PLUS (P2) the registry-backed classifier that decides which node
 * an event belongs to, PLUS (P3) `defineSurface` external touchpoints.
 *
 * A flow node is one place a contact can *be* in the growth machine (a surface
 * they touched, a journey they're enrolled in, a funnel stage they've reached);
 * a tier is the lifecycle column it lives in.
 *
 * The classifier is compiled TWICE from the SAME ordered rule list:
 * - {@link FlowTopology.classifyEvent} — TS, for the per-event live path (P4).
 * - {@link FlowTopology.classifierSql} — a SQL `CASE`, for the windowed
 *   aggregate query (flow-map / flow-dwell).
 * They MUST agree on every input — the parity test (`admin-flow-curated.test.ts`
 * / `admin-flow-surfaces.test.ts`) runs a table of synthetic events through
 * both and asserts identical node ids. If you add a rule, add it to both
 * compilations in the same position.
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
 *   3. A `defineSurface` match, in this sub-order (the P3 seam):
 *      3a. an EXACT `events` name (declaration order across surfaces);
 *      3b. an `eventPrefix` — LONGEST prefix wins across ALL surfaces, ties by
 *          declaration order;
 *      3c. a `source` match AND-ed with the `where` refinement (declaration
 *          order). `where` is a SQL-compilable subset over TOP-LEVEL scalar
 *          properties.
 *   4. A positive `value` → the builtin `revenue` node.
 *   5. Nothing → NULL (the event is dropped from the map).
 */
import type {
  DefinedFunnel,
  JourneyMeta,
  SurfaceTier,
  SurfaceWhereCondition,
} from "@hogsend/core";
import type { JourneyRegistry } from "@hogsend/core/registry";
import { type SQL, sql } from "drizzle-orm";
import type { FunnelRegistry } from "./funnel-registry.js";
import type { Logger } from "./logger.js";
import type { SurfaceRegistry } from "./surface-registry.js";

/** Lifecycle column a node is drawn in — the flow map's x-axis. Re-exported
 * from `@hogsend/core` (the single source of truth) so
 * `import { SurfaceTier } from "@hogsend/engine"` keeps working. */
export type { SurfaceTier };

/** What a node *is* — decides its icon + drill-down in Studio. */
export type FlowNodeKind = "surface" | "journey" | "funnelStage" | "builtin";

export interface FlowNode {
  id: string;
  kind: FlowNodeKind;
  name: string;
  tier: SurfaceTier;
  /** Surface rendering hint (`defineSurface({ display: "source" })`). */
  display?: "source";
}

/** The builtin money node — every valued event nothing else claims lands here. */
export const REVENUE_NODE_ID = "revenue";

const JOURNEY_PREFIX = "journey:";
const SURFACE_PREFIX = "surface:";

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

/** Node id for a declared surface. */
export function surfaceNodeId(surfaceId: string): string {
  return `${SURFACE_PREFIX}${surfaceId}`;
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
  /** Every node the classifier can emit, registry order (journeys → funnels → surfaces → revenue). */
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
  /** Declared external surfaces (P3). Empty registry = no surface nodes. */
  surfaces: SurfaceRegistry;
  /** Boot-time collision warnings go here. Silent when omitted. */
  logger?: Logger;
}

/** One compiled surface rule set for a single surface node. */
interface SurfacePrefixRule {
  prefix: string;
  nodeId: string;
}
interface SurfaceSourceRule {
  nodeId: string;
  sources?: string[];
  where?: SurfaceWhereCondition[];
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

/** Normalize a `string | string[] | undefined` match dimension to an array. */
function toArray(value: string | string[] | undefined): string[] {
  if (value === undefined) return [];
  return Array.isArray(value) ? value : [value];
}

/**
 * Escape LIKE-special chars (`% _ \`) so a bound prefix/substring can only ever
 * match LITERALLY. Postgres LIKE's default escape char is backslash, and the
 * value crosses the wire as a BOUND parameter (no SQL-string-literal parsing),
 * so escaping the three specials is sufficient — a prefix of "docs." can never
 * wildcard-match, and "100%_launch." matches only itself.
 */
function escapeLike(value: string): string {
  return value.replace(/[\\%_]/g, (c) => `\\${c}`);
}

/**
 * eq/neq/contains are STRING comparisons by definition — the TS mirror of the
 * SQL string-only accessor ({@link surfaceScalarTextSql}). A property matches
 * only when its value is a STRING; a number or boolean never matches, in BOTH
 * compilations.
 *
 * Why string-only: Postgres prints jsonb numbers CANONICALLY (`1e21` becomes
 * `'1000000000000000000000'`, and a non-JS writer's `1.50` keeps its trailing
 * zero), which JS `String()` can never reproduce — so a numeric-property eq
 * could silently disagree between the live and windowed classifiers. Forcing
 * string typing removes the possibility by construction. (Authors: store
 * comparable values as strings.)
 */
function stringProp(
  props: Record<string, unknown> | null | undefined,
  key: string,
): string | null {
  const value = props?.[key];
  return typeof value === "string" ? value : null;
}

/**
 * Storage-faithful key presence, the TS mirror of `jsonb_exists`: an OWN key
 * whose value is not `undefined`. `JSON.stringify` DROPS undefined-valued keys,
 * so an in-process `{k: undefined}` (reachable on the P4 live path) stores no
 * key and SQL says false — TS must agree. A JSON `null` value still counts as
 * present, and `Object.hasOwn` (not `k in props`) keeps an inherited member
 * like "constructor" from falsely matching.
 */
function keyPresent(
  props: Record<string, unknown> | null | undefined,
  key: string,
): boolean {
  return props != null && Object.hasOwn(props, key) && props[key] !== undefined;
}

/** TS evaluation of ONE surface `where` condition (mirrors {@link surfaceCondSql}). */
function surfaceCondMatchesTs(
  props: Record<string, unknown> | null | undefined,
  cond: SurfaceWhereCondition,
): boolean {
  const key = cond.property;
  switch (cond.operator) {
    case "exists":
      return keyPresent(props, key);
    case "not_exists":
      return !keyPresent(props, key);
    case "eq": {
      const text = stringProp(props, key);
      return text !== null && text === cond.value;
    }
    // Missing (or non-string) property does NOT match neq (the SQL `<>` yields
    // NULL → false).
    case "neq": {
      const text = stringProp(props, key);
      return text !== null && text !== cond.value;
    }
    case "contains": {
      const text = stringProp(props, key);
      return (
        text !== null && cond.value !== undefined && text.includes(cond.value)
      );
    }
    default:
      return false;
  }
}

function surfaceWhereMatchesTs(
  props: Record<string, unknown> | null | undefined,
  where: SurfaceWhereCondition[],
): boolean {
  return where.every((cond) => surfaceCondMatchesTs(props, cond));
}

/**
 * The string-only jsonb accessor: the property's text only when it is a jsonb
 * STRING, else NULL. Numbers/booleans/objects never match eq/neq/contains, so
 * the compilation can never disagree with TS over canonical number printing
 * (see {@link stringProp}).
 */
function surfaceStringTextSql(key: string): SQL {
  return sql`(case when jsonb_typeof(properties -> ${key}) = 'string'
              then properties ->> ${key} else null end)`;
}

/** SQL compilation of ONE surface `where` condition (mirrors {@link surfaceCondMatchesTs}). */
function surfaceCondSql(cond: SurfaceWhereCondition): SQL {
  const key = cond.property;
  switch (cond.operator) {
    case "exists":
      return sql`(properties is not null and jsonb_exists(properties, ${key}))`;
    case "not_exists":
      return sql`(properties is null or not jsonb_exists(properties, ${key}))`;
    case "eq":
      return sql`(${surfaceStringTextSql(key)} = ${cond.value})`;
    case "neq":
      return sql`(${surfaceStringTextSql(key)} <> ${cond.value})`;
    case "contains":
      return sql`(${surfaceStringTextSql(key)} like ('%' || ${escapeLike(
        cond.value ?? "",
      )} || '%'))`;
    default:
      return sql`false`;
  }
}

function surfaceWhereSql(where: SurfaceWhereCondition[]): SQL {
  return sql.join(
    where.map((cond) => surfaceCondSql(cond)),
    sql` and `,
  );
}

/**
 * Build the classifier + node set from the live registries. Called once per
 * process by `createHogsendClient` (both API and worker), after the registries
 * exist.
 */
export function buildFlowTopology({
  registry,
  funnels,
  surfaces,
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
      // The journey's own declared lifecycle stage; retention is the
      // historical default for the unannotated.
      tier: meta.tier ?? "retention",
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

  // 3 — surfaces (P3). Each surface mints ONE node; its match dimensions become
  // classifier rules at the seam (exact events → prefixes → source+where). The
  // three rule lists are built ONCE here and consumed by BOTH compilations, so
  // there is nothing for TS and SQL to disagree about.
  const surfaceExact = new Map<string, string>();
  const surfacePrefixRules: SurfacePrefixRule[] = [];
  const surfaceSourceRules: SurfaceSourceRule[] = [];
  const seenPrefixes = new Map<string, string>();
  for (const surface of surfaces.getAll()) {
    const surfaceId = surface.meta.id;
    const nodeId = surfaceNodeId(surfaceId);
    if (nodes.has(nodeId)) {
      logger?.warn(
        `flow map: surface "${surfaceId}" node id "${nodeId}" collides with an ` +
          "existing node — the surface is ignored.",
      );
      continue;
    }
    nodes.set(nodeId, {
      id: nodeId,
      kind: "surface",
      name: surface.meta.name || surfaceId,
      tier: surface.meta.tier,
      ...(surface.meta.display === "source" ? { display: "source" } : {}),
    });

    const { events, eventPrefix, source, where } = surface.meta.match;
    // 3a — exact events.
    for (const event of events ?? []) {
      if (eventToNode.has(event)) {
        logger?.warn(
          `flow map: surface "${surfaceId}" claims exact event "${event}", but a ` +
            "funnel stage already owns it — the funnel wins.",
        );
      }
      const existing = surfaceExact.get(event);
      if (existing === undefined) {
        surfaceExact.set(event, nodeId);
      } else if (existing !== nodeId) {
        logger?.warn(
          `flow map: exact event "${event}" is claimed by two surfaces — ` +
            "the first-declared wins.",
        );
      }
    }
    // 3b — prefixes.
    for (const prefix of toArray(eventPrefix)) {
      const firstNode = seenPrefixes.get(prefix);
      if (firstNode === undefined) {
        seenPrefixes.set(prefix, nodeId);
      } else if (firstNode !== nodeId) {
        logger?.warn(
          `flow map: two surfaces declare the identical prefix "${prefix}" — ` +
            "the first-declared wins.",
        );
      }
      surfacePrefixRules.push({ prefix, nodeId });
    }
    // 3c — source and/or where.
    if (source !== undefined || where !== undefined) {
      surfaceSourceRules.push({
        nodeId,
        ...(source !== undefined ? { sources: toArray(source) } : {}),
        ...(where !== undefined ? { where } : {}),
      });
    }
  }
  // Longest prefix first so "docs.api." beats "docs."; JS sort is stable, so
  // equal-length prefixes keep declaration order.
  surfacePrefixRules.sort((a, b) => b.prefix.length - a.prefix.length);

  // 4 — the builtin money node.
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
      // (3) surfaces — exact → prefix (longest first) → source+where.
      const exact = surfaceExact.get(event.event);
      if (exact) return exact;
      for (const rule of surfacePrefixRules) {
        if (event.event.startsWith(rule.prefix)) return rule.nodeId;
      }
      for (const rule of surfaceSourceRules) {
        const sourceOk =
          !rule.sources ||
          (event.source !== null && rule.sources.includes(event.source));
        const whereOk =
          !rule.where || surfaceWhereMatchesTs(event.properties, rule.where);
        if (sourceOk && whereOk) return rule.nodeId;
      }
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
      // P3 seam — surface rules compile in HERE, same order as the TS path.
      // 3a — exact events (map insertion = declaration order).
      for (const [event, nodeId] of surfaceExact) {
        whens.push(sql`when event = ${event} then ${nodeId}::text`);
      }
      // 3b — prefixes (longest first). Specials escaped so the prefix is literal.
      for (const rule of surfacePrefixRules) {
        whens.push(
          sql`when event like (${escapeLike(rule.prefix)} || '%') then ${rule.nodeId}::text`,
        );
      }
      // 3c — source (+where), declaration order.
      for (const rule of surfaceSourceRules) {
        const preds: SQL[] = [];
        if (rule.sources) {
          preds.push(
            sql`source in (${sql.join(
              rule.sources.map((s) => sql`${s}`),
              sql`, `,
            )})`,
          );
        }
        if (rule.where) preds.push(surfaceWhereSql(rule.where));
        whens.push(
          sql`when (${sql.join(preds, sql` and `)}) then ${rule.nodeId}::text`,
        );
      }
      // (4) money.
      whens.push(
        sql`when value is not null and value > 0 then ${REVENUE_NODE_ID}::text`,
      );
      return sql`case ${sql.join(whens, sql` `)} else null end`;
    },

    revenueNodeFor: (funnelId) => revenueNodes.get(funnelId),

    conversionDestinationNodeIds: () => [...conversionDestinations],
  };
}
