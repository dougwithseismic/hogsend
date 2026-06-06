ALTER TABLE "bucket_memberships" ADD COLUMN "dwell_state" jsonb DEFAULT '{}'::jsonb;--> statement-breakpoint
ALTER TABLE "bucket_memberships" ADD COLUMN "dwell_anchor_at" timestamp with time zone;--> statement-breakpoint
CREATE INDEX "bucket_memberships_dwell_idx" ON "bucket_memberships" USING btree ("bucket_id","status","entered_at");--> statement-breakpoint
CREATE INDEX "bucket_memberships_bucket_id_status_id_idx" ON "bucket_memberships" USING btree ("bucket_id","status","id");--> statement-breakpoint
CREATE INDEX "bucket_memberships_dwell_lastfired_idx" ON "bucket_memberships" USING btree ("bucket_id","status","last_evaluated_at");