ALTER TABLE "contacts" ADD COLUMN "timezone" text;--> statement-breakpoint
CREATE INDEX "email_sends_freq_cap_idx" ON "email_sends" USING btree ("to_email","created_at","category");