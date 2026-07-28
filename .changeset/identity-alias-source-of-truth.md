---
"@hogsend/engine": minor
---

The identity table becomes the source of truth for key resolution.

`contact_aliases` — until now a fallback consulted only after the identity
columns missed, populated only on merge/promote — is promoted to the primary
resolution index. Four changes, no schema migration:

- **Alias-first resolution.** `findByKey` probes `contact_aliases` first (one
  joined statement with a live-target rule: an alias pointing at a soft-deleted
  contact produces no row and falls through), then the identity columns, then
  the row-uuid fallback, exactly as before. With an empty alias table behavior
  is byte-identical to the old order.
- **Dual-write.** Every resolver arm (create / fill-in-link / collide-merge)
  now ensures an alias row per identity column the contact carries, with
  `reason: 'resolve'`. Existing `promote`/`merge` rows keep their provenance; a
  `(kind, value)` owned by another contact is never repointed (logged as
  `identity.alias.conflict` — kind and contact id only, never the value).
- **Backfill.** New `identityAliasBackfillTask` (chunked, idempotent,
  resumable; `dryRun` supported) fills the table for pre-existing contacts. The
  worker enqueues it once at boot (skipped when a completed job record exists);
  `POST /v1/admin/identity/alias-backfill` forces a re-run and
  `GET /v1/admin/identity/alias-backfill/{jobId}` polls it. The read-only
  parity probe `GET /v1/admin/identity/alias-parity` reports, per kind, keys
  where alias-first and column-first resolution disagree — `diverged` should
  be 0; if it is not, that is pre-existing data corruption to fix on its own
  (roll back to the previous release, repair, re-upgrade).
- **Erasure.** Soft-deleting a contact (public `DELETE /v1/contacts`, admin
  delete, agent tool) now deletes EVERY `contact_aliases` row keyed to that
  contact — regardless of `reason` or `from_contact_id` — since each such row
  holds that person's own identity key. Merge-trail rows under a surviving
  contact are untouched.

New exports: `identityAliasBackfillTask`, `runIdentityAliasBackfill`,
`enqueueIdentityAliasBackfill`, `identityAliasParity`,
`deleteIdentityAliasesForContact` (call it from any consumer-built deletion
flow that soft-deletes `contacts` rows directly),
`IDENTITY_ALIAS_BACKFILL_FORMAT`, and the `AliasParityRow` /
`IdentityAliasBackfillInput` / `IdentityAliasBackfillResult` types.
