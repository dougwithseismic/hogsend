import { evaluatePropertyConditions } from "@hogsend/core";
import type { JourneyMeta } from "@hogsend/core/types";

export interface EnrollmentPolicyFacts {
  /** Omit when there is no persisted admin override. */
  adminEnabled?: boolean;
  entry?: { allowed: boolean; reason?: string };
  unsubscribed?: boolean;
  heldOut?: boolean;
  alreadyActive?: boolean;
}

export type EnrollmentPolicyResult =
  | { allowed: true }
  | { allowed: false; reason: string };

/** Pure enrollment guard ordering shared by production and test fixtures. */
export function evaluateEnrollmentPolicy(opts: {
  journey: JourneyMeta;
  properties: Record<string, unknown>;
  facts?: EnrollmentPolicyFacts;
}): EnrollmentPolicyResult {
  const { journey, properties, facts = {} } = opts;
  if (!journey.enabled) return { allowed: false, reason: "journey_disabled" };
  if (facts.adminEnabled === false) {
    return { allowed: false, reason: "journey_disabled_by_admin" };
  }
  if (
    journey.trigger.where?.length &&
    !evaluatePropertyConditions({
      conditions: journey.trigger.where,
      properties,
    })
  ) {
    return { allowed: false, reason: "trigger_conditions_not_met" };
  }
  if (facts.entry && !facts.entry.allowed) {
    return {
      allowed: false,
      reason: facts.entry.reason ?? "entry_limit",
    };
  }
  if (facts.unsubscribed) {
    return { allowed: false, reason: "user_unsubscribed" };
  }
  if (facts.heldOut) return { allowed: false, reason: "held_out" };
  if (facts.alreadyActive) {
    return { allowed: false, reason: "already_active" };
  }
  return { allowed: true };
}
