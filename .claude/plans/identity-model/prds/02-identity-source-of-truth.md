# PRD 02 — The identity table becomes the source of truth

## Goal

`contact_aliases` already has the target shape but holds only 65 rows against 18,203 live contacts
in the dev database — it is a *fallback* consulted after the identity columns miss, populated only
on merge and promote. This PRD fills it in: every identity key of every live contact gets a row,
every resolve keeps it current, and `findByKey` reads it FIRST. The identity columns are still
written and still authoritative for `contactKey` — nothing about the canonical key changes here.
When this lands, "which person owns this key" is answered by one indexed table, which is the
precondition for PRD 03 (many keys per person) and PRD 06 (trust per key).

## Locked decisions

### The table needs no schema change at all

Verified against `packages/db/src/schema/contact-aliases.ts:13-43`: `contact_id uuid` (FK to
`contacts.id`, `onDelete: "cascade"`, `:19-21`), `alias_kind text` (`:22`), `alias_value text`
(`:25`), `uniqueIndex(alias_kind, alias_value)` (`:35-38`), `index(contact_id)` (`:39`),
`index(from_contact_id)` (`:42`). `reason` is a bare `text` (`:32`) with no enum and no CHECK
constraint, so new reason values need no DDL. The alias probe in `findByKey`
(`packages/engine/src/lib/contacts.ts:319-328`) already hits the unique index.

**Therefore this PRD ships ZERO `packages/db` migrations.** No new file in `packages/db/drizzle/`,
no `_journal.json` entry, no schema-drift risk in CI. Everything here is engine code plus one data
job.

### The backfill is a Hatchet job, not a migration

The brief asked how to write the backfill migration in `packages/db`. The answer, grounded in this
repo's own rules, is: don't.

- `docs/UPGRADING.md:82-87` — "A migration that does `UPDATE big_table SET ...` locks rows and can
  run for minutes against a live DB. Migrations only add the column/table. The data backfill ships
  as a **Hatchet job** — batched, idempotent, resumable, and observable."
- `docs/UPGRADING.md:111` — "Heavy data changes → Hatchet backfill job, not the migration."
- `packages/db/src/migrate.ts:52-54` sets `lock_timeout = '10s'` and `statement_timeout = '15min'`
  on the migration connection. Railway runs `db:migrate` as a **pre-deploy** step, so a backfill
  that trips the statement timeout does not just fail — it blocks the deploy.
- The one hand-written data migration in the tree
  (`packages/db/drizzle/0043_normalize-bucket-membership-emails.sql`) is a single guarded `UPDATE`
  and says so in its own header: "Runs well inside the migration runner's 15-minute statement
  timeout at current table sizes — if that ever stops being true, UPGRADING.md's answer is a chunked
  Hatchet backfill." This backfill is an INSERT of ~1.8 rows per live contact — bigger than 0043 by
  construction, and unbounded in a large deployment.

So the mechanism is `identityAliasBackfillTask`, modelled line-for-line on
`packages/engine/src/workflows/bucket-backfill.ts` (chunked at `BATCH_SIZE = 500`, `:33`; progress
recorded in `import_jobs` discriminated by `format`; `retries: 0`, `executionTimeout` set; "Set-based,
chunked, idempotent, resumable — never run in a migration", `:69-70`).

### The backfill statement, verbatim

Keyset-paginated on the `contacts` PK. One statement per batch:

```sql
WITH batch AS (
  SELECT id, external_id, email, anonymous_id, discord_id
  FROM contacts
  WHERE deleted_at IS NULL AND id > $1
  ORDER BY id
  LIMIT 500
), pairs AS (
  SELECT id, 'external'::text  AS kind, external_id            AS value FROM batch WHERE external_id  IS NOT NULL
  UNION ALL
  SELECT id, 'email',                   lower(trim(email))            FROM batch WHERE email        IS NOT NULL AND trim(email) <> ''
  UNION ALL
  SELECT id, 'anonymous',               anonymous_id                  FROM batch WHERE anonymous_id IS NOT NULL
  UNION ALL
  SELECT id, 'discord',                 discord_id                    FROM batch WHERE discord_id   IS NOT NULL
)
INSERT INTO contact_aliases
  (contact_id, alias_kind, alias_value, from_contact_id, reason, created_at, updated_at)
SELECT id, kind, value, NULL, 'backfill', now(), now() FROM pairs
ON CONFLICT (alias_kind, alias_value) DO NOTHING
RETURNING contact_id;
```

Four properties of that statement, each verified rather than assumed:

1. **Idempotent.** `ON CONFLICT (alias_kind, alias_value) DO NOTHING` against the plain (not
   partial) unique index at `contact-aliases.ts:35-38`. Re-running the whole job is a no-op; the
   arbiter is the two bare columns, so there is no partial-index arbiter trap.
2. **Safe against intra-batch duplicates.** Two live rows can collide within a batch only for
   `email` (see below). Confirmed empirically on Postgres 18 in `growthhog-postgres-1`: an
   `INSERT ... SELECT` containing `('a','1'),('a','1'),('b','2')` with `ON CONFLICT DO NOTHING`
   inserts 2 rows and does not raise. (`DO UPDATE` would raise "cannot affect row a second time";
   `DO NOTHING` does not.)
3. **Never steals.** A `(kind, value)` already claimed by a different contact is skipped, not
   repointed. `RETURNING contact_id` lets the job count skips as a divergence metric instead of
   discovering them at read time.
4. **Emails are normalized on the way in.** `findByKey`'s email probe compares
   `eq(contacts.email, key.value)` (`contacts.ts:305-306, 311-315`) against a value the resolver has
   already run through `normalizeEmail` = `trim` + `toLowerCase` (`contacts.ts:270-272`, applied at
   `:685`). An alias row storing a raw mixed-case address would therefore be unreachable. Storing
   `lower(trim(email))` matches both the lookup and `fillInLink`'s existing promote write (which
   uses the already-normalized `ctx.email`, `contacts.ts:1050-1053`).

