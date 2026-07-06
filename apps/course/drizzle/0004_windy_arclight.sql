CREATE TABLE "license_code" (
	"id" text PRIMARY KEY NOT NULL,
	"pack_id" text NOT NULL,
	"code" text NOT NULL,
	"stripe_promotion_code_id" text NOT NULL,
	"stripe_coupon_id" text NOT NULL,
	"redeemed_by_user_id" text,
	"redeemed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "license_pack" (
	"id" text PRIMARY KEY NOT NULL,
	"buyer_user_id" text NOT NULL,
	"course_slug" text NOT NULL,
	"seats" integer NOT NULL,
	"stripe_checkout_session_id" text NOT NULL,
	"amount" integer,
	"currency" text,
	"emailed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "license_code" ADD CONSTRAINT "license_code_pack_id_license_pack_id_fk" FOREIGN KEY ("pack_id") REFERENCES "public"."license_pack"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "license_pack" ADD CONSTRAINT "license_pack_buyer_user_id_user_id_fk" FOREIGN KEY ("buyer_user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "license_code_code_uq" ON "license_code" USING btree ("code");--> statement-breakpoint
CREATE INDEX "license_code_pack_idx" ON "license_code" USING btree ("pack_id");--> statement-breakpoint
CREATE UNIQUE INDEX "license_pack_checkout_session_uq" ON "license_pack" USING btree ("stripe_checkout_session_id");--> statement-breakpoint
CREATE INDEX "license_pack_buyer_idx" ON "license_pack" USING btree ("buyer_user_id");