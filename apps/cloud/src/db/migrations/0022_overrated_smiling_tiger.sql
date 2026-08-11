CREATE TABLE "cloud"."email_allowance_warnings" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" text NOT NULL,
	"period" text NOT NULL,
	"percent" integer NOT NULL,
	"used" bigint NOT NULL,
	"allowance" bigint NOT NULL,
	"recipients" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "cloud"."email_overage_reports" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" text NOT NULL,
	"period" text NOT NULL,
	"reported_quantity" bigint DEFAULT 0 NOT NULL,
	"pending_quantity" bigint,
	"last_reported_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "cloud"."email_allowance_warnings" ADD CONSTRAINT "email_allowance_warnings_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "cloud"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "cloud"."email_overage_reports" ADD CONSTRAINT "email_overage_reports_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "cloud"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "email_allowance_warnings_org_period_percent_unique_idx" ON "cloud"."email_allowance_warnings" USING btree ("organization_id","period","percent");--> statement-breakpoint
CREATE UNIQUE INDEX "email_overage_reports_org_period_unique_idx" ON "cloud"."email_overage_reports" USING btree ("organization_id","period");