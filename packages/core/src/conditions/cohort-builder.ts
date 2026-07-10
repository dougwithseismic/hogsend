import type {
  ChannelIdentityCondition,
  ConditionEval,
  EmailEngagementCondition,
  EventCondition,
} from "../types/conditions.js";

/**
 * The fluent builder passed to a campaign step's `where` function. Every
 * terminal returns a plain `ConditionEval` POJO — byte-identical to the
 * declarative form — so the stored `campaigns.steps` blob stays
 * introspectable data. The function runs ONCE, at `defineCampaign` time
 * (same normalize-at-definition pattern as `trigger.where` in
 * `defineJourney`); it never executes per-user. All engagement terminals are
 * scoped to THIS campaign's prior deliveries: an omitted `template` means
 * "any prior send of this campaign" (the wave runtime supplies the scope).
 */
export interface CohortBuilder {
  /** `email_sends.openedAt` set on a prior wave's send. */
  opened(template?: string): EmailEngagementCondition;
  /** `email_sends.openedAt` null on a prior wave's send. */
  notOpened(template?: string): EmailEngagementCondition;
  /** `email_sends.clickedAt` set on a prior wave's send. */
  clicked(template?: string): EmailEngagementCondition;
  /** `email_sends.clickedAt` null on a prior wave's send. */
  notClicked(template?: string): EmailEngagementCondition;
  /** A `user_events` row for this user (connector engagement included). */
  firedEvent(event: string): EventCondition;
  /** No `user_events` row for this user. */
  notFiredEvent(event: string): EventCondition;
  /** Has a linked identity for the connector (v1: `"discord"` only). */
  linked(connector: string): ChannelIdentityCondition;
  /** Lacks a linked identity for the connector — the channel-fallback leg. */
  notLinked(connector: string): ChannelIdentityCondition;
}

function engagement(
  check: EmailEngagementCondition["check"],
  template?: string,
): EmailEngagementCondition {
  return {
    type: "email_engagement",
    check,
    ...(template !== undefined ? { templateKey: template } : {}),
  };
}

function event(
  check: "exists" | "not_exists",
  eventName: string,
): EventCondition {
  return { type: "event", eventName, check };
}

function identity(
  check: ChannelIdentityCondition["check"],
  connector: string,
): ChannelIdentityCondition {
  return { type: "channel_identity", connector, check };
}

/**
 * The default {@link CohortBuilder} instance. `step.send()` passes this to a
 * `where` function and stores the returned conditions. Exported so it can
 * also be used standalone (e.g. composing reusable fragments in tests).
 */
export const cohortBuilder: CohortBuilder = {
  opened: (template) => engagement("opened", template),
  notOpened: (template) => engagement("not_opened", template),
  clicked: (template) => engagement("clicked", template),
  notClicked: (template) => engagement("not_clicked", template),
  firedEvent: (eventName) => event("exists", eventName),
  notFiredEvent: (eventName) => event("not_exists", eventName),
  linked: (connector) => identity("linked", connector),
  notLinked: (connector) => identity("not_linked", connector),
};

/**
 * Authoring form of a campaign step's `where`: the stored data form (one
 * condition or an array), or a builder function resolved ONCE at
 * `defineCampaign` time into the byte-identical POJOs —
 * `where: (c) => [c.notFiredEvent(Events.SIGNED_UP), c.notClicked()]`.
 * An array is AND (OR is deferred — core's `composite` type is the seam).
 */
export type CampaignWhere =
  | ConditionEval
  | ConditionEval[]
  | ((c: CohortBuilder) => ConditionEval | ConditionEval[]);

/**
 * Resolve a {@link CampaignWhere} to its stored `ConditionEval[]` — a
 * one-shot, definition-time call (mirrors `normalizeWhere` for journeys). A
 * builder fn is invoked ONCE with the cohort builder; a single condition is
 * wrapped. Returns `undefined` for an absent where so callers can take a
 * fast path.
 */
export function normalizeCampaignWhere(
  where: CampaignWhere | undefined,
): ConditionEval[] | undefined {
  if (where === undefined) return undefined;
  const resolved = typeof where === "function" ? where(cohortBuilder) : where;
  return Array.isArray(resolved) ? resolved : [resolved];
}
