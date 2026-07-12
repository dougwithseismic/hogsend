ALTER TABLE "deals" ADD COLUMN "funnel_id" text;--> statement-breakpoint
CREATE INDEX "deals_funnel_idx" ON "deals" USING btree ("funnel_id");