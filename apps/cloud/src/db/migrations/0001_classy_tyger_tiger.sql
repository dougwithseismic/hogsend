CREATE TYPE "cloud"."cloud_plan" AS ENUM('trial', 'self_serve', 'dedicated');--> statement-breakpoint
CREATE TYPE "cloud"."cloud_region" AS ENUM('us', 'eu');--> statement-breakpoint
CREATE TYPE "cloud"."cloud_environment_kind" AS ENUM('production', 'staging', 'test');--> statement-breakpoint
CREATE TYPE "cloud"."cloud_stack_status" AS ENUM('requested', 'provisioning', 'running', 'publishing', 'suspended', 'destroying', 'destroyed', 'error');--> statement-breakpoint
CREATE TABLE "cloud"."cloud_audit_log" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"actor" text NOT NULL,
	"organization_id" text NOT NULL,
	"action" text NOT NULL,
	"subject" text NOT NULL,
	"detail" jsonb DEFAULT '{}'::jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "cloud"."cells" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"name" text NOT NULL,
	"region" "cloud"."cloud_region" NOT NULL,
	"shared_cluster_dsn" text NOT NULL,
	"shared_hatchet_url" text NOT NULL,
	"accepting" boolean DEFAULT true NOT NULL,
	"max_tenants" integer DEFAULT 100 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "cells_name_unique" UNIQUE("name")
);
--> statement-breakpoint
CREATE TABLE "cloud"."environments" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" text NOT NULL,
	"name" text NOT NULL,
	"kind" "cloud"."cloud_environment_kind" NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "cloud"."organizations" (
	"id" text PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"region" "cloud"."cloud_region" NOT NULL,
	"plan" "cloud"."cloud_plan" DEFAULT 'trial' NOT NULL,
	"cell_id" uuid,
	"suspended_at" timestamp with time zone,
	"trial_ends_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "cloud"."provider_keys" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" text NOT NULL,
	"environment_id" uuid NOT NULL,
	"provider" text NOT NULL,
	"encrypted_payload" text NOT NULL,
	"last4" text,
	"verified_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "cloud"."stacks" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" text NOT NULL,
	"environment_id" uuid NOT NULL,
	"status" "cloud"."cloud_stack_status" DEFAULT 'requested' NOT NULL,
	"last_error" text,
	"retry_count" integer DEFAULT 0 NOT NULL,
	"substrate_refs" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"engine_version" text,
	"hatchet_namespace" text,
	"db_name" text,
	"region" "cloud"."cloud_region" NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "cloud"."usage_counters" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" text NOT NULL,
	"environment_id" uuid NOT NULL,
	"month" text NOT NULL,
	"events_count" bigint DEFAULT 0 NOT NULL,
	"emails_count" bigint DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "cloud"."cloud_audit_log" ADD CONSTRAINT "cloud_audit_log_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "cloud"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "cloud"."environments" ADD CONSTRAINT "environments_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "cloud"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "cloud"."organizations" ADD CONSTRAINT "organizations_cell_id_cells_id_fk" FOREIGN KEY ("cell_id") REFERENCES "cloud"."cells"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "cloud"."provider_keys" ADD CONSTRAINT "provider_keys_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "cloud"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "cloud"."provider_keys" ADD CONSTRAINT "provider_keys_environment_id_environments_id_fk" FOREIGN KEY ("environment_id") REFERENCES "cloud"."environments"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "cloud"."stacks" ADD CONSTRAINT "stacks_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "cloud"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "cloud"."stacks" ADD CONSTRAINT "stacks_environment_id_environments_id_fk" FOREIGN KEY ("environment_id") REFERENCES "cloud"."environments"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "cloud"."usage_counters" ADD CONSTRAINT "usage_counters_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "cloud"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "cloud"."usage_counters" ADD CONSTRAINT "usage_counters_environment_id_environments_id_fk" FOREIGN KEY ("environment_id") REFERENCES "cloud"."environments"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "cloud_audit_log_org_created_at_idx" ON "cloud"."cloud_audit_log" USING btree ("organization_id","created_at");--> statement-breakpoint
CREATE INDEX "cells_region_accepting_idx" ON "cloud"."cells" USING btree ("region","accepting");--> statement-breakpoint
CREATE UNIQUE INDEX "environments_org_name_unique_idx" ON "cloud"."environments" USING btree ("organization_id","name");--> statement-breakpoint
CREATE INDEX "environments_organization_id_idx" ON "cloud"."environments" USING btree ("organization_id");--> statement-breakpoint
CREATE INDEX "organizations_cell_id_idx" ON "cloud"."organizations" USING btree ("cell_id");--> statement-breakpoint
CREATE INDEX "organizations_plan_idx" ON "cloud"."organizations" USING btree ("plan");--> statement-breakpoint
CREATE INDEX "provider_keys_organization_id_idx" ON "cloud"."provider_keys" USING btree ("organization_id");--> statement-breakpoint
CREATE INDEX "provider_keys_environment_provider_idx" ON "cloud"."provider_keys" USING btree ("environment_id","provider");--> statement-breakpoint
CREATE UNIQUE INDEX "stacks_environment_id_unique_idx" ON "cloud"."stacks" USING btree ("environment_id");--> statement-breakpoint
CREATE INDEX "stacks_organization_id_idx" ON "cloud"."stacks" USING btree ("organization_id");--> statement-breakpoint
CREATE INDEX "stacks_status_idx" ON "cloud"."stacks" USING btree ("status");--> statement-breakpoint
CREATE UNIQUE INDEX "usage_counters_environment_month_unique_idx" ON "cloud"."usage_counters" USING btree ("environment_id","month");--> statement-breakpoint
CREATE INDEX "usage_counters_org_month_idx" ON "cloud"."usage_counters" USING btree ("organization_id","month");