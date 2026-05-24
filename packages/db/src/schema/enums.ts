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
