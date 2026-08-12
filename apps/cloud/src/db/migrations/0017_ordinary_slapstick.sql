CREATE TYPE "cloud"."cloud_email_sending_status" AS ENUM('active', 'paused', 'enforced', 'reinstated');--> statement-breakpoint
CREATE TABLE "cloud"."email_idempotency" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"environment_id" uuid NOT NULL,
	"idempotency_key" text NOT NULL,
	"message_id" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"claimed_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "cloud"."email_sending_status" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"environment_id" uuid NOT NULL,
	"status" "cloud"."cloud_email_sending_status" DEFAULT 'active' NOT NULL,
	"reason" text,
	"paused_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "cloud"."relay_tokens" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"environment_id" uuid NOT NULL,
	"token_hash" text NOT NULL,
	"last4" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"rotated_at" timestamp with time zone
);
--> statement-breakpoint
ALTER TABLE "cloud"."email_idempotency" ADD CONSTRAINT "email_idempotency_environment_id_environments_id_fk" FOREIGN KEY ("environment_id") REFERENCES "cloud"."environments"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "cloud"."email_sending_status" ADD CONSTRAINT "email_sending_status_environment_id_environments_id_fk" FOREIGN KEY ("environment_id") REFERENCES "cloud"."environments"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "cloud"."relay_tokens" ADD CONSTRAINT "relay_tokens_environment_id_environments_id_fk" FOREIGN KEY ("environment_id") REFERENCES "cloud"."environments"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "email_idempotency_environment_key_unique_idx" ON "cloud"."email_idempotency" USING btree ("environment_id","idempotency_key");--> statement-breakpoint
CREATE INDEX "email_idempotency_environment_created_idx" ON "cloud"."email_idempotency" USING btree ("environment_id","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "email_sending_status_environment_id_unique_idx" ON "cloud"."email_sending_status" USING btree ("environment_id");--> statement-breakpoint
CREATE UNIQUE INDEX "relay_tokens_environment_id_unique_idx" ON "cloud"."relay_tokens" USING btree ("environment_id");--> statement-breakpoint
CREATE UNIQUE INDEX "relay_tokens_token_hash_unique_idx" ON "cloud"."relay_tokens" USING btree ("token_hash");