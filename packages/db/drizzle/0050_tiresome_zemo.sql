CREATE TABLE "attribution_credits" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"conversion_id" uuid NOT NULL,
	"model" text NOT NULL,
	"touchpoint_event_id" uuid NOT NULL,
	"touchpoint_event" text NOT NULL,
	"channel" text NOT NULL,
	"touchpoint_at" timestamp with time zone NOT NULL,
	"weight" numeric(9, 8) NOT NULL,
	"value" numeric(14, 2),
	"currency" char(3),
	"converted_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "attribution_credits" ADD CONSTRAINT "attribution_credits_conversion_id_conversions_id_fk" FOREIGN KEY ("conversion_id") REFERENCES "public"."conversions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "attribution_credits_conv_model_touch_idx" ON "attribution_credits" USING btree ("conversion_id","model","touchpoint_event_id");--> statement-breakpoint
CREATE INDEX "attribution_credits_model_converted_idx" ON "attribution_credits" USING btree ("model","converted_at");--> statement-breakpoint
CREATE INDEX "attribution_credits_channel_idx" ON "attribution_credits" USING btree ("channel");