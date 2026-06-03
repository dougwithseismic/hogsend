CREATE TYPE "public"."bucket_membership_status" AS ENUM('active', 'left');--> statement-breakpoint
CREATE TABLE "bucket_configs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"bucket_id" text NOT NULL,
	"enabled" boolean DEFAULT true NOT NULL,
	"criteria_hash" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "bucket_memberships" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" text,
	"user_id" text NOT NULL,
	"user_email" text,
	"bucket_id" text NOT NULL,
	"status" "bucket_membership_status" DEFAULT 'active' NOT NULL,
	"entered_at" timestamp with time zone DEFAULT now() NOT NULL,
	"left_at" timestamp with time zone,
	"expires_at" timestamp with time zone,
	"last_evaluated_at" timestamp with time zone,
	"entry_count" integer DEFAULT 1 NOT NULL,
	"source" text,
	"context" jsonb DEFAULT '{}'::jsonb,
	"deleted_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX "bucket_configs_bucket_id_idx" ON "bucket_configs" USING btree ("bucket_id");--> statement-breakpoint
CREATE UNIQUE INDEX "uq_user_bucket_active" ON "bucket_memberships" USING btree ("user_id","bucket_id") WHERE status = 'active' AND deleted_at IS NULL;--> statement-breakpoint
CREATE INDEX "bucket_memberships_bucket_id_status_idx" ON "bucket_memberships" USING btree ("bucket_id","status");--> statement-breakpoint
CREATE INDEX "bucket_memberships_user_id_idx" ON "bucket_memberships" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "bucket_memberships_last_evaluated_idx" ON "bucket_memberships" USING btree ("last_evaluated_at");--> statement-breakpoint
CREATE INDEX "bucket_memberships_expires_at_idx" ON "bucket_memberships" USING btree ("expires_at");