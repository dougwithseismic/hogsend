CREATE TABLE "crm_links" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"provider" text NOT NULL,
	"kind" text NOT NULL,
	"external_id" text NOT NULL,
	"contact_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "crm_sync_cursors" (
	"provider" text PRIMARY KEY NOT NULL,
	"cursor" text,
	"last_polled_at" timestamp with time zone,
	"last_error" jsonb,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "deals" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"provider" text NOT NULL,
	"external_id" text NOT NULL,
	"contact_id" uuid NOT NULL,
	"pipeline_id" text,
	"stage_id" text,
	"canonical_stage" text DEFAULT 'lead' NOT NULL,
	"stage_rank" integer DEFAULT 0 NOT NULL,
	"value" numeric(14, 2),
	"currency" char(3),
	"quoted_at" timestamp with time zone,
	"sold_at" timestamp with time zone,
	"lost_at" timestamp with time zone,
	"last_stage_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "crm_links" ADD CONSTRAINT "crm_links_contact_id_contacts_id_fk" FOREIGN KEY ("contact_id") REFERENCES "public"."contacts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "deals" ADD CONSTRAINT "deals_contact_id_contacts_id_fk" FOREIGN KEY ("contact_id") REFERENCES "public"."contacts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "crm_links_provider_kind_external_idx" ON "crm_links" USING btree ("provider","kind","external_id");--> statement-breakpoint
CREATE INDEX "crm_links_contact_idx" ON "crm_links" USING btree ("contact_id");--> statement-breakpoint
CREATE UNIQUE INDEX "deals_provider_external_idx" ON "deals" USING btree ("provider","external_id");--> statement-breakpoint
CREATE INDEX "deals_contact_idx" ON "deals" USING btree ("contact_id");--> statement-breakpoint
CREATE INDEX "deals_stage_idx" ON "deals" USING btree ("canonical_stage");