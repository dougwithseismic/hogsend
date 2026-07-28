# PRD 04 — Add `contact_id` to the history tables

## Goal

Give the five string-keyed history tables — `user_events`, `journey_states`,
`bucket_memberships`, `email_sends`, `email_preferences` — a NULLABLE `contact_id uuid`,
populate it on every insert, keep it consistent through merges, and backfill the existing rows
from the canonical key. **No read changes at all**: after this PRD every query in the engine still
joins on `user_id`, and deleting the whole column would be behaviourally invisible. This exists
solely so PRD 05 has a correct, verified column to flip onto.

This is the only PRD in the stack that writes to the two largest tables in the system. The plan is
sized around that: the column add is metadata-only, the index is empty at creation time, and the
data movement is a chunked, resumable Hatchet job — never a migration.

## Advisory corrections (applied 2026-07-28, re-anchored against `e9c7c10f`)

A senior pass re-derived this PRD against the post-02/03 code. **D8's 15 write sites verified exact —
all fifteen, remarkably — and 02/03 added no new insert sites into the five tables.** Five
corrections:

| # | Severity | Correction |
| --- | --- | --- |
| C1 | major | **`lookupContactIdByKey` becomes alias-aware, restricted to kinds `external`/`anonymous`** (mirroring backfill pass 2's restriction; `resolveViaAlias` is the existing precedent). D6 already flagged its column-only lookup as a rare staleness leak. Post-03 it is a COMMON one: any second-device anonymous id that reaches a dual-write site as a bare key string lives ONLY in `contact_aliases`, so a column-only lookup permanently NULLs it. That is F3's silent-permanent-data-loss shape, and on `email_preferences` it means mail to someone who unsubscribed. One extra indexed probe closes it at write time instead of leaning on the reconcile sweep |
| C2 | minor | **D4 pass 2's cost claim is stale by orders of magnitude.** "Bounded by the alias table (65 rows on the dev DB), so it costs nothing" predates PRD 02 — the backfill plus dual-write now populate roughly one alias row per identity column per live contact (tens of thousands on dev). Pass 2 is still needed (a uuid-canonical email-only contact has no external/anonymous alias, so pass 1's coalesce does not subsume it) and still an indexed join UPDATE, but rewrite the bound |
| C3 | minor | **Add D8 row 16:** `apps/api/scripts/smoke.ts:97` inserts `emailSends` and is missing from the table. Dev script; leaving `contact_id` NULL is harmless, but the census claimed exhaustiveness |
| C4 | minor | **T5/T6 have a fresher precedent than `bucket-backfill.ts`:** PRD 02 shipped `workflows/identity-alias-backfill.ts` (import_jobs progress, chunked, resumable, boot-enqueued, FK-race retry) plus `routes/admin/identity.ts`, whose parity route IS T6's invariant-probe pattern already shipped. Model on these |
| C5 | minor | The D8 reproduce grep must also match `insert(schema.userEvents)` — the seed files use the `schema.` prefix, so a bare `insert(userEvents)` grep misses rows 14-15 |

## Re-anchoring (2026-07-28, wave-2 start, against post-0.57.0 main `1e2e7b0d`)

