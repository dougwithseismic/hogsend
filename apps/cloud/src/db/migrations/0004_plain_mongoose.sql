ALTER TABLE "cloud"."stacks" ADD COLUMN "db_dsn_encrypted" text;--> statement-breakpoint
ALTER TABLE "cloud"."stacks" ADD COLUMN "hatchet_token_encrypted" text;--> statement-breakpoint
ALTER TABLE "cloud"."stacks" ADD COLUMN "stack_secrets_encrypted" text;