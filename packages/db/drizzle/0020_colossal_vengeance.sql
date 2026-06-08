ALTER TABLE "email_sends" RENAME COLUMN "resend_id" TO "message_id";--> statement-breakpoint
CREATE INDEX "email_sends_message_id_idx" ON "email_sends" USING btree ("message_id");