import type {
  BranchStep,
  JourneyContext,
  JourneySpec,
  JourneyStep,
  JourneyUser,
  SpecCondition,
} from "@hogsend/core";
import { evaluatePropertyConditions, journeySpecSchema } from "@hogsend/core";
import type { TemplateName } from "@hogsend/email";
import { sendEmail } from "../../lib/email.js";
import { type DefinedJourney, defineJourney } from "../define-journey.js";
import { registerJourneySpec } from "./spec-registry.js";

export { isJourneySpec } from "@hogsend/core";

/**
 * Turn a {@link JourneySpec} (JSON/YAML/object — the format is the caller's
 * business) into a completely ordinary {@link DefinedJourney}.
 *
 * The returned journey goes through `defineJourney` like any authored one, so
 * it inherits the full pipeline unchanged: Hatchet durable-task registration,
 * replay recovery, the enrollment guard chain, `journeyStates` lifecycle, and
 * terminal handling. The `run` function is a step interpreter that maps each
 * step 1:1 onto the existing context primitives, always passing the step id as
 * the durable label — which threads it through the exactly-once idempotency
 * keys, `currentNodeId`, `journey_logs`, and the flow-graph node ids.
 *
 * Validation happens HERE, at definition time (i.e. boot), never at send time:
 *   - shape via `journeySpecSchema`
 *   - step-id uniqueness across the whole tree
 *   - `wait_result.of` must reference a `wait_for_event` step that precedes it
 *   - when `opts.templateKeys` is provided, every `send_email.template` must be
 *     a registered key — a dead template reference fails the boot loudly
 *     instead of failing a real send months later.
 */
export function journeyFromSpec(
  input: unknown,
  opts: { templateKeys?: ReadonlySet<string> } = {},
): DefinedJourney {
  const spec = validateJourneySpec(input, opts);
  registerJourneySpec(spec);

  const journey = defineJourney({
    meta: { id: spec.id, ...spec.meta },
    run: makeSpecRun(spec),
  });
  return journey;
}

/**
 * Parse + referentially validate a spec WITHOUT any side effect (no
 * `registerJourneySpec`, no Hatchet task built). The write path (admin
 * `PUT /journey-specs/:id`) uses this to reject a bad spec at author time with
 * the same guarantees the boot loader enforces, so a stored row is always
 * valid-at-write. Throws a `ZodError` (shape) or an `Error` (referential) —
 * both carry an actionable message. Returns the typed, validated spec.
 */
export function validateJourneySpec(
  input: unknown,
  opts: { templateKeys?: ReadonlySet<string> } = {},
): JourneySpec {
  const spec = journeySpecSchema.parse(input);
  validateReferences(spec, opts.templateKeys);
  return spec;
}

// ---------------------------------------------------------------------------
// Definition-time referential validation
// ---------------------------------------------------------------------------

function validateReferences(
  spec: JourneySpec,
  templateKeys?: ReadonlySet<string>,
): void {
  const seen = new Set<string>();
  const waitIdsSoFar = new Set<string>();
  const problems: string[] = [];

  const visitCondition = (condition: SpecCondition, at: string): void => {
    if (condition.type === "wait_result") {
      // `waitIdsSoFar` is DFS-global: a wait in an earlier branch arm counts as
      // "preceding" even for a sibling/later arm. This is intentional — it only
      // rejects forward references and typos. Whether the referenced wait was
      // actually WALKED on a given enrollment's path is a runtime fact: if it
      // wasn't, `evaluateSpecCondition` treats the outcome as "did not fire"
      // (deterministic, replay-safe). We don't attempt path-dominance analysis.
      if (!waitIdsSoFar.has(condition.of)) {
        problems.push(
          `step "${at}": wait_result references "${condition.of}", which is not a preceding wait_for_event step`,
        );
      }
      return;
    }
    if (condition.type === "composite") {
      for (const child of condition.conditions) visitCondition(child, at);
    }
  };

  const visit = (steps: JourneyStep[]): void => {
    for (const step of steps) {
      if (seen.has(step.id)) {
        problems.push(`duplicate step id "${step.id}"`);
      }
      seen.add(step.id);

      if (step.type === "send_email" && templateKeys) {
        if (!templateKeys.has(step.template)) {
          problems.push(
            `step "${step.id}": template "${step.template}" is not in the email registry`,
          );
        }
      }
      if (step.type === "wait_for_event") {
        waitIdsSoFar.add(step.id);
      }
      if (step.type === "branch") {
        visitCondition(step.if, step.id);
        // Walk order == execution order: yes-arm, then no-arm.
        visit(step.yes);
        if (step.no) visit(step.no);
      }
    }
  };

  visit(spec.steps);

  if (problems.length > 0) {
    throw new Error(
      `journey spec "${spec.id}" is invalid:\n  - ${problems.join("\n  - ")}`,
    );
  }
}

