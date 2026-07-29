CREATE TABLE "cloud"."cli_device_codes" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"device_code_hash" text NOT NULL,
	"user_code" text NOT NULL,
	"label" text,
	"status" text DEFAULT 'pending' NOT NULL,
	"organization_id" text,
	"approved_by_user_id" text,
	"approved_session_id" uuid,
	"expires_at" timestamp with time zone NOT NULL,
	"consumed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "cloud"."cli_rate_limits" (
	"bucket" text NOT NULL,
	"window_start" timestamp with time zone NOT NULL,
	"count" integer DEFAULT 0 NOT NULL,
	CONSTRAINT "cli_rate_limits_pkey" PRIMARY KEY("bucket","window_start")
);
--> statement-breakpoint
CREATE TABLE "cloud"."cli_sessions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"token_hash" text NOT NULL,
	"last4" text NOT NULL,
	"user_id" text NOT NULL,
	"organization_id" text NOT NULL,
	"label" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_used_at" timestamp with time zone,
	"revoked_at" timestamp with time zone
);
--> statement-breakpoint
ALTER TABLE "cloud"."cli_device_codes" ADD CONSTRAINT "cli_device_codes_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "cloud"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "cloud"."cli_device_codes" ADD CONSTRAINT "cli_device_codes_approved_by_user_id_user_id_fk" FOREIGN KEY ("approved_by_user_id") REFERENCES "cloud"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "cloud"."cli_device_codes" ADD CONSTRAINT "cli_device_codes_approved_session_id_cli_sessions_id_fk" FOREIGN KEY ("approved_session_id") REFERENCES "cloud"."cli_sessions"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "cloud"."cli_sessions" ADD CONSTRAINT "cli_sessions_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "cloud"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "cloud"."cli_sessions" ADD CONSTRAINT "cli_sessions_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "cloud"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "cli_device_codes_device_code_hash_unique_idx" ON "cloud"."cli_device_codes" USING btree ("device_code_hash");--> statement-breakpoint
CREATE UNIQUE INDEX "cli_device_codes_user_code_unique_idx" ON "cloud"."cli_device_codes" USING btree ("user_code");--> statement-breakpoint
CREATE INDEX "cli_device_codes_expires_at_idx" ON "cloud"."cli_device_codes" USING btree ("expires_at");--> statement-breakpoint
CREATE INDEX "cli_rate_limits_window_start_idx" ON "cloud"."cli_rate_limits" USING btree ("window_start");--> statement-breakpoint
CREATE UNIQUE INDEX "cli_sessions_token_hash_unique_idx" ON "cloud"."cli_sessions" USING btree ("token_hash");--> statement-breakpoint
CREATE INDEX "cli_sessions_organization_id_idx" ON "cloud"."cli_sessions" USING btree ("organization_id","created_at");--> statement-breakpoint
CREATE INDEX "cli_sessions_user_id_idx" ON "cloud"."cli_sessions" USING btree ("user_id");