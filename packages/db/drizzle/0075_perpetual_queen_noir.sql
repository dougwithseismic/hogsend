-- HAND-EDITED: drizzle emits plain `CREATE INDEX`; each statement below was
-- rewritten to `CREATE INDEX IF NOT EXISTS` (the house pattern — see
-- 0070_confused_mindworm.sql). Index-only: no column, no constraint, no data
-- change (PRD 09 part A — the ingest and send hot paths).
--
-- drizzle's pg dialect wraps all pending migrations in ONE transaction, so
-- `CONCURRENTLY` is impossible here (it throws 25001) and each build below
-- holds a SHARE lock that blocks writes to its table for the duration. An
-- operator with a large `user_events` / `email_sends` should pre-create these
-- by hand, online, against the running PREVIOUS release, then deploy — this
-- migration finds them and no-ops:
--
--   CREATE INDEX CONCURRENTLY IF NOT EXISTS user_events_orphan_user_id_idx
--     ON user_events (user_id) WHERE contact_id IS NULL;
--   CREATE INDEX CONCURRENTLY IF NOT EXISTS user_events_contact_event_occurred_idx
--     ON user_events (contact_id, event, occurred_at) WHERE contact_id IS NOT NULL;
--   CREATE INDEX CONCURRENTLY IF NOT EXISTS email_sends_orphan_user_id_idx
--     ON email_sends (user_id) WHERE contact_id IS NULL;
--   CREATE INDEX CONCURRENTLY IF NOT EXISTS email_preferences_email_idx
--     ON email_preferences (email);
--   CREATE INDEX CONCURRENTLY IF NOT EXISTS email_preferences_lower_email_idx
--     ON email_preferences (lower(email));
--
-- A CONCURRENTLY build that fails leaves an INVALID index behind; DROP it
-- (`DROP INDEX CONCURRENTLY <name>`) and retry, because `IF NOT EXISTS` will
-- otherwise skip over the invalid one.
--
-- What each serves:
--  - *_orphan_user_id_idx: the orphan-adoption probe every identity resolve
--    runs (`WHERE user_id = $1 AND contact_id IS NULL`). Partial on the
--    contactless rows, which are a small, shrinking slice — a known contact's
--    probe no longer walks its whole history.
--  - user_events_contact_event_occurred_idx: `event` conditions scoped by
--    contact (`contact_id = $1 AND event = $2 [AND occurred_at >= $3]`).
--  - email_preferences_email_idx: the per-send preference read
--    (`email = $1 OR contact_id = $2`), previously a sequential scan.
--  - email_preferences_lower_email_idx: the campaign suppression anti-joins,
--    which correlate on `lower(email)`.
CREATE INDEX IF NOT EXISTS "email_preferences_email_idx" ON "email_preferences" USING btree ("email");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "email_preferences_lower_email_idx" ON "email_preferences" USING btree (lower("email"));--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "email_sends_orphan_user_id_idx" ON "email_sends" USING btree ("user_id") WHERE contact_id IS NULL;--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "user_events_orphan_user_id_idx" ON "user_events" USING btree ("user_id") WHERE contact_id IS NULL;--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "user_events_contact_event_occurred_idx" ON "user_events" USING btree ("contact_id","event","occurred_at") WHERE contact_id IS NOT NULL;
