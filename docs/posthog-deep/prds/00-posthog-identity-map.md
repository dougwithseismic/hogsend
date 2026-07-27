# PRD 00 — `posthog-identity-map`

**Depends on:** nothing. **Status:** `[ ]`

## Goal

Give a PostHog `person_id` a first-class, mapped-alias home in Hogsend, plus a resolver
path, so every downstream feature in this stack has a stable and idempotent PostHog↔Hogsend
key.

## Why this is first

Not in the original brief, and it blocks everything. Verified: PostHog `person_id` is
stored **nowhere** in Hogsend. The entire integration operates on `distinct_id` only
(`packages/plugin-posthog/src/properties.ts:150-172` reads
`/api/environments/{projectId}/persons/` and never reads `results[0].id`).

A PostHog person has **many** distinct_ids under one `person_id` — that is precisely what
`person_id` exists to represent. Picking "the first distinct_id" from a cohort page yields
a key that changes between polls, producing phantom joins and leaves on every tick.

Getting this wrong in the over-matching direction folds a PostHog person into the wrong
Hogsend contact, which is the same shape as the value-fold identity bug this repo already
shipped and fixed in 0.36.1. That bug was a security hole.

## Locked decisions

- **Mapped alias, not an identity `Kind`.** Follow the `crm_links` precedent
  (`packages/db/src/schema/deals.ts:84-107`): own an internal key, treat every external
  system's id as a mapped alias. A pure FK side-table join that does **not** touch the
  `contacts` resolver's identity columns (`externalId`/`email`/`anonymousId`/`discordId`)
  and is therefore immune to the string-key fold class entirely.
- Rejected alternative: adding a `posthog_person_id` identity `Kind` to the resolver.
  Merge-participating keys go through `resolveOrCreateContact`'s collide-MERGE machinery,
  which is exactly the code hardened against this bug class. Not worth the blast radius
  for an id we only ever join on.
- **Two functions, not one** (DECISIONS §2.3). A single `resolveOrCreateContact`-backed
  entry point cannot satisfy both "resolve a person" and "tell me if this person is known
  without creating anything": `resolveOrCreateContact`
  (`packages/engine/src/lib/contacts.ts:519-750`) has **no find-only mode** — its three
  documented outcomes are create, fill-in-link, and collide-MERGE, and a zero-candidate
  call falls through to an unconditional insert. So the surface splits:
  - **`lookupPostHogPerson`** — find-only. Mapping lookup, then value lookup across the
    whole distinct_id set plus email. Returns `{ found: contact } | { found: null }` and
    **creates nothing**. This is what every read path consumes: PRD 02's cohort diff,
    PRD 06's dry-run, PRD 08's reconciliation. It is what satisfies AC 5.
  - **`resolvePostHogPerson`** — creating. Wraps `resolveOrCreateContact` across the whole
    distinct_id set plus email, tagged with an explicit `source`. Used only where
    materializing a contact is *intended*.
- Resolution — in both functions — uses the **whole** distinct_id set plus email, never
  distinct_id ordering.
- A mapping miss means **re-resolve**, never "absent".
- Merge-safety comes free: `crm_links.contactId` is already re-pointed loser→survivor
  during a contact merge (`contacts.ts:958-965`), because it is an FK not a string key.

## Acceptance criteria (EARS)

1. WHEN a PostHog person is resolved for the first time by **either** function, the system
   SHALL persist a mapping row keyed on `(provider, kind, externalId)` where `externalId`
   is the PostHog `person_id`, and SHALL return the resolved Hogsend contact.
2. WHEN the same PostHog `person_id` is resolved again, the system SHALL return the same
   contact without re-running value-based resolution.
3. WHEN a PostHog person carries multiple distinct_ids, both functions SHALL attempt
   resolution against the whole set plus email, and SHALL NOT depend on distinct_id
   ordering.
4. WHEN a stored mapping points at a contact that no longer exists or was merged away, the
   system SHALL re-resolve and update the mapping, and SHALL NOT report the person as
   unresolvable.
5. WHEN `lookupPostHogPerson` is called for a PostHog person that matches no existing
   contact, the system SHALL return `{ found: null }`, SHALL NOT insert a `contacts` row,
   SHALL NOT insert a mapping row, and SHALL NOT call `resolveOrCreateContact`.
   Mutation-test this: a test that still passes when the find-only path is swapped for the
   creating one is a vacuous test.
5a. WHEN `resolvePostHogPerson` is called for a PostHog person that matches no existing
   contact, the system SHALL create the contact through `resolveOrCreateContact` with an
   explicit `source` tag, and SHALL persist the mapping.
6. WHEN two Hogsend contacts are merged, the system SHALL carry the PostHog mapping to the
   survivor.
7. WHEN no PostHog credential is configured, every function added here SHALL be a
   documented no-op and SHALL NOT throw.

## Tasks

### T00.1 — Persist PostHog person id as a mapped alias
_Boundary:_ `packages/db` · _Depends:_ —

