CREATE TABLE "voice_tool_calls" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"voice_call_id" uuid,
	"tool_call_id" text NOT NULL,
	"name" text NOT NULL,
	"result" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "voice_tool_calls" ADD CONSTRAINT "voice_tool_calls_voice_call_id_voice_calls_id_fk" FOREIGN KEY ("voice_call_id") REFERENCES "public"."voice_calls"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "voice_tool_calls_tool_call_id_idx" ON "voice_tool_calls" USING btree ("tool_call_id");--> statement-breakpoint
CREATE INDEX "voice_tool_calls_voice_call_id_idx" ON "voice_tool_calls" USING btree ("voice_call_id");