CREATE INDEX "email_sends_to_email_idx" ON "email_sends" USING btree ("to_email");--> statement-breakpoint
CREATE INDEX "email_sends_template_key_idx" ON "email_sends" USING btree ("template_key");--> statement-breakpoint
CREATE INDEX "email_sends_status_idx" ON "email_sends" USING btree ("status");--> statement-breakpoint
CREATE INDEX "email_sends_created_at_idx" ON "email_sends" USING btree ("created_at");--> statement-breakpoint
CREATE INDEX "email_sends_journey_state_id_idx" ON "email_sends" USING btree ("journey_state_id");--> statement-breakpoint
CREATE INDEX "journey_logs_journey_state_id_idx" ON "journey_logs" USING btree ("journey_state_id");--> statement-breakpoint
CREATE INDEX "link_clicks_tracked_link_id_idx" ON "link_clicks" USING btree ("tracked_link_id");--> statement-breakpoint
CREATE INDEX "tracked_links_email_send_id_idx" ON "tracked_links" USING btree ("email_send_id");