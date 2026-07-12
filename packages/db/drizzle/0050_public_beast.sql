CREATE TABLE "conversion_dispatches" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"conversion_id" uuid NOT NULL,
	"destination_id" text NOT NULL,
	"event_id" text NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"attempts" integer DEFAULT 0 NOT NULL,
	"last_error" text,
	"response" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"delivered_at" timestamp with time zone
);
--> statement-breakpoint
ALTER TABLE "conversion_dispatches" ADD CONSTRAINT "conversion_dispatches_conversion_id_conversions_id_fk" FOREIGN KEY ("conversion_id") REFERENCES "public"."conversions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "conversion_dispatches_destination_event_idx" ON "conversion_dispatches" USING btree ("destination_id","event_id");--> statement-breakpoint
CREATE INDEX "conversion_dispatches_status_idx" ON "conversion_dispatches" USING btree ("status");