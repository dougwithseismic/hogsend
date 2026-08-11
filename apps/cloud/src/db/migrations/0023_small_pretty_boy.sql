CREATE TYPE "cloud"."cloud_email_abuse_event_outcome" AS ENUM('paused', 'reinstated', 'finding_opened', 'finding_closed', 'unknown_tenant', 'ignored');--> statement-breakpoint
CREATE TYPE "cloud"."cloud_email_finding_status" AS ENUM('open', 'fixed');--> statement-breakpoint
CREATE TYPE "cloud"."cloud_email_pause_source" AS ENUM('eventbridge', 'relay', 'operator', 'reconcile');--> statement-breakpoint
CREATE TYPE "cloud"."cloud_email_trust_tier" AS ENUM('new', 'established', 'watched');--> statement-breakpoint
CREATE TABLE "cloud"."email_abuse_events" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"event_id" text NOT NULL,
	"detail_type" text NOT NULL,
	"tenant_name" text,
	"environment_id" uuid,
	"occurred_at" timestamp with time zone NOT NULL,
	"payload" jsonb NOT NULL,
	"outcome" "cloud"."cloud_email_abuse_event_outcome",
	"handled_at" timestamp with time zone,
	"notified_at" timestamp with time zone,
	"notice_error" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "cloud"."email_daily_sends" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"environment_id" uuid NOT NULL,
	"day" text NOT NULL,
	"count" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "cloud"."email_findings" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"environment_id" uuid NOT NULL,
	"type" text NOT NULL,
	"impact" text,
	"description" text,
	"status" "cloud"."cloud_email_finding_status" DEFAULT 'open' NOT NULL,
	"opened_at" timestamp with time zone DEFAULT now() NOT NULL,
	"closed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "cloud"."email_pause_history" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"environment_id" uuid NOT NULL,
	"status" "cloud"."cloud_email_sending_status" NOT NULL,
	"reason" text,
	"source" "cloud"."cloud_email_pause_source" NOT NULL,
	"event_id" text,
	"at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "cloud"."ses_tenants" ADD COLUMN "trust_tier" "cloud"."cloud_email_trust_tier" DEFAULT 'new' NOT NULL;--> statement-breakpoint
ALTER TABLE "cloud"."email_abuse_events" ADD CONSTRAINT "email_abuse_events_environment_id_environments_id_fk" FOREIGN KEY ("environment_id") REFERENCES "cloud"."environments"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "cloud"."email_daily_sends" ADD CONSTRAINT "email_daily_sends_environment_id_environments_id_fk" FOREIGN KEY ("environment_id") REFERENCES "cloud"."environments"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "cloud"."email_findings" ADD CONSTRAINT "email_findings_environment_id_environments_id_fk" FOREIGN KEY ("environment_id") REFERENCES "cloud"."environments"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "cloud"."email_pause_history" ADD CONSTRAINT "email_pause_history_environment_id_environments_id_fk" FOREIGN KEY ("environment_id") REFERENCES "cloud"."environments"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "email_abuse_events_event_id_unique_idx" ON "cloud"."email_abuse_events" USING btree ("event_id");--> statement-breakpoint
CREATE INDEX "email_abuse_events_environment_created_idx" ON "cloud"."email_abuse_events" USING btree ("environment_id","created_at");--> statement-breakpoint
CREATE INDEX "email_abuse_events_outcome_idx" ON "cloud"."email_abuse_events" USING btree ("outcome");--> statement-breakpoint
CREATE UNIQUE INDEX "email_daily_sends_environment_day_unique_idx" ON "cloud"."email_daily_sends" USING btree ("environment_id","day");--> statement-breakpoint
CREATE UNIQUE INDEX "email_findings_environment_type_unique_idx" ON "cloud"."email_findings" USING btree ("environment_id","type");--> statement-breakpoint
CREATE INDEX "email_findings_environment_status_idx" ON "cloud"."email_findings" USING btree ("environment_id","status");--> statement-breakpoint
CREATE INDEX "email_pause_history_environment_at_idx" ON "cloud"."email_pause_history" USING btree ("environment_id","at");