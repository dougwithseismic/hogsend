/**
 * The sentences the stack alert sweep sends, and the vocabulary they share
 * with it.
 *
 * Same posture as `billing-notice.ts`: the codes and their prose live
 * together, so a sweep can only fire a condition that has a sentence, and the
 * sentence is written once rather than assembled at the call site.
 *
 * The register is an operator at 2am, not a status page. Every line is a fact
 * about this stack, and each condition says what the control plane already
 * TRIED and what it will NOT do next — "no further re-drive will be attempted"
 * is the thing someone woken by this actually needs to know. No severity
 * words, no exclamation, no advice we cannot back with a fact from the row.
 */

/** The rules the sweep watches. Each has a sentence below; none may be added
 * without one. */
export const STACK_ALERT_CONDITIONS = [
  "non_running",
  "provision_exhausted",
  "needs_credentials",
] as const;

export type StackAlertCondition = (typeof STACK_ALERT_CONDITIONS)[number];

/** The short label an operator scans in a subject line. */
const CONDITION_LABELS: Record<StackAlertCondition, string> = {
  non_running: "stuck",
  provision_exhausted: "provisioning gave up",
  needs_credentials: "running without credentials",
};

export interface StackAlertFacts {
  stackId: string;
  organizationId: string;
  organizationName: string;
  environmentName: string;
  status: string;
  /** Last write to the row — how long it has looked like this. */
  since: Date;
  /** The instant the sweep read the row, so the elapsed time is not a guess. */
  now: Date;
  retryCount: number;
  attemptCeiling: number;
  lastError: string | null;
  /** Every condition firing for this stack on this tick, deduped upstream. */
  conditions: StackAlertCondition[];
}

/**
 * Whole units only, largest that fits. An operator reads "2 hours", acts on
 * "2 hours", and gains nothing from "2 hours 14 minutes 9 seconds".
 */
export function describeElapsed(fromMs: number, toMs: number): string {
  const seconds = Math.max(0, Math.floor((toMs - fromMs) / 1000));
  const minutes = Math.floor(seconds / 60);
  if (minutes < 1) return "less than a minute";
  const hours = Math.floor(minutes / 60);
  if (hours < 1) return minutes === 1 ? "1 minute" : `${minutes} minutes`;
  const days = Math.floor(hours / 24);
  if (days < 1) return hours === 1 ? "1 hour" : `${hours} hours`;
  return days === 1 ? "1 day" : `${days} days`;
}

/** The per-condition paragraph. Each ends on what did NOT happen. */
function conditionLine(
  condition: StackAlertCondition,
  facts: StackAlertFacts,
): string {
  switch (condition) {
    case "non_running":
      return [
        `Stuck: the stack has been "${facts.status}" for ${describeElapsed(facts.since.getTime(), facts.now.getTime())}.`,
        "The control plane has not suspended, destroyed or changed it. It is",
        "still the customer's stack, and it is not serving.",
      ].join(" ");
    case "provision_exhausted":
      return [
        `Provisioning gave up: ${facts.retryCount} attempts since the last`,
        `success, which is the ceiling of ${facts.attemptCeiling}.`,
        "The provision sweep will not re-drive this stack again. Nothing else",
        "in the control plane will retry it, so it stays as it is until a",
        "human resumes it.",
      ].join(" ");
    case "needs_credentials":
      return [
        "Running without credentials: the stack is up and healthy, but no",
        "Studio admin and no API key were ever minted for it, so the customer",
        "cannot log in or send anything. Provisioning did not fail — the mint",
        "step is a recorded no-op until T2 ships.",
      ].join(" ");
  }
}

/** `Hogsend Cloud: acme/production stuck` — the tenant first, then the rule. */
export function stackAlertSubject(facts: StackAlertFacts): string {
  const labels = facts.conditions.map((c) => CONDITION_LABELS[c]).join(", ");
  return `Hogsend Cloud: ${facts.organizationName}/${facts.environmentName} ${labels}`;
}

export function stackAlertBody(facts: StackAlertFacts): string {
  const lines = [
    `Organization: ${facts.organizationName} (${facts.organizationId})`,
    `Environment: ${facts.environmentName}`,
    `Stack: ${facts.stackId}`,
    `Status: ${facts.status}`,
    `Unchanged for: ${describeElapsed(facts.since.getTime(), facts.now.getTime())}`,
    `Provision attempts since the last success: ${facts.retryCount}`,
  ];
  // Only when there is one. An empty "Last error:" line reads as a missing
  // value rather than as the absence of a failure.
  if (facts.lastError) lines.push(`Last error: ${facts.lastError}`);
  lines.push("");
  for (const condition of facts.conditions) {
    lines.push(conditionLine(condition, facts));
    lines.push("");
  }
  lines.push(
    [
      "This notice is sent once per stack per condition. It repeats only if the",
      "condition changes, or after the cooldown. No email is sent when the",
      "condition clears.",
    ].join(" "),
  );
  return lines.join("\n");
}
