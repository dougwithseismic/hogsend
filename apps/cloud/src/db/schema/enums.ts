import { cloud } from "./_shared";

/**
 * Data-residency region. A cell, an organization and its stacks all carry one;
 * an organization never spans regions.
 */
export const cloudRegionEnum = cloud.enum("cloud_region", ["us", "eu"]);

/**
 * Commercial plan. `trial` is the signup default (14 days); `self_serve` is a
 * paid shared-cell tenant; `dedicated` tenants get their own substrate and so
 * carry a null `cell_id`.
 */
export const cloudPlanEnum = cloud.enum("cloud_plan", [
  "trial",
  "self_serve",
  "dedicated",
]);

/**
 * Environment kind. Exactly one `production` per organization — enforced in the
 * service layer (PRD 02 task 3), not by a constraint, because the rule is
 * "one live production" and future soft-delete would break a partial index's
 * arbiter contract silently.
 */
export const environmentKindEnum = cloud.enum("cloud_environment_kind", [
  "production",
  "staging",
  "test",
]);

/**
 * Whether an environment may send email through the relay, mirrored from SES.
 *
 * `active` and `reinstated` send; `paused` and `enforced` do not, and the relay
 * fails closed on both (DECISIONS §6: loudly, no queueing, no BYO fallback).
 * The two blocking values are separate because only one of them is ours to
 * reverse: `paused` is AWS's own reputation policy stopping one tenant, and
 * `enforced` is an operator stop from PRD 08. `reinstated` mirrors SES's own
 * `REINSTATED` — paused once, since let back on — and is deliberately NOT the
 * same value as `active`, so "has this tenant ever been stopped" survives.
 */
export const emailSendingStatusEnum = cloud.enum("cloud_email_sending_status", [
  "active",
  "paused",
  "enforced",
  "reinstated",
]);

/**
 * The reputation policy SES enforces for ONE tenant, mirrored on `ses_tenants`.
 *
 * `NONE` observes — findings are still recorded and still visible, they just do
 * not auto-pause — and is where every new tenant starts (PRD 06), because
 * enforcing on a tenant with no sending history is enforcing on noise.
 * `STANDARD` and `STRICT` are promotions, and promotion is PRD 08's decision,
 * never a provisioning-time one.
 *
 * Uppercase because these are AWS's own values, and translating them would
 * mean two vocabularies for one fact.
 */
export const sesReputationPolicyEnum = cloud.enum(
  "cloud_ses_reputation_policy",
  ["NONE", "STANDARD", "STRICT"],
);

/**
 * Stack lifecycle. The legal-edge table lives in the state machine (PRD 02
 * task 4) — this enum only fixes the vocabulary and its Postgres ordering.
 * `error` is terminal-until-retried and pairs with `last_error` + `retry_count`.
 *
 * `deferred` is the pre-`requested` state a stack is born in under
 * `CLOUD_PROVISION_ON=first-publish` (PRD 15): the tenant row exists and is
 * addressable, but no substrate has been asked for yet. It is deliberately its
 * own status rather than "requested but unqueued" — nothing sweeps it, nothing
 * alerts on it, and the ONLY way out is the publish intake promoting it to
 * `requested`.
 */
export const stackStatusEnum = cloud.enum("cloud_stack_status", [
  "deferred",
  "requested",
  "provisioning",
  "running",
  "publishing",
  "suspended",
  "destroying",
  "destroyed",
  "error",
]);
