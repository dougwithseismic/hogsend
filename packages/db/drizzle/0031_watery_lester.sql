CREATE TYPE "public"."connector_delivery_status" AS ENUM('queued', 'sent', 'failed');--> statement-breakpoint
CREATE TABLE "connector_deliveries" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"connector_id" text NOT NULL,
	"action" text NOT NULL,
	"dedupe_key" text,
	"result" jsonb,
	"status" "connector_delivery_status" DEFAULT 'queued' NOT NULL,
	"last_error" text,
	"sent_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX "connector_deliveries_connector_dedupe_idx" ON "connector_deliveries" USING btree ("connector_id","dedupe_key");--> statement-breakpoint
CREATE INDEX "connector_deliveries_connector_idx" ON "connector_deliveries" USING btree ("connector_id","created_at");