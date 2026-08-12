import { createHash, timingSafeEqual } from "node:crypto";

/**
 * EVENTBRIDGE REQUEST AUTHENTICATION (PRD 08 task 1).
 *
 * This module stands between an anonymous HTTP POST and a tenant's ability to
 * send email at all. A forged `Sending Status Disabled` stops a paying
 * customer's mail mid-campaign; a forged `Advisor Recommendation Status Open`
 * demotes them to `watched`, quarters their cap and blocks their imports. So
 * the posture is the same as PRD 05's SNS ingress: refuse first, act second.
 *
 * **It is a DIFFERENT mechanism from SNS, and that is not an inconsistency.**
 * SNS signs its message body with a certificate we fetch and verify
 * (`src/sns/verify.ts`), and none of that machinery exists on this wire:
 * EventBridge reaches an HTTP endpoint through an **API destination**, which
 * authenticates with a **connection** — BASIC, OAUTH, or an API key sent as a
 * header — and does not sign the payload at all. Reusing the SNS verifier here
 * would mean verifying a signature that is never sent. What IS reused is every
 * decision around it: fail closed when unconfigured, one status code for every
 * refusal so a hostile caller learns nothing, and the reason in the body for
 * the operator reading a log.
 *
 * Fail-closed when unconfigured is the important one. An endpoint that accepted
 * anything until someone remembered to set a secret would be a pause-anyone
 * button on the public internet for exactly as long as that took.
 */

/**
 * The header the EventBridge connection is configured to send.
 *
 * An `x-` prefixed custom header rather than `authorization`, because AWS's
 * API-destination connections attach their own `Authorization` for BASIC and
 * OAUTH modes and a name collision there would be silently overwritten.
 */
export const EVENTBRIDGE_SECRET_HEADER = "x-hogsend-eventbridge-secret";

export type EventBridgeVerificationReason = "not_configured" | "mismatch";

export class EventBridgeVerificationError extends Error {
  readonly reason: EventBridgeVerificationReason;

  constructor(message: string, reason: EventBridgeVerificationReason) {
    super(message);
    this.name = "EventBridgeVerificationError";
    this.reason = reason;
  }
}

/**
 * Compare two secrets without leaking their length or their prefix.
 *
 * Both sides are hashed to a fixed 32 bytes FIRST. `timingSafeEqual` throws a
 * RangeError on buffers of different lengths, so comparing raw strings would
 * turn "wrong length" into a different failure mode from "wrong value" — a
 * distinction an attacker can measure, and a crash rather than a 403.
 */
function secretsMatch(presented: string, expected: string): boolean {
  const a = createHash("sha256").update(presented, "utf8").digest();
  const b = createHash("sha256").update(expected, "utf8").digest();
  return timingSafeEqual(a, b);
}

/**
 * Authenticate an EventBridge delivery, or throw.
 *
 * `secret` is the configured value — `null` when the deploy has none, which is
 * a REFUSAL and not a pass.
 */
export function verifyEventBridgeSecret(input: {
  headers: Headers;
  secret: string | null | undefined;
}): void {
  if (!input.secret) {
    throw new EventBridgeVerificationError(
      "no EventBridge secret is configured for this control plane, so no reputation event can be authenticated",
      "not_configured",
    );
  }

  const presented = input.headers.get(EVENTBRIDGE_SECRET_HEADER);
  // A missing header and a wrong one are the SAME refusal. Telling them apart
  // tells a prober whether they have the header name right.
  if (!presented || !secretsMatch(presented, input.secret)) {
    throw new EventBridgeVerificationError(
      "the EventBridge secret did not match",
      "mismatch",
    );
  }
}
