CREATE TABLE "cloud"."stack_health" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"stack_id" uuid NOT NULL,
	"organization_id" text NOT NULL,
	"healthy" boolean NOT NULL,
	"detail" text,
	"checked_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "cloud"."stack_health" ADD CONSTRAINT "stack_health_stack_id_stacks_id_fk" FOREIGN KEY ("stack_id") REFERENCES "cloud"."stacks"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "cloud"."stack_health" ADD CONSTRAINT "stack_health_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "cloud"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "stack_health_stack_id_checked_at_idx" ON "cloud"."stack_health" USING btree ("stack_id","checked_at");