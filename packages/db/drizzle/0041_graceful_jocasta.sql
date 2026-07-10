CREATE TABLE "campaign_recipients" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"campaign_id" uuid NOT NULL,
	"user_id" text,
	"email" text NOT NULL,
	"resolved_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "campaigns" ADD COLUMN "steps" jsonb;--> statement-breakpoint
ALTER TABLE "campaigns" ADD COLUMN "current_step" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "campaigns" ADD COLUMN "step_base_counts" jsonb;--> statement-breakpoint
ALTER TABLE "campaigns" ADD COLUMN "next_step_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "campaign_recipients" ADD CONSTRAINT "campaign_recipients_campaign_id_campaigns_id_fk" FOREIGN KEY ("campaign_id") REFERENCES "public"."campaigns"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "campaign_recipients_campaign_email_idx" ON "campaign_recipients" USING btree ("campaign_id","email");--> statement-breakpoint
CREATE INDEX "campaign_recipients_campaign_id_id_idx" ON "campaign_recipients" USING btree ("campaign_id","id");--> statement-breakpoint
CREATE INDEX "campaigns_next_step_at_idx" ON "campaigns" USING btree ("status","next_step_at");