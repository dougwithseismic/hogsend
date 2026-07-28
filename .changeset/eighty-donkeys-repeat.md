---
"@hogsend/db": minor
---

Add a nullable `contact_id uuid` column to the five history tables — `user_events`, `journey_states`, `bucket_memberships`, `email_sends` and `email_preferences` — so a person's past can be carried by contact id rather than only by the text identity key. The column is additive and inert in this release: nothing writes it and nothing reads it, so every existing query and insert path is unchanged. A foreign key to `contacts` is deliberately omitted because it would add `FOR KEY SHARE` row locking to the ingest hot path and change hard-delete semantics; an index is deferred to a later release, to be added once the read paths that need it exist.
