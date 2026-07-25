CREATE TYPE "public"."enrichment_lookup_kind" AS ENUM('email', 'domain');--> statement-breakpoint
CREATE TYPE "public"."enrichment_lookup_status" AS ENUM('found', 'not_found', 'error');--> statement-breakpoint
CREATE TABLE "enrichment_lookups" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"provider" text NOT NULL,
	"lookup_kind" "enrichment_lookup_kind" NOT NULL,
	"lookup_key" text NOT NULL,
	"status" "enrichment_lookup_status" NOT NULL,
	"contact_id" uuid,
	"refined_at" timestamp with time zone NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"raw" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "enrichment_lookups" ADD CONSTRAINT "enrichment_lookups_contact_id_contacts_id_fk" FOREIGN KEY ("contact_id") REFERENCES "public"."contacts"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "enrichment_lookups_provider_key_unique_idx" ON "enrichment_lookups" USING btree ("provider","lookup_kind","lookup_key");--> statement-breakpoint
CREATE INDEX "enrichment_lookups_refined_at_idx" ON "enrichment_lookups" USING btree ("refined_at");--> statement-breakpoint
CREATE INDEX "enrichment_lookups_contact_id_idx" ON "enrichment_lookups" USING btree ("contact_id");