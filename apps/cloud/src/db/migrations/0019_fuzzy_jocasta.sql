CREATE TYPE "cloud"."cloud_email_event_status" AS ENUM('pending', 'delivered', 'dropped', 'failed');--> statement-breakpoint
CREATE TABLE "cloud"."email_events" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"environment_id" uuid,
	"tenant_name" text,
	"region" "cloud"."cloud_region" NOT NULL,
	"dedupe_key" text NOT NULL,
	"type" text NOT NULL,
	"message_id" text NOT NULL,
	"payload" jsonb NOT NULL,
	"status" "cloud"."cloud_email_event_status" DEFAULT 'pending' NOT NULL,
	"attempts" integer DEFAULT 0 NOT NULL,
	"last_error" text,
	"delivered_at" timestamp with time zone,
	"occurred_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "cloud"."email_events" ADD CONSTRAINT "email_events_environment_id_environments_id_fk" FOREIGN KEY ("environment_id") REFERENCES "cloud"."environments"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "email_events_dedupe_key_unique_idx" ON "cloud"."email_events" USING btree ("dedupe_key");--> statement-breakpoint
CREATE INDEX "email_events_environment_created_idx" ON "cloud"."email_events" USING btree ("environment_id","created_at");--> statement-breakpoint
CREATE INDEX "email_events_status_idx" ON "cloud"."email_events" USING btree ("status");--> statement-breakpoint
CREATE INDEX "email_events_message_id_idx" ON "cloud"."email_events" USING btree ("message_id");