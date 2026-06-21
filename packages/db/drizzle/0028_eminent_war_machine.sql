CREATE TABLE "links" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"original_url" text NOT NULL,
	"type" text DEFAULT 'public' NOT NULL,
	"label" text,
	"campaign" text,
	"source" text NOT NULL,
	"distinct_id" text,
	"created_by" text,
	"archived_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "tracked_links" ADD COLUMN "link_id" uuid;--> statement-breakpoint
CREATE INDEX "links_source_idx" ON "links" USING btree ("source");--> statement-breakpoint
CREATE INDEX "links_campaign_idx" ON "links" USING btree ("campaign");--> statement-breakpoint
CREATE INDEX "links_created_at_idx" ON "links" USING btree ("created_at");--> statement-breakpoint
ALTER TABLE "tracked_links" ADD CONSTRAINT "tracked_links_link_id_links_id_fk" FOREIGN KEY ("link_id") REFERENCES "public"."links"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "tracked_links_link_id_idx" ON "tracked_links" USING btree ("link_id");