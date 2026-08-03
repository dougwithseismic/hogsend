CREATE TABLE "cloud"."stack_alerts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"stack_id" uuid NOT NULL,
	"organization_id" text NOT NULL,
	"condition" text NOT NULL,
	"fingerprint" text NOT NULL,
	"last_alerted_at" timestamp with time zone DEFAULT now() NOT NULL,
	"cleared_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "cloud"."stack_alerts" ADD CONSTRAINT "stack_alerts_stack_id_stacks_id_fk" FOREIGN KEY ("stack_id") REFERENCES "cloud"."stacks"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "cloud"."stack_alerts" ADD CONSTRAINT "stack_alerts_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "cloud"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "stack_alerts_stack_id_condition_unique_idx" ON "cloud"."stack_alerts" USING btree ("stack_id","condition");