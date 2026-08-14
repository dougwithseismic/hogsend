CREATE TABLE "linked_accounts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"contact_id" uuid NOT NULL,
	"provider" text NOT NULL,
	"provider_user_id" text NOT NULL,
	"username" text,
	"verified_email" text,
	"avatar_url" text,
	"tokens" text,
	"method" text DEFAULT 'oauth' NOT NULL,
	"singleton" boolean DEFAULT false NOT NULL,
	"version" bigint NOT NULL,
	"linked_at" timestamp with time zone DEFAULT now() NOT NULL,
	"unlinked_at" timestamp with time zone,
	"unlink_reason" text,
	"tokens_revoked_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "linked_accounts" ADD CONSTRAINT "linked_accounts_contact_id_contacts_id_fk" FOREIGN KEY ("contact_id") REFERENCES "public"."contacts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "linked_accounts_provider_uid_live_idx" ON "linked_accounts" USING btree ("provider","provider_user_id") WHERE unlinked_at IS NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "linked_accounts_contact_provider_singleton_idx" ON "linked_accounts" USING btree ("contact_id","provider") WHERE unlinked_at IS NULL AND singleton;--> statement-breakpoint
CREATE UNIQUE INDEX "linked_accounts_provider_uid_version_idx" ON "linked_accounts" USING btree ("provider","provider_user_id","version");--> statement-breakpoint
CREATE INDEX "linked_accounts_contact_live_idx" ON "linked_accounts" USING btree ("contact_id") WHERE unlinked_at IS NULL;