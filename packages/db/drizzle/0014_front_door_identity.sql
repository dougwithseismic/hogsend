CREATE TABLE "contact_aliases" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"contact_id" uuid NOT NULL,
	"alias_kind" text NOT NULL,
	"alias_value" text NOT NULL,
	"from_contact_id" uuid,
	"reason" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "contacts" DROP CONSTRAINT "contacts_external_id_unique";--> statement-breakpoint
ALTER TABLE "contacts" ALTER COLUMN "external_id" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "contacts" ADD COLUMN "anonymous_id" text;--> statement-breakpoint
ALTER TABLE "contact_aliases" ADD CONSTRAINT "contact_aliases_contact_id_contacts_id_fk" FOREIGN KEY ("contact_id") REFERENCES "public"."contacts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "contact_aliases_kind_value_idx" ON "contact_aliases" USING btree ("alias_kind","alias_value");--> statement-breakpoint
CREATE INDEX "contact_aliases_contact_id_idx" ON "contact_aliases" USING btree ("contact_id");--> statement-breakpoint
CREATE UNIQUE INDEX "contacts_external_id_unique_idx" ON "contacts" USING btree ("external_id") WHERE external_id IS NOT NULL AND deleted_at IS NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "contacts_email_unique_idx" ON "contacts" USING btree (lower(email)) WHERE email IS NOT NULL AND deleted_at IS NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "contacts_anonymous_id_unique_idx" ON "contacts" USING btree ("anonymous_id") WHERE anonymous_id IS NOT NULL AND deleted_at IS NULL;