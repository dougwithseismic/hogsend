CREATE TYPE "public"."journey_blueprint_source" AS ENUM('mcp', 'studio', 'api');--> statement-breakpoint
CREATE TYPE "public"."journey_blueprint_status" AS ENUM('draft', 'enabled', 'disabled');--> statement-breakpoint
CREATE TYPE "public"."journey_entry_limit" AS ENUM('once', 'once_per_period', 'unlimited');--> statement-breakpoint
CREATE TABLE "journey_blueprints" (
	"id" text PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"description" text,
	"status" "journey_blueprint_status" DEFAULT 'draft' NOT NULL,
	"version" integer DEFAULT 1 NOT NULL,
	"trigger_event" text NOT NULL,
	"trigger_where" jsonb,
	"entry_limit" "journey_entry_limit" NOT NULL,
	"entry_period" jsonb,
	"exit_on" jsonb,
	"suppress" jsonb NOT NULL,
	"graph" jsonb NOT NULL,
	"source" "journey_blueprint_source" NOT NULL,
	"created_by" text,
	"promoted_at" timestamp with time zone,
	"promoted_to_journey_id" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE INDEX "journey_blueprints_trigger_event_status_idx" ON "journey_blueprints" USING btree ("trigger_event","status");