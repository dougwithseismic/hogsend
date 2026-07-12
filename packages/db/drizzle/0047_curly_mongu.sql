ALTER TABLE "user_events" ADD COLUMN "value" numeric(14, 2);--> statement-breakpoint
ALTER TABLE "user_events" ADD COLUMN "currency" char(3);--> statement-breakpoint
CREATE INDEX "user_events_valued_user_idx" ON "user_events" USING btree ("user_id","occurred_at") WHERE "user_events"."value" is not null;