CREATE TABLE "group_memberships" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" text,
	"group_id" uuid NOT NULL,
	"contact_id" uuid NOT NULL,
	"role" text,
	"joined_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "groups" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" text,
	"group_type" text NOT NULL,
	"group_key" text NOT NULL,
	"display_name" text,
	"properties" jsonb DEFAULT '{}'::jsonb,
	"first_seen_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_seen_at" timestamp with time zone DEFAULT now() NOT NULL,
	"deleted_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "user_events" ADD COLUMN "groups" jsonb;--> statement-breakpoint
ALTER TABLE "group_memberships" ADD CONSTRAINT "group_memberships_group_id_groups_id_fk" FOREIGN KEY ("group_id") REFERENCES "public"."groups"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "group_memberships" ADD CONSTRAINT "group_memberships_contact_id_contacts_id_fk" FOREIGN KEY ("contact_id") REFERENCES "public"."contacts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "group_memberships_group_contact_unique_idx" ON "group_memberships" USING btree ("group_id","contact_id");--> statement-breakpoint
CREATE INDEX "group_memberships_group_id_idx" ON "group_memberships" USING btree ("group_id");--> statement-breakpoint
CREATE INDEX "group_memberships_contact_id_idx" ON "group_memberships" USING btree ("contact_id");--> statement-breakpoint
CREATE UNIQUE INDEX "groups_type_key_unique_idx" ON "groups" USING btree ("group_type","group_key") WHERE deleted_at IS NULL;