---
"@hogsend/engine": patch
"@hogsend/core": patch
"@hogsend/db": patch
---

Ingesting an event for a known contact now takes 10 database statements instead of 17. Before, every identity resolve ran eight statements to adopt contactless history under the contact's key, even when there was none, and two of them read the contact's whole event and send history. It now runs one indexed check first and skips the eight when nothing is waiting to be adopted. Adoption itself is unchanged.

Bucket and flag `event` conditions now answer `exists`/`not_exists` with an `EXISTS` check and stop counting a `count` comparison once the answer is settled, instead of counting every matching event. `ctx.history.hasEvent` still returns the exact count.

Migration `0075` adds five indexes: `email_preferences(email)`, which turns the preference check on every tracked send from a sequential scan into an index lookup; `email_preferences(lower(email))` for the campaign suppression checks; partial `user_events(user_id)` and `email_sends(user_id)` indexes over contactless rows for the adoption check; and a partial `user_events(contact_id, event, occurred_at)` index for `event` conditions. It uses `CREATE INDEX IF NOT EXISTS`, so on a large database you can build the indexes online before you deploy, and the migration will skip them:

```sql
CREATE INDEX CONCURRENTLY IF NOT EXISTS user_events_orphan_user_id_idx ON user_events (user_id) WHERE contact_id IS NULL;
CREATE INDEX CONCURRENTLY IF NOT EXISTS user_events_contact_event_occurred_idx ON user_events (contact_id, event, occurred_at) WHERE contact_id IS NOT NULL;
CREATE INDEX CONCURRENTLY IF NOT EXISTS email_sends_orphan_user_id_idx ON email_sends (user_id) WHERE contact_id IS NULL;
CREATE INDEX CONCURRENTLY IF NOT EXISTS email_preferences_email_idx ON email_preferences (email);
CREATE INDEX CONCURRENTLY IF NOT EXISTS email_preferences_lower_email_idx ON email_preferences (lower(email));
```

A `CONCURRENTLY` build that fails leaves an invalid index; drop it and retry.
