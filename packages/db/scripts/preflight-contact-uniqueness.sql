-- PRD 05 T3 preflight — run BEFORE migration 0071.
--
-- 0071 adds three contact-scoped PARTIAL UNIQUE indexes. Adoption stamps
-- `contact_id` without rewriting `user_id`, so two rows under different string
-- keys can already have become the same contact; if any such pair is live, the
-- index build FAILS (and a CONCURRENTLY build leaves an INVALID index behind).
--
-- Each query below returns the OFFENDING GROUPS for one index. Every query must
-- return ZERO rows before migrating. Any row is a real duplicate a `contact_id`
-- read would see twice — resolve it (terminate/soft-delete the stale row, or
-- merge) rather than weakening the index.
--
-- Each predicate is copied VERBATIM from its index. Keep them in sync:
--   uq_contact_journey_active            packages/db/src/schema/journey-states.ts
--   uq_contact_bucket_active             packages/db/src/schema/bucket-memberships.ts
--   email_preferences_contact_email_idx  packages/db/src/schema/email-preferences.ts
--
--   psql "$DATABASE_URL" -f packages/db/scripts/preflight-contact-uniqueness.sql

-- 1. journey_states → uq_contact_journey_active
--    WHERE contact_id IS NOT NULL AND status IN ('active', 'waiting')
--    (NO deleted_at clause — the index has none; journey_states.deleted_at is
--    not part of the live-enrollment predicate.)
select contact_id, journey_id, count(*) as live_rows
  from journey_states
 where contact_id is not null
   and status in ('active', 'waiting')
 group by 1, 2
having count(*) > 1;

-- 2. bucket_memberships → uq_contact_bucket_active
--    WHERE contact_id IS NOT NULL AND status = 'active' AND deleted_at IS NULL
select contact_id, bucket_id, count(*) as live_rows
  from bucket_memberships
 where contact_id is not null
   and status = 'active'
   and deleted_at is null
 group by 1, 2
having count(*) > 1;

-- 3. email_preferences → email_preferences_contact_email_idx
--    WHERE contact_id IS NOT NULL  (the index is otherwise unfiltered)
select contact_id, email, count(*) as live_rows
  from email_preferences
 where contact_id is not null
 group by 1, 2
having count(*) > 1;
