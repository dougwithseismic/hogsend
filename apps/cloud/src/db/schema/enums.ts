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
