ALTER TABLE "attribution_credits" ADD COLUMN "journey_id" text;--> statement-breakpoint
ALTER TABLE "attribution_credits" ADD COLUMN "campaign_id" uuid;--> statement-breakpoint
ALTER TABLE "attribution_credits" ADD COLUMN "template_key" text;--> statement-breakpoint
ALTER TABLE "attribution_credits" ADD COLUMN "funnel_id" text;--> statement-breakpoint
CREATE INDEX "attribution_credits_journey_idx" ON "attribution_credits" USING btree ("journey_id");--> statement-breakpoint
CREATE INDEX "attribution_credits_campaign_idx" ON "attribution_credits" USING btree ("campaign_id");