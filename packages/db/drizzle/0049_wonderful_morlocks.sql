CREATE TABLE "conversions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"definition_id" text NOT NULL,
	"contact_id" uuid NOT NULL,
	"user_key" text NOT NULL,
	"event_id" uuid NOT NULL,
	"value" numeric(14, 2),
	"currency" char(3),
	"occurred_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "conversions" ADD CONSTRAINT "conversions_contact_id_contacts_id_fk" FOREIGN KEY ("contact_id") REFERENCES "public"."contacts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "conversions" ADD CONSTRAINT "conversions_event_id_user_events_id_fk" FOREIGN KEY ("event_id") REFERENCES "public"."user_events"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "conversions_definition_event_idx" ON "conversions" USING btree ("definition_id","event_id");--> statement-breakpoint
CREATE INDEX "conversions_contact_idx" ON "conversions" USING btree ("contact_id");--> statement-breakpoint
CREATE INDEX "conversions_definition_occurred_idx" ON "conversions" USING btree ("definition_id","occurred_at");