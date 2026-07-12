CREATE TYPE "public"."voice_call_status" AS ENUM('queued', 'ringing', 'in_progress', 'completed', 'no_answer', 'voicemail', 'failed');--> statement-breakpoint
CREATE TABLE "voice_calls" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" text,
	"journey_state_id" uuid,
	"user_id" text,
	"agent_key" text,
	"provider_id" text,
	"provider_call_id" text,
	"direction" text DEFAULT 'outbound' NOT NULL,
	"from_number" text,
	"to_number" text NOT NULL,
	"status" "voice_call_status" DEFAULT 'queued' NOT NULL,
	"started_at" timestamp with time zone,
	"ended_at" timestamp with time zone,
	"duration_sec" integer,
	"ended_reason" text,
	"recording_url" text,
	"transcript" jsonb,
	"summary" text,
	"structured_data" jsonb,
	"cost" double precision,
	"error_code" text,
	"error_reason" text,
	"idempotency_key" text,
	"metadata" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "voice_suppressions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"phone" text NOT NULL,
	"reason" text NOT NULL,
	"source" text,
	"suppressed_at" timestamp with time zone DEFAULT now() NOT NULL,
	"metadata" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "voice_calls" ADD CONSTRAINT "voice_calls_journey_state_id_journey_states_id_fk" FOREIGN KEY ("journey_state_id") REFERENCES "public"."journey_states"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "voice_calls_to_number_idx" ON "voice_calls" USING btree ("to_number");--> statement-breakpoint
CREATE INDEX "voice_calls_agent_key_idx" ON "voice_calls" USING btree ("agent_key");--> statement-breakpoint
CREATE INDEX "voice_calls_status_idx" ON "voice_calls" USING btree ("status");--> statement-breakpoint
CREATE INDEX "voice_calls_created_at_idx" ON "voice_calls" USING btree ("created_at");--> statement-breakpoint
CREATE INDEX "voice_calls_journey_state_id_idx" ON "voice_calls" USING btree ("journey_state_id");--> statement-breakpoint
CREATE INDEX "voice_calls_user_id_idx" ON "voice_calls" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "voice_calls_provider_call_id_idx" ON "voice_calls" USING btree ("provider_call_id");--> statement-breakpoint
CREATE INDEX "voice_calls_freq_cap_idx" ON "voice_calls" USING btree ("to_number","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "voice_calls_idempotency_key_idx" ON "voice_calls" USING btree ("idempotency_key");--> statement-breakpoint
CREATE UNIQUE INDEX "voice_suppressions_phone_idx" ON "voice_suppressions" USING btree ("phone");