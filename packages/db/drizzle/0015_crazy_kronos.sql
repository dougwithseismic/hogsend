ALTER TABLE "email_sends" ADD COLUMN "idempotency_key" text;--> statement-breakpoint
CREATE UNIQUE INDEX "email_sends_idempotency_key_idx" ON "email_sends" USING btree ("idempotency_key");