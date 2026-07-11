ALTER TABLE "sms_sends" ADD COLUMN "clicked_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "tracked_links" ADD COLUMN "sms_send_id" uuid;--> statement-breakpoint
ALTER TABLE "tracked_links" ADD COLUMN "short_code" text;--> statement-breakpoint
ALTER TABLE "tracked_links" ADD CONSTRAINT "tracked_links_sms_send_id_sms_sends_id_fk" FOREIGN KEY ("sms_send_id") REFERENCES "public"."sms_sends"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "tracked_links_sms_send_id_idx" ON "tracked_links" USING btree ("sms_send_id");--> statement-breakpoint
CREATE UNIQUE INDEX "tracked_links_short_code_unique" ON "tracked_links" USING btree ("short_code") WHERE "tracked_links"."short_code" IS NOT NULL;