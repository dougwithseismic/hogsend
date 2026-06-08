ALTER TABLE "webhook_endpoints" ALTER COLUMN "secret" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "webhook_endpoints" ALTER COLUMN "secret_prefix" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "webhook_endpoints" ADD COLUMN "kind" text DEFAULT 'webhook' NOT NULL;--> statement-breakpoint
ALTER TABLE "webhook_endpoints" ADD COLUMN "config" jsonb;