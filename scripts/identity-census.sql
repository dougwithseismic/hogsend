-- Identity census (PRD 07 T1). READ-ONLY — counts only, no writes.
--
-- Run:  psql "$DATABASE_URL" -f scripts/identity-census.sql
--
-- Per history table (the five contact_id-stamped tables; sms_sends has no
-- contact_id column yet and is out of scope):
--   total             all rows
--   null_contact_id   rows no contact owns. Legal ONLY via the refusal path
--                     (publishable anon-only writes; raw-address email sends).
--   null_no_user_id   nulls with no user_id either (email_sends raw-address
--                     sends; structurally 0 on tables with NOT NULL user_id).
--   null_live_key     nulls whose user_id IS a live contact's canonical key.
--                     adoptOrphanHistory should have stamped these at identify
--                     time — a large count here is a PRD 05 defect (risk #5)
--                     and PRD 07 must not proceed on top of it.
--   null_aliased_key  nulls whose user_id matches any contact_aliases value
--                     (claimed or stale keys still unstamped).
--
-- Alias-vs-column parity (a nonzero *_unaliased count means the PRD 02
-- dual-write missed keys and the alias table is NOT yet the full registry):
--   kind_<k>          contact_aliases rows of kind k
--   col_<k>           live contacts carrying the matching column
--   <k>_unaliased     live contacts whose column value has NO alias row.
--                     Row-uuid pseudo-keys are deliberately unaliased by
--                     design and excluded here.
--   anon_only         live contacts with anonymous_id and no external_id.
with live as (
  select
    id,
    external_id,
    anonymous_id,
    email,
    discord_id,
    coalesce(external_id, anonymous_id, id::text) as canonical_key
  from contacts
  where deleted_at is null
)
select table_name, metric, count from (
  select 'user_events' as table_name, 'total' as metric,
         count(*)::bigint as count, 1 as ord from user_events
  union all
  select 'user_events', 'null_contact_id', count(*), 2
    from user_events where contact_id is null
  union all
  select 'user_events', 'null_no_user_id', count(*), 3
    from user_events where contact_id is null and user_id is null
  union all
  select 'user_events', 'null_live_key', count(*), 4
    from user_events t
    where t.contact_id is null
      and exists (select 1 from live l where l.canonical_key = t.user_id)
  union all
  select 'user_events', 'null_aliased_key', count(*), 5
    from user_events t
    where t.contact_id is null
      and exists (select 1 from contact_aliases a
                  where a.alias_value = t.user_id)

  union all
  select 'journey_states', 'total', count(*), 6 from journey_states
  union all
  select 'journey_states', 'null_contact_id', count(*), 7
    from journey_states where contact_id is null
  union all
  select 'journey_states', 'null_no_user_id', count(*), 8
    from journey_states where contact_id is null and user_id is null
  union all
  select 'journey_states', 'null_live_key', count(*), 9
    from journey_states t
    where t.contact_id is null
      and exists (select 1 from live l where l.canonical_key = t.user_id)
  union all
  select 'journey_states', 'null_aliased_key', count(*), 10
    from journey_states t
    where t.contact_id is null
      and exists (select 1 from contact_aliases a
                  where a.alias_value = t.user_id)

  union all
  select 'bucket_memberships', 'total', count(*), 11 from bucket_memberships
  union all
  select 'bucket_memberships', 'null_contact_id', count(*), 12
    from bucket_memberships where contact_id is null
  union all
  select 'bucket_memberships', 'null_no_user_id', count(*), 13
    from bucket_memberships where contact_id is null and user_id is null
  union all
  select 'bucket_memberships', 'null_live_key', count(*), 14
    from bucket_memberships t
    where t.contact_id is null
      and exists (select 1 from live l where l.canonical_key = t.user_id)
  union all
  select 'bucket_memberships', 'null_aliased_key', count(*), 15
    from bucket_memberships t
    where t.contact_id is null
      and exists (select 1 from contact_aliases a
                  where a.alias_value = t.user_id)

  union all
  select 'email_sends', 'total', count(*), 16 from email_sends
  union all
  select 'email_sends', 'null_contact_id', count(*), 17
    from email_sends where contact_id is null
  union all
  select 'email_sends', 'null_no_user_id', count(*), 18
    from email_sends where contact_id is null and user_id is null
  union all
  select 'email_sends', 'null_live_key', count(*), 19
    from email_sends t
    where t.contact_id is null
      and exists (select 1 from live l where l.canonical_key = t.user_id)
  union all
  select 'email_sends', 'null_aliased_key', count(*), 20
    from email_sends t
    where t.contact_id is null
      and exists (select 1 from contact_aliases a
                  where a.alias_value = t.user_id)

  union all
  select 'email_preferences', 'total', count(*), 21 from email_preferences
  union all
  select 'email_preferences', 'null_contact_id', count(*), 22
    from email_preferences where contact_id is null
  union all
  select 'email_preferences', 'null_no_user_id', count(*), 23
    from email_preferences where contact_id is null and user_id is null
  union all
  select 'email_preferences', 'null_live_key', count(*), 24
    from email_preferences t
    where t.contact_id is null
      and exists (select 1 from live l where l.canonical_key = t.user_id)
  union all
  select 'email_preferences', 'null_aliased_key', count(*), 25
    from email_preferences t
    where t.contact_id is null
      and exists (select 1 from contact_aliases a
                  where a.alias_value = t.user_id)

  union all
  select 'contact_aliases', 'kind_external', count(*), 26
    from contact_aliases where alias_kind = 'external'
  union all
  select 'contacts', 'col_external', count(*), 27
    from live where external_id is not null
  union all
  select 'contacts', 'external_unaliased', count(*), 28
    from live l
    where l.external_id is not null
      and not exists (select 1 from contact_aliases a
                      where a.alias_kind = 'external'
                        and a.alias_value = l.external_id)

  union all
  select 'contact_aliases', 'kind_anonymous', count(*), 29
    from contact_aliases where alias_kind = 'anonymous'
  union all
  select 'contacts', 'col_anonymous', count(*), 30
    from live where anonymous_id is not null
  union all
  select 'contacts', 'anonymous_unaliased', count(*), 31
    from live l
    where l.anonymous_id is not null
      and not exists (select 1 from contact_aliases a
                      where a.alias_kind = 'anonymous'
                        and a.alias_value = l.anonymous_id)

  union all
  select 'contact_aliases', 'kind_email', count(*), 32
    from contact_aliases where alias_kind = 'email'
  union all
  select 'contacts', 'col_email', count(*), 33
    from live where email is not null
  union all
  -- Alias emails land normalized (lower/trim); compare against that form.
  select 'contacts', 'email_unaliased', count(*), 34
    from live l
    where l.email is not null
      and not exists (select 1 from contact_aliases a
                      where a.alias_kind = 'email'
                        and a.alias_value = lower(trim(l.email)))

  union all
  select 'contact_aliases', 'kind_discord', count(*), 35
    from contact_aliases where alias_kind = 'discord'
  union all
  select 'contacts', 'col_discord', count(*), 36
    from live where discord_id is not null
  union all
  select 'contacts', 'discord_unaliased', count(*), 37
    from live l
    where l.discord_id is not null
      and not exists (select 1 from contact_aliases a
                      where a.alias_kind = 'discord'
                        and a.alias_value = l.discord_id)

  union all
  select 'contacts', 'anon_only', count(*), 38
    from live where anonymous_id is not null and external_id is null
) census
order by ord;
