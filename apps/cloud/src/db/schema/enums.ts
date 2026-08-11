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
 * What became of one consumed SES status event (`email_events`, PRD 05).
 *
 * `pending` — recorded, not yet handed to the instance. `delivered` — the
 * instance accepted it. `dropped` — TERMINAL and not a failure: the event's
 * SES tenant resolved to no environment, so there was nobody to deliver it
 * to and broadcasting was never an option. `failed` — bounded retry exhausted;
 * the row keeps the attempt count and the last error rather than the loop
 * running forever.
 */
export const emailEventStatusEnum = cloud.enum("cloud_email_event_status", [
  "pending",
  "delivered",
  "dropped",
  "failed",
]);

/**
 * What became of one RECEIVED message (`email_inbound_messages`, PRD 16).
 *
 * Deliberately its own type rather than a fifth value bolted onto
 * {@link emailEventStatusEnum}: the two tables answer different questions, and
 * `suppressed` — which only inbound has — is the one value that must never be
 * confusable with `dropped`.
 *
 * `pending` — recorded, not yet handed to the instance. `delivered` — the
 * instance accepted the `email.replied` event. `suppressed` — an auto-responder
 * (`Auto-Submitted`, `Precedence: bulk`) or a message too large to parse: the
 * message is STORED and referenced and no event is emitted, which is a success,
 * not a failure. Emitting for an auto-responder is how a mail loop starts.
 * `dropped` — TERMINAL and not a failure either: the envelope recipient
 * resolved to no environment, so there was nobody to deliver to and
 * broadcasting was never an option. `failed` — bounded retry exhausted.
 */
export const emailInboundStatusEnum = cloud.enum("cloud_email_inbound_status", [
  "pending",
  "delivered",
  "suppressed",
  "dropped",
  "failed",
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
 * The trust tier one environment sits in (PRD 08, AUP §5.2).
 *
 * The tier is the single input to three separate enforcement decisions — the
 * SES reputation policy, the send cap, and whether bulk list import is
 * available — so it is one column rather than three flags that could disagree.
 *
 * `new` at provisioning, `established` automatically once the volume-and-window
 * criteria hold, `watched` automatically and immediately on any reputation
 * finding. Promotion OUT of `watched` is a human review and has no automatic
 * edge, because an automatic reinstate on request is an automatic bypass.
 */
export const emailTrustTierEnum = cloud.enum("cloud_email_trust_tier", [
  "new",
  "established",
  "watched",
]);

/**
 * A reputation finding's lifecycle, mirroring SES Advisor's own
 * `OPEN` / `FIXED` recommendation statuses in our lowercase vocabulary.
 *
 * There is deliberately no `dismissed`: a finding we chose to ignore is still
 * an open finding as far as the tier engine is concerned, and giving an
 * operator a way to clear one without fixing it would be the bypass §6.6
 * exists to prevent.
 */
export const emailFindingStatusEnum = cloud.enum("cloud_email_finding_status", [
  "open",
  "fixed",
]);

/**
 * What the control plane DID with one EventBridge reputation event.
 *
 * `unknown_tenant` is a first-class outcome rather than an error: an event for
 * a tenant we no longer know is evidence of a provisioning gap and must be
 * kept, and it must never throw — one stale tenant cannot be allowed to wedge
 * the whole event pipeline (PRD 08 EARS 9). `ignored` is a detail-type we do
 * not consume.
 */
export const emailAbuseEventOutcomeEnum = cloud.enum(
  "cloud_email_abuse_event_outcome",
  [
    "paused",
    "reinstated",
    "finding_opened",
    "finding_closed",
    "unknown_tenant",
    "ignored",
  ],
);

/**
 * WHO decided a sending-status transition. The pause history is read by a human
 * during an appeal, and "AWS stopped you" and "we stopped you" are different
 * conversations.
 *
 * `eventbridge` — SES's own reputation policy, relayed to us. `relay` — the
 * send path discovering a pause AWS had already applied. `operator` — a human
 * or the reputation sweep acting under AUP §6.1/§6.2. `reconcile` — the
 * read-back repairing a mirror that had drifted.
 */
export const emailPauseSourceEnum = cloud.enum("cloud_email_pause_source", [
  "eventbridge",
  "relay",
  "operator",
  "reconcile",
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
