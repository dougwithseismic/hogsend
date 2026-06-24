ALTER TABLE "user_events" ADD COLUMN "source" text;--> statement-breakpoint
CREATE INDEX "user_events_source_idx" ON "user_events" USING btree ("source");