### Soft-deleted contacts are excluded from the backfill

`WHERE deleted_at IS NULL`, for three independent reasons:

- **Collisions.** The identity uniqueness guarantees are PARTIAL —
  `contacts_external_id_unique_idx` / `contacts_email_unique_idx` / `contacts_anonymous_id_unique_idx`
  / `contacts_discord_id_unique_idx` are all `WHERE <col> IS NOT NULL AND deleted_at IS NULL`
  (`packages/db/src/schema/contacts.ts`). A soft-deleted loser row legitimately still carries the
  key a live survivor now owns (merge soft-deletes the loser FIRST, then copies keys onto the
  survivor — `contacts.ts:1387-1403`). Including dead rows guarantees collisions whose winner is
  decided by scan order.
- **Already covered.** The keys of a merged-away loser are exactly what `recordMergeAliases`
  (`contacts.ts:1788-1872`) already writes, pointing at the SURVIVOR, which is the correct target.
- **Erasure.** A GDPR/DSR soft-delete must not have its identity keys resurrected into a second
  index by a backfill run afterwards.

Measured on the dev DB: 18,685 contacts, 18,203 live, 482 soft-deleted.

### Collisions during backfill, enumerated

| Class | Reachable? | Measured (dev DB) | Handling |
| --- | --- | --- | --- |
| Same value in two DIFFERENT columns (e.g. `external_id = "x"` on A, `anonymous_id = "x"` on B) | Yes | — | **Not a collision.** `kind` is part of the unique key, so `('external','x')` and `('anonymous','x')` coexist. |
| Same value in the SAME column on two LIVE contacts | No — blocked by the partial-unique indexes | 0 for external, 0 for anonymous, 0 for email-after-`lower(trim())` | n/a |
| Two live emails equal after `trim` but not after `lower` alone (the index is `lower(email)`, no trim) | Yes in principle | 0 (`email <> trim(email)` count is 0) | `ON CONFLICT DO NOTHING`; the loser is reported as a skip. |
| Live column value whose `(kind, value)` alias already points at ANOTHER contact | Yes, via a delete-then-recreate window | 0 | `DO NOTHING`; counted, and handled at read time by the live-target rule in T5. |
| Alias row pointing at a contact that is soft-deleted or gone | Yes | 0 | Read-time fallback (T5). Never repaired by the backfill. |

The two "reachable but 0 today" classes are why T4 exists as a separate read-only verifier: a zero
in the dev database is not a zero in a production database.

### The row-uuid alias is deliberately NOT backfilled

`findByKey` has a third probe: `kind === "external"` + uuid-shaped value → `contacts.id`
(`contacts.ts:347-354`), because an email-only/anon-only contact's canonical key IS its row uuid and
that key circulates (Hatchet payloads, outbound `userId`s, `hs_t` tokens). `recordMergeAliases`
writes exactly such an `('external', loser.id)` alias for merged losers (`contacts.ts:1846-1854`).

The backfill does **not** write `('external', <contacts.id>)` rows for live contacts. If a
deployment uses uuids as `external_id` values, contact A's row-uuid alias and contact B's real
`external_id` would contend for the same `(kind, value)` and the winner would be scan order — a
history-theft-shaped outcome for a purely defensive row. The uuid probe stays where it is, last, in
`findByKey`.

### The alias-kind vocabulary vs what is written today

`Kind` is `"external" | "email" | "anonymous" | "discord"` (`contacts.ts:285`). The backfill and the
dual-write use exactly those four. **`phone` is not included** — BACKLOG "Out of scope (decided)"
defers folding phone into the identity table until SMS identity is re-modelled, and
`contacts.phone`'s own docblock records that it is not a merge-participating key. 603 live contacts
carry a phone; they get no phone alias here.

