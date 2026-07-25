# PRD 02 — Enrichment lookup ledger

**Depends on:** none (independent of PRD 01) · **Status:** `[ ]`

## Goal

A durable ledger of every enrichment lookup, so refinement is cached, negatively cached, budgeted,
and exactly-once **without** a Hatchet boundary. This table is the version-independent Layer-2
backstop, architecturally identical to `email_sends` for the tracked mailer.

## Locked decisions

- One row per `(provider, lookupKind, lookupKey)`, enforced by a unique index. That single index
  carries three jobs at once: TTL cache, negative cache, and exactly-once.
- `status` is `"found" | "not_found" | "error"`. A `not_found` row is a **paid** negative result and
  must suppress re-spend until it expires. An `error` row is **not** a paid result and must NOT
  suppress a retry.
- `expiresAt` is materialised on write (`refinedAt + ENRICHMENT_TTL_DAYS`) rather than computed at
  read time, so the TTL of an existing row is stable if the env var later changes.
- `raw` (jsonb, nullable) stores the provider's verbatim response for debugging. It is nullable so a
  deployment can null it out for storage or privacy reasons without a schema change.
- No soft delete. This is an operational ledger, not contact data. `contactId` is nullable with
  `ON DELETE SET NULL` so a contact deletion does not erase spend history.

## Acceptance criteria (EARS)

1. WHEN two rows are inserted with the same `(provider, lookupKind, lookupKey)` the database SHALL
   reject the second with a unique violation.
2. WHEN a row is inserted the system SHALL persist `refinedAt` and `expiresAt` as timestamps and
   `status` constrained to the three allowed values.
3. WHEN the referenced contact is hard-deleted the ledger row SHALL survive with `contactId` set to null.
4. WHEN counting lookups for a budget period the system SHALL be able to filter on `refinedAt` using
   an index.

## Tasks

### T2.1 — Schema + migration
_Boundary:_ `packages/db` · _Depends:_ —

Create `packages/db/src/schema/enrichment-lookups.ts` following the conventions of the neighbouring
schema files (naming, `createdAt`/`updatedAt` helpers, index naming). Export it from the schema
barrel and add relations in `schema/relations.ts` if the neighbouring tables do.

```
enrichment_lookups
  id            uuid pk
  provider      text not null
  lookup_kind   text not null            -- "email" | "domain"
  lookup_key    text not null
  status        text not null            -- "found" | "not_found" | "error"
  contact_id    uuid null references contacts(id) on delete set null
  refined_at    timestamptz not null
  expires_at    timestamptz not null
  raw           jsonb null
  created_at / updated_at

  UNIQUE (provider, lookup_kind, lookup_key)   -- enrichment_lookups_provider_key_unique_idx
  INDEX  (refined_at)                          -- enrichment_lookups_refined_at_idx
  INDEX  (contact_id)
```

Generate the migration with `cd packages/db && pnpm db:generate`. **Commit the generated SQL file** —
do not hand-write it. Do not run `db:push`.

_Test:_ the package's existing test approach for schema (if `packages/db` has no test setup, the
verification is the generated migration plus `pnpm exec turbo run check-types --concurrency=2`, and
the behavioural assertions land in PRD 03's tests against a live DB).

## Seams

None.

## Done when

The migration file exists and is committed, the schema is exported, gates are green, and the SQL
contains the unique index on the three-column tuple.

## Implementation Notes

Shipped in `8456800b`. Migration `0065_chubby_archangel`.

**Deviation from spec, deliberately kept:** the PRD specified `lookup_kind` and `status` as plain
`text`. The implementation used `pgEnum` (`enrichment_lookup_kind`, `enrichment_lookup_status`) to
match the convention in `packages/db/src/schema/enums.ts`. This is stronger than the spec — AC 2's
"status constrained to the three allowed values" is now enforced by Postgres rather than by
convention. Trade-off accepted: adding a fourth status later needs an `ALTER TYPE` migration, but the
three-value set is closed by design (paid-positive / paid-negative / not-paid).

**Verified behaviourally** against the live worktree DB, not just by type-check:
- AC 1 — second insert of `(apollo, email, a@b.com)` rejected by
  `enrichment_lookups_provider_key_unique_idx`; the same key under a different provider inserts fine.
- AC 2 — `status = 'totally-invalid'` rejected with `invalid input value for enum`.
- AC 3 — contact hard-deleted; ledger row survived with `contact_id` nulled.
- AC 4 — `enrichment_lookups_refined_at_idx` present.

**Gate note for future tasks:** `pnpm exec turbo run check-types` reported `FULL TURBO` (all 48 cached)
after this change. `packages/db` has no `build` task, so its source edits do **not** invalidate
downstream `check-types` hashes. A db-only change must be verified with
`--force --filter=@hogsend/api --filter=@hogsend/engine` or the gate is vacuous.
