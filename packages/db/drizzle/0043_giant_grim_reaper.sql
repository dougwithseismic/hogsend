CREATE TYPE "public"."journey_spec_origin" AS ENUM('code', 'json');--> statement-breakpoint
CREATE TABLE "journey_spec_versions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"journey_id" text NOT NULL,
	"version" integer NOT NULL,
	"spec" jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "journey_specs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"journey_id" text NOT NULL,
	"spec_schema_version" integer DEFAULT 1 NOT NULL,
	"version" integer DEFAULT 1 NOT NULL,
	"origin" "journey_spec_origin" DEFAULT 'json' NOT NULL,
	"enabled" boolean DEFAULT true NOT NULL,
	"spec" jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "journey_states" ADD COLUMN "spec_version" integer;--> statement-breakpoint
CREATE UNIQUE INDEX "journey_spec_versions_journey_version_idx" ON "journey_spec_versions" USING btree ("journey_id","version");--> statement-breakpoint
CREATE UNIQUE INDEX "journey_specs_journey_id_idx" ON "journey_specs" USING btree ("journey_id");