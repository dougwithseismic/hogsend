export type JourneyNodeType =
  | "start"
  | "sleep"
  | "sleepUntil"
  | "wait"
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

export interface JourneyNode {
  /** == authored label where possible (joins to currentNodeId) */
  id: string;
  type: JourneyNodeType;
  /** human label for the node header */
  title: string;
  /** e.g. duration "14 days", event name, template key */
  subtitle?: string;
  meta?: {
    /** DurationObject for sleep */
    duration?: Record<string, number>;
    /** waitForEvent timeout */
    timeout?: Record<string, number>;
    /** wait/trigger event */
    event?: string;
    /** send templateKey (→ preview) */
    template?: string;
    idempotencyLabel?: string;
    /** sendConnectorAction */
    connectorId?: string;
    action?: string;
    /** PropertyCondition[] for trigger/exit/where */
    conditions?: unknown[];
    /** true if id is synthetic/high-cardinality */
    unstable?: boolean;
  };
  /** source line (best-effort, for "jump to code") */
  line?: number;
}

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
