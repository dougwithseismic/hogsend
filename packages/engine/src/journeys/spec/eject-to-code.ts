import type { JourneySpec, JourneyStep, SpecCondition } from "@hogsend/core";

/**
 * Promote-to-code (Slice 3): render a validated {@link JourneySpec} as the
 * equivalent `defineJourney(...)` TypeScript source. This is the graduation path
 * — the "fast lane INTO code" — so a team can start a journey as data and, when
 * it needs real control flow or a custom step, eject to a normal code journey.
 *
 * The output is a faithful 1:1 translation of the interpreter, not a beautifier:
 * every step maps to the same `ctx.*` / `sendEmail` primitive the runtime uses.
 * It is a STARTING POINT — the header comment tells the developer to swap the
 * string template keys for their `Templates` constants and tidy the conditions.
 */
export function ejectSpecToCode(spec: JourneySpec): string {
  const constName = `${toCamel(spec.id)}Journey`;
  const body = stepsToLines(spec.steps, 2).join("\n");

  return `// Auto-generated from a JSON journey spec by promote-to-code.
// STARTING POINT — refine before shipping: replace the string template keys with
// your \`Templates\` constants, and tidy any mechanical branch conditions.
import { defineJourney, sendEmail } from "@hogsend/engine";

export const ${constName} = defineJourney({
  meta: ${indentBlock(literal(metaObject(spec)), 1).trimStart()},
  run: async (user, ctx) => {
${body}
  },
});
`;
}

// ---------------------------------------------------------------------------
// Meta
// ---------------------------------------------------------------------------

function metaObject(spec: JourneySpec): Record<string, unknown> {
  // Reassemble the JourneyMeta shape defineJourney expects (id + spec.meta).
  return { id: spec.id, ...spec.meta };
}

// ---------------------------------------------------------------------------
// Steps → statements
// ---------------------------------------------------------------------------

function stepsToLines(steps: JourneyStep[], indent: number): string[] {
  const pad = "  ".repeat(indent);
  const lines: string[] = [];
  for (const step of steps) {
    switch (step.type) {
      case "send_email": {
        const props = step.props
          ? `\n${pad}  props: ${literal(step.props)},`
          : "";
        lines.push(
          `${pad}await sendEmail({`,
          `${pad}  to: user.email,`,
          `${pad}  userId: user.id,`,
          `${pad}  journeyStateId: user.stateId,`,
          `${pad}  journeyName: user.journeyName,`,
          `${pad}  template: ${str(step.template)}, // TODO: use your Templates constant`,
          `${pad}  subject: ${str(step.subject)},${props}`,
          `${pad}  idempotencyLabel: ${str(step.id)},`,
          `${pad}});`,
        );
        break;
      }
      case "sleep":
        lines.push(
          `${pad}await ctx.sleep({ duration: ${literal(step.duration)}, label: ${str(step.id)} });`,
        );
        break;
      case "sleep_until":
        lines.push(
          `${pad}await ctx.sleepUntil(${str(step.at)}, { label: ${str(step.id)} });`,
        );
        break;
      case "wait_for_event": {
        const lookback = step.lookback
          ? `, lookback: ${literal(step.lookback)}`
          : "";
        lines.push(
          `${pad}const ${waitVar(step.id)} = await ctx.waitForEvent({ event: ${str(step.event)}, timeout: ${literal(step.timeout)}${lookback}, label: ${str(step.id)} });`,
        );
        break;
      }
      case "checkpoint":
        lines.push(`${pad}await ctx.checkpoint(${str(step.id)});`);
        break;
      case "trigger_event": {
        const props = step.properties
          ? `, properties: ${literal(step.properties)}`
          : "";
        lines.push(
          `${pad}await ctx.trigger({ event: ${str(step.event)}, userId: user.id${props}, idempotencyLabel: ${str(step.id)} });`,
        );
        break;
      }
      case "end":
        lines.push(`${pad}return;`);
        break;
      case "branch": {
        lines.push(`${pad}if (${conditionExpr(step.if)}) {`);
        lines.push(...stepsToLines(step.yes, indent + 1));
        if (step.no && step.no.length > 0) {
          lines.push(`${pad}} else {`);
          lines.push(...stepsToLines(step.no, indent + 1));
        }
        lines.push(`${pad}}`);
        break;
      }
    }
  }
  return lines;
}

// ---------------------------------------------------------------------------
// Conditions → boolean expressions
// ---------------------------------------------------------------------------

const OP: Record<string, string> = {
  eq: "===",
  neq: "!==",
  gt: ">",
  gte: ">=",
  lt: "<",
  lte: "<=",
};

function conditionExpr(cond: SpecCondition): string {
  switch (cond.type) {
    case "property": {
      const key = `user.properties[${str(cond.property)}]`;
      if (cond.operator === "exists") return `${key} != null`;
      if (cond.operator === "not_exists") return `${key} == null`;
      if (cond.operator === "contains")
        return `String(${key} ?? "").includes(${str(String(cond.value ?? ""))})`;
      const op = OP[cond.operator];
      if (op) return `${key} ${op} ${literal(cond.value)}`;
      // Unknown operator — emit a readable fallback the developer can finish.
      return `/* TODO: ${cond.operator} */ Boolean(${key})`;
    }
    case "event": {
      const within = cond.within ? `, within: ${literal(cond.within)}` : "";
      const call = `(await ctx.history.hasEvent({ userId: user.id, event: ${str(cond.eventName)}${within} }))`;
      if (cond.check === "not_exists") return `!${call}.found`;
      if (cond.check === "count" && cond.operator && cond.value !== undefined) {
        const op = OP[cond.operator] ?? "===";
        return `${call}.count ${op} ${literal(cond.value)}`;
      }
      return `${call}.found`;
    }
    case "wait_result":
      // References the `const <id>Result` bound by the wait_for_event step.
      return cond.fired
        ? `!${waitVar(cond.of)}.timedOut`
        : `${waitVar(cond.of)}.timedOut`;
    case "composite": {
      const joiner = cond.operator === "and" ? " && " : " || ";
      return `(${cond.conditions.map(conditionExpr).join(joiner)})`;
    }
  }
}

// ---------------------------------------------------------------------------
// Formatting helpers
// ---------------------------------------------------------------------------

/** A JS identifier for a wait step's result binding. */
function waitVar(stepId: string): string {
  return `${toCamel(stepId)}Result`;
}

/** kebab/snake id → a safe camelCase identifier (leading digit prefixed). */
function toCamel(id: string): string {
  const camel = id
    .replace(/[^a-zA-Z0-9]+(.)?/g, (_, ch: string | undefined) =>
      ch ? ch.toUpperCase() : "",
    )
    .replace(/^[^a-zA-Z_$]/, (m) => `_${m}`);
  return camel || "journey";
}

/** JSON string literal (safely escaped). */
function str(value: string): string {
  return JSON.stringify(value);
}

/** A JS object/value literal via JSON (deterministic, safely escaped). */
function literal(value: unknown): string {
  return JSON.stringify(value, null, 2);
}

/** Re-indent a multi-line block to `indent` levels (2 spaces each). */
function indentBlock(block: string, indent: number): string {
  const pad = "  ".repeat(indent);
  return block
    .split("\n")
    .map((line) => `${pad}${line}`)
    .join("\n");
}
