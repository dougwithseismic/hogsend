ALTER TABLE "email_sends" ADD COLUMN "user_id" text;--> statement-breakpoint
ALTER TABLE "email_sends" ADD COLUMN "user_email" text;--> statement-breakpoint
ALTER TABLE "email_sends" ADD COLUMN "bounce_type" text;--> statement-breakpoint
ALTER TABLE "email_sends" ADD COLUMN "bounce_reason" text;--> statement-breakpoint
CREATE INDEX "email_sends_user_id_idx" ON "email_sends" USING btree ("user_id");--> statement-breakpoint
-- Backfill denormalized identity for existing rows.
UPDATE "email_sends" AS es SET "user_id" = js."user_id", "user_email" = js."user_email" FROM "journey_states" js WHERE es."journey_state_id" = js."id" AND es."user_id" IS NULL;--> statement-breakpoint
UPDATE "email_sends" SET "user_email" = "to_email" WHERE "user_email" IS NULL;