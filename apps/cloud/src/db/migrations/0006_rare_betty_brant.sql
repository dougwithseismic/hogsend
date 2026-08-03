ALTER TABLE "cloud"."organizations" ADD COLUMN "dunning_since" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "cloud"."organizations" ADD COLUMN "billing_customer_id" text;--> statement-breakpoint
CREATE INDEX "organizations_dunning_since_idx" ON "cloud"."organizations" USING btree ("dunning_since") WHERE "cloud"."organizations"."dunning_since" is not null;