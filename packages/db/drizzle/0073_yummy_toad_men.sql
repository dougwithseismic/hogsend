CREATE TABLE "referral_touches" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"referral_id" text NOT NULL,
	"referrer_contact_id" uuid NOT NULL,
	"referee_key" text NOT NULL,
	"referee_contact_id" uuid,
	"link_id" uuid,
	"click_id" uuid,
	"source" text NOT NULL,
	"touched_at" timestamp with time zone DEFAULT now() NOT NULL,
	"bound_at" timestamp with time zone,
	"status" text DEFAULT 'touched' NOT NULL,
	"rejected_reason" text,
	"qualified_at" timestamp with time zone,
	"qualified_conversion_id" uuid,
	"properties" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "attribution_credits" ADD COLUMN "referral_touch_id" uuid;--> statement-breakpoint
ALTER TABLE "links" ADD COLUMN "owner_contact_id" uuid;--> statement-breakpoint
ALTER TABLE "referral_touches" ADD CONSTRAINT "referral_touches_referrer_contact_id_contacts_id_fk" FOREIGN KEY ("referrer_contact_id") REFERENCES "public"."contacts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "referral_touches" ADD CONSTRAINT "referral_touches_referee_contact_id_contacts_id_fk" FOREIGN KEY ("referee_contact_id") REFERENCES "public"."contacts"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "referral_touches" ADD CONSTRAINT "referral_touches_link_id_links_id_fk" FOREIGN KEY ("link_id") REFERENCES "public"."links"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "referral_touches" ADD CONSTRAINT "referral_touches_qualified_conversion_id_conversions_id_fk" FOREIGN KEY ("qualified_conversion_id") REFERENCES "public"."conversions"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "referral_touches_referee_idx" ON "referral_touches" USING btree ("referee_contact_id","referral_id","touched_at");--> statement-breakpoint
CREATE INDEX "referral_touches_referrer_idx" ON "referral_touches" USING btree ("referrer_contact_id","referral_id");--> statement-breakpoint
CREATE INDEX "referral_touches_referee_key_unbound_idx" ON "referral_touches" USING btree ("referee_key") WHERE referee_contact_id IS NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "referral_touches_edge_idx" ON "referral_touches" USING btree ("referral_id","referee_contact_id","referrer_contact_id") WHERE status <> 'rejected';--> statement-breakpoint
ALTER TABLE "links" ADD CONSTRAINT "links_owner_contact_id_contacts_id_fk" FOREIGN KEY ("owner_contact_id") REFERENCES "public"."contacts"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "attribution_credits_referral_touch_idx" ON "attribution_credits" USING btree ("referral_touch_id");--> statement-breakpoint
CREATE INDEX "links_owner_contact_idx" ON "links" USING btree ("owner_contact_id");