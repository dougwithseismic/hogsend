ALTER TABLE "enrichment_lookups" ADD COLUMN "traits" jsonb;--> statement-breakpoint
ALTER TABLE "enrichment_lookups" ADD COLUMN "spend_window" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "enrichment_lookups" ADD COLUMN "spend_count" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "enrichment_lookups" ADD COLUMN "last_error_at" timestamp with time zone;--> statement-breakpoint
CREATE INDEX "enrichment_lookups_spend_window_idx" ON "enrichment_lookups" USING btree ("spend_window");