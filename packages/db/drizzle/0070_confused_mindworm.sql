-- HAND-EDITED: drizzle emits plain `CREATE INDEX`; each statement below was
-- rewritten to `CREATE INDEX IF NOT EXISTS` (hand-editing migration bodies is
-- the house pattern — see 0043_normalize-bucket-membership-emails.sql and
-- 0051_melted_frog_thor.sql). The columns shipped in the PREVIOUS release
-- (0069) without indexes precisely so an operator with a large `user_events`
-- can pre-create these five by hand, online, against that running release:
--
--   CREATE INDEX CONCURRENTLY IF NOT EXISTS user_events_contact_id_idx
--     ON user_events (contact_id) WHERE contact_id IS NOT NULL;
--
-- ...and the four twins. This migration then finds them already there and
-- no-ops. Without that, the build below runs inside the migration transaction
-- (drizzle's pg dialect wraps all pending migrations in one transaction, so
-- CONCURRENTLY is impossible here — it throws 25001) and holds a SHARE lock,
-- blocking writes to the table for its duration.
--
-- The indexes are PARTIAL (`WHERE contact_id IS NOT NULL`): the column is 100%
-- NULL at this point, so the build is a heap scan with zero index writes.
CREATE INDEX IF NOT EXISTS "bucket_memberships_contact_id_idx" ON "bucket_memberships" USING btree ("contact_id") WHERE contact_id IS NOT NULL;--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "email_preferences_contact_id_idx" ON "email_preferences" USING btree ("contact_id") WHERE contact_id IS NOT NULL;--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "email_sends_contact_id_idx" ON "email_sends" USING btree ("contact_id") WHERE contact_id IS NOT NULL;--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "journey_states_contact_id_idx" ON "journey_states" USING btree ("contact_id") WHERE contact_id IS NOT NULL;--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "user_events_contact_id_idx" ON "user_events" USING btree ("contact_id") WHERE contact_id IS NOT NULL;
