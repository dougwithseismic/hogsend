CREATE TYPE "public"."sms_send_status" AS ENUM('queued', 'sent', 'delivered', 'failed');--> statement-breakpoint
CREATE TABLE "sms_sends" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" text,
	"journey_state_id" uuid,
	"user_id" text,
	"template_key" text,
	"message_id" text,
	"from_phone" text NOT NULL,
	"to_phone" text NOT NULL,
	"body" text NOT NULL,
	"category" text,
	"status" "sms_send_status" DEFAULT 'queued' NOT NULL,
	"segments" integer,
	"sent_at" timestamp with time zone,
	"delivered_at" timestamp with time zone,
	"failed_at" timestamp with time zone,
	"error_code" text,
	"error_reason" text,
	"idempotency_key" text,
	"metadata" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "sms_suppressions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"phone" text NOT NULL,
	"reason" text NOT NULL,
	"suppressed_at" timestamp with time zone DEFAULT now() NOT NULL,
	"resubscribed_at" timestamp with time zone,
	"metadata" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "contacts" ADD COLUMN "phone" text;--> statement-breakpoint
ALTER TABLE "sms_sends" ADD CONSTRAINT "sms_sends_journey_state_id_journey_states_id_fk" FOREIGN KEY ("journey_state_id") REFERENCES "public"."journey_states"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "sms_sends_to_phone_idx" ON "sms_sends" USING btree ("to_phone");--> statement-breakpoint
CREATE INDEX "sms_sends_template_key_idx" ON "sms_sends" USING btree ("template_key");--> statement-breakpoint
CREATE INDEX "sms_sends_status_idx" ON "sms_sends" USING btree ("status");--> statement-breakpoint
CREATE INDEX "sms_sends_created_at_idx" ON "sms_sends" USING btree ("created_at");--> statement-breakpoint
CREATE INDEX "sms_sends_journey_state_id_idx" ON "sms_sends" USING btree ("journey_state_id");--> statement-breakpoint
CREATE INDEX "sms_sends_user_id_idx" ON "sms_sends" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "sms_sends_message_id_idx" ON "sms_sends" USING btree ("message_id");--> statement-breakpoint
CREATE INDEX "sms_sends_freq_cap_idx" ON "sms_sends" USING btree ("to_phone","created_at","category");--> statement-breakpoint
CREATE UNIQUE INDEX "sms_sends_idempotency_key_idx" ON "sms_sends" USING btree ("idempotency_key");--> statement-breakpoint
CREATE UNIQUE INDEX "sms_suppressions_phone_idx" ON "sms_suppressions" USING btree ("phone");--> statement-breakpoint
CREATE UNIQUE INDEX "contacts_phone_unique_idx" ON "contacts" USING btree ("phone") WHERE phone IS NOT NULL AND deleted_at IS NULL;