CREATE TABLE "cloud"."hostnames" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" text NOT NULL,
	"environment_id" uuid NOT NULL,
	"hostname" text NOT NULL,
	"kind" text DEFAULT 'managed' NOT NULL,
	"dns_record_id" text,
	"substrate_domain_id" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "cloud"."hostnames" ADD CONSTRAINT "hostnames_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "cloud"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "cloud"."hostnames" ADD CONSTRAINT "hostnames_environment_id_environments_id_fk" FOREIGN KEY ("environment_id") REFERENCES "cloud"."environments"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "hostnames_hostname_unique_idx" ON "cloud"."hostnames" USING btree ("hostname");--> statement-breakpoint
CREATE INDEX "hostnames_environment_id_idx" ON "cloud"."hostnames" USING btree ("environment_id");--> statement-breakpoint
CREATE INDEX "hostnames_organization_id_idx" ON "cloud"."hostnames" USING btree ("organization_id");