CREATE TABLE "funnel_progress" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"contact_id" uuid NOT NULL,
	"user_key" text NOT NULL,
	"funnel_id" text NOT NULL,
	"stage" text NOT NULL,
	"stage_rank" integer NOT NULL,
	"reached_at" timestamp with time zone NOT NULL,
	"event_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "funnel_progress" ADD CONSTRAINT "funnel_progress_contact_id_contacts_id_fk" FOREIGN KEY ("contact_id") REFERENCES "public"."contacts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "funnel_progress_contact_funnel_stage_idx" ON "funnel_progress" USING btree ("contact_id","funnel_id","stage");--> statement-breakpoint
CREATE INDEX "funnel_progress_funnel_rank_idx" ON "funnel_progress" USING btree ("funnel_id","stage_rank");--> statement-breakpoint
CREATE INDEX "funnel_progress_funnel_reached_idx" ON "funnel_progress" USING btree ("funnel_id","reached_at");