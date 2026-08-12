/**
 * THE ALLOWANCE SEAM (PRD 03) and the rule behind it (PRD 09).
 *
 * The decision "may this environment send N more messages this month" is made
 * HERE, in the relay's pre-send path, because that is the only place that sees
 * every send. The COUNTING lives in `services/email-usage.ts` and the BILLING
 * in `metering/overage.ts`; this file holds the seam and the pure rule, and
 * touches no database.
 *
 * Two deliberate shapes, both from PRD 03:
 *  - single object in, result object out, like every other seam in this app, so
 *    a later field is additive rather than a signature break;
 *  - `count` is a PARAMETER. A batch of fifty asks for fifty, and a gate that
 *    could only be asked about one message at a time would have to be called
 *    fifty times or would silently admit forty-nine over the ceiling.
 *
 * PRD 09 added the second verb. `canSend` is asked BEFORE the wire and
 * `recordSent` is told AFTER it, and they are on one interface because they are
 * two halves of one fact: a gate that is asked but never told counts nothing,
 * and a meter that is told but never asked enforces nothing.
 */

export interface AllowanceRequest {
  environmentId: string;
  /** The environment's tenant. PRD 09 meters and bills per organization. */
  organizationId: string;
  /** How many messages this request wants to send. Never zero. */
  count: number;
}

/**
 * A refusal carries the numbers so the plugin can put a real sentence in the
 * journey's failure reason rather than "not allowed".
 */
export interface AllowanceRefusal {
  allowed: false;
  reason: "allowance_exhausted";
  /** The plan's included messages for the period. */
  limit: number;
  /** How many have been used. */
  used: number;
  /** ISO-8601 instant the allowance resets. */
  resetsAt?: string;
}

export type AllowanceVerdict = { allowed: true } | AllowanceRefusal;

/**
 * What actually went out. Told to the gate AFTER the wire accepted it, never
 * before: a message counted and then not sent bills a customer for nothing.
 */
export interface AllowanceCommit extends AllowanceRequest {
  /** How many messages the wire ACCEPTED. Never the number submitted. */
  count: number;
  /** The instant they were sent; picks the `YYYY-MM` counter row. */
  at?: Date;
}

export interface AllowanceGate {
  canSend(request: AllowanceRequest): Promise<AllowanceVerdict>;
  /** Meter `count` successful sends. Called once per request, after the wire. */
  recordSent(commit: AllowanceCommit): Promise<void>;
}

/**
 * Everything is allowed and nothing is counted.
 *
 * Kept from PRD 03 for the tests that need a relay with no meter behind it; the
 * relay's DEFAULT is the real gate (`createEmailAllowanceGate`), so a route with
 * no injected dependency enforces and counts.
 */
export const unlimitedAllowance: AllowanceGate = {
  async canSend(): Promise<AllowanceVerdict> {
    return { allowed: true };
  },
  async recordSent(): Promise<void> {
    // Deliberately nothing.
  },
};

/**
 * The inputs the rule needs, with every one of them already resolved. A pure
 * function over injected numbers, so the rules are testable without a database
 * and a reader can see the whole policy at once.
 */
export interface AllowanceInputs {
  /** The plan's included messages for the period. */
  limit: number;
  /** How many have already been sent in it. */
  used: number;
  /** How many this request wants. */
  count: number;
  /** Does the plan bill sends above `limit` rather than refusing them? */
  overageEnabled: boolean;
  /** The absolute ceiling. Sending stops here whatever `overageEnabled` says. */
  hardCap: number;
  /** ISO-8601 instant the allowance resets, when the period has an end. */
  resetsAt?: string;
}

/**
 * May these `count` messages go?
 *
 * The ceiling is the hard cap when the plan bills overage and the included
 * allowance when it does not — one number either way, so there is exactly one
 * comparison and no state in which "allowed" and "refused" are both defensible.
 *
 * The refusal reports the ceiling that STOPPED the request rather than the
 * included allowance. Answering "used 100000 of 10000" to a tenant who is
 * knowingly paying for overage is a sentence they cannot act on.
 */
export function decideAllowance(inputs: AllowanceInputs): AllowanceVerdict {
  const ceiling = inputs.overageEnabled ? inputs.hardCap : inputs.limit;
  // The WHOLE request is weighed. Admitting a batch of fifty into thirty
  // remaining messages is the failure this parameter exists to prevent.
  if (inputs.used + inputs.count <= ceiling) return { allowed: true };
  return {
    allowed: false,
    reason: "allowance_exhausted",
    limit: ceiling,
    used: inputs.used,
    ...(inputs.resetsAt ? { resetsAt: inputs.resetsAt } : {}),
  };
}
