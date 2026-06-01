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
