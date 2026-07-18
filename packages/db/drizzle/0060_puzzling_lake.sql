CREATE TABLE "flags" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"key" text NOT NULL,
	"name" text NOT NULL,
	"description" text,
	"enabled" boolean DEFAULT true NOT NULL,
	"type" text NOT NULL,
	"variants" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"default_value" jsonb,
	"targeting" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"rollout" integer DEFAULT 100 NOT NULL,
	"origin" text DEFAULT 'native' NOT NULL,
	"archived_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX "flags_key_unique_idx" ON "flags" USING btree ("key") WHERE archived_at IS NULL;