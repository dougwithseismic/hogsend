CREATE TABLE "cloud"."builds" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"environment_id" uuid NOT NULL,
	"stack_id" uuid,
	"status" text DEFAULT 'queued' NOT NULL,
	"engine_version" text,
	"image_digest" text,
	"artifact_path" text NOT NULL,
	"manifest" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"log_tail" text,
	"error" text,
	"started_at" timestamp with time zone,
	"finished_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "cloud"."publish_tokens" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"environment_id" uuid NOT NULL,
	"token_hash" text NOT NULL,
	"last4" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"rotated_at" timestamp with time zone
);
--> statement-breakpoint
ALTER TABLE "cloud"."builds" ADD CONSTRAINT "builds_environment_id_environments_id_fk" FOREIGN KEY ("environment_id") REFERENCES "cloud"."environments"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "cloud"."builds" ADD CONSTRAINT "builds_stack_id_stacks_id_fk" FOREIGN KEY ("stack_id") REFERENCES "cloud"."stacks"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "cloud"."publish_tokens" ADD CONSTRAINT "publish_tokens_environment_id_environments_id_fk" FOREIGN KEY ("environment_id") REFERENCES "cloud"."environments"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "builds_environment_created_at_idx" ON "cloud"."builds" USING btree ("environment_id","created_at" desc);--> statement-breakpoint
CREATE UNIQUE INDEX "builds_environment_active_unique_idx" ON "cloud"."builds" USING btree ("environment_id") WHERE "cloud"."builds"."status" not in ('succeeded', 'failed');--> statement-breakpoint
CREATE UNIQUE INDEX "publish_tokens_environment_id_unique_idx" ON "cloud"."publish_tokens" USING btree ("environment_id");--> statement-breakpoint
CREATE UNIQUE INDEX "publish_tokens_token_hash_unique_idx" ON "cloud"."publish_tokens" USING btree ("token_hash");