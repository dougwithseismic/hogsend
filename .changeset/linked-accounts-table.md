---
"@hogsend/db": minor
---

`linked_accounts` table. One row per platform-account link, live or historical, keyed to a contact by a NOT NULL `contact_id` FK. Purely additive: no existing table changes, no column drops, no backfill. **Consumers must run `pnpm db:migrate` on upgrade** — migration `0072_lively_sue_storm` on the ENGINE track.

Rows are soft-unlinked (`unlinked_at`, `unlink_reason`), never deleted, so the `version` sequence for a `(provider, provider_user_id)` pair stays monotonic across relinks and the ownership history stays auditable. `tokens` is a nullable `text` column holding an AES-256-GCM sealed blob — `text` and not `jsonb` for the same reason as `provider_credentials.payload`: the contents must not be queryable. `tokens_revoked_at` records a provider-side revocation, which kills the property sync and keeps the link.

`version` is a Postgres `bigint` declared `mode: "bigint"`, so drizzle returns a JS BigInt and a version above `Number.MAX_SAFE_INTEGER` round-trips without loss. Every boundary serializes it explicitly with `String(row.version)`.

Four indexes carry the invariants. `linked_accounts_provider_uid_live_idx` is partial-unique on `(provider, provider_user_id) WHERE unlinked_at IS NULL` — at most one live link per platform account, while unlinked rows stay for history. `linked_accounts_contact_provider_singleton_idx` is partial-unique on `(contact_id, provider) WHERE unlinked_at IS NULL AND singleton`, which is the only place a provider's one-per-contact rule is actually enforced. `linked_accounts_provider_uid_version_idx` is unique on `(provider, provider_user_id, version)` across live and unlinked rows, so a lost version race surfaces as a retryable 23505 rather than a silent duplicate. `linked_accounts_contact_live_idx` serves the "what is this contact linked to right now" read.

The `contact_id` FK is `ON DELETE cascade`, but that is a database-level backstop rather than a code path: nothing in this repo hard-deletes a contact (merge and both delete routes set `deleted_at`). Soft-unlinking a deleted contact's live links, and repointing them on merge, is separate work.