**Consequence this PRD owes PRD 01.** Because phone-only contacts have no non-anonymous alias row,
any "has this person ever identified" predicate expressed as a bare
`EXISTS(alias_kind <> 'anonymous')` classifies all 603 of them as never-identified. PRD 01's
`identifiedContactFilter()` therefore keeps an `OR contacts.phone IS NOT NULL` leg through this PRD
and PRD 03, and its mutation proof pins that leg. Do not "simplify" the predicate to a pure `EXISTS`
while this exclusion stands — the leg retires when phone joins the identity table, and not before.

`reason` today carries two values, both written by the resolver:

| `reason` | Written at | Rows (dev DB) |
| --- | --- | --- |
| `promote` | `fillInLink`'s promote loop, `contacts.ts:1183-1196` | 39 |
| `merge` | `recordMergeAliases`, `contacts.ts:1860-1871` | 26 |

This PRD adds two, and does not touch the existing two:

| `reason` | Written at | Meaning |
| --- | --- | --- |
| `resolve` | the new `ensureIdentityAliases`, called from all three resolver arms (T2) | "this contact holds this key right now" — the index entry, not a provenance event |
| `backfill` | the backfill job (T3) | same as `resolve`, but authored offline |

**The split for T1 is `from_contact_id`, NOT the `reason` string.** An earlier revision of this PRD
said "`resolve`/`backfill` are a derived index, `promote`/`merge` are provenance" — that is wrong,
and erasing on it leaks personal data. Verified against the real write at `contacts.ts:1183-1196`:
the promote loop inserts `fromContactId: null` for keys the contact holds **right now** (the ones
`fillInLink` just attached — the person's own email and account ids). A `promote` row is
semantically identical to a `resolve` row; only its author differs. Skipping it on erasure would
leave the deleted person's own email address in `contact_aliases`.

**Erasure deletes EVERY row for the erased contact — both branches, no filter at all.**

Two earlier revisions of this rule were wrong in the same direction, each stopping one step short:
first `reason IN ('resolve','backfill')` (which spared `promote` rows holding the person's own email),
then `from_contact_id IS NULL` (which spares ABSORBED rows). Absorbed rows are the same leak:
`recordMergeAliases` (`contacts.ts:1855-1875`) writes `loser.externalId` / `loser.email` with
`fromContactId: loser.id`, and in the overwhelmingly common merge the loser **is the same human** —
an anonymous record folded into their identified one, or two records of one person. So those rows
hold the erased person's own email address, and any filter that keeps them fails the erasure.

Their stated retention purpose is void anyway once the target is erased: `findByKey`'s alias fallback
resolves the aliased contact under `isNull(contacts.deletedAt)` (`contacts.ts:258-267`), so every
alias row pointing at a soft-deleted contact already dead-ends. Keeping them retains personal data
and buys nothing.

```sql
DELETE FROM contact_aliases WHERE contact_id = $1
```

The `from_contact_id` distinction still matters for the MERGE-TRAIL question — `followToSurvivor`
(`contacts.ts:417-444`) walks rows by `from_contact_id` to find where a loser went — but that chain
is about rows pointing at a LIVE survivor, which this delete does not touch: it is scoped to
`contact_id = <the erased contact>`. A loser's rows point at the survivor's id, not the loser's.

**Generalise the lesson.** Both wrong revisions came from asking "what kind of row is this?" when the
erasure question is "whose data is this?" — and for any row whose `contact_id` is the erased person,
the answer is always *theirs*. Prefer the predicate that cannot be got wrong by a future writer
inventing a new `reason` value or a new alias-authoring path.

### Dual-write attaches at three sites, and only three

Identity columns are written in exactly three places, all inside `packages/engine/src/lib/contacts.ts`
(verified by grepping every `.insert(contacts)` / `.update(contacts)` in the repo):

| Arm | Site | What it writes today |
| --- | --- | --- |
| create | `:771-786` | all four columns, and **zero** alias rows |
| fill-in-link | `:1110` + promote loop `:1183-1196` | changed columns; aliases only for NEWLY-attached keys |
| collide-merge | `:1400-1403` (survivor) + `recordMergeAliases` `:1300` | survivor's keys; aliases only for LOSER keys |

The other `.update(contacts)` call sites write non-identity columns only:
`workflows/import-contacts.ts:59` (phone), `lib/timezone.ts:120` and
`journeys/execute-journey-run.ts:586` (timezone cache), `routes/admin/contacts.ts:548` (properties on
a keyless contact — identity edits on that route go through `resolveOrCreateContact` at `:537`), and
the two soft-delete sites covered by T1.

`resolveByContactId` (`contacts.ts:371-408`, the provenance pin) is deliberately NOT a dual-write
site: it changes no keys, and it is on the hottest internal re-emit path. Rows it touches are covered
by the backfill.

### The read flip changes ONE function

Only `findByKey` (`contacts.ts:301-357`) flips, and only its probe ORDER. Everything else that reads
identity columns stays exactly as it is, and is listed here so the flip's blast radius is not
guessed at later: `collidesWithIdentified` (`:55-85`), `keysAnotherContact` (`:106-136`),
`contactSearchFilter` (`:257-264`), `resolveViaAlias`/`resolveRecipient` (`:2020-2089`),
`refine.ts:239-247`, `routes/feed/recipient.ts:133,175`, `lib/connector-actions.ts:99-102`, and the
`contacts.external_id = <table>.user_id` joins in `buckets/bucket-access.ts`,
`workflows/bucket-reconcile.ts`, `workflows/bucket-backfill.ts`, `workflows/send-campaign.ts:984`,
`routes/admin/events.ts:79-80`. Those joins are the canonical-key problem and belong to PRD 04/05.

## EARS acceptance criteria

- **WHEN** a contact is soft-deleted through `deleteContactByKeys` (`contacts.ts:1970-1978`) or
  `DELETE /v1/admin/contacts/:id` (`routes/admin/contacts.ts:594-597`), the system **SHALL** delete
  **every** `contact_aliases` row whose `contact_id` is that contact — regardless of `reason` or
  `from_contact_id` — because every such row holds that person's own identity key.
- **WHEN** the resolver creates a contact, the system **SHALL** insert one `contact_aliases` row per
  supplied identity key with `reason = 'resolve'`, and **SHALL** insert no row for a `(kind, value)`
  already owned by another contact.
- **WHEN** the resolver fill-in-links or merges onto a contact, the system **SHALL** leave that
  contact holding an alias row for every identity column it carries after the call.
- **WHEN** the resolver runs twice for the same unchanged contact, the system **SHALL** produce no
  new `contact_aliases` rows and **SHALL NOT** modify the existing ones (no `updated_at` churn).
- **WHEN** the resolver's alias write is skipped because another contact owns the `(kind, value)`,
  the system **SHALL** log the kind and the contact id and **SHALL NOT** log the alias value.
- **WHEN** the backfill job runs to completion, the system **SHALL** hold, for every live contact and
  every non-null `external_id` / `email` / `anonymous_id` / `discord_id`, a `contact_aliases` row
  with that kind, the normalized value, and `contact_id` equal to that contact — except values a
  different contact already claims, which **SHALL** be reported in the job's skip count.
- **WHEN** the backfill job runs a second time, the system **SHALL** insert zero rows.
- **WHEN** the backfill job is interrupted and re-run, the system **SHALL** resume without
  double-writing and **SHALL** reach the same terminal state.
- **WHEN** the backfill job is invoked with `dryRun: true`, the system **SHALL** write no rows and
  **SHALL** report the projected insert count, the projected skip count, and the count of live
  contacts whose stored `email` differs from `lower(trim(email))`.
- **WHEN** the parity verifier runs, the system **SHALL** report, per kind, the number of live
  `(kind, value)` pairs for which an alias-first lookup and a column-first lookup resolve to
  DIFFERENT contact ids, or to a contact id in one case and nothing in the other.
- **WHEN** `findByKey` is called after the flip and a live alias row owns `(kind, value)`, the system
  **SHALL** return that alias's contact.
- **WHEN** `findByKey` is called after the flip and the matching alias row points at a soft-deleted or
  missing contact, the system **SHALL** fall through to the identity-column probe and then to the
  uuid probe, exactly as before.
- **WHEN** `findByKey` is called after the flip for a key held by no alias and no column, the system
  **SHALL** return null, and the resolver **SHALL** take the same create/refuse arm it takes today.
- **WHEN** any step of this PRD is applied, the system **SHALL** keep every behaviour test from #621
  green — `apps/api/src/__tests__/identity-merge.test.ts`, `contact-key-roundtrip.test.ts`,
  `contacts-no-create.test.ts`, `identity-provenance.test.ts`, `discord-link-direction.test.ts`.

## Tasks

### T1 — Delete resolver-written aliases when a contact is soft-deleted

_Boundary:_ `packages/engine` · _Depends:_ —

Ships FIRST, before anything writes a `resolve`/`backfill` row, so the leak never exists in a
released commit. It is a no-op until T2/T3 land, which is the point.

Today `contact_aliases` holds 65 rows and its FK is `onDelete: "cascade"`
(`contact-aliases.ts:19-21`) — but every deletion in the product is a SOFT delete
(`deletedAt` set), which the cascade does not see. After T3 the table holds a full copy of every
contact's identity keys, so "delete this contact" would leave their `external_id`, email,
`anonymous_id` and `discord_id` sitting in a second table indefinitely. That is a new erasure-scope
regression created by this PRD, so it is fixed by this PRD.

Add a helper next to `deleteContactByKeys` that runs
`DELETE FROM contact_aliases WHERE contact_id = $1`, and call it from both soft-delete sites
(`contacts.ts:1970-1978`, `routes/admin/contacts.ts:594-597`). No predicate beyond the contact id:
every row keyed to the erased contact is that person's own identity key, whatever wrote it.

This does not strand `followToSurvivor` (`contacts.ts:417-444`). That walk finds where a LOSER went
by following rows whose `from_contact_id` is the loser — and those rows live under the SURVIVOR's
`contact_id`, which this delete does not touch. Erasing a survivor removes its own rows, and the
chain into it is moot because the alias probe only resolves live contacts
(`isNull(contacts.deletedAt)`, `contacts.ts:258-267`).

_Tested by:_ a new `apps/api/src/__tests__/identity-alias-lifecycle.test.ts` (vitest, real Postgres):
seed a contact and hand-insert all three row shapes — `reason:'resolve'`, `reason:'promote'` with
`fromContactId: null`, and an absorbed row with `fromContactId` set carrying a DISTINCT email;
soft-delete via each of the two paths; assert **all three are gone**, asserting on the absorbed row's
email specifically, since that is the one two earlier revisions of this rule would have left behind.
Then a separate fixture proving the chain survives: merge B into A, erase B, assert A's absorbed rows
(which live under A's `contact_id`) are untouched and `followToSurvivor` still resolves B's old key
to A. Plus a
regression assertion that a merge survivor's aliases are untouched when the LOSER is later deleted —
mutation-check by flipping the `reason` filter off and confirming that test goes red.

### T2 — `ensureIdentityAliases` dual-write on the three resolver arms

_Boundary:_ `packages/engine` · _Depends:_ T1

New module-local helper in `contacts.ts`:

```ts
async function ensureIdentityAliases(tx: Tx, row: ContactRow): Promise<void>
```

Builds up to four `{contactId, aliasKind, aliasValue, fromContactId: null, reason: "resolve"}` values
from the row's non-null `externalId` / `email` (normalized) / `anonymousId` / `discordId`, and issues
**one** `insert(contactAliases).values(rows).onConflictDoNothing({ target: [aliasKind, aliasValue] })`.
One statement, never a loop — this runs inside the resolver transaction on the hottest write path in
the engine (every ingested event). `.returning()` gives the inserted subset; when it is shorter than
the input, log `identity.alias.conflict` at `warn` with `{ contactId, kinds }` and **never** the
value (alias values are emails and user ids).

Call sites, all additive and placed AFTER the existing writes so the existing `promote`/`merge`
reasons win the conflict and keep their provenance:

- create arm, after the insert at `contacts.ts:786` (this is the arm that writes no alias at all
  today);
- `fillInLink`, after the promote loop at `contacts.ts:1196` — this is what backfills a hot
  pre-existing contact whose columns predate `contact_aliases`;
- `mergeContacts`, after the survivor update at `contacts.ts:1403`, on the post-merge survivor row.

No read changes. No behaviour changes: an alias row that nothing reads first cannot alter resolution.

_Tested by:_ extend `identity-alias-lifecycle.test.ts` — (a) a fresh `POST /v1/events` with a
`userId` leaves exactly one `('external', userId)` row with `reason:'resolve'`; (b) a second
identical event inserts nothing new and leaves `updated_at` unchanged; (c) a fill-in-link on a
contact whose columns were seeded directly (no aliases) ends with a row per column; (d) after a
collide-merge the SURVIVOR has a row per key it now holds AND the loser's `merge` rows still carry
`reason:'merge'` (i.e. the new write did not overwrite provenance); (e) a resolve whose key is
already aliased to a different contact inserts nothing and logs one `identity.alias.conflict`. Cost
guard: assert the arm issues exactly one insert statement (spy on the tx), not one per key.

### T3 — `identityAliasBackfillTask` + admin trigger, with a dry run

_Boundary:_ `packages/engine` · _Depends:_ T2

**This is the largest task in the PRD.** Not because the SQL is hard — it is the statement above —
but because it needs the whole job apparatus: a Hatchet task, an `import_jobs` progress record, a
resumable cursor, an admin route, an OpenAPI schema, a status poll, and tests for the resume and
dry-run paths. Budget it like `bucket-backfill.ts`, which is 1,000+ lines for the same shape.

- `packages/engine/src/workflows/identity-alias-backfill.ts` — `identityAliasBackfillTask`, input
  `{ jobId: string; dryRun: boolean }`, `retries: 0`, `executionTimeout: "600s"`, chunked at 500
  (mirroring `bucket-backfill.ts:33,76-80`). Progress in `import_jobs` with
  `format = "identity-alias-backfill"`; `processedRows` = contacts scanned, and the insert/skip
  counts in `errors`-adjacent job state or the log line (do NOT invent a new table). The keyset
  cursor is the last `contacts.id` of the batch, so a re-run after a crash resumes from
  `MAX(id)`-so-far; because the statement is `ON CONFLICT DO NOTHING`, resuming from zero is also
  correct, just slower. Between batches, yield (no long-held transaction, no table lock).
- `dryRun: true` runs the same `pairs` CTE with `COUNT(*)` and an anti-join instead of the INSERT,
  and additionally reports
  `SELECT count(*) FROM contacts WHERE deleted_at IS NULL AND email IS NOT NULL AND email IS DISTINCT FROM lower(trim(email))`
  — the number that tells the operator whether the T5 flip changes email resolution for anyone real
  (see Risks).
- Register in `packages/engine/src/worker.ts` `baseWorkflows` beside `bucketBackfillTask` (`:134`)
  and export from `packages/engine/src/index.ts` beside it (`:906-911`).
- `POST /v1/admin/identity/alias-backfill` + `GET /v1/admin/identity/alias-backfill/{jobId}` in
  `routes/admin/bulk.ts`, mirroring `/contacts/import` and `/contacts/import/{jobId}`
  (`bulk.ts:13-14, 52-53, 249-292`): insert the `import_jobs` row, `runNoWait`, 202 with `jobId`,
  mark the job `failed` if the enqueue throws. Wired into `adminRouter` (`routes/admin/index.ts:50`),
  behind `requireAdmin` like the rest of `/v1/admin`.
- The job is triggered EXPLICITLY. It is not enqueued at boot. A whole-table write that fires on
  every consumer's next deploy is exactly the surprise DECISIONS §4 bans.
- Changeset: new exported task + two new admin routes = a minor `@hogsend/engine` bump, plus a
  release note telling operators to run the backfill (`docs/UPGRADING.md:26`: "If a release notes a
  backfill job, trigger/verify it after the deploy").

_Tested by:_ a real-Postgres vitest that seeds ~50 contacts across all four kinds plus soft-deleted
and mixed-case-email rows, then: (a) runs the task and asserts one alias per live column value with
normalized email values and no rows for soft-deleted contacts; (b) runs it a second time and asserts
zero inserts; (c) runs it with a pre-planted conflicting alias and asserts the row is untouched and
counted as a skip; (d) runs `dryRun` and asserts zero rows written and a projected count equal to
what the real run then inserts. Verification query for operators, documented in the release note:

```sql
SELECT 'external' kind, count(*) FROM contacts c
 WHERE c.deleted_at IS NULL AND c.external_id IS NOT NULL
   AND NOT EXISTS (SELECT 1 FROM contact_aliases a
                    WHERE a.alias_kind='external' AND a.alias_value=c.external_id
                      AND a.contact_id=c.id)
UNION ALL ... -- email (lower(trim())), anonymous, discord
```

Expected residual = the skip count, not necessarily zero.

### T4 — Read-only parity verifier

_Boundary:_ `packages/engine` · _Depends:_ T3

The gate on T5. A pure-SQL, read-only report — no writes, no flip — that answers "would alias-first
have returned a different contact than column-first?" for every live key, per kind:

```sql
SELECT a.alias_kind,
       count(*) FILTER (WHERE ac.id IS NOT NULL AND cc.id IS NOT NULL AND ac.id <> cc.id) AS diverged,
       count(*) FILTER (WHERE ac.id IS NULL     AND cc.id IS NOT NULL)                    AS alias_dead,
       count(*) FILTER (WHERE ac.id IS NOT NULL AND cc.id IS NULL)                        AS alias_only
FROM contact_aliases a
LEFT JOIN contacts ac ON ac.id = a.contact_id AND ac.deleted_at IS NULL
LEFT JOIN contacts cc ON cc.deleted_at IS NULL AND (
      (a.alias_kind='external'  AND cc.external_id  = a.alias_value)
   OR (a.alias_kind='email'     AND lower(trim(cc.email)) = a.alias_value)
   OR (a.alias_kind='anonymous' AND cc.anonymous_id = a.alias_value)
   OR (a.alias_kind='discord'   AND cc.discord_id   = a.alias_value))
GROUP BY 1;
```

`diverged` must be 0 before the flip; a non-zero value is a data bug to be filed and fixed on its
own, never flipped over. `alias_dead` is expected and non-fatal (that is precisely what the flip's
live-target rule handles). `alias_only` is the pre-existing merge/promote population plus, after
PRD 03, the whole point of the table.

Surface it as `GET /v1/admin/identity/alias-parity` (`requireAdmin`, read-only, returns the three
counts per kind) so it can be run against production without a psql session. Measured baseline on
the dev database today: `diverged` 0, `alias_dead` 0, over 65 alias rows.

_Tested by:_ a vitest that manufactures each class deliberately — a diverged pair (alias → live A,
column → live B), a dead alias, an alias-only key — and asserts the endpoint counts each in the
right bucket. Cheap task; it is three counts and a route.

### T5 — Flip `findByKey` to alias-first

_Boundary:_ `packages/engine` · _Depends:_ T4

The commitment step, and the only read change in this PRD. In `contacts.ts:301-357`, reorder to:

1. **alias probe (new first)** — ONE statement, joined so it is a single round trip:
   `SELECT c.* FROM contact_aliases a JOIN contacts c ON c.id = a.contact_id AND c.deleted_at IS NULL
    WHERE a.alias_kind = $1 AND a.alias_value = $2 LIMIT 1`.
   The `deleted_at IS NULL` predicate is inside the join on purpose: an alias whose target is dead
   must produce NO row so the query falls through, rather than resolving to a tombstone.
2. **identity-column probe** — unchanged (`:311-316`).
3. **uuid probe** — unchanged (`:347-354`), still `external`-only.

The two-statement alias fallback currently at `:319-338` collapses into step 1. Behaviour with an
empty `contact_aliases` is identical to today, which is what makes the flip revertable.

_Tested by:_ (a) the entire existing identity suite, unchanged, must stay green — that is the
contract per DECISIONS §4; (b) new cases in `identity-alias-lifecycle.test.ts`: a key present ONLY as
an alias resolves; a key whose alias points at a soft-deleted contact still resolves via the column;
a key present in neither still returns null and still takes the create/refuse arm; (c) a mutation
check — delete the `deleted_at IS NULL` predicate from the join and confirm the dead-alias test goes
red (without it the test is vacuous, per the "vacuous green tests" rule); (d) a timing note in the PR:
p50 of `POST /v1/events` before and after against the 18k-contact dev DB, because alias-first turns
one index probe into an index probe plus a PK fetch per key (up to four keys per resolve).

### T6 — Normalize `contacts.email` (conditional; separate commit)

_Boundary:_ `packages/db` · _Depends:_ T3 (its dry-run supplies the count)

Filed, not bundled — DECISIONS §4: "If a step reveals a bug, it is filed, not fixed in the same
commit." The bug: `findByKey`'s email probe is a case-sensitive `eq`, while callers always pass a
normalized value, so a contact stored with a mixed-case email is invisible to email resolution today
(and a resolve on that address would attempt an insert that the `lower(email)` partial-unique index
rejects with 23505). The dev DB has 659 such live rows — **all 659 are `@example.com` test fixtures,
0 are real addresses**, which is exactly why the number must be re-measured per deployment before
the flip rather than assumed away.

If a deployment's dry-run reports a non-zero REAL count, land this first as its own migration
mirroring `packages/db/drizzle/0043_normalize-bucket-membership-emails.sql`:

```sql
UPDATE "contacts" SET "email" = lower(trim("email"))
WHERE "email" IS DISTINCT FROM lower(trim("email")) AND "deleted_at" IS NULL;
```

(guarded, NULL-safe, and small — 659 rows here). Then the T5 flip changes email resolution for
nobody. If the count is zero, skip this task entirely.

_Tested by:_ the migration is verified by re-running the dry-run count and asserting 0, plus the
existing email-resolution tests.

## Risks / how this can go wrong

- **The flip silently changes who owns a key.** The failure mode is one person resolving to another
  person's contact — the exact class of bug #621 was about. Mitigated by T4 being a hard gate
  (`diverged` must be 0), by the live-target rule in T5, and by the backfill never repointing an
  existing alias. Residual risk: a divergence created BETWEEN the T4 run and the T5 deploy. Re-run
  the parity endpoint immediately before flipping.
- **The backfill is bigger than it looks in a big deployment.** Dev DB: 18,203 live contacts →
  32,416 projected alias rows (1.78 per contact), taking `contact_aliases` from 65 rows / 128 kB to
  roughly 32k rows / several MB. Linear: a million-contact deployment gets ~1.8M rows. That is fine
  for Postgres and NOT fine inside a 15-minute pre-deploy statement timeout, which is why it is a
  chunked job. DECISIONS §7's open question (online vs maintenance window) is answered by the
  dry-run's projected count, per deployment.
- **Dual-write cost on the hottest path.** Every resolve gains one INSERT statement inside an
  existing transaction. One statement, up to four VALUES, conflict-probed on an existing unique
  index. Measure it in T2 (assert one statement) and T5 (p50 timing) rather than asserting it is
  free.
- **Alias values are PII.** `alias_value` holds email addresses and account ids in a table nothing
  previously enumerated at scale. Two consequences, both handled: log kinds and contact ids only
  (T2), and delete the derived rows on contact deletion (T1). A third is left open: nothing in
  Studio displays `contact_aliases`, so there is no new UI exposure to review.
- **Reason-string typos.** `reason` is bare `text` with no CHECK. A typo (`'resolved'`) makes T1's
  erasure filter silently miss rows. Mitigation: a single exported const per reason value, used by
  both the writer and the deleter, asserted in a test.
- **Interaction with PRD 03.** PRD 03 makes a second anonymous id "just another alias row". If T5
  ships without the live-target rule, PRD 03 inherits a resolver that can return tombstones. T5 is
  the load-bearing dependency there, not the backfill.
- **Interaction with `keysAnotherContact`.** The adoption guard (`contacts.ts:106-136`) probes
  `contacts` columns only, deliberately including a uuid arm. It is NOT flipped here. After the
  backfill, an anon id held only as an alias still fails that probe, so adoption stays as
  conservative as it is today. That is intentional for this PRD; widening it is PRD 03's call, and
  widening it is a security decision, not a cleanup.

## Rollback

Each task reverts independently, and the destructive-looking one is not.

- **T5 (flip)** — revert the commit. `findByKey` returns to column-first; the alias rows become inert
  again exactly as they are today. This is the only change with a behavioural blast radius and it is
  a pure code revert with no data implication. **Roll back T5 alone first** before considering
  anything else.
- **T2 (dual-write)** — revert the commit. New resolves stop writing `resolve` rows. Existing rows are
  harmless once T5 is reverted (nothing reads them first).
- **T3 (backfill data)** — the data is removable with one statement, because the reason column
  segregates it: `DELETE FROM contact_aliases WHERE reason IN ('resolve','backfill')`. That restores
  the table to its 65 pre-existing rows. **Note the two filters answer different questions and are
  both correct — do not "reconcile" them.** Erasure asks *whose data is this* and keys on
  `from_contact_id IS NULL`; rollback asks *which rows did this PRD add* and keys on `reason`. A
  `promote` row is the person's own data (erasure deletes it) but pre-dates this PRD (rollback keeps
  it). This is why `reason` values were split rather than reusing
  `'promote'` — a shared reason would make the backfill unrollbackable without re-deriving which
  rows were pre-existing.
- **T1 (erasure hook)** — revert the commit. It only ever deleted rows the other tasks created.
- **T6** — the email normalization is a data change with no inverse (the original casing is gone).
  Treat it like any migration: `docs/UPGRADING.md:115-125` — roll forward, or restore the snapshot.
  This is the one irreversible step, which is another reason it is optional and gated on a real
  non-zero count.

No `packages/db` migration ships in T1-T5, so there is no schema state to unwind and no ledger entry
to reconcile.

## Done when

- `contact_aliases` holds a row for every identity key of every live contact in the dev database,
  the backfill re-run inserts zero, and the residual query returns only the reported skip count.
- The parity endpoint reports `diverged = 0` across all four kinds.
- `findByKey` reads the alias table first, falls through correctly on a dead alias, and the full
  #621 behaviour suite is green — `identity-merge`, `contact-key-roundtrip`, `contacts-no-create`,
  `identity-provenance`, `discord-link-direction`.
- Deleting a contact removes its derived alias rows and leaves its merge/promote provenance.
- Every gate in DECISIONS §5 passes:
  `pnpm lint`;
  `pnpm exec turbo run check-types --concurrency=2`;
  `cd apps/api && HOGSEND_TEST_DATABASE_URL=postgresql://growthhog:growthhog@localhost:5434/ghost_clean pnpm exec vitest run`;
  `cd packages/engine && pnpm test`.
- Reverting any single guard (the `reason` filter in T1, the conflict target in T2, the
  `deleted_at IS NULL` join predicate in T5) turns a specific named test red.
- A changeset exists for the new exported task and admin routes, and the release note tells operators
  to run the backfill and check parity before upgrading past the flip.

## Implementation Notes

Shipped `18fb2dc0`. `contact_aliases` is backfilled, dual-written on every resolve, and read first.
Changeset `identity-alias-source-of-truth`. Tests: `identity-alias-backfill.test.ts` (8),
`identity-alias-lifecycle.test.ts` (13).

**Erasure went unconditional, on the third attempt (F2).** The spec's filter keyed on `reason`;
the first correction keyed on `from_contact_id IS NULL`. Both were wrong. `reason` spared `promote`
rows and `from_contact_id IS NULL` spared ABSORBED rows — and both hold the person's own email,
because `recordMergeAliases` writes the loser's email and a merge loser is usually the same human.
Erasure now deletes every alias row for the erased contact with **no predicate**. Their retention
rationale was void anyway: the alias probe requires `deleted_at IS NULL`, so rows pointing at a
deleted contact already dead-end. Three tests pin this and all three go red under either filter.

**Two real races surfaced during the build and are fixed.**
1. A contact hard-deleted mid-backfill killed the job on an FK violation. The batch now retries
   under a fresh snapshot.
2. A contact erased mid-backfill could have its keys **resurrected** from a stale batch snapshot —
   precisely the leak this PRD exists to prevent. The job now sweeps backfill-authored rows pointing
   at soft-deleted contacts *after* its inserts commit, so whichever of erasure and backfill commits
   second performs the cleanup.

**The dual-write is SELECT-first, not insert-first.** Steady state is one indexed four-row read with
no insert churn on the hottest path in the engine. It also separates a benign own-row from a foreign
owner, so the divergence warning fires on real divergence instead of on every repeat resolve.

The backfill is boot-enqueued, resumable by keyset cursor, idempotent, and has a dry-run mode.
`GET /v1/admin/identity/alias-parity` reports divergence and is available from the moment this ships
— an operator with pre-existing diverged data can detect it and roll back rather than discover it
through a failed ingest.
