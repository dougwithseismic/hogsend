ALTER TABLE "campaigns" ADD COLUMN "scheduled_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "campaigns" ADD COLUMN "canceled_at" timestamp with time zone;--> statement-breakpoint
CREATE INDEX "campaigns_scheduled_at_idx" ON "campaigns" USING btree ("status","scheduled_at");