-- One-off backfill for audience-model.md wart #1: bucket_memberships.user_email
-- was written verbatim from raw event payloads (mixed case / stray whitespace),
-- forcing every read site into a defensive lower(trim(...)) join against the
-- normalized email_preferences keyspace. All write sites now normalize
-- (normalizeEmail = trim + lowercase); this brings the existing rows in line.
-- Guarded so already-normalized rows (the vast majority) are not rewritten;
-- IS DISTINCT FROM keeps NULLs untouched. Runs well inside the migration
-- runner's 15-minute statement timeout at current table sizes — if that ever
-- stops being true, UPGRADING.md's answer is a chunked Hatchet backfill.
UPDATE "bucket_memberships"
SET "user_email" = lower(trim("user_email"))
WHERE "user_email" IS DISTINCT FROM lower(trim("user_email"));
