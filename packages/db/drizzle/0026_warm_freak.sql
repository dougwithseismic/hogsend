CREATE TABLE "connector_link_codes" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"connector_id" text NOT NULL,
	"code_hash" text NOT NULL,
	"platform_user_id" text NOT NULL,
	"target_email" text NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"used_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX "connector_link_codes_code_hash_idx" ON "connector_link_codes" USING btree ("code_hash");--> statement-breakpoint
CREATE INDEX "connector_link_codes_throttle_user_idx" ON "connector_link_codes" USING btree ("connector_id","platform_user_id","created_at");--> statement-breakpoint
CREATE INDEX "connector_link_codes_throttle_email_idx" ON "connector_link_codes" USING btree ("connector_id","target_email","created_at");