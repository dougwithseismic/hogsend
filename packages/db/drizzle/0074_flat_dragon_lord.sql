ALTER TABLE "links" ADD COLUMN "referral_id" text;--> statement-breakpoint
CREATE INDEX "links_referral_idx" ON "links" USING btree ("referral_id");