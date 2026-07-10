import type { DurationObject } from "../duration.js";
import type {
  CompositeCondition,
  EventCondition,
  PropertyCondition,
} from "../types/conditions.js";
import type { JourneyMeta } from "../types/journey.js";

/**
 * A journey authored as DATA — a validated, declarative spec executed by the
 * engine's step interpreter (`journeyFromSpec` in `@hogsend/engine`).
 *
 * Design contract (docs/json-journeys-thin-slice-plan.md):
 *  - The spec is a STRICT SUBSET of what `defineJourney` can express. Every
 *    step maps 1:1 onto an existing `ctx.*` / `sendEmail` primitive; there is
 *    nothing a spec journey can do that a TypeScript journey can't.
 *  - Step `id`s are author-stable and become the durable labels: they key the
 *    exactly-once idempotency machinery, `journeyStates.currentNodeId`, the
 *    flow-graph node ids, and `journey_logs` — one identifier through the
 *    whole stack.
 *  - The format is irrelevant: JSON, YAML, or a TS object literal all converge
 *    on this shape. The engine only ever sees the parsed object.
 */

/** Meta is the authored subset of {@link JourneyMeta} (conditions are plain data). */
export type JourneySpecMeta = Omit<JourneyMeta, "id">;

// ---------------------------------------------------------------------------
// Conditions
// ---------------------------------------------------------------------------

/**
 * Branch on the outcome of a prior `wait_for_event` step. `of` must reference
 * a `wait_for_event` step that appears earlier in the walk order; `fired: true`
 * matches when the event arrived before the timeout.
 */
export interface WaitResultCondition {
  type: "wait_result";
  of: string;
  fired: boolean;
}

/**
 * Conditions a spec branch may evaluate. Deliberately narrower than the full
 * `ConditionEval`: `email_engagement` needs direct DB access the interpreter
 * doesn't have (and shouldn't — it runs purely over `JourneyContext`). Property
 * conditions evaluate against the enrollment properties; event conditions go
 * through `ctx.history.hasEvent`.
 */
export type SpecCondition =
  | PropertyCondition
  | EventCondition
  | WaitResultCondition
  | SpecCompositeCondition;

export interface SpecCompositeCondition
  extends Omit<CompositeCondition, "conditions"> {
  type: "composite";
  operator: "and" | "or";
  conditions: SpecCondition[];
}

// ---------------------------------------------------------------------------
// Steps
// ---------------------------------------------------------------------------

interface BaseStep {
  /**
   * Author-stable identifier, unique within the spec. Becomes the durable
   * label for this step (idempotency key site, currentNodeId, graph node id).
   */
  id: string;
}

/** `sendEmail(...)` with `idempotencyLabel = id`. */
export interface SendEmailStep extends BaseStep {
  type: "send_email";
  /** Registered template key — validated against the registry at load time. */
  template: string;
  subject: string;
  /** Extra template props merged over the engine-injected defaults. */
  props?: Record<string, unknown>;
}

/** `ctx.sleep({ duration, label: id })`. */
export interface SleepStep extends BaseStep {
  type: "sleep";
  duration: DurationObject;
}

/** `ctx.sleepUntil(at, { label: id })`. */
export interface SleepUntilStep extends BaseStep {
  type: "sleep_until";
  /** Absolute instant, ISO-8601. */
  at: string;
}

/** `ctx.waitForEvent({ event, timeout, label: id })`. */
export interface WaitForEventStep extends BaseStep {
  type: "wait_for_event";
  event: string;
  timeout: DurationObject;
  /** Optional lookback window checked against recent events first. */
  lookback?: DurationObject;
}

/**
 * `if (condition) { yes } else { no }` — arms are step sequences. Named
 * `yes`/`no` (not `then`/`else`): they match the flow canvas edge labels, and
 * a `then` property would make every spec object thenable-shaped (a real
 * footgun around `await`, and a lint error in most configs).
 */
export interface BranchStep extends BaseStep {
  type: "branch";
  if: SpecCondition;
  yes: JourneyStep[];
  no?: JourneyStep[];
}

/** `ctx.checkpoint(id)`. */
export interface CheckpointStep extends BaseStep {
  type: "checkpoint";
}

/** `ctx.trigger({ event, ... , idempotencyLabel: id })`. */
export interface TriggerEventStep extends BaseStep {
  type: "trigger_event";
  event: string;
  properties?: Record<string, unknown>;
}

/** Terminates the walk — the journey completes here. */
export interface EndStep extends BaseStep {
  type: "end";
}

export type JourneyStep =
  | SendEmailStep
  | SleepStep
  | SleepUntilStep
  | WaitForEventStep
  | BranchStep
  | CheckpointStep
  | TriggerEventStep
  | EndStep;

// ---------------------------------------------------------------------------
// The spec
// ---------------------------------------------------------------------------

export interface JourneySpec {
  /** Spec schema version — bump on breaking step-vocabulary changes. */
  specVersion: 1;
  /** Journey id (registry key; unique across code + spec journeys). */
  id: string;
  meta: JourneySpecMeta;
  steps: JourneyStep[];
}
