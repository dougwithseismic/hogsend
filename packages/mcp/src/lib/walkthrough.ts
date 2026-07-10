/**
 * Plain-English walkthroughs — how a non-technical user "reads" a journey.
 * Two sources: a JourneySpec (data journeys — exact) or a graph's node list
 * (code journeys — best-effort linear narration).
 */

import type { JourneySpec, JourneyStep, SpecCondition } from "@hogsend/core";

function duration(d: {
  hours?: number;
  minutes?: number;
  seconds?: number;
}): string {
  const parts: string[] = [];
  const h = d.hours ?? 0;
  if (h >= 24 && h % 24 === 0)
    parts.push(`${h / 24} day${h === 24 ? "" : "s"}`);
  else if (h) parts.push(`${h} hour${h === 1 ? "" : "s"}`);
  if (d.minutes) parts.push(`${d.minutes} minute${d.minutes === 1 ? "" : "s"}`);
  if (d.seconds) parts.push(`${d.seconds} second${d.seconds === 1 ? "" : "s"}`);
  return parts.join(" ") || "0 seconds";
}

function stepLines(steps: JourneyStep[], indent: string): string[] {
  const lines: string[] = [];
  for (const step of steps) {
    switch (step.type) {
      case "send_email":
        lines.push(
          `${indent}Send the "${step.template}" email (subject: "${step.subject}")`,
        );
        break;
      case "sleep":
        lines.push(`${indent}Wait ${duration(step.duration)}`);
        break;
      case "sleep_until":
        lines.push(`${indent}Wait until ${step.at}`);
        break;
      case "wait_for_event":
        lines.push(
          `${indent}Wait up to ${duration(step.timeout)} for the "${step.event}" event`,
        );
        break;
      case "branch": {
        lines.push(`${indent}If ${describeCondition(step.if)}:`);
        lines.push(...stepLines(step.yes, `${indent}  `));
        if (step.no?.length) {
          lines.push(`${indent}Otherwise:`);
          lines.push(...stepLines(step.no, `${indent}  `));
        }
        break;
      }
      case "checkpoint":
        lines.push(`${indent}Mark progress ("${step.id}")`);
        break;
      case "trigger_event":
        lines.push(`${indent}Fire the "${step.event}" event`);
        break;
      case "end":
        lines.push(`${indent}End the journey here`);
        break;
    }
  }
  return lines;
}

function describeCondition(cond: SpecCondition): string {
  switch (cond.type) {
    case "property":
      return cond.operator === "exists"
        ? `the user has a "${cond.property}" property`
        : cond.operator === "not_exists"
          ? `the user has no "${cond.property}" property`
          : `the user's "${cond.property}" ${cond.operator} ${JSON.stringify(cond.value)}`;
    case "event":
      return cond.check === "not_exists"
        ? `the "${cond.eventName}" event has NOT happened`
        : `the "${cond.eventName}" event has happened`;
    case "wait_result":
      return cond.fired
        ? "the awaited event arrived in time"
        : "the wait timed out";
    case "composite":
      return cond.conditions
        .map(describeCondition)
        .join(cond.operator === "and" ? " AND " : " OR ");
  }
}

/** Numbered walkthrough of a JourneySpec (data journeys — exact). */
export function specWalkthrough(spec: JourneySpec): string {
  const lines: string[] = [
    `Starts when "${spec.meta.trigger.event}" fires (entry: ${spec.meta.entryLimit}).`,
  ];
  if (spec.meta.exitOn?.length) {
    lines.push(
      `Exits immediately if ${spec.meta.exitOn.map((e) => `"${e.event}"`).join(" or ")} fires.`,
    );
  }
  lines.push(...stepLines(spec.steps, ""));
  return lines.map((l, i) => `${i + 1}. ${l.trimStart()}`).join("\n");
}

/** Best-effort narration for a code journey from its graph nodes. */
export function graphWalkthrough(
  nodes: Array<{ id: string; type: string; title?: string; subtitle?: string }>,
): string {
  const label = (n: { title?: string; subtitle?: string; id: string }) =>
    [n.title, n.subtitle].filter(Boolean).join(" — ") || n.id;
  return nodes
    .filter((n) => n.type !== "end-completed" && n.type !== "end-exited")
    .map((n, i) => `${i + 1}. [${n.type}] ${label(n)}`)
    .join("\n");
}
