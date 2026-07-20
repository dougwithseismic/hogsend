import { pgEnum } from "drizzle-orm/pg-core";

export const journeyStatusEnum = pgEnum("journey_status", [
  "active",
  "waiting",
  "completed",
  "failed",
  "exited",
  // Holdout diversion: the contact
  // WOULD have entered but was deterministically diverted to control. One
  // row per (user, journey), ever — the queryable counterfactual.
  "held_out",
]);

export const emailSendStatusEnum = pgEnum("email_send_status", [
  "queued",
  "rendered",
  "sent",
  "delivered",
  "opened",
  "clicked",
  "bounced",
  "complained",
  "failed",
  // Gated by policy BEFORE any dispatch (recipient suppression / preference
  // check, or a test-mode block with no addressable inbox). Distinct from
  // "failed" because a provider dispatch failure RELEASES its idempotency key
  // (so a retry can re-attempt) and thereby becomes byte-identical to a
  // suppressed row — status is the only place the difference can live.
  // Appended last: pg enums are order-sensitive and ADD VALUE appends.
  "suppressed",
]);

export const importJobStatusEnum = pgEnum("import_job_status", [
  "pending",
  "processing",
  "completed",
  "failed",
]);

export const alertRuleTypeEnum = pgEnum("alert_rule_type", [
  "bounce_rate_exceeded",
  "journey_failure_spike",
  "delivery_issue",
  "high_complaint_rate",
]);

export const alertChannelEnum = pgEnum("alert_channel", [
  "webhook",
  "slack",
  "email",
]);

export const dlqStatusEnum = pgEnum("dlq_status", [
  "pending",
  "retried",
  "discarded",
]);

export const bucketMembershipStatusEnum = pgEnum("bucket_membership_status", [
  "active",
  "left",
]);

export const webhookDeliveryStatusEnum = pgEnum("webhook_delivery_status", [
  "pending", // enqueued, awaiting first attempt OR a scheduled retry (nextRetryAt)
  "sending", // a delivery run CAS'd the row and is mid-POST (orphan-recovery sentinel)
  "delivered", // 2xx received — TERMINAL
  "failed", // attempts exhausted — TERMINAL, mirrored to dead_letter_queue
  "discarded", // endpoint disabled/deleted mid-flight — TERMINAL, NOT an error, NOT dead-lettered
]);

export const journeyBlueprintStatusEnum = pgEnum("journey_blueprint_status", [
  "draft", // staged, never dispatched — the opt-in review state (spec §10)
  "enabled", // live: ingest dispatch enrolls matching events
  "disabled", // stops NEW enrollments; in-flight runs keep going
]);

// Mirrors JourneyMeta["entryLimit"] (@hogsend/core journeyMetaSchema) — kept
// in lockstep by hand: code journeys never store entryLimit in the DB, so
// this enum exists only for blueprints (there was no db-level enum to reuse).
export const journeyEntryLimitEnum = pgEnum("journey_entry_limit", [
  "once",
  "once_per_period",
  "unlimited",
]);

export const journeyBlueprintSourceEnum = pgEnum("journey_blueprint_source", [
  "mcp",
  "studio",
  "api",
]);

export const smsSendStatusEnum = pgEnum("sms_send_status", [
  "queued", // row claimed (INSERT won) — the provider call is in flight; a replay
  // finding this re-drives the send (safer missed>doubled), mirroring email_sends.
  "sent", // provider accepted the message — updated to "delivered"/"failed" by the
  // provider status webhook. No opened/clicked/bounced lifecycle: SMS has no
  // pixel/link/bounce machinery; carrier "undelivered" folds into "failed" +
  // error_code.
  "delivered",
  "failed",
]);

export const connectorDeliveryStatusEnum = pgEnum("connector_delivery_status", [
  "queued", // row claimed (INSERT won) — the action call is in flight; NOT yet a
  // satisfied duplicate. A replay finding this re-drives the action (safer
  // missed>doubled), mirroring the email_sends "queued" re-drive.
  "sent", // the action returned — TERMINAL success. A replay finding this returns
  // the stored result WITHOUT re-running the action.
  "failed", // the action threw — TERMINAL failure. The dedupe key is released
  // (set null) so a retry genuinely re-attempts, mirroring email_sends.
]);
