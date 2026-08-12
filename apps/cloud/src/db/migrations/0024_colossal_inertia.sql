CREATE TYPE "cloud"."cloud_email_inbound_status" AS ENUM('pending', 'delivered', 'suppressed', 'dropped', 'failed');--> statement-breakpoint
CREATE TABLE "cloud"."email_inbound_messages" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"environment_id" uuid,
	"region" "cloud"."cloud_region" NOT NULL,
	"dedupe_key" text NOT NULL,
	"ses_message_id" text NOT NULL,
	"recipient" text NOT NULL,
	"recipients" jsonb NOT NULL,
	"domain" text,
	"bucket" text NOT NULL,
	"object_key" text NOT NULL,
	"size_bytes" integer,
	"from_address" text,
	"subject" text,
	"in_reply_to" text,
	"correlated_message_id" text,
	"correlated" boolean DEFAULT false NOT NULL,
	"attachments" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"status" "cloud"."cloud_email_inbound_status" DEFAULT 'pending' NOT NULL,
	"reason" text,
	"attempts" integer DEFAULT 0 NOT NULL,
	"last_error" text,
	"delivered_at" timestamp with time zone,
	"forwarded_at" timestamp with time zone,
	"received_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "cloud"."email_inbound_messages" ADD CONSTRAINT "email_inbound_messages_environment_id_environments_id_fk" FOREIGN KEY ("environment_id") REFERENCES "cloud"."environments"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "email_inbound_messages_dedupe_key_unique_idx" ON "cloud"."email_inbound_messages" USING btree ("dedupe_key");--> statement-breakpoint
CREATE INDEX "email_inbound_messages_environment_created_idx" ON "cloud"."email_inbound_messages" USING btree ("environment_id","created_at");--> statement-breakpoint
CREATE INDEX "email_inbound_messages_status_idx" ON "cloud"."email_inbound_messages" USING btree ("status");--> statement-breakpoint
CREATE INDEX "email_inbound_messages_ses_message_id_idx" ON "cloud"."email_inbound_messages" USING btree ("ses_message_id");--> statement-breakpoint
CREATE INDEX "email_idempotency_environment_message_id_idx" ON "cloud"."email_idempotency" USING btree ("environment_id","message_id");