Reuse `crm_links` with `provider: "posthog"`, `kind: "contact"`, or add a dedicated table
if the reviewer judges `crm_links`' `kind` enum a poor fit. Generate the migration with
`pnpm db:generate`; do not hand-write SQL. Verify the partial-unique/arbiter semantics
against `reference_drizzle-partial-index-onconflict` (the arbiter predicate is `where`;
23505 walks `err.cause`).

**Migration-batching choice, decide explicitly at build time.** PRD 02 and PRD 06 both
require a resumable page cursor persisted in `import_jobs`, and `import_jobs`
(`packages/db/src/schema/import-jobs.ts:12-26`) has **no cursor or metadata column today**
— only `fileName`/`format`/`status`/`totalRows`/`processedRows`/`failedRows`/`errors`.
PRD 02 owns that column in its own `packages/db` task (T02.0). If PRD 06 or PRD 05 is
likely to ship **before** PRD 02, hoist the `import_jobs` cursor/metadata column into
this task's migration instead, so the first consumer to land is not blocked on a PRD it
does not depend on. Record which option was taken in Implementation Notes; do not add the
column twice.

### T00.2 — Read `person_id` alongside person properties
_Boundary:_ `packages/plugin-posthog` · _Depends:_ T00.1

`getPersonProperties` currently discards `results[0].id`. Add a sibling read that returns
both, without changing the existing function's signature or its soft-fail-to-`{}`
contract. Preserve the OAuth-preferred-degrade-to-personal-key token order and the
private-vs-ingestion host derivation.

### T00.3 — The two resolvers
_Boundary:_ `packages/engine/src/lib/` · _Depends:_ T00.1, T00.2

Two exported functions sharing one internal lookup core, per the locked decision above.

- **`lookupPostHogPerson({ personId, distinctIds, email })` → `{ found: contact } | { found: null }`.**
  Mapping lookup first, then a **find-only** value lookup across the whole key set
  (distinct_ids + email). It must **not** call `resolveOrCreateContact` — that function
  has no find-only mode and a zero-candidate call inserts unconditionally
  (`contacts.ts:519`). Persists/repairs the mapping only when a contact **is** found.
  Satisfies AC 3, 4, 5.
- **`resolvePostHogPerson({ personId, distinctIds, email, source })` → contact.**
  Same lookup, then `resolveOrCreateContact` across the whole key set with an explicit
  `source` tag, then persist the mapping. Satisfies AC 3, 4, 5a.

Never let a miss cause a removal — that invariant is load-bearing for PRD 02, whose diff
consumes the **find-only** function.

### T00.4 — Fix `check-membership.ts:179` to use `contactKeySql()`
_Boundary:_ `packages/engine/src/buckets/` · _Depends:_ —

Currently reads contacts by `external_id` only, so anonymous-keyed contacts are invisible.
Small, independent, and a prerequisite for correctness on anonymous cohort members. Verify
it does not change behaviour for externally-keyed contacts.

## Seams

A real PostHog project is needed to verify AC 3 against genuine multi-distinct_id persons.
Build against a deterministic Fake that returns multi-distinct_id fixtures; enumerate the
real-project check as a human verification step.

## Done when

All ACs pass, gates green, and a fixture PostHog person with three distinct_ids resolves
to exactly one contact across two consecutive resolution calls with no phantom writes.

## Implementation Notes

**Shipped 2026-07-27** across `ff7853fd`, `0ab883bf`, `b9be3e6d`, `efcc18f0`.

- **T00.1 extended `crm_links`** (`provider: "posthog"`) rather than adding a table: it is
  already provider-agnostic, FK-based, and re-pointed loser to survivor during a contact
  merge, so mapping rows survive a merge for free. The `import_jobs` cursor column was
  hoisted here so PRD 06 can ship before PRD 02. **PRD 02 must not add it again.**
- **T00.2 keys on the person `uuid`, not `results[0].id`.** Verified against PostHog's docs:
  the numeric `id` is a Postgres row PK that appears on no query-shaped surface, while the
  uuid is generated deterministically (UUIDv5 over team + distinct_id) and is what HogQL
  exposes as `person_id`. Keying on the PK would have missed on every cohort pull and
  re-resolved every tick.
- **`getPerson` returns a discriminated `found`/`absent`/`failed`.** Review caught it
  collapsing a 429 into "no such person", which is the §2.6 conflation that produces mass
  unenrollment downstream. `getPersonProperties` keeps its original signature and
  soft-fail-to-`{}` contract, locked by regression tests.
- **T00.4 fixed a bug it introduced.** Moving to the canonical coalesce key made anonymous
  contacts visible but allowed an unordered `limit(1)` to return a soft-deleted merge loser,
  since the dead row keeps its identity keys and the survivor inherits a copy. The predicate
  is now the named, exported `liveContactByCanonicalKey`, so tests assert on the row set
  rather than on heap order. The first attempt at this guard failed only 1 run in 3 under
  mutation; it now fails 3 of 3.
- Four tests were proven vacuous by mutation during review and rewritten, including one
  named for the alias fallback that passed with the entire alias query replaced by `[]`.
