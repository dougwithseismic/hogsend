ALTER TABLE "bucket_memberships" ADD COLUMN "contact_id" uuid;--> statement-breakpoint
ALTER TABLE "email_preferences" ADD COLUMN "contact_id" uuid;--> statement-breakpoint
ALTER TABLE "email_sends" ADD COLUMN "contact_id" uuid;--> statement-breakpoint
ALTER TABLE "journey_states" ADD COLUMN "contact_id" uuid;--> statement-breakpoint
ALTER TABLE "user_events" ADD COLUMN "contact_id" uuid;