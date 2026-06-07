import { pgEnum } from "drizzle-orm/pg-core";

export const journeyStatusEnum = pgEnum("journey_status", [
  "active",
  "waiting",
  "completed",
  "failed",
  "exited",
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
