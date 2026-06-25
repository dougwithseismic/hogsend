CREATE TYPE "public"."feed_item_status" AS ENUM('unseen', 'seen', 'read', 'archived');--> statement-breakpoint
CREATE TABLE "feed_items" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"recipient_key" text NOT NULL,
	"contact_id" uuid,
	"type" text NOT NULL,
	"title" text,
	"body" text,
	"blocks" jsonb,
	"action_url" text,
	"metadata" jsonb,
	"journey_state_id" uuid,
	"template_key" text,
	"category" text DEFAULT 'in_app' NOT NULL,
	"status" "feed_item_status" DEFAULT 'unseen' NOT NULL,
	"seen_at" timestamp with time zone,
	"read_at" timestamp with time zone,
	"archived_at" timestamp with time zone,
	"idempotency_key" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE INDEX "feed_items_recipient_created_idx" ON "feed_items" USING btree ("recipient_key","created_at");--> statement-breakpoint
CREATE INDEX "feed_items_recipient_status_idx" ON "feed_items" USING btree ("recipient_key","status");--> statement-breakpoint
CREATE INDEX "feed_items_contact_idx" ON "feed_items" USING btree ("contact_id");--> statement-breakpoint
CREATE UNIQUE INDEX "feed_items_idempotency_key_idx" ON "feed_items" USING btree ("idempotency_key");