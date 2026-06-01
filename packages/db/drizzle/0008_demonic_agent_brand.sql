ALTER TABLE "api_keys" ADD COLUMN "organization_id" text;--> statement-breakpoint
ALTER TABLE "contacts" ADD COLUMN "organization_id" text;--> statement-breakpoint
ALTER TABLE "email_sends" ADD COLUMN "organization_id" text;--> statement-breakpoint
ALTER TABLE "journey_states" ADD COLUMN "organization_id" text;--> statement-breakpoint
ALTER TABLE "user_events" ADD COLUMN "organization_id" text;