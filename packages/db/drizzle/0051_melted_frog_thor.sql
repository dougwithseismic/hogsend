ALTER TABLE "email_sends" ADD COLUMN "campaign_id" uuid;--> statement-breakpoint
ALTER TABLE "email_sends" ADD CONSTRAINT "email_sends_campaign_id_campaigns_id_fk" FOREIGN KEY ("campaign_id") REFERENCES "public"."campaigns"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "email_sends_campaign_id_idx" ON "email_sends" USING btree ("campaign_id");--> statement-breakpoint
-- Backfill campaign identity from the idempotency-key convention
-- (`campaign:<id>[:<step>]:<email>`, campaign-send-key.ts). Joined against
-- `campaigns` so a key whose id segment is not a live campaign uuid (deleted
-- row, malformed key) stays NULL instead of violating the FK. Suppressed sends
-- never carried a key, so pre-column suppressed rows remain NULL — the column
-- is fully authoritative only from this migration forward.
UPDATE "email_sends" es
SET "campaign_id" = c."id"
FROM "campaigns" c
WHERE es."campaign_id" IS NULL
  AND es."idempotency_key" LIKE 'campaign:%'
  AND split_part(es."idempotency_key", ':', 2) = c."id"::text;
