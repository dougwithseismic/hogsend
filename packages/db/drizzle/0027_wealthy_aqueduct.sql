ALTER TABLE "tracked_links" ALTER COLUMN "email_send_id" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "tracked_links" ADD COLUMN "distinct_id" text;--> statement-breakpoint
ALTER TABLE "tracked_links" ADD COLUMN "source" text;