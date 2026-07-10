import type { ConditionEval, PropertyCondition } from "../types/conditions.js";

export type JourneyNodeType =
  | "start"
  | "sleep"
  | "sleepUntil"
  | "wait"
  | "digest"
  | "send"
  | "connector"
  | "checkpoint"
  | "trigger"
  | "capture"
  | "branch"
  | "decision"
  | "end-completed"
  | "end-exited"
  | "end-failed"
  | "unknown";

/** Fields shared by every {@link JourneyNode} variant. */
export interface JourneyNodeBase {
  /** == authored label where possible (joins to currentNodeId) */
  id: string;
  /** human label for the node header */
  title: string;
  /** e.g. duration "14 days", event name, template key */
  subtitle?: string;
  /** source line (best-effort, for "jump to code") */
  line?: number;
}

/**
 * Meta flags shared by every variant. `unstable` is a property of the node
 * *id* (any node type can carry a synthetic/high-cardinality id), so it lives
 * on the shared base rather than on individual variants.
 */
export interface JourneyNodeMetaBase {
  /** true if id is synthetic/high-cardinality */
  unstable?: boolean;
}

/** Entry point; carries the trigger event (subtitle) + `trigger.where` chips. */
export interface JourneyStartNode extends JourneyNodeBase {
  type: "start";
  meta?: JourneyNodeMetaBase & {
    /** `trigger.where` conditions (resolved `PropertyCondition[]` form) */
    conditions?: PropertyCondition[];
  };
}

/** `ctx.sleep({ duration })` */
export interface JourneySleepNode extends JourneyNodeBase {
  type: "sleep";
  meta?: JourneyNodeMetaBase & {
    /** DurationObject for sleep (verbatim from source — best-effort) */
    duration?: Record<string, number>;
  };
}

/** `ctx.sleepUntil(at)` — the instant is dynamic, so no static meta. */
export interface JourneySleepUntilNode extends JourneyNodeBase {
  type: "sleepUntil";
  meta?: JourneyNodeMetaBase;
}

/** `ctx.waitForEvent({ event, timeout })` */
export interface JourneyWaitNode extends JourneyNodeBase {
  type: "wait";
  meta?: JourneyNodeMetaBase & {
    /** awaited event name */
    event?: string;
    /** waitForEvent timeout */
    timeout?: Record<string, number>;
  };
}

/** `ctx.digest({ window, event? })` */
export interface JourneyDigestNode extends JourneyNodeBase {
  type: "digest";
  meta?: JourneyNodeMetaBase & {
    /** digested event name (defaults to the trigger event at runtime) */
    event?: string;
    /** the digest window */
    duration?: Record<string, number>;
  };
}

/** `sendEmail({ template, idempotencyLabel? })` */
export interface JourneySendNode extends JourneyNodeBase {
  type: "send";
  meta?: JourneyNodeMetaBase & {
    /** send templateKey (→ preview) */
    template?: string;
    idempotencyLabel?: string;
  };
}

/** `sendConnectorAction({ connectorId, action })` */
export interface JourneyConnectorNode extends JourneyNodeBase {
  type: "connector";
  meta?: JourneyNodeMetaBase & {
    connectorId?: string;
    action?: string;
  };
}

/** `ctx.checkpoint(label)` */
export interface JourneyCheckpointNode extends JourneyNodeBase {
  type: "checkpoint";
  meta?: JourneyNodeMetaBase;
}

/** `ctx.trigger({ event })` */
export interface JourneyTriggerNode extends JourneyNodeBase {
  type: "trigger";
  meta?: JourneyNodeMetaBase & {
    /** triggered event name */
    event?: string;
  };
}

/** `getPostHog()?.capture()` / `.identify()` */
export interface JourneyCaptureNode extends JourneyNodeBase {
  type: "capture";
  meta?: JourneyNodeMetaBase;
}

/**
 * A fork in the flow. `decision` nodes are minted from branching `if`s by the
 * AST extractor (conditions best-effort); `branch` is the authored/data form.
 */
export interface JourneyDecisionNode extends JourneyNodeBase {
  type: "branch" | "decision";
  meta?: JourneyNodeMetaBase & {
    /** the real condition vocabulary — same one `trigger.where`/`exitOn` use */
    conditions?: ConditionEval[];
  };
}

/** Terminal states — completed / exited (exitOn) / failed (thrown). */
export interface JourneyEndNode extends JourneyNodeBase {
  type: "end-completed" | "end-exited" | "end-failed";
  meta?: JourneyNodeMetaBase;
}

/**
 * The display-tier escape hatch: an unresolved helper call the AST extractor
 * could not expand. Deliberately permissive meta — a degraded/best-effort
 * graph may attach anything here. Never executable (the blueprint
 * execution-tier schema rejects it outright).
 */
export interface JourneyUnknownNode extends JourneyNodeBase {
  type: "unknown";
  meta?: JourneyNodeMetaBase & { [key: string]: unknown };
}

/**
 * A journey graph node — a discriminated union on `type`, one variant per
 * {@link JourneyNodeType}, each with only the meta fields that node type
 * actually uses. A `switch (node.type)` over this union gets compiler-enforced
 * exhaustiveness; a `send` node can no longer structurally carry a `duration`.
 */
export type JourneyNode =
  | JourneyStartNode
  | JourneySleepNode
  | JourneySleepUntilNode
  | JourneyWaitNode
  | JourneyDigestNode
  | JourneySendNode
  | JourneyConnectorNode
  | JourneyCheckpointNode
  | JourneyTriggerNode
  | JourneyCaptureNode
  | JourneyDecisionNode
  | JourneyEndNode
  | JourneyUnknownNode;

export interface JourneyEdge {
  id: string;
  source: string;
  target: string;
  /** "14 days", "answered", "timed out", "score ≤ 6" */
  label?: string;
  kind?:
    | "default"
    | "timedOut"
    | "answered"
    | "conditional-true"
    | "conditional-false";
}

/**
 * Source location of a journey definition, for the Studio "open in editor"
 * affordance. Best-effort: absent when the engine could not capture a call site.
 */
export interface JourneySourceLocation {
  /** Absolute path of the file that called `defineJourney`. */
  path: string;
  /** 1-based line of the `defineJourney(...)` call. */
  line: number;
}

export interface JourneyGraph {
  journeyId: string;
  /** Where `defineJourney` was called (best-effort, for "open in editor"). */
  source?: JourneySourceLocation;
  nodes: JourneyNode[];
  edges: JourneyEdge[];
  /** true when built without source (meta+labels fallback) */
  degraded?: boolean;
  /** e.g. "loop not fully expanded", "dynamic template" */
  warnings?: string[];
}
