ALTER TABLE "tracked_links" ADD COLUMN "event" text;--> statement-breakpoint
ALTER TABLE "tracked_links" ADD COLUMN "event_properties" jsonb;--> statement-breakpoint
ALTER TABLE "tracked_links" ADD COLUMN "semantic_emitted_at" timestamp with time zone;