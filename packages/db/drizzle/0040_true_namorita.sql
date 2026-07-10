ALTER TABLE "link_clicks" ADD COLUMN "visitor_distinct_id" text;--> statement-breakpoint
ALTER TABLE "link_clicks" ADD COLUMN "visitor_kind" text;--> statement-breakpoint
ALTER TABLE "link_clicks" ADD COLUMN "arrived_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "links" ADD COLUMN "append_ref" boolean DEFAULT false NOT NULL;