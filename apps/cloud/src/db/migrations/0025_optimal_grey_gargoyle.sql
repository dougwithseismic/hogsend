CREATE TABLE "cloud"."sending_domains" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" text NOT NULL,
	"environment_id" uuid,
	"domain" text NOT NULL,
	"aws_region" text NOT NULL,
	"released_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "cloud"."sending_domains" ADD CONSTRAINT "sending_domains_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "cloud"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "cloud"."sending_domains" ADD CONSTRAINT "sending_domains_environment_id_environments_id_fk" FOREIGN KEY ("environment_id") REFERENCES "cloud"."environments"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "sending_domains_domain_live_unique_idx" ON "cloud"."sending_domains" USING btree ("domain") WHERE released_at IS NULL;--> statement-breakpoint
CREATE INDEX "sending_domains_organization_id_idx" ON "cloud"."sending_domains" USING btree ("organization_id");