Census re-derived after #624–#628 merged: **21 insert statements, 16 sites, zero new, zero missing** —
wave 1 added no writes into the five tables. Raw-SQL grep: zero hits; every insert is Drizzle
`.insert()`. Drifted anchors: `ingestion.ts` inserts now `:523`/`:547`; `check-membership.ts` insert
`:338`; `bucket-reconcile.ts` insert `:1233`; `contacts.ts` now 2,655 lines — `mergeContacts` `:1592`
with the deals/crm_links repoint at `:1668-1674` (group memberships now fold via
`foldGroupMemberships`, called `:1682`, defined `:2059`); `repointOwnHistory` `:2188`; `contactKey`
`:792` / `contactKeySql` `:803`; `insertEnrollment` def `:126`, sole caller `:508`,
`subjectContactId` `:409`. **T4e narrative correction:** `routes/lists/index.ts` gained a
`resolveOrCreateContact` step at `:509` returning `{ contactId }` BEFORE `resolveRecipient` (`:530`);
the `upsertEmailPreference` call is `:539` and can take that `contactId` directly — no lookup needed
on that path (the PRD's "from `resolveRecipient`" provenance is stale). `email_preferences`'s leading
`user_id` probe index is a `uniqueIndex` on `(user_id, email)` — still serves D3's backfill probe.

## Locked decisions

### D1 — Column shape: `contact_id uuid`, nullable, **no FK in this PRD**

Five identical additions in `packages/db/src/schema/`: `user-events.ts:41`,
`journey-states.ts:49`, `bucket-memberships.ts:56`, `email-sends.ts:67`,
`email-preferences.ts:27`. No `.references()`.

The FK is deferred to PRD 07 (alongside `NOT NULL`), and this is an argued choice, not an omission:

- **It changes hot-path locking.** A FK on `user_events.contact_id` makes every ingest INSERT take
  a `FOR KEY SHARE` lock on the parent `contacts` row. The merge path already takes `FOR UPDATE` on
  `contacts` (`packages/engine/src/lib/contacts.ts:380-388`, `resolveByContactId`), and `FOR UPDATE`
  conflicts with `FOR KEY SHARE`. Today an in-flight merge and a concurrent event insert for the
  same person do not block each other; with the FK they would. That is a behavioural change smuggled
  into a migration — banned by DECISIONS §4.
- **It changes hard-delete semantics.** `onDelete: no action` (drizzle's default) would make a
  `contacts` hard delete fail; `cascade` would make it silently destroy the event ledger, which it
  does not do today. The only behaviour-preserving choice is `set null` (the
  `enrichment-lookups.ts:43` precedent) — which enforces almost nothing anyway. Note that the test
  suite hard-deletes contacts in cleanup (`apps/api/src/__tests__/observation-bucket-expiry.test.ts:170-172`,
  `anonymous-id-threading.test.ts:108`, `discord-link-direction.test.ts:80`, and 5 more), so a
  non-`set null` FK breaks the suite the moment T5's backfill runs against test data.
- **Validating it later is cheap.** PRD 07 can add it `NOT VALID` (brief `ACCESS EXCLUSIVE`, no
  scan) and `VALIDATE CONSTRAINT` separately (a scan under `SHARE UPDATE EXCLUSIVE`, which does not
  block writes).

The enforcement this PRD ships instead is **T6's invariant probe**, which is strictly stronger than
an FK: an FK only proves the uuid exists, T6 proves it is the *right* uuid.

### D2 — Index: one **partial** btree per table, `WHERE contact_id IS NOT NULL`

Names follow the house convention (`enrichment_lookups_contact_id_idx`,
`email_sends_campaign_id_idx`): `user_events_contact_id_idx`, `journey_states_contact_id_idx`,
`bucket_memberships_contact_id_idx`, `email_sends_contact_id_idx`,
`email_preferences_contact_id_idx`.

Partial, not plain, for three reasons:

1. At the moment the migration runs the column is 100% NULL, so the index is **empty** — the build
   is a heap scan with zero index writes, the fastest possible version of an expensive statement.
2. It stays small through the whole additive era, and permanently excludes the rows that
   legitimately have no contact (D5).
3. It still serves the only query this PRD introduces — the merge repoint's
   `WHERE contact_id = <uuid>` (T4). The planner can prove `contact_id = $1` implies
   `contact_id IS NOT NULL`, so the partial predicate is not a barrier. T2's test asserts this
   rather than assuming it.

**Why the index cannot be `CONCURRENTLY`.** `docs/UPGRADING.md:97-99` and `:110` tell contributors
to rewrite large index statements as `CREATE INDEX CONCURRENTLY` "in its own non-transactional
migration". **That is not achievable with the current runner.** `drizzle-orm`'s pg dialect wraps
*all* pending migrations in one `session.transaction`
(`drizzle-orm/pg-core/dialect.js:60`), and `CREATE INDEX CONCURRENTLY` throws `25001` inside a
transaction block. No migration in `packages/db/drizzle/` uses `CONCURRENTLY` (grep: zero hits) —
the documented pattern has never actually been exercised. See Surprises.

The workable substitute, and the locked plan:

- The migration emits `CREATE INDEX IF NOT EXISTS` (hand-edited into the generated SQL; hand-editing
  migration bodies is the house pattern — see `0043_normalize-bucket-membership-emails.sql`, entirely
  hand-written, and `0051_melted_frog_thor.sql`, hand-appended `UPDATE`).
- The release notes instruct any operator with a large `user_events` to run the concurrent build by
  hand **against the already-running release that has the column but not the index**:
  ```sql
  CREATE INDEX CONCURRENTLY IF NOT EXISTS user_events_contact_id_idx
    ON user_events (contact_id) WHERE contact_id IS NOT NULL;
  ```
  That statement needs the column to exist, so the ordering is forced: **T1's release adds the five
  columns, the operator pre-creates the five indexes concurrently at leisure, T2's release finds
  them already there and no-ops.** This is the entire reason T1 and T2 are separate tasks in
  separate releases, and the concrete instance of DECISIONS §4's additive-then-flip rule for a
  migration that cannot be made online any other way.

### D3 — Backfill runs as a chunked Hatchet job, keyed **per contact**, never in a migration

`docs/UPGRADING.md:82-87` is explicit: "A migration that does `UPDATE big_table SET ...` locks rows
and can run for minutes against a live DB. Migrations only add the column/table." The runner backs
this up with `SET statement_timeout = '15min'` and `SET lock_timeout = '10s'`
(`packages/db/src/migrate.ts:51-54`) — and because everything is one transaction, a slow backfill
would hold its locks until the *last* migration in the release commits.

The job iterates **contacts**, not events. For each live contact it derives the canonical key
`external_id ?? anonymous_id ?? id` — the same expression the whole system keys on
(`contactKey`, `packages/engine/src/lib/contacts.ts:557-559`; `contactKeySql`, `:568-570`) — and
issues one bounded UPDATE per table:

```sql
UPDATE user_events SET contact_id = $1
 WHERE id IN (
   SELECT id FROM user_events
    WHERE user_id = $2 AND contact_id IS NULL
    LIMIT $3
 );
```
looped until it affects zero rows.

This shape is chosen because **all five tables already have a usable leading index on `user_id`**,
verified individually:

| Table | Index that makes the backfill index-driven |
| --- | --- |
| `user_events` | `user_events_user_id_idx` (`user-events.ts:57`) |
| `journey_states` | `journey_states_user_id_idx` (`journey-states.ts:74`) |
| `bucket_memberships` | `bucket_memberships_user_id_idx` (`bucket-memberships.ts:78`) |
| `email_sends` | `email_sends_user_id_idx` (`email-sends.ts:76`) |
| `email_preferences` | `email_preferences_user_email_idx` on `(user_id, email)` (`email-preferences.ts:30-33`) — leading column, so a `user_id =` probe uses it |

So the statement count is O(contacts), not O(events), and no statement ever seq-scans `user_events`.

**Batch sizing.** Defaults: 500 contacts per chunk (the `BATCH_SIZE = 500` precedent,
`packages/engine/src/workflows/bucket-backfill.ts:33`), **5,000 rows per UPDATE statement**, 25ms
pause between statements. The sizing *rule* — which is what actually matters, because the defaults
are guesses about someone else's data — is: **keep any single UPDATE under ~1 second and under
~10,000 row locks.** Measure before deploying:

```sql
-- how big is the problem, per table
SELECT relname,
       reltuples::bigint AS est_rows,
       pg_size_pretty(pg_total_relation_size(c.oid)) AS total
  FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
 WHERE n.nspname = 'public'
   AND relname IN ('user_events','journey_states','bucket_memberships',
                   'email_sends','email_preferences','contacts');

-- the fattest single key (this is what sets the per-statement cap)
SELECT user_id, count(*) FROM user_events GROUP BY 1 ORDER BY 2 DESC LIMIT 10;
```

For calibration, the local dev database (`growthhog-postgres-1`, port 5434) measures
`user_events` 78,177 rows / 61 MB against `contacts` 18,698 rows / 13 MB — roughly 4 events per
contact. That is a **dev** number and must not be used as a production estimate; the shape it does
support is that the fat tail (a bot anon id with tens of thousands of events) is the thing to cap
against, not the mean.

**Bloat is the real cost, and it is stated honestly.** `contact_id` is indexed (D2), so a
NULL→value UPDATE cannot be a HOT update: every touched row leaves a dead tuple and writes a new
index entry. A full backfill transiently costs up to ~1× the table's size in dead tuples plus WAL.
The 25ms inter-statement pause exists to let autovacuum keep up. Operators need headroom for roughly
2× `user_events` before starting.

### D4 — Backfill pass 2: `contact_aliases`, for keys the canonical expression misses

After pass 1, a second bounded pass fills rows whose `user_id` is a *stale* key that a merge
recorded an alias for:

```sql
UPDATE <t> SET contact_id = a.contact_id
  FROM contact_aliases a
 WHERE <t>.user_id = a.alias_value
   AND <t>.contact_id IS NULL
   AND a.alias_kind IN ('external','anonymous');
```

Restricted to `external`/`anonymous` because those are the only kinds the canonical key can ever
be (`contactKey = external_id ?? anonymous_id ?? id`, and a keyless loser's row id is aliased under
kind `external` — `contacts.ts:1838-1848`). `email`/`discord` aliases are *not* canonical keys and
folding them in would resolve history that today resolves to nothing — a behaviour change.
`uniqueIndex(alias_kind, alias_value)` (`contact-aliases.ts:35-38`) is per-kind, not per-value, so
the same string can exist under both permitted kinds; when it does and the two rows disagree on
`contact_id`, **skip the row and log** rather than guess. Pass 2 is bounded by the alias table
(65 rows on the dev DB), so it costs nothing.

### D5 — A row whose key resolves to NO contact stays NULL. Forever. That is correct.

This is the decision the brief asks to justify, and it is the most consequential one here.

After #621 the engine deliberately refuses to mint a contact on observation
(`resolveContactNoCreate`, `contacts.ts:969`; threaded through `ingestEvent` at
`packages/engine/src/lib/ingestion.ts:391-393`). DECISIONS §4 locks that refusal in place. The
direct consequence is that **all five tables can legitimately hold rows with no contact**:

- `user_events` — a refused anonymous ingest still stores the event under the anon key
  (`ingestion.ts:465`, `:489`) with `contactId === null` in scope at that very line (`:412-420`).
- `bucket_memberships` — bucket evaluation deliberately still runs for a contactless subject
  (`check-membership.ts:60-72` documents exactly this).
- `journey_states` — `execute-journey-run.ts:388-392` states outright that "`userId` is routinely a
  browser anon id owning NO contact row".
- `email_sends` — `userId` is already nullable (`email-sends.ts:31`).
- `email_preferences` — written from a token-derived `externalId` that need not own a contact
  (`routes/email/unsubscribe.ts:71`, `:94`).

Three options were considered and two rejected:

- **Mint a contact for the orphans.** Rejected: that is precisely the ghost-contact bug #621
  removed, and it would re-create it at scale, retroactively, in one batch.
- **Delete the orphan rows.** Rejected outright — they are real observations.
- **Leave them NULL.** Locked.

Therefore **the backfill's completion criterion is NOT "zero NULLs"**. It is:

> zero rows where a live contact owns the row's `user_id` but `contact_id` is NULL, **and** zero
> rows where `contact_id` points at a contact that does not own the row's `user_id`.

That is T6's invariant, and it is checkable in SQL. The second half is the part an FK could never
give us, and it is the half that catches a dual-write bug.

### D6 — Dual-write is best-effort and can never fail the operation it rides on

Every dual-write site wraps its resolve in a try/catch and logs on failure. A `contact_id` we
failed to derive is a NULL that T5 will later fill; a send/enrollment/ingest that throws because a
bookkeeping column could not be computed is an outage. Nothing reads the column, so the blast
radius of a miss is exactly zero until PRD 05.

**"T5 will later fill it" EXPIRES, and that is what makes this dangerous.** T5 is one-shot: it is
boot-enqueued and skips when a completed job row exists. So the sentence above is true only while
the backfill is still pending. After PRD 05 flips the reads, a transient resolve failure at any
dual-write site writes a row that is invisible to **every** contact-scoped read, permanently — and
on `email_preferences` that means mailing someone who unsubscribed. The best-effort posture is
correct; the assumption that a miss is self-healing is not.

Two further paths produce the same permanent NULL, so this is not a rare fault case:
- `lookupContactIdByKey` is deliberately NOT alias-aware while the backfill's pass 2 IS. A stale
  merged key arriving after the backfill — an old unsubscribe token, a Hatchet payload carrying a
  loser key — resolves to nothing and lands NULL.
- The adoption stamp has an in-flight-ingest race: a refused resolve commits, an identify adopts the
  key, and the event insert lands afterwards with NULL. The idempotence guards then ensure it is
  never re-stamped.

**Required, and it is cheap because the job is already idempotent** (its `contact_id IS NULL` guard
makes a re-run free): make the backfill a **periodic reconcile sweep**, not a one-shot. And T6's
flip-readiness probe must **ALERT on `missing > 0`**, not merely report it — post-flip, a growing
missing-count is a live data-loss signal, and a number in a report nobody reads is not a control.

Revisit D6 for the `email_preferences` path specifically before PRD 05 lands: a suppression write
whose `contact_id` could not be derived should arguably fail CLOSED (reject the write) rather than
persist a row that the post-flip reader cannot see. Failing an operation is bad; silently failing to
suppress is worse.

### D7 — Resolution rule is the canonical key ONLY. No email fallback on `email_sends`.

`email_sends` rows with `user_id IS NULL` (raw/batch sends, `email-sends.ts:28-32`) get
`contact_id = NULL`, even when `to_email` matches a contact exactly. Resolving them by email would
make a send visible to per-contact queries that cannot see it today — a behaviour change bundled
into a migration, banned by DECISIONS §4. File it, do not fix it.

### D8 — The 15 write sites, enumerated

Inserts (grep `insert(<table>)` across `packages` + `apps`, excluding `__tests__`):

| # | Site | `contact_id` source | Cost |
| --- | --- | --- | --- |
| 1 | `lib/ingestion.ts:465` (idempotent insert) | `contactId` already in scope from `:412` | **zero** — no extra query |
| 2 | `lib/ingestion.ts:489` (plain insert) | same | **zero** |
| 3 | `journeys/execute-journey-run.ts:169` / `:179` (`insertEnrollment`) | new optional `contactId` opt, fed `input.contactId ?? lookup(userId)` | 1 indexed SELECT per *fresh* enrollment |
| 4 | `journeys/execute-journey-run.ts:358` (held-out row) | own D6-wrapped `resolveEnrollmentContactId` — `input.contactId` when pushed, else `lookupContactIdByKey` (T4 build correction: the `subjectContactId` compute at `:409-417` runs AFTER this insert, inside the `journey.heldout` re-emit try/catch, so "reuse at zero cost" was unimplementable without a control-flow change DECISIONS §4 forbids here) | zero with a pushed pin; 1–2 indexed probes once-ever per (user, journey) without one |
| 5 | `buckets/check-membership.ts:320` | `contactId` already a documented param (`:56-63`) | zero |
| 6 | `workflows/bucket-reconcile.ts:1126` | `contactId` already a param of `reconcileJoinOne` (`:1111`) | zero |
| 7 | `workflows/bucket-backfill.ts:306` | add `id: contacts.id` to the existing `chunkContacts` select at `:231-235` (already keyed by `contactKeySql()`) | zero |
| 8 | `lib/tracked.ts:205` (suppressed row) | `lookup(options.userId)`, computed once per send | 1 indexed SELECT per send |
| 9 | `lib/tracked.ts:395` (test-mode blocked row) | same computed value | zero |
| 10 | `lib/tracked.ts:453` (the real send) | same computed value | zero |
| 11 | `routes/admin/bulk.ts:483` (resend) | copy `email.contactId` off the source row | zero |
| 12 | `lib/preferences.ts:81` (`upsertEmailPreference`) | new optional opt; `lookup(externalId)` when absent | 1 indexed SELECT per pref write |
| 13 | `routes/admin/preferences.ts:132` | `contact.id` already in hand at `:124` | zero |
| 14 | `db/src/seed.ts:60`, `:73` | left NULL (dev fixture) | — |
| 15 | `db/src/demo-seed.ts:689,697,747,752` | left NULL — **files a follow-up**, the demo Studio will show gaps after PRD 05 | — |

Only three sites cost a query, all on low-frequency paths. `user_events`, the highest-volume table
by an order of magnitude, is free.

The lookup helper is one new engine-internal function:

```ts
// packages/engine/src/lib/contacts.ts
export async function lookupContactIdByKey(
  db: Database, key: string,
): Promise<string | null>
```
— a single `SELECT id FROM contacts WHERE deleted_at IS NULL AND (external_id = $1 OR anonymous_id
= $1 OR id::text = $1) LIMIT 1`. All three legs are indexed
(`contacts_external_id_unique_idx` `contacts.ts:96`, `contacts_anonymous_id_unique_idx` `:105`, the
PK), so Postgres serves it as a BitmapOr. It is deliberately **not** `findByKey`
(`contacts.ts:301`): `findByKey` follows aliases and has a uuid-external fallback, and reusing it
would make the dual-write resolve differently from the canonical key the row is stored under.

### D9 — Merge must repoint `contact_id`, and it is a uuid move, not a string move

`mergeContacts` already repoints uuid-keyed children next to the string rewrites — `deals` and
`crm_links` at `contacts.ts:1281-1288`, `group_memberships` at `:1296`. The five new columns join
that block verbatim:

```ts
await tx.update(userEvents).set({ contactId: survivor.id })
  .where(eq(userEvents.contactId, loser.id));
// … × 5
```

No unique index involves `contact_id`, so plain UPDATEs suffice (the same reasoning the existing
comment at `:1284-1286` gives for `deals`).

`repointOwnHistory` (`contacts.ts:1755`) needs **no** change: it moves a contact's own rows from its
old canonical key to its new one, and the contact — hence `contact_id` — is unchanged. T4 asserts
that explicitly rather than leaving it as an assumption.

### D10 — Additive-then-flip, taken seriously

DECISIONS §4 forbids a step that both adds and flips. Applied here, that yields six tasks in a
strict order: **T1 and T2 ship in separate releases** (D2), and **the merge repoint (T3) lands
before the dual-write (T4)** — a repoint over a column nothing writes yet is a pure no-op, whereas
a dual-write shipped before the repoint immediately starts producing pointers at soft-deleted
loser rows.

## EARS acceptance criteria

- **WHEN** T1's migration is applied to a database at the previous release's head, the system
  **SHALL** add a nullable `contact_id uuid` to all five tables with no index, no constraint, and no
  row rewrite, and `db:migrate` **SHALL** complete in under one second on an empty column.
- **WHEN** T2's migration is applied, the system **SHALL** create five partial btree indexes with
  predicate `contact_id IS NOT NULL`, and **SHALL** be a no-op if an operator already created them
  concurrently under the same names.
- **WHEN** a query filters `WHERE contact_id = <uuid>` on any of the five tables, the planner
  **SHALL** be able to use that table's partial index.
- **WHEN** `mergeContacts` folds a loser into a survivor, the system **SHALL** leave zero rows in
  any of the five tables with `contact_id = <loser id>`.
- **WHEN** a contact's canonical key flips via `repointOwnHistory`, the system **SHALL** leave that
  contact's `contact_id` values unchanged.
- **WHEN** an event is ingested for a resolvable identity, the system **SHALL** write
  `user_events.contact_id` equal to the resolved `contacts.id`, with no additional database query
  beyond those `ingestEvent` already issues.
- **WHEN** an event is ingested with `allowCreate: false` for an unseen anonymous id, the system
  **SHALL** store the event with `contact_id = NULL` and **SHALL** create zero `contacts` rows.
- **WHEN** a journey enrolls, a bucket is joined, an email is sent, or a preference is written for a
  resolvable identity, the system **SHALL** write that row's `contact_id` to the owning contact.
- **WHEN** the `contact_id` resolve throws at any dual-write site, the system **SHALL** log a
  warning, write `contact_id = NULL`, and complete the underlying operation successfully.
- **WHEN** the backfill job runs, it **SHALL** set `contact_id` on every row whose `user_id` is the
  canonical key of a live contact, **SHALL** leave `contact_id` NULL on every row whose `user_id`
  owns no contact, and **SHALL** never insert, delete, or modify any other column.
- **WHEN** the backfill job is re-run after completing, it **SHALL** update zero rows.
- **WHEN** the backfill job is interrupted mid-run and re-enqueued, it **SHALL** resume without
  double-processing and without skipping rows.
- **WHEN** the invariant probe runs on a fully backfilled database, it **SHALL** report zero
  "missing" rows (a live contact owns the key but `contact_id` is NULL) and zero "mismatched" rows
  (`contact_id` points at a contact that does not own the key).
- **WHEN** every task in this PRD has landed, every existing read path **SHALL** still resolve
  history through `user_id`, and dropping `contact_id` **SHALL** leave the test suite green.

## Tasks

### T1 — the five columns
_Boundary:_ `packages/db` · _Depends:_ —

Add `contactId: uuid("contact_id")` — nullable, no `.references()`, no index — to
`user-events.ts`, `journey-states.ts`, `bucket-memberships.ts`, `email-sends.ts`,
`email-preferences.ts`. Run `pnpm --filter @hogsend/db db:generate`; the emitted SQL must be exactly
five `ALTER TABLE … ADD COLUMN "contact_id" uuid;` statements and nothing else. Each is
metadata-only in PG11+ (nullable, no default), so it takes a brief `ACCESS EXCLUSIVE` and rewrites
no rows. Comment each column with what it is and, pointedly, that **nothing reads it yet**.

Changeset: `@hogsend/db` minor. No engine API change.

**Tested by:** CI's migration job (`.github/workflows/ci.yml:124-165`) already runs drift-check,
fresh apply, idempotent re-apply, and the previous-release upgrade path — that is the real test and
it needs no new code. Add one vitest asserting via `information_schema.columns` that all five
columns exist, are `uuid`, and are `is_nullable = YES`. Mutation proof: remove one column from the
schema and the drift check fails.

**Size: small.**

### T2 — the five partial indexes (separate release from T1)
_Boundary:_ `packages/db` · _Depends:_ T1 (shipped in a prior release)

Add `index("<table>_contact_id_idx").on(table.contactId).where(sql\`contact_id IS NOT NULL\`)` to
each of the five schema files, generate, then hand-edit the generated SQL to
`CREATE INDEX IF NOT EXISTS`. Ship this migration **alone** in its release — if it does end up
scanning a large `user_events`, it holds the whole release's migration transaction, and any
unrelated migration bundled with it fails too.

Release notes must carry the operator escape hatch verbatim (the `CREATE INDEX CONCURRENTLY IF NOT
EXISTS` statements from D2, runnable against the *old* release), and must state that skipping it
means a `SHARE`-lock write block on `user_events` for the duration of the build.

**Tested by:** (a) vitest asserting `pg_indexes.indexdef` for each of the five names contains
`WHERE (contact_id IS NOT NULL)`; (b) **the important one** — with `SET enable_seqscan = off`,
`EXPLAIN SELECT id FROM user_events WHERE contact_id = '<uuid>'` produces an `Index Scan` using
`user_events_contact_id_idx`. That proves the planner can discharge the partial predicate, which is
the one assumption in D2 that would be expensive to discover was wrong. (c) Re-run the migration
after pre-creating an index by hand and assert it succeeds (the `IF NOT EXISTS` path).

**Size: small in code, operationally the riskiest single statement in the PRD.**

### T3 — merge repoints `contact_id`
_Boundary:_ `packages/engine` · _Depends:_ T2

In `mergeContacts`, immediately after the existing `deals` / `crm_links` repoint
(`packages/engine/src/lib/contacts.ts:1281-1288`), add the five
`UPDATE … SET contact_id = survivor.id WHERE contact_id = loser.id` statements, with a comment
pointing at D9. This is deliberately ahead of T4: while nothing writes `contact_id` it is a pure
no-op, and the moment T4 starts writing it is already correct.

**Tested by:** a vitest that (1) creates two contacts, (2) writes rows into all five tables with
`contact_id` set by hand to each contact's id, (3) drives a real merge through
`resolveOrCreateContact`, (4) asserts `SELECT count(*) FROM <t> WHERE contact_id = <loserId>` is 0
and the survivor's count is the sum. Plus a `repointOwnHistory` case: flip a contact's canonical key
via fill-in-link and assert every `contact_id` is byte-identical before and after. Mutation proof:
delete any one of the five UPDATEs and the test goes red on that table.

**Size: small.**

### T4 — dual-write, five sub-tasks
_Boundary:_ `packages/engine` · _Depends:_ T3

Land the `lookupContactIdByKey` helper (D8) first, then one commit per table so each is
independently revertable:

- **T4a `user_events`** — `lib/ingestion.ts:465` + `:489`. Pass the already-resolved `contactId`
  (in scope from `:412`). Zero new queries.
- **T4b `journey_states`** — `insertEnrollment` (`execute-journey-run.ts:125`) gains
  `contactId?: string | null`; the caller at `:499` passes
  `input.contactId ?? (await lookupContactIdByKey(db, userId))`; the held-out insert at `:358` uses
  the `subjectContactId` already computed at `:409-417`. `insertEnrollment` is public
  (`packages/engine/src/index.ts:221`) — the new opt must be optional, and the existing
  `journey-version-stamping.test.ts:210-230` "public API back-compat" test must stay green untouched.
- **T4c `bucket_memberships`** — `check-membership.ts:320` and `bucket-reconcile.ts:1126` already
  receive `contactId`; `bucket-backfill.ts:306` gets it by adding `id: contacts.id` to the
  `chunkContacts` select at `:231-235`. `checkBucketMembership` is also public
  (`index.ts:87`) but its `contactId` param already exists — no signature change.
- **T4d `email_sends`** — resolve once near the top of `sendTracked` and reuse at all three inserts
  (`lib/tracked.ts:205`, `:395`, `:453`); copy the column at `routes/admin/bulk.ts:483`. Note in
  passing that the resend path does not copy `userId` either — **file, do not fix** (DECISIONS §4).
- **T4e `email_preferences`** — `upsertEmailPreference` (`lib/preferences.ts:32`, internal — not in
  `index.ts`) gains an optional `contactId`; `routes/lists/index.ts:518` already holds one from
  `resolveRecipient` (`:509`), `routes/admin/preferences.ts:132` holds `contact.id`, and the two
  token paths in `routes/email/unsubscribe.ts:71,94` plus
  `workflows/import-suppressions.ts:227` and `lib/sms-inbound.ts:177` fall back to the lookup.

Every site wraps its resolve per D6.

**Tested by:** one vitest per sub-task, each driving the **real** path (HTTP request / real journey
run / real mailer) and asserting the written row's `contact_id` equals the resolved `contacts.id` —
never asserting on a return value. Each sub-task also carries the negative: an anonymous, refused
operation writes `contact_id = NULL` and creates zero contacts. And a fault-injection case per D6:
stub the lookup to throw, assert the operation still succeeds with a NULL column and a logged
warning. Mutation proof: revert any one sub-task's write and only that table's test goes red.

**Size: medium-large — five separate code paths, ~10 write sites, and the mailer path needs care
because three inserts must share one resolved value.**

### T5 — the backfill Hatchet task
_Boundary:_ `packages/engine` · _Depends:_ T4

New `packages/engine/src/workflows/backfill-contact-id.ts`, modelled directly on
`bucket-backfill.ts`: an `import_jobs` row for progress (`format: "identity-contact-id-backfill"`,
`totalRows` = live contact count, `processedRows` = contacts done), chunked, idempotent, resumable,
registered in `worker.ts` next to `bucketBackfillTask` (`worker.ts:134`).

Pass 1 per D3 (per contact, per table, `LIMIT`-bounded, paused). Pass 2 per D4 (aliases). Resume is
free: the job re-reads live contacts ordered by `id` and every UPDATE is guarded by
`contact_id IS NULL`, so re-processing a done contact affects zero rows.

Enqueue: an `enqueueContactIdBackfill({ db, logger })` called from worker boot exactly as
`enqueueBucketBackfills` is (`bucket-backfill.ts:639`), best-effort, skipping when a completed
`import_jobs` row for that format already exists. Boot-triggered rather than operator-triggered
deliberately — the engine is a published dependency, and a manual step every consumer must remember
would strand deployments at PRD 05. Add a `POST /v1/admin/maintenance/backfill-contact-id`
(`requireAdmin`) to force a re-run.

**Tested by:** seed a fixture with (a) contacts whose canonical key is an `external_id`, (b) one
whose key is an `anonymous_id`, (c) one whose key is its row `id` (email-only), (d) orphan rows
under a key owning no contact, (e) rows under a stale key present only in `contact_aliases`; run
the task; assert a→c and e are filled with the right uuid, d is still NULL, and no other column
changed (snapshot the rows before/after). Then re-run and assert zero rows updated. Then run with
a per-statement limit of 1 to force many iterations and assert the same end state (proves the loop
terminates and the bound is honoured). Mutation proof: remove the `contact_id IS NULL` guard and the
re-run test goes red.

**Size: medium — the task itself is ~200 lines of well-precedented code; the fixture is the work.**

### T6 — the invariant probe
_Boundary:_ `packages/engine` · _Depends:_ T5

A `verifyContactIdBackfill({ db })` returning per-table `{ missing, mismatched, orphaned }`.

**Ownership is ALIAS-AWARE (T4 review correction).** The probes as first specced tested
ownership with the bare canonical coalesce only. Post-03 that predicate is WRONG: a
second-device anonymous id lives ONLY in `contact_aliases`, the dual-write deliberately
resolves it (C1), and a bare-coalesce `mismatched` probe would then flag every such
correctly-stamped row as corruption — a false alarm that would block the PRD 05 gate
forever on any deployment with a second device. "Contact `c` owns key `k`" means:
`coalesce(c.external_id, c.anonymous_id, c.id::text) = k` **OR** an alias row
`(contact_id = c.id, alias_value = k, alias_kind IN ('external','anonymous'))` exists.

```sql
-- missing: a live contact owns the key (canonical OR alias), but contact_id is NULL
SELECT count(*) FROM <t> t
 WHERE t.contact_id IS NULL
   AND EXISTS (SELECT 1 FROM contacts c
                WHERE c.deleted_at IS NULL
                  AND coalesce(c.external_id, c.anonymous_id, c.id::text) = t.user_id)
    OR t.contact_id IS NULL
   AND EXISTS (SELECT 1 FROM contact_aliases a JOIN contacts c ON c.id = a.contact_id
                WHERE c.deleted_at IS NULL AND a.alias_value = t.user_id
                  AND a.alias_kind IN ('external','anonymous'));

-- mismatched: contact_id points somewhere that owns the key NEITHER canonically NOR by alias
SELECT count(*) FROM <t> t
  JOIN contacts c ON c.id = t.contact_id
 WHERE coalesce(c.external_id, c.anonymous_id, c.id::text) IS DISTINCT FROM t.user_id
   AND NOT EXISTS (SELECT 1 FROM contact_aliases a
                    WHERE a.contact_id = c.id
                      AND a.alias_value = t.user_id
                      AND a.alias_kind IN ('external','anonymous'));

-- orphaned (expected, reported not failed): no live contact owns the key either way
SELECT count(*) FROM <t> t
 WHERE t.contact_id IS NULL
   AND NOT EXISTS (SELECT 1 FROM contacts c
                    WHERE c.deleted_at IS NULL
                      AND coalesce(c.external_id, c.anonymous_id, c.id::text) = t.user_id)
   AND NOT EXISTS (SELECT 1 FROM contact_aliases a JOIN contacts c ON c.id = a.contact_id
                    WHERE c.deleted_at IS NULL AND a.alias_value = t.user_id
                      AND a.alias_kind IN ('external','anonymous'));
```

(Exact SQL shape is T6's to settle — the `missing` OR-of-EXISTS above needs parenthesising
when implemented; what is LOCKED is the alias-aware ownership definition and that T6's test
fixture must include an alias-only-keyed row asserted to land in NEITHER `missing` (when
stamped) NOR `mismatched`.)

Surfaced on the existing admin readiness surface (`routes/admin/readiness.ts`). `missing` and
`mismatched` must be zero to enter PRD 05; `orphaned` is expected and non-zero by D5 — the probe
reports it as information, never as a failure.

Note the `mismatched` query is deliberately tolerant of the merge case only because T3 repoints; if
T3 regresses, `mismatched` is exactly what catches it in production.

Docs: a section in `docs/UPGRADING.md` under the release, and a note in `packages/db/README.md`.

**Tested by:** hand-corrupt one row per table (set `contact_id` to a wrong-but-real contact) and
assert the probe reports `mismatched: 1` for that table and 0 elsewhere; NULL one filled row and
assert `missing: 1`; assert an anonymous refused-ingest row lands in `orphaned` and **not** in
`missing`.

**Size: small.**

## Risks / how this can go wrong

1. **The index build takes the release down.** T2's `CREATE INDEX` on a large `user_events` holds a
   `SHARE` lock (blocking all writes) inside the single migration transaction
   (`dialect.js:60`), against a 15-minute statement timeout (`migrate.ts:54`). If it times out, the
   whole release's migrations roll back and the deploy fails. *Mitigations:* the index is empty at
   creation (D2); it ships alone in its release; `IF NOT EXISTS` lets an operator pre-create it
   concurrently. *Residual:* an operator who ignores the release note on a multi-hundred-million-row
   `user_events` gets a write outage. Accepted, and loudly documented.
2. **Backfill bloat outruns autovacuum.** Every updated row is a dead tuple plus an index entry
   (D3). On a table already near its disk headroom this can fill the volume. *Mitigation:* paced
   batches, and the pre-flight sizing query. *Detection:* `pg_stat_user_tables.n_dead_tup` during
   the run.
3. **A dual-write site writes the wrong contact and nothing notices.** No reads, no FK. This is the
   scenario that makes PRD 05 corrupt rather than merely broken. *Mitigation:* T6's `mismatched`
   probe, which is the only thing in this PRD that can catch it, and which the backfill cannot —
   the backfill only fills NULLs and will happily leave a wrong non-NULL value in place. **Stated
   plainly: the backfill is not a repair tool.** If `mismatched > 0`, the fix is a targeted
   corrective job, not a re-run.
4. **A missed insert site.** The D8 table was built by grepping `insert(<table>)` across
   `packages` + `apps` excluding tests; a site constructed dynamically or added concurrently on
   another branch would be missed. *Mitigation:* T6's `missing` count catches it for live traffic
   within one probe cycle. *Residual:* a rarely-exercised path could sit missing for a long time.
5. **Merge repoint regression.** If T3 is reverted or a new merge-like path appears (a future
   identity primitive from PRD 03/06), rows strand on a soft-deleted loser. *Mitigation:* T3's
   mutation-proof test, plus T6's `mismatched`.
6. **`insertEnrollment`'s new lookup adds a query to the journey hot path.** One indexed SELECT per
   *fresh* enrollment (not per replay — a recovered run does not re-insert). Acceptable; but if
   enrollment latency is measured to regress, the correct fix is to make `ingestEvent` always push
   `contactId` (it already does when it has one) rather than to widen the lookup.
7. **Demo/seed data will have NULL `contact_id` everywhere** (D8 rows 14-15). Harmless now; after
   PRD 05 the demo Studio shows an empty history for every seeded person. Filed as a follow-up
   against `packages/db/src/demo-seed.ts` — deliberately not fixed here, because a seed change in a
   migration PRD makes the diff unreviewable.
8. **`NOT NULL` in PRD 07 is unreachable as the plan currently stands.** See Surprises. Not a risk
   to *this* PRD, but this PRD is where it becomes undeniable.

## Rollback

Ordered cheapest-first; nothing here needs a snapshot restore, because nothing reads the column.

- **T4/T3 (code).** `git revert` the dual-write and repoint commits and redeploy. The column stops
  being written; existing values become stale but are read by nothing. **Total rollback, zero data
  risk.** This is the property that makes the whole PRD safe, and it is exactly why no read may
  change here.
- **T5 (backfill in flight).** Cancel the Hatchet run and mark the `import_jobs` row `failed`.
  Partial progress is harmless — every UPDATE is guarded by `contact_id IS NULL`, so a resumed or
  abandoned run leaves a consistent (if incomplete) column. If the backfill wrote *wrong* values,
  `UPDATE <t> SET contact_id = NULL WHERE contact_id IS NOT NULL` returns the table to the T1 state;
  it is safe precisely because nothing reads it.
- **T2 (indexes).** `DROP INDEX CONCURRENTLY IF EXISTS <name>;` per table — online, no lock,
  reclaims the disk. Note this must be done by hand: `docs/UPGRADING.md:115-125` forbids
  hand-written `down` migrations against production, and the roll-forward alternative is a new
  migration containing the drops.
- **T1 (columns).** `ALTER TABLE … DROP COLUMN contact_id` is fast (metadata-only; the space is
  reclaimed by the next rewrite, not immediately). Ship it as a forward migration, never as a
  hand-run statement. In practice: **do not do this.** Leaving five unread nullable columns in place
  costs nothing, and dropping them throws away the backfill.
- **What is genuinely irreversible.** Nothing. There is no data loss path in this PRD; the worst
  outcome is wasted disk and a wasted backfill run.

## Done when

- All six tasks are green under the DECISIONS §5 gates, verbatim:
  ```
  pnpm lint
  pnpm exec turbo run check-types --concurrency=2
  cd apps/api && HOGSEND_TEST_DATABASE_URL=postgresql://growthhog:growthhog@localhost:5434/prd06_test pnpm exec vitest run
  cd packages/engine && pnpm test
  ```
- CI's migration job passes all four legs (drift, fresh apply, idempotent re-apply, upgrade from the
  previous release) for both T1's and T2's releases.
- The #621 behaviour tests are untouched and green — they are the contract (DECISIONS §4).
- Reverting any single dual-write sub-task, the merge repoint, or the backfill's NULL-guard turns a
  specific named test red.
- On a database with the backfill complete, T6 reports `missing = 0` and `mismatched = 0` for all
  five tables; `orphaned` is reported and explicitly permitted to be non-zero.
- A `git grep` proves no read path filters, joins, or selects on `contact_id` in any of the five
  tables outside T3, T5 and T6.
- Changesets: `@hogsend/db` minor (schema), `@hogsend/engine` minor (`insertEnrollment` gains an
  optional opt; new exported backfill task + verify function), run through
  `pnpm changeset:engine-line`.

## Implementation Notes

**Shipped 2026-07-28, wave 2, all six tasks.** T1 released alone as **0.58.0** (PR #630,
migration `0069_sour_wildside`, exactly five metadata-only ADD COLUMNs) — the two-release split
D2 demands, so operators can pre-create the indexes concurrently against the running column-only
release. T2–T6 ship together in the follow-up PR (migration `0070_confused_mindworm`,
`CREATE INDEX IF NOT EXISTS` hand-edited per the house pattern; the changeset body carries the
five `CONCURRENTLY` statements verbatim plus the invalid-index-after-failed-CONCURRENTLY drop
instruction).

**Where the build deviated from the spec, and why:**

- **T4b held-out row** — its own D6-wrapped resolve, NOT a `subjectContactId` reuse: the compute
  sits AFTER the insert, inside the `journey.heldout` re-emit's try/catch; hoisting it would
  change which failures skip the re-emit (D8 row 4 corrected in place above).
- **T4 review round added a pin-liveness guard** (`resolveEnrollmentContactId`): the ingest-time
  `input.contactId` crosses an unbounded Hatchet queue delay, and a merge in that window would
  stamp a soft-deleted loser — permanently, since the backfill fills only NULLs. The pin is now
  validated against a live contact row and falls through to the alias-aware probe (which resolves
  the re-aliased key to the survivor). Mutation-verified: unguarding it turns exactly the two
  stale-pin tests red.
- **T6 ownership is alias-aware** (locked mid-build after the T4 review panel caught it): the
  bare canonical-coalesce probes would have counted every correctly-stamped second-device row as
  `mismatched`, blocking the PRD 05 gate forever on any deployment with a multi-device user.
- **T6 does NOT count `user_id IS NULL, contact_id IS NOT NULL` email_sends rows as mismatched**
  — investigated against the committed code: the admin resend path copies `contact_id` off the
  source row while (pre-existing gap, filed not fixed) not copying `userId`, so the shape is
  reachable today with a CORRECT stamp. Cost stated in the probe comment: an address-resolving
  D7 violator on that one path is invisible to the probe.
- **T6 `mismatched` does not require the pointed-at contact to be live**: a GDPR-deleted contact
  whose key still matches is consistent data. Merge regressions are still caught because a merge
  rewrites `user_id` to the survivor's key, so a stranded row mismatches on the key.
- **T5 is a periodic reconcile sweep** per the revised D6 (`CONTACT_ID_BACKFILL_RESWEEP_HOURS`,
  default 24h), with a runaway guard (5,000 statements per key), pause-only-after-writes pacing,
  and pass 2 keyset-paginated over alias values that resolve unambiguously AND are not already a
  live canonical key. Both-kinds-disagree values are skipped, counted (`ambiguousAliases`,
  surfaced as `import_jobs.failedRows`) and sampled into the log.

**Mutation proofs run by the orchestrator** (all conclusive, all restored): T2 index drop → 3
red; T3 delete one repoint UPDATE → exactly that table red; T4 unguard the pin → the two
stale-pin tests red; T5 remove the NULL guard → 4 red incl. the named re-run test; T6 remove the
alias ownership leg → the alias-acceptance + healthy-world tests red.

**Follow-ups filed, deliberately not fixed here:** (1) `contactIdBackfillTask.fn` creates a
`createDatabase` pool per invocation and never closes it — the EXACT pattern of the two shipped
backfill tasks (`bucket-backfill.ts:84`, `identity-alias-backfill.ts:333`), so it went in
matching precedent; the trio deserves one shared fix (a `getDb()`-style handle or an explicit
`end()`), and the local symptom (Postgres `53300` connection exhaustion during heavy test
cadence, container restart required) is worth remembering. (2) demo-seed NULL stamps (D8 row 15,
already filed in Risks). (3) resend-path `userId` gap (T4d, pre-existing).

**Test infrastructure:** wave-2 test DB is `prd04_test` (fresh-created, migrated 0000→0070); the
`prd06_test` DB from wave 1 was left poisoned by its mutation runs and was not reused.
