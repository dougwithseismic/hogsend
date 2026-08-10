CREATE TYPE "cloud"."cloud_ses_reputation_policy" AS ENUM('NONE', 'STANDARD', 'STRICT');--> statement-breakpoint
CREATE TABLE "cloud"."ses_tenants" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"environment_id" uuid NOT NULL,
	"tenant_name" text NOT NULL,
	"tenant_arn" text NOT NULL,
	"configuration_set_name" text NOT NULL,
	"region" "cloud"."cloud_region" NOT NULL,
	"aws_region" text NOT NULL,
	"reputation_policy" "cloud"."cloud_ses_reputation_policy" DEFAULT 'NONE' NOT NULL,
	"webhook_secret_encrypted" text NOT NULL,
	"available" boolean DEFAULT false NOT NULL,
	"provisioned_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "cloud"."ses_tenants" ADD CONSTRAINT "ses_tenants_environment_id_environments_id_fk" FOREIGN KEY ("environment_id") REFERENCES "cloud"."environments"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "ses_tenants_environment_id_unique_idx" ON "cloud"."ses_tenants" USING btree ("environment_id");