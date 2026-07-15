CREATE TABLE "fx_rates" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"base" char(3) NOT NULL,
	"quote" char(3) NOT NULL,
	"rate" numeric(24, 12) NOT NULL,
	"as_of" date NOT NULL,
	"fetched_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX "fx_rates_base_quote_unique_idx" ON "fx_rates" USING btree ("base","quote");