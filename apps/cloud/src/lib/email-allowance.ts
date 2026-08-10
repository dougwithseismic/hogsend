/**
 * THE ALLOWANCE SEAM (PRD 03 → PRD 09).
 *
 * The decision "may this environment send N more messages this month" is made
 * HERE, in the relay's pre-send path, because that is the only place that sees
 * every send. The COUNTING and the BILLING that answer it are PRD 09's, and
 * nothing in this file counts anything.
 *
 * Until PRD 09 lands, `unlimitedAllowance` answers `allowed` unconditionally.
 * The refusal branch is nevertheless wired and tested (with a gate that
 * refuses), so PRD 09 is a drop-in: it supplies an `AllowanceGate` backed by
 * `usage_counters` and Stripe, and nothing in the relay changes.
 *
 * Two deliberate shapes:
 *  - single object in, result object out, like every other seam in this app, so
 *    PRD 09 adding a field is additive rather than a signature break;
 *  - `count` is a PARAMETER. A batch of fifty asks for fifty, and a gate that
 *    could only be asked about one message at a time would have to be called
 *    fifty times or would silently admit forty-nine over the ceiling.
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

export interface AllowanceGate {
  canSend(request: AllowanceRequest): Promise<AllowanceVerdict>;
}

/**
 * The PRD 03 stub: everything is allowed.
 *
 * It is a value rather than a `null` check inside the relay on purpose — the
 * relay always calls a gate, so the call site PRD 09 has to satisfy already
 * exists and is already exercised by every relay test.
 */
export const unlimitedAllowance: AllowanceGate = {
  async canSend(): Promise<AllowanceVerdict> {
    return { allowed: true };
  },
};
