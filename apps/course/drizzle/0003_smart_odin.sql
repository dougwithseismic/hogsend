CREATE TABLE "gift" (
	"id" text PRIMARY KEY NOT NULL,
	"buyer_user_id" text NOT NULL,
	"course_slug" text NOT NULL,
	"recipient_email" text,
	"promotion_code" text DEFAULT '' NOT NULL,
	"stripe_promotion_code_id" text DEFAULT '' NOT NULL,
	"stripe_coupon_id" text DEFAULT '' NOT NULL,
	"stripe_checkout_session_id" text NOT NULL,
	"amount" integer,
	"currency" text,
	"redeemed_by_user_id" text,
	"redeemed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "gift" ADD CONSTRAINT "gift_buyer_user_id_user_id_fk" FOREIGN KEY ("buyer_user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "gift_checkout_session_uq" ON "gift" USING btree ("stripe_checkout_session_id");--> statement-breakpoint
CREATE INDEX "gift_buyer_idx" ON "gift" USING btree ("buyer_user_id");