// ---------------------------------------------------------------------------
// The interpreter
// ---------------------------------------------------------------------------

type WaitOutcome = Awaited<ReturnType<JourneyContext["waitForEvent"]>>;

/**
 * Build the interpreter `run` for a VALIDATED spec. Exported as a seam for
 * tests (and the future simulator), which drive the run through the real
 * journey boundary + context without registering a Hatchet task.
 */
export function makeSpecRun(spec: JourneySpec) {
  return async function runSpecJourney(
    user: JourneyUser,
    ctx: JourneyContext,
  ): Promise<void> {
    // Outcomes of wait_for_event steps, for wait_result branch conditions.
    // Walk-local (per enrollment); on a durable replay the waits re-resolve
    // deterministically through Hatchet, so the map converges to the same
    // values it held before the replay.
    const waits = new Map<string, WaitOutcome>();
    await execSequence(spec.steps, user, ctx, waits);
  };
}

/** Returns "ended" when an `end` step terminated the walk. */
async function execSequence(
  steps: JourneyStep[],
  user: JourneyUser,
  ctx: JourneyContext,
  waits: Map<string, WaitOutcome>,
): Promise<"continue" | "ended"> {
  for (const step of steps) {
    switch (step.type) {
      case "send_email": {
        await sendEmail({
          to: user.email,
          userId: user.id,
          journeyStateId: user.stateId,
          // Compile-time template safety comes from the consumer's augmented
          // TemplateName union — a spec's template arrives as a runtime string
          // instead, validated against the registry at DEFINITION time (see
          // validateReferences), which is the same guarantee delivered earlier.
          template: step.template as TemplateName,
          subject: step.subject,
          journeyName: user.journeyName,
          ...(step.props ? { props: step.props } : {}),
          idempotencyLabel: step.id,
        });
        break;
      }
      case "sleep": {
        await ctx.sleep({ duration: step.duration, label: step.id });
        break;
      }
      case "sleep_until": {
        await ctx.sleepUntil(step.at, { label: step.id });
        break;
      }
      case "wait_for_event": {
        const outcome = await ctx.waitForEvent({
          event: step.event,
          timeout: step.timeout,
          label: step.id,
          ...(step.lookback ? { lookback: step.lookback } : {}),
        });
        waits.set(step.id, outcome);
        break;
      }
      case "checkpoint": {
        await ctx.checkpoint(step.id);
        break;
      }
      case "trigger_event": {
        await ctx.trigger({
          event: step.event,
          userId: user.id,
          userEmail: user.email,
          ...(step.properties ? { properties: step.properties } : {}),
          idempotencyLabel: step.id,
        });
        break;
      }
      case "branch": {
        const matched = await evaluateSpecCondition(step, user, ctx, waits);
        const arm = matched ? step.yes : (step.no ?? []);
        const outcome = await execSequence(arm, user, ctx, waits);
        if (outcome === "ended") return "ended";
        break;
      }
      case "end": {
        return "ended";
      }
    }
  }
  return "continue";
}

async function evaluateSpecCondition(
  step: BranchStep,
  user: JourneyUser,
  ctx: JourneyContext,
  waits: Map<string, WaitOutcome>,
): Promise<boolean> {
  const evaluate = async (condition: SpecCondition): Promise<boolean> => {
    switch (condition.type) {
      case "property":
        return evaluatePropertyConditions({
          conditions: [condition],
          properties: user.properties,
        });
      case "event": {
        const { found, count } = await ctx.history.hasEvent({
          userId: user.id,
          event: condition.eventName,
          ...(condition.within ? { within: condition.within } : {}),
        });
        if (condition.check === "exists") return found;
        if (condition.check === "not_exists") return !found;
        return compareCount(count, condition.operator, condition.value);
      }
      case "wait_result": {
        const outcome = waits.get(condition.of);
        if (!outcome) {
          // Reachable only when the referenced wait sits on a branch arm this
          // enrollment never walked — treat as "did not fire".
          return condition.fired === false;
        }
        return condition.fired ? !outcome.timedOut : outcome.timedOut;
      }
      case "composite": {
        if (condition.operator === "and") {
          for (const child of condition.conditions) {
            if (!(await evaluate(child))) return false;
          }
          return true;
        }
        for (const child of condition.conditions) {
          if (await evaluate(child)) return true;
        }
        return false;
      }
    }
  };
  return evaluate(step.if);
}

function compareCount(
  count: number,
  operator: "gt" | "gte" | "lt" | "lte" | "eq" | undefined,
  value: number | undefined,
): boolean {
  if (operator === undefined || value === undefined) return count > 0;
  switch (operator) {
    case "gt":
      return count > value;
    case "gte":
      return count >= value;
    case "lt":
      return count < value;
    case "lte":
      return count <= value;
    case "eq":
      return count === value;
  }
}
