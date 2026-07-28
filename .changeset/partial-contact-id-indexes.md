---
"@hogsend/db": minor
---

Index `contact_id` on the five history tables — `user_events`, `journey_states`, `bucket_memberships`, `email_sends` and `email_preferences`. Each gets one partial btree index, `<table>_contact_id_idx`, scoped to `WHERE contact_id IS NOT NULL`. The columns themselves shipped in the previous release; this release adds only the indexes, and nothing reads them yet.

The indexes are partial rather than plain for three reasons: the column is still entirely NULL when the migration runs, so the build is a heap scan with zero index writes; the index stays small while the column is sparsely populated; and it permanently excludes rows that legitimately have no owning contact. The predicate does not block the equality probes the indexes exist to serve — the planner proves `contact_id = $1` implies `contact_id IS NOT NULL` and discharges it at plan time, which the test suite asserts with an `EXPLAIN` rather than assuming.

**Operators with a large `user_events` should read this before deploying.** The index build runs inside the migration transaction and takes a `SHARE` lock on each table, which blocks all writes to that table for the duration of the build. `CREATE INDEX CONCURRENTLY` is not available inside a migration: the migration runner wraps every pending migration in a single transaction, and `CONCURRENTLY` is rejected in a transaction block (`25001`). The migration also runs under a 15-minute statement timeout, so on a large enough table it will not merely block writes — it will time out and roll the whole deploy back.

The escape hatch is to build the indexes yourself, online, **against the previous release** — the one that already has the columns but not the indexes. Run these five statements outside a transaction, one at a time, at whatever pace suits your traffic:

```sql
CREATE INDEX CONCURRENTLY IF NOT EXISTS user_events_contact_id_idx
  ON user_events (contact_id) WHERE contact_id IS NOT NULL;

CREATE INDEX CONCURRENTLY IF NOT EXISTS journey_states_contact_id_idx
  ON journey_states (contact_id) WHERE contact_id IS NOT NULL;

CREATE INDEX CONCURRENTLY IF NOT EXISTS bucket_memberships_contact_id_idx
  ON bucket_memberships (contact_id) WHERE contact_id IS NOT NULL;

CREATE INDEX CONCURRENTLY IF NOT EXISTS email_sends_contact_id_idx
  ON email_sends (contact_id) WHERE contact_id IS NOT NULL;

CREATE INDEX CONCURRENTLY IF NOT EXISTS email_preferences_contact_id_idx
  ON email_preferences (contact_id) WHERE contact_id IS NOT NULL;
```

The migration's own statements are `CREATE INDEX IF NOT EXISTS`, so it then finds the indexes already present and no-ops with no lock taken. This is why the columns and the indexes ship in separate releases. If `CREATE INDEX CONCURRENTLY` fails part-way it leaves an invalid index behind; drop it (`DROP INDEX CONCURRENTLY <name>;`) and retry before deploying, since an invalid index satisfies `IF NOT EXISTS` but is not used by the planner.

Deployments where `user_events` is small enough that a `SHARE` lock for the build is acceptable need to do nothing — deploy as usual.
