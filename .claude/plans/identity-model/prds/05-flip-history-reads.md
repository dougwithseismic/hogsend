# PRD 05 — Flip history reads to contact_id

## Goal

Move every read of the five string-keyed history tables off `<table>.user_id` and onto the
`contact_id` uuid FK that PRD 04 added, backfilled and dual-writes. This is the commitment step: once
reads are on the FK, the canonical key string stops being load-bearing, `repointOwnHistory`'s
five-table string rewrite becomes dead, and the provenance guard that exists only because strings
collide across namespaces (`keysAnotherContact`) **collapses to its attach role** — its
adoption-gating half is replaced by a `WHERE contact_id IS NULL` predicate that cannot steal by
construction, while the attach half survives because aliases and the analytics stitch stay
string-keyed forever (D6). Reads and deletions are separate tasks; nothing here drops a column
(that is PRD 07).

## Advisory corrections (applied 2026-07-28, re-anchored against `e9c7c10f`)

A senior pass re-derived this PRD against the post-02/03 code. **The 159-site total reproduces
exactly and 02/03 added or removed zero sites** — but the bookkeeping under it had six errors, and
one decision was outright wrong.

| # | Severity | Correction |
| --- | --- | --- |
| C1 | **blocking** | **D6/T9's deletion of `keysAnotherContact` is withdrawn.** It would re-open a live hole (a refused claim skips the `contact_aliases` INSERT, and post-02 aliases ARE resolution) and would go red on three committed PRD 03 tests. The originally chosen proof-gate could not have caught it. See D6 |
| C2 | major | D7 is CLOSED, not open — PRD 03 already made the alias insert self-reporting and deleted `anonAliasAlreadyHeld`. T9's item 4 is moot |
| C3 | major | D8 is **twelve** sites, not eleven — `bucket-reconcile.ts:424` joins an aliased subquery and is invisible to the textual census |
| C4 | minor | `lib/journey-lift.ts` has three drizzle `journeyStates.userId` sites (`:67`, `:78`, `:79`) missing from the batch table; only its raw-SQL hit was counted. Assign to T8 → T8 becomes 8 sites |
| C5 | minor | Two batch labels miscount their own rows: T6 says 14 but its rows sum 15; T7 says 22 but its rows sum 24. `demo-seed` is 4 sites, not 5 → T10 = 9. With C4 applied the batches now sum to **130 exactly**, fully reconciled against the drizzle total |
| C6 | minor | The "−3" in the raw count is NOT schema self-references — it is `.next/standalone` build-artifact copies of two docs files. Add `--exclude-dir=.next` to the reproduce command and fix the explanation |
| C7 | minor | `routes/admin/contacts.ts` moved (PRD 01 grew the file): raw `:364→:388`, email-preferences `:425→:461` |
| C8 | minor | Every heavy-fixture test this PRD adds (T3's arbiter tests, T4's anon→register→enroll, T6's unsubscribe flow) MUST run-namespace every identity value and scope its assertions to that namespace, and the suite must pass twice against a reused database. Same law as PRD 06 T2, same reason: these fixtures seed colliding rows deliberately, so a state-poisoned run passes for the wrong reason |

`contacts.ts` anchors throughout are taken at `e9c7c10f` and **must be re-derived at build time** —
PRD 06 shifts that file again by roughly 60 lines. Every other file's anchors were verified current.

F1 (the `NULLS DISTINCT` arbiter trap) was re-verified end to end against the current schema and is
**unchanged**: the partial unique indexes, the enrollment upsert target, the preferences arbiter and
PG18's default all still hold, and the contactless test is still specified first.

## Re-anchoring (2026-07-28, post-0.59, HEAD `3a8239cc`)

A full census re-derivation after PRD 04 shipped (0.58.0/0.59.0) and `origin/main` was merged back —
bringing the #623-#625 bucket fixes, which are sibling work this PRD's census predates. The advisory
pass's `e9c7c10f` is not an ancestor of this branch; everything below is measured at HEAD. Numeric
corrections are applied in place throughout this document; this table records the deltas and the two
scope changes.

| # | Correction |
| --- | --- |
| R1 | **Total is 160, not 159.** PR #625 (`199f4b23`) added one `bucketMemberships.userId` site: `workflows/bucket-reconcile.ts:749`, a raw-SQL EXISTS subquery joining `coalesce(c.external_id, c.anonymous_id, c.id::text)` to `bm.user_id`. It belongs to T5 → T5 = 44, drizzle total = 131 |
| R2 | **D8 is now a per-site audit, not a blanket patch.** #625 already rewrote the four `bucket-access.ts` joins from `eq(contacts.externalId, …)` to `eq(contactKeySql(), …)` — the widening D8 wanted to defer has SHIPPED there, and adding `isNotNull(contacts.externalId)` at those sites today would regress it. `routes/admin/events.ts:79` was mischaracterized from the start (its LATERAL already ORs all three key shapes). The two `bucket-backfill.ts` userEvents joins (now `:479-480`, `:497`) are still genuinely narrow and DO need the preservation treatment. Rule: classify each D8 site as already-wide (flip to the FK join, no `isNotNull`) or still-narrow (`isNotNull` + file the widening) before flipping it |
| R3 | **`contactKeySql()` has 19 consumers across 6 files, not four**: `bucket-access.ts` ×4, `check-membership.ts` ×1, `bucket-backfill.ts` ×4, `bucket-reconcile.ts` ×5, `send-campaign.ts` ×1, plus ×4 in PRD 04's `backfill-contact-id.ts` (deliberately string-keyed — it is the machinery that populates `contact_id` FROM `user_id`). T9 item 6 rescoped: the helper does not die; it shrinks to that single permanent consumer |
| R4 | **`ConditionContext` has 8 construction sites, not 4**: the three listed plus `buckets/check-membership.ts:253`, `workflows/bucket-backfill.ts:552`, and `workflows/bucket-reconcile.ts:259`, `:486`, `:1102` (bucket criteria evaluation). `flags.ts:437` is NOT a site — it builds an unrelated `TargetingEvalContext` that funnels into the single real site at `:274`. T1b's required-field approach enumerates all of these via `check-types` regardless, which is the point |
| R5 | `ConditionContext`'s optional email field is named `email`, not `userEmail`. `evaluateTriggerConditions()` does not exist — `trigger.where` routes through the pure `evaluatePropertyConditions()` (no DB, no ConditionContext); out of scope either way |
| R6 | The raw-SQL reproduce grep must add `t` to the alias set AND exclude `workflows/backfill-contact-id.ts` — its 4 `t.user_id` sites are PRD 04 machinery, permanently string-keyed |
| R7 | Line-anchor drift: every `lib/contacts.ts` anchor is stale by ≈ +464 (file is now 2769 lines; `contactKey` `:792`, `repointOwnHistory` `:2219`, call sites `:1131`/`:1522`/`:1571`/`:1890`); enrollment arbiter `execute-journey-run.ts:223`; preferences arbiter `lib/preferences.ts:141`; the three partial unique indexes at `journey-states.ts:72-73`, `bucket-memberships.ts:74-75`, `email-preferences.ts:34-37`; `admin/contacts.ts` raw hit `:389`. `enrollment-guards.ts`, `conditions/evaluate.ts`, `relations.ts` and EVERY named test anchor have zero drift. Builders re-grep; never trust a digit |
| R8 | `routes/admin/events.ts` "6 UE" included a docblock mention at `:62`; real code sites are 5 (`:79,80,81,87,311`) — expect 5 edits in T7 |

## Measured surface (reproduce before starting)

```bash
for t in userEvents journeyStates bucketMemberships emailSends emailPreferences; do
  echo "=== $t ==="
  grep -rn "$t\.userId" --include="*.ts" --include="*.tsx" packages apps scripts \
    | grep -v "__tests__" | grep -v "\.test\.ts" | awk -F: '{print $1}' | sort | uniq -c | sort -rn
done
```

**131 drizzle-column sites** (was 130 before #625; R1). The DECISIONS §2 figure of 48 for
`user_events` counts the three self-references inside `packages/db/src/schema/user-events.ts` (`:19`,
`:45`, `:57`), which PRD 04 already owns; journey_states 29, bucket_memberships 35,
email_preferences 15, email_sends 7. Measured non-schema total: **45 + 29 + 35 + 15 + 7 = 131**.

**Plus a THIRD category that NO grep of either shape can see: indirect subject threading.**
`ConditionContext` (`packages/core/src/conditions/evaluate.ts:8-10`) carries the subject as a bare
`userId: string`. Its construction sites contain zero `<table>.userId` references and zero raw
`user_id`, so both censuses above are structurally blind to them. Confirmed sites:

| File | Site |
| --- | --- |
| `packages/engine/src/workflows/journey-blueprint-interpreter.ts` | `:373` — `ctx: { db, userId: user.id, … }` for `conditional` nodes |
| `packages/engine/src/lib/flags.ts` | `:274` — server-mode flag targeting (the ONLY flags site; `:437` builds an unrelated `TargetingEvalContext` that funnels into it, R4) |
| `packages/engine/src/lib/agent/tools.ts` | `:294-300` — audience preview (already holds the contact row `c` and passes `contactKey(c)`) |
| `packages/engine/src/buckets/check-membership.ts` | `:253-255` — bucket criteria evaluation (R4) |
| `packages/engine/src/workflows/bucket-backfill.ts` | `:552-559` — backfill criteria matcher (R4) |
| `packages/engine/src/workflows/bucket-reconcile.ts` | `:259-261`, `:486-488`, `:1102-1104` — reconcile leave/join checks (R4) |

This matters precisely BECAUSE it is invisible: after T9 deletes `repointOwnHistory`, the evaluator's
subject arm sees only rows written under the key it was handed, so a blueprint `conditional`, a
server-side flag rule and the agent's audience preview each silently under-count a person's anon-era
history — the exact loss D2 exists to prevent, arriving through a door the grep does not cover. The
word "blueprint" appeared nowhere in an earlier revision of this PRD.

**Do not solve this with a wider grep.** Add `contactId: string | null` to `ConditionContext` as a
**REQUIRED** field, so `check-types` enumerates every caller for you and the compiler, not a regex,
is what proves the census is complete. Explicitly NOT optional: the adjacent `email` field
(`:11-18`) was added as optional-with-a-fallback and its own docblock now has to warn callers to
"pass it explicitly (even `null`)" — that is the failure mode repeating itself. A required field
cannot be forgotten.

**Plus 29 sites the DECISIONS grep does not see**, because they are raw `user_id` inside `sql`
templates with table aliases rather than drizzle column references:

| File | raw-SQL hits | alias |
| --- | --- | --- |
| `packages/engine/src/routes/admin/impact.ts` | 10 | `js.user_id` |
| `packages/engine/src/routes/admin/journey-impact.ts` | 9 | `js.user_id` |
| `packages/engine/src/workflows/impact-digest.ts` | 3 | `js.user_id` |
| `packages/engine/src/routes/admin/conversions.ts` | 3 | `js.user_id`, `ue.user_id` |
| `packages/engine/src/routes/admin/funnels.ts` | 1 (`:146`) | `ue.user_id` |
| `packages/engine/src/routes/admin/contacts.ts` | 1 (`:364`) | `ue.user_id` |
| `packages/engine/src/lib/journey-lift.ts` | 1 (`:128`) | `js.user_id` |
| `apps/api/src/workflows/gtm-score.ts` | 1 (`:274`) | `e.user_id` |

Reproduce with `grep -rnE "\b(js|ue|ep|bm|es|e)\.user_id\b" --include="*.ts" packages apps`.
(Adding `t` to the alias set also surfaces PRD 04's `workflows/backfill-contact-id.ts` — 4 sites,
deliberately string-keyed, permanently excluded; R6.)
**True surface: 160 sites.** `check-types` catches the 131 and none of the 29 — the raw-SQL ones are
strings and will compile clean while returning zero rows.

**Minus 3 that are not code.** `apps/docs/app/(home)/recipes/_data/weekly-digest.ts:78,92` and
`ai-drafted-sends.ts:31` sit inside template literals of published documentation
(`const TASK_CODE = \`…\``, `weekly-digest.ts:52`). They are a doc-sync obligation, not a call site,
and the compiler is blind to them.

### Per-file breakdown, grouped as this PRD batches them

| Batch | Files (sites) |
| --- | --- |
| T4 journey runtime | `journeys/journey-context.ts` (5 UE + 1 JS), `journeys/execute-journey-run.ts` (3 JS), `lib/enrollment-guards.ts` (2 JS + 1 EP), `lib/ingestion.ts:942` (1 JS), `lib/flags.ts` (1 JS + 1 BM), `packages/core/src/conditions/event.ts:17` (1 UE) — **16** |
| T5 buckets | `workflows/bucket-reconcile.ts` (5 UE + 12 BM, incl. the #625 EXISTS subquery at `:749`, R1), `workflows/bucket-backfill.ts` (9 UE + 6 BM), `buckets/bucket-access.ts` (6 BM), `buckets/check-membership.ts` (2 BM), `buckets/membership-epoch.ts` (1 BM), `workflows/send-campaign.ts:979,984` (2 BM), `routes/admin/buckets.ts:467` (1 BM) — **44** |
| T6 email + preferences | `lib/tracking-events.ts` (3 JS + 1 ES), `lib/preferences.ts:104`, `lib/recipient-preferences.ts:28`, `workflows/send-campaign.ts:1064`, `routes/lists/index.ts:408,463`, `routes/email/preferences.ts:74`, `routes/admin/preferences.ts:107,141`, `routes/admin/contacts.ts:425`, `routes/admin/reporting.ts:288,420` — **14** |
| T7 admin + agent reads | `routes/admin/events.ts` (6 UE), `routes/admin/timeline.ts` (2 UE + 4 JS), `routes/admin/emails.ts` (3 JS + 1 ES), `routes/admin/journeys.ts:748`, `routes/admin/groups.ts:868`, `routes/admin/bulk.ts:392`, `workflows/check-alerts.ts:79`, `lib/agent/tools.ts` (2 UE + 1 JS + 1 EP) — **22 drizzle** + the **29 raw-SQL** sites above |
| T8 attribution + revenue | `lib/revenue.ts:96`, `lib/conversion-dispatch.ts:111`, `lib/attribution.ts:161`, `lib/attribution-backfill.ts:136`, `campaigns/cohort-sql.ts:166` — **5** |
| T2/T9 identity core | `lib/contacts.ts` (2 UE + 2 JS + 3 BM + 2 ES + 2 EP) — **11**, the merge/fold/repoint machinery. Not "flipped"; rewritten in T2, then cut down in T9 |
| T1 relations | `packages/db/src/schema/relations.ts` (1 each for UE, JS, BM, EP) — **4** |
| T10 tail | `packages/db/src/demo-seed.ts` (5), `apps/api/scripts/smoke.ts` (2), `apps/docs/.../_data/*.ts` (3 doc strings) — **10** |

## Locked decisions

### D1 — Batch by SUBSYSTEM, not by table. The per-table cut does not compile.

BACKLOG's fallback ("05 can be split per-table, each of the five is independent") is wrong as stated.
Single expressions span two tables:

- `routes/admin/emails.ts:288` — `or(eq(emailSends.userId, userId), eq(journeyStates.userId, userId))`.
  A per-table cut leaves this half-flipped, comparing a uuid to a text key in one leg.
- `workflows/bucket-backfill.ts:489` joins `contacts` to `userEvents.userId` while `:356` in the same
  file joins `contacts` to `bucketMemberships.userId`. Same file, same subsystem, two tables.
- `lib/tracking-events.ts:102-104` selects `journeyStates.userId` and `emailSends.userId` in one
  LEFT JOIN (`resolveEmailSendContext`).

The subsystem cut is also the reviewable one: a reviewer can hold "does journey enrollment still find
its own history" in their head; they cannot hold "every `user_events` read in the repo".

### D2 — One read helper, introduced before any flip. 159 sites must not each invent a predicate.

Journeys run **without a contact**. `JourneyContextConfig.contactId` is `contactId?: string`
(`journeys/journey-context.ts:211`) and is explicitly undefined on a refusal — the comment at
`journey-context.ts:1269` says the ingest push "OMITS `contactId` on a refusal". A naive flip to
`eq(table.contactId, X)` returns nothing for every contactless enrollment, which is the exact
population PRD 01/#621 created.

So the flip target is not `eq(contactId)`. It is one exported helper:

```
bySubject(table, { contactId, userKey })
  → contactId ? eq(table.contactId, contactId) : eq(table.userId, userKey)
```

Either/or, never `OR`. Once a contact exists, T2 guarantees all of that person's rows carry
`contact_id`, so the `OR` form would only add a redundant text scan and re-open the collision class
this whole effort exists to close. The helper lives in `packages/engine/src/lib/` next to
`contactKey` (`lib/contacts.ts:557`), is exported, and every batch routes through it.

### D3 — `mergedKeys` / `mergedIdentifiedKeys` plumbing STAYS. It is not a DB concern.

Checked directly. `mergeAnalyticsIdentities` (`lib/analytics-identity.ts:41-84`) consumes
`loserKeys: string[]` and calls `analytics.mergeIdentities({ distinctId: survivorKey, alias: loserKey })`
— the PostHog anon→known stitch. It touches no table. Its caller `ingestion.ts:513-533` reads
`mergedKeys` off the resolve result for exactly that purpose, and `identity-service.ts:85-99` does the
same for the Discord link path. Making history a uuid FK does not give PostHog a uuid FK; PostHog
still merges *distinct ids*, which are still the canonical key strings. **Delete none of it.** The
brief's "IF it is no longer needed" resolves to: still needed, and it is the reason the canonical key
string survives PRD 07.

### D4 — `repointOwnHistory` is NOT deleted. It collapses to a stamp. This contradicts the BACKLOG line.

BACKLOG row 05 says the flip deletes `repointOwnHistory`, the adoption arms and the provenance guard.
Two of the three hold. The repoint does not, and the reason is structural:

The refusal path (`resolveContactNoCreate`, kept by DECISIONS §4) writes history with **no contact
row in existence**. Those rows carry `contact_id = NULL` and `user_id = <anonId>`. When the visitor
later identifies, a contact is minted — and nothing has yet associated those NULL rows with it. Under
`contact_id` reads they are invisible: the identical loss #621's PRD 01 T2 and PRD 06 were written to
fix, re-introduced through the other door.

So adoption survives. What changes is its shape:

- **Today:** rewrite `user_id` on five tables from `oldKey` to `newKey`, with three dedupe folds to
  avoid violating `uq_user_journey_active` / `uq_user_bucket_active` / `uq(user_id, email)`
  (`contacts.ts:1755-1785`).
- **After:** `UPDATE <t> SET contact_id = :id WHERE user_id = :fromKey AND contact_id IS NULL` on five
  tables. One column, no key rewrite. The folds still run, re-expressed on `contact_id` (see D5).

The win is real but it is a simplification, not a deletion: five blind single-column updates replace a
five-table key rewrite, and the `AND contact_id IS NULL` predicate is what makes D6 possible.

### D5 — Contact-scoped uniqueness must be added, and it is the one genuinely risky schema step.

Three partial unique indexes encode "one live row per person":

- `uq_user_journey_active` on `(user_id, journey_id) WHERE status IN ('active','waiting')`
  (`packages/db/src/schema/journey-states.ts:70-72`)
- `uq_user_bucket_active` on `(user_id, bucket_id) WHERE status = 'active' AND deleted_at IS NULL`
  (`packages/db/src/schema/bucket-memberships.ts:71-73`)
- `email_preferences_user_email_idx` on `(user_id, email)`
  (`packages/db/src/schema/email-preferences.ts:29-32`)

Adoption stamps `contact_id` without touching `user_id`, so two rows keyed `A` and `U` can both become
`contact_id = X` for the same journey and both be active. The DB permits it (the index is on
`user_id`); a `contact_id` read then sees two active enrollments and the enrollment guard
(`lib/enrollment-guards.ts:17,32`) silently double-enrolls. The contact-scoped indexes are therefore
part of the flip's correctness, not cosmetic, and they can only be created after a preflight proves
zero violations. That preflight is T3 and it may find real duplicates in production.

### D6 — `keysAnotherContact` COLLAPSES to its attach role. It is NOT deleted. *(Respecced 2026-07-28 — the original decision was wrong and is recorded below so the reasoning is not repeated.)*

**The original decision, now withdrawn:** delete `keysAnotherContact` entirely once the target
predicate is `WHERE contact_id IS NULL`, on the argument that a victim's rows already carry their own
`contact_id` so the UPDATE matches zero of them, making the guard a redundant SELECT on a hot path.
Proof-gate was `contacts-no-create.test.ts:584` + `:642` staying green.

**Why that is wrong.** The argument is sound for the ADOPTION half and false for the ATTACH half, and
PRDs 02/03 moved the attach half from incidental to load-bearing:

1. **The call structure the decision described no longer exists.** PRD 03 replaced the three scattered
   call sites with ONE direct call in the create arm plus a single choke-point, `claimIdentityKey`,
   invoked from both `fillInLink` and `mergeContacts`. The `foreignAnonKey` local is gone (now a
   `foreignMemo` map). There is nothing shaped like "its three call sites" left to delete.
2. **A refused claim skips the `contact_aliases` INSERT, and post-02 aliases ARE resolution.**
   `findByKey` probes aliases FIRST. Delete the gate and a caller holding a legitimate token for their
   own `userId` can claim `(anonymous, <victim's canonical key>)` onto their own contact. The
   `contact_id IS NULL` predicate protects the victim's EXISTING rows — it does nothing about the
   alias. Every FUTURE resolve presenting that value under the anonymous kind now lands on the
   attacker.
3. **Worse, the claim enters `mergedKeys`,** so `mergeAnalyticsIdentities` aliases the victim's key
   into the attacker's PostHog person. **D3 proves the FK can never subsume this:** the analytics
   stitch stays keyed on canonical-key STRINGS forever, so a string-collision guard on claims
   necessarily outlives string-keyed history.
4. **The deletion would go red on PRD 03's own committed suite** — `contacts-many-keys.test.ts:148`
   ("a victim's external_id named as anonymousId is not claimed, aliased, or adopted"), `:191`
   (external arm) and `:470` (merge arm) pin the attach refusal directly. **The originally chosen
   proof-gate could not have caught this**: `contacts-no-create.test.ts:584`/`:642` assert adoption
   outcomes only, so they would have stayed green while the attach hazard shipped. That is the
   vacuous-green failure mode from house memory — a gate that certifies rather than tests.

**What T9 actually deletes:** the guard's ADOPTION-gating role (genuinely subsumed by
`WHERE contact_id IS NULL`) and the five `user_id` string rewrites. The guard itself survives inside
`claimIdentityKey` as the attach + `mergedKeys`-report guard. The create arm's direct call survives
for the same report reason — a foreign anon id must not enter `mergedKeys` there either.

**New proof-gate:** `contacts-many-keys.test.ts:148`, `:191`, `:470` green **with the string rewrites
deleted**, plus `contacts-no-create.test.ts:584`/`:642`. Do not delete on argument.

### D7 — RESOLVED by PRD 03. Nothing to decide. *(Closed 2026-07-28.)*

`anonAliasAlreadyHeld` no longer exists — PRD 03 deleted it and replaced it with exactly the
self-reporting insert this decision asked for: `claimIdentityKey`'s
`onConflictDoNothing().returning()` classifies each claim as `"claimed"` or `"held"`, so first-claim
detection is the unique index rather than a probe. A browser identifying on every page load
re-reports no merge, structurally. The gate test
(`contacts-no-create.test.ts:666`, "claims a second device's anon id ONCE, not on every resolve")
exists and passes. T9's corresponding deletion item is moot.

### D8 — The twelve identity-JOIN sites change result sets. Preserve today's, file the widening.

`eq(contacts.externalId, <t>.userId)` appears at `buckets/bucket-access.ts:77,101,149,160`,
`workflows/bucket-reconcile.ts:459,537,715`, `workflows/bucket-backfill.ts:356,489`,
`workflows/send-campaign.ts:984`, `routes/admin/events.ts:79`, **and
`workflows/bucket-reconcile.ts:424`**. The twelfth was invisible to both censuses because it joins an
ALIASED SUBQUERY over `bucketMemberships` (`eq(contacts.externalId, members.userId)`), so the textual
pattern sees `members.userId` rather than `bucketMemberships.userId` — a reminder that a grep-derived
census under-reports exactly where the query is most indirect. It carries the same
drop-email-only-contacts semantics as the other eleven and belongs in T5's scope.

Not in this class, and correctly excluded: the other `eq(contacts.externalId, <var>)` hits
(`check-membership.ts:192`, `bucket-reconcile.ts:1095`, `timezone.ts:122`,
`execute-journey-run.ts:415,565`, `refine.ts:245`, `connector-actions.ts:100`) are value-probes
resolving a runtime key to a contact, not history-table joins. Replacing it with
`eq(contacts.id, <t>.contactId)` is **not** behaviour-preserving: today the join drops every row whose
owner has no `external_id`. An email-only contact's canonical key is its row uuid
(`contactKey`, `contacts.ts:557`), so its bucket memberships are invisible to `bucket.count()`
(`bucket-access.ts:74-85`) right now. The FK join makes them visible.

DECISIONS §4 forbids bundling a behavioural change with a migration step. **Add
`isNotNull(contacts.externalId)` at each of the eleven** to reproduce today's result set exactly, and
file the widening as its own issue. It is probably the most valuable bug this whole re-model surfaces
and it deserves its own PR, its own test and its own line in a changeset.

> **Re-audited 2026-07-28 (R2) — the paragraph above is now wrong at most of its own sites.** #625
> already rewrote the four `bucket-access.ts` joins to `eq(contactKeySql(), …)`: they are WIDE today,
> so "preserve today's result set" at those sites means the FK join with NO `isNotNull` — adding it
> would regress a shipped fix. `routes/admin/events.ts:79` was always wide (its LATERAL ORs all three
> key shapes). `bucket-backfill.ts`'s two userEvents joins (now `:479-480`, `:497`) are still
> genuinely narrow and keep the `isNotNull` preservation + filed widening. Every remaining D8 site
> must be classified already-wide vs still-narrow at flip time, against the code as it stands, not
> against this section's original description.

### D9 — Hatchet payloads, CEL filters and the admin API keep their string `userId`.

Not DB reads, so not in scope, and each is a trap that looks in-scope:

- `ctx.waitForEvent`'s CEL filter is `input.userId == '…'` over the pushed event payload — a Hatchet
  concern, untouched.
- `journeyStates.userId` is the key written at `execute-journey-run.ts:163`
  (`onConflictDoUpdate target: [journeyStates.userId, journeyStates.journeyId]`). The write stays until
  PRD 07; only the reads move.
- Admin routes take a `userId` **query parameter** (`routes/admin/events.ts:311`,
  `admin/journeys.ts:748`, `admin/buckets.ts:467`, `admin/bulk.ts:392`, `admin/reporting.ts:420`).
  That parameter is a published contract. Resolve it to a contact inside the handler; do not rename it
  or change its meaning. `packages/studio/src/views/journey-detail-view.tsx:298` is the only Studio
  site that renders a `userId`, and it renders `state.userId` for display — leave it.

### D10 — `conversions` / `funnel_progress` are the proven precedent, and the end state is dual-key.

Both already carry `contact_id uuid NOT NULL` **and** `user_key text NOT NULL`
(`packages/db/src/schema/conversions.ts:28,32`, `funnel-progress.ts:27,31`). That is exactly the shape
this PRD produces for the five: FK for identity, text for denormalized display and for the analytics
stitch (D3). It is not a transitional state to be embarrassed about; it is the shape four tables have
shipped in for months.

## EARS acceptance criteria

- **WHEN** `bySubject` is called with a `contactId`, the system **SHALL** filter on `contact_id` and
  **SHALL NOT** reference `user_id`.
- **WHEN** `bySubject` is called with no `contactId`, the system **SHALL** filter on `user_id`, so a
  contactless journey enrollment reads exactly the history it reads today.
- **WHEN** a contact is created or fill-in-linked absorbing an anonymous key `A`, the system
  **SHALL** set `contact_id` on every `user_events`, `journey_states`, `bucket_memberships`,
  `email_sends` and `email_preferences` row where `user_id = A` **and** `contact_id IS NULL`.
- **WHEN** that adoption runs a second time for the same `(contact, A)` pair, the system **SHALL**
  change zero rows and **SHALL NOT** re-report `A` in `mergedKeys`.
- **WHEN** `user_id = A` names a live contact other than the adopter, the system **SHALL** leave every
  one of those rows' `contact_id` unchanged, because they are already non-NULL.
- **WHEN** adoption would leave a contact holding two active `journey_states` rows for one journey, or
  two active `bucket_memberships` rows for one bucket, or two `email_preferences` rows for one email,
  the system **SHALL** fold them to one exactly as the merge path does today.
- **WHEN** an anonymous visitor accumulates history under `A`, then registers as `U`, then a journey
  guard checks its entry limit, the system **SHALL** count the pre-registration enrollments.
- **WHEN** the bucket accessor counts members of a bucket, the system **SHALL** return the same count
  it returns before this PRD, for the same data (D8).
- **WHEN** `mergedKeys` is non-empty after a flip or adoption, the system **SHALL** still fire
  `mergeAnalyticsIdentities` with the canonical key strings (D3).
- **WHEN** any batch of this PRD is reverted, the system **SHALL** behave exactly as it did before that
  batch, because `user_id` is still written on every insert until PRD 07.

## Tasks

Ordering is load-bearing: **T2 (adoption stamps `contact_id`) must ship before any read flips**, or the
first flipped read loses anon history. **T9 (deletions) must ship last**, after every read is off
`user_id`.

### T1 — `bySubject` helper + drizzle relations
_Boundary:_ `packages/core` + `packages/db` (+ `packages/engine` re-export) · _Depends:_ PRD 04

Add and export the D2 helper. **Placement amendment (2026-07-28):** D2 says the helper lives in
`packages/engine/src/lib/`, but `conditions/event.ts` — a T1b flip site — is in `@hogsend/core`,
which cannot import the engine. So `bySubject` lives in `@hogsend/core` (which already imports
`@hogsend/db/schema`), exported from core's index and re-exported by `@hogsend/engine` so engine
call sites import it from the engine surface as D2 intended. Flip the four `relations()` declarations in
`packages/db/src/schema/relations.ts:97,125,133,142` from `references: [contacts.externalId]` to
`references: [contacts.id]` on the new `contactId` field.

**Cost: small.** The relations flip is free and unobservable — `grep -rn "db\.query\.(userEvents|journeyStates|bucketMemberships|emailSends|emailPreferences)"`
returns 14 sites and **none** of them use `with: { contact }`, so no result shape changes. Verified.

**Tested by:** unit tests on `bySubject` asserting the generated SQL for both arms (contactId present /
absent). Relations: a test that `db.query.userEvents.findFirst({ with: { contact: true } })` resolves
the owning contact for an anon-keyed event — which fails today (the `external_id` join misses) and
passes after. This is the one place the relations flip is observable, and it is new behaviour, so gate
it behind a test rather than shipping it silently.

### T1b — `ConditionContext` carries `contactId` (the compiler-enforced census)
_Boundary:_ `packages/core` (the type + evaluator) then `packages/engine` (every constructor) ·
_Depends:_ T1

Add `contactId: string | null` to `ConditionContext` (`packages/core/src/conditions/evaluate.ts:8`)
as a **REQUIRED** field, and thread it through the `event` / `email_engagement` / composite arms so
the subject query uses `bySubject`. Then fix every construction site the compiler reports — the eight
known ones are in the census table above (R4), but **trust `check-types`, not that list**: the point
of making it required is that the compiler finds sites no census could.

**Do this BEFORE T4-T8.** It is the task that converts an invisible surface into a visible one, and
running it early means the remaining flips start from a type error list rather than a grep.

**Cost: small in lines, high in value.** The type change is one line; the fallout is however many
callers exist, each a one-line addition, and `agent/tools.ts` already has the contact row in hand.

**Tested by:** a test that a condition evaluated with `contactId` set sees history written under a
DIFFERENT string key for the same contact (the anon-era rows) while the same condition with
`contactId: null` sees only the string-keyed rows — proving the new arm is actually consulted and
that the fallback still works. Mutation proof: reverting any single constructor to drop `contactId`
must fail `check-types`, which is the whole point of the field being required.

### T2 — adoption stamps `contact_id` (additive; the string rewrite stays)
_Boundary:_ `packages/engine` · _Depends:_ T1

Rewrite `repointOwnHistory` (`lib/contacts.ts:1755`) to ALSO set `contact_id` where
`contact_id IS NULL`, keeping the `user_id` rewrite. Same for the three fold helpers
(`foldJourneyStates:1461`, `foldBucketMemberships:1567`, `foldEmailPreferences:1667`) and the merge
path's bulk rewrites (`contacts.ts:1252`, `:1266`, `:1612`, `:1677`). All three call sites — create arm
`:813`, fill-in-link flip `:1133`, fill-in-link adoption `:1177`, merge `:1426` — keep their current
shape.

**Tested by:** extend every existing assertion block in
`apps/api/src/__tests__/contacts-no-create.test.ts` to assert `contact_id` alongside the `user_id`
move. The T2 test at `:270` already inserts one row into each of the five tables under `T2_ANON` and
asserts zero residual under `A` / one under `U` (`:319-340`) — add `contact_id === created.id` to each.
Mutation proof: dropping the `contact_id` clause from one table's update must fail exactly one
assertion.

### T3 — contact-scoped uniqueness preflight + partial unique indexes
_Boundary:_ `packages/db` · _Depends:_ T2

Ship the preflight query first, as a script, and run it against production before the migration:

```sql
select contact_id, journey_id, count(*) from journey_states
 where contact_id is not null and status in ('active','waiting') and deleted_at is null
 group by 1,2 having count(*) > 1;
```

…and the analogues for `(contact_id, bucket_id)` active and `(contact_id, email)`. Then add
`uq_contact_journey_active`, `uq_contact_bucket_active`, `email_preferences_contact_email_idx` with the
same predicates as their `user_id` twins (D5). The existing three indexes stay (PRD 07 drops them).

**Cost: medium, and unbounded on the downside.** If the preflight returns rows, this task grows a data
repair step and needs a human decision on which row wins. Say so up front rather than discovering it
in a migration.

> **BLOCKING — a naive arbiter flip breaks the CONTACTLESS population. Verified empirically.**
> Postgres unique indexes are `NULLS DISTINCT` by default, so `(contact_id, journey_id)` does not
> constrain rows where `contact_id IS NULL`. Proven against the real database: two rows with a NULL
> `contact_id` and the same journey both insert under such an index. That population is not a corner
> case — it is every anonymous visitor, and PRD 04 D6 plus #621's refusal guarantee it stays
> non-empty.
>
> So moving the enrollment arbiter to the new index means an anonymous visitor re-triggering an
> ACTIVE journey never fires `ON CONFLICT`. It inserts a second row, which then violates the
> RETAINED `uq_user_journey_active` twin as a raw, unhandled 23505 — the journey run fails. The
> failure is invisible to the arbiter test specified below (two `user_id` strings, one contact),
> because the failing case has no contact at all.
>
> **`NULLS NOT DISTINCT` is not the fix — it is worse.** It would make every contactless row for a
> journey conflict with every OTHER anonymous visitor's row for that journey: cross-person
> enrollment collapse.
>
> Two acceptable shapes, pick one and state why:
> 1. **Coalesce arbiter** — index on `(coalesce(contact_id::text, user_id), journey_id)` with the
>    same partial predicate. One arbiter serves both populations and degrades to today's behaviour
>    when `contact_id` is NULL.
> 2. **Keep the `user_id` arbiter**, add the contact-scoped index as a constraint only, and handle
>    23505 on `err.cause` explicitly.
>
> The same defect applies to the `email_preferences` upsert in T6 for token-derived contactless
> preference writes — where the consequence is mail to someone who unsubscribed. Fix both together.
>
> D2's `bySubject` helper already models the contactless population correctly on the READ path; this
> is the same population forgotten on the WRITE path.

**The arbiter moves in THIS task, not a later one.** Adding an index does not change which one an
upsert targets: the enrollment `onConflictDoUpdate` names its arbiter explicitly, and it still names
the `user_id` twin. Leaving it means the new index is created but never enforced through the upsert
path. So flip the arbiter in the same commit as the index — to whichever of the two shapes above you
chose, never bare `(contact_id, journey_id)` — and do the same for the bucket-membership and
email-preferences upserts. Per [[reference_drizzle-partial-index-onconflict]] the arbiter's predicate
goes in `where`, and a 23505 surfaces on `err.cause` — both matter here because all three indexes are
partial.

**Tested by:** a migration test that inserts two active `journey_states` rows for one contact and one
journey and asserts a 23505; plus running the preflight against the seeded test DB and asserting zero
rows. **Plus TWO arbiter tests, and the second is the one that matters:**

1. *Identified:* drive the real enrollment upsert twice for one `(contact_id, journey_id)` with
   DIFFERENT `user_id` strings (the anon-then-identified shape) and assert it UPDATES rather than
   raising or inserting a second row — fails if the arbiter still names the `user_id` index.
2. *Contactless — the F1 regression guard:* drive the same upsert twice for one anonymous visitor
   with `contact_id IS NULL` and the same `(user_id, journey_id)`, and assert it UPDATES — no second
   row, no 23505. **Write this one first.** Under a bare `(contact_id, journey_id)` arbiter it fails,
   and test 1 passes, which is exactly how the defect would have shipped.

### T4 — flip the journey runtime (16 sites)
_Boundary:_ `packages/engine` + `packages/core` · _Depends:_ T3

`lib/enrollment-guards.ts:17,32,52` · `journeys/execute-journey-run.ts:350,481` (NOT `:163`, that is
the write target, D9) · `journeys/journey-context.ts:470,479,678,817,1469,1542` ·
`lib/ingestion.ts:942` (the exit-condition scan) · `lib/flags.ts:102,113` ·
`packages/core/src/conditions/event.ts:17`.

`conditions/event.ts` is in `@hogsend/core`, whose `evaluateCondition` signature takes `ctx.userId`. It
needs `ctx.contactId` threaded through — a public type change in `@hogsend/core`, therefore a changeset.
Also wire real `contactId` values into this batch's R4 ConditionContext sites
(`journey-blueprint-interpreter.ts:373`, `flags.ts:274`), which T1b left as explicit `null`.

**Cost: medium, highest risk.** These sites govern enrollment, entry limits and exits. A wrong flip
here double-enrolls or silently stops exiting.

**Tested by:** the anon→register→enroll sequence end to end — `apps/api/src/__tests__/` already has the
fixtures in `contacts-no-create.test.ts`. New test: accumulate two completed enrollments under `A`,
register as `U`, assert a `once` journey refuses entry. That test fails today if reads are flipped
without T2, which is the proof the ordering is right. Also assert `ingestEvent` still exits an active
journey for a contactless subject (the `bySubject` else-arm).

### T5 — flip the bucket subsystem (44 sites)
_Boundary:_ `packages/engine` · _Depends:_ T3

`workflows/bucket-reconcile.ts` (17, incl. the #625 EXISTS subquery at `:749`, R1) ·
`workflows/bucket-backfill.ts` (15) ·
`buckets/bucket-access.ts` (6) · `buckets/check-membership.ts:223,535` ·
`buckets/membership-epoch.ts:39` · `workflows/send-campaign.ts:979,984` ·
`routes/admin/buckets.ts:467`.

**Cost: LARGE — the single biggest task in the identity re-model.** What makes it large is not the site
count, it is that `bucket-reconcile.ts` and `bucket-backfill.ts` are set-based batch workflows built on
chunked `inArray(<t>.userId, chunk)` paging (`bucket-backfill.ts:252,276`) and
`groupBy(<t>.userId)` aggregation (`:255,279,463,497`). Every chunk boundary, every `groupBy` key and
every `selectDistinct` projection changes type from `string` to `uuid`, and the aggregate results feed
downstream maps keyed by that value. Most of the D8 identity joins are in this batch — classify each
per the R2 re-audit before flipping it.

Consider splitting T5 into T5a (the two workflow files, 32 sites) and T5b (accessor + membership +
campaign + admin, 12 sites) if review latency becomes the bottleneck. Also wire real `contactId`
values into this batch's R4 ConditionContext sites (`check-membership.ts:253`,
`bucket-backfill.ts:552`, `bucket-reconcile.ts:259/:486/:1102`), which T1b left as explicit `null`. They are independent: the
workflows write memberships, the accessor reads them.

**Tested by:** engine bucket tests plus a fixture where an event-count bucket is entered under an anon
key and the contact then registers — `bucket.has(contact)` must be true after, and the reconcile pass
must not evict the membership. Assert `bucket.count()` returns the SAME number before and after the
flip on identical data (D8 preservation), using a fixture that deliberately includes an email-only
contact whose membership is excluded today.

### T6 — flip email + preferences (14 sites)
_Boundary:_ `packages/engine` · _Depends:_ T3

`lib/tracking-events.ts:44,102,104,313` · `lib/preferences.ts:104` (the upsert `target:` — this one is
an ON CONFLICT arbiter and must move to the new index from T3, not just the predicate) ·
`lib/recipient-preferences.ts:28` · `workflows/send-campaign.ts:1064` ·
`routes/lists/index.ts:408,463` · `routes/email/preferences.ts:74` ·
`routes/admin/preferences.ts:107,141` · `routes/admin/contacts.ts:425` ·
`routes/admin/reporting.ts:288,420`.

Four of these compute the key inline as `contact.externalId ?? contact.id`
(`admin/contacts.ts:425`, `admin/preferences.ts:107`, `lib/agent/tools.ts:175`, and the comment trail at
`routes/lists/index.ts:282,455`). Those inline derivations are exactly the idiom this PRD exists to
kill; each becomes `contact.id`.

**Cost: medium.** The risk concentration is unsubscribe. A missed flip means an unsubscribed person
gets mail.

**Tested by:** unsubscribe under an anon key, then register, then attempt a marketing send — must be
suppressed. This is the single most important behaviour test in the PRD and it should be written
before the flip, failing, then passing.

### T7 — flip admin + agent reads (22 drizzle + 29 raw SQL)
_Boundary:_ `packages/engine` · _Depends:_ T3

Drizzle: `routes/admin/events.ts:79,80,81,87,311` · `routes/admin/timeline.ts:88,98,126,137,146,162` ·
`routes/admin/emails.ts:288,309,363` · `routes/admin/journeys.ts:748` · `routes/admin/groups.ts:868` ·
`routes/admin/bulk.ts:392` · `workflows/check-alerts.ts:79` · `lib/agent/tools.ts:133,175,200,212`.

Raw SQL: the 29 sites in the table above. **These do not type-check.** They must each be opened and
read; a `grep`-and-replace will produce queries that run and return zero rows, which looks like "no
data" rather than a bug. `routes/admin/impact.ts` and `journey-impact.ts` together hold 19 of them
inside lift/holdout CTEs that also join a `c.user_key` cohort table — check whether that cohort table
is `conversions` (which has `contact_id` already, D10) and join on the FK instead.

`routes/admin/events.ts:79-87` is a LATERAL "pick THE live contact for an event's userId" with a
three-way priority `case` — the flip DELETES that whole construct, since `contact_id` names the contact
directly. That is the clearest single illustration of the win and worth calling out in the PR.

**Cost: medium-large**, dominated by the raw SQL needing per-query reading rather than mechanical
replacement. Also wire the real `contactId` into this batch's R4 ConditionContext site
(`agent/tools.ts:294-300`, which already holds the contact row), left as explicit `null` by T1b.

**Tested by:** each admin route already has route tests; assert unchanged response bodies against a
seeded fixture (golden-ish). For the raw-SQL analytics queries, assert a **non-zero** count on a
fixture — a zero-row assertion would pass on a broken query.

### T8 — flip attribution + revenue (5 sites)
_Boundary:_ `packages/engine` · _Depends:_ T3

`lib/revenue.ts:96` · `lib/conversion-dispatch.ts:111` · `lib/attribution.ts:161` ·
`lib/attribution-backfill.ts:136` · `campaigns/cohort-sql.ts:166`.

`cohort-sql.ts:166` correlates `userEvents.userId` to `campaignRecipients.userId` — and
`campaign_recipients` is **not** one of the five tables and has no `contact_id` (see Surprises). Either
leave that one join on strings with a comment, or extend PRD 04's scope. Leaving it is correct for this
PRD.

**Cost: small.**

**Tested by:** existing attribution tests; add one asserting revenue attribution follows a contact
across an anon→identified transition.

### T9 — the deletions
_Boundary:_ `packages/engine` · _Depends:_ T4, T5, T6, T7, T8

Only after every read is off `user_id`:

> **Re-anchor before building.** PRD 06 shifts `lib/contacts.ts` again (~+60 lines) after these
> anchors were taken. Every `contacts.ts` line in this task must be re-derived at build time; the
> other files are 06-inert (06 touches routes + the resolver top, T9 touches the resolver bottom).

1. `repointOwnHistory` drops its five `user_id` rewrites, keeping the `contact_id` stamps. Rename it
   `adoptOrphanHistory` in the same commit — the name is now a lie. It has **four** call sites (the
   create arm, the fill-in-link canonical flip, the fill-in-link adoption loop, and the merge arm),
   not three; the "five" elsewhere in this PRD is the count of TABLES it rewrites, which is a
   different number that happens to be adjacent.
2. `keysAnotherContact` — **NOT deleted.** Its adoption-gating role goes; the guard itself survives
   inside `claimIdentityKey` as the attach + `mergedKeys`-report guard, and the create arm's direct
   call survives for the report reason. See D6, which was respecced after the original deletion was
   shown to re-open a live hole and to go red on three committed PRD 03 tests.
3. The create-arm adoption block and the fill-in-link adoption collapse into `adoptOrphanHistory`,
   because the "did the canonical key flip" test that distinguished them is meaningless when nothing
   is keyed on the canonical key. **Note the post-03 shape:** the fill-in-link adoption is now a LOOP
   over `claimed` anonymous keys (multi-device), so the collapse is per-claimed-key, not a single
   call. This is the deletion that removes the class of bug #621 existed to fix.
4. `anonAliasAlreadyHeld` — already gone; PRD 03 deleted it (D7, closed).
5. `mergedKeys` / `mergedIdentifiedKeys` — **kept** (D3).
6. `contactKeySql()` — **not deleted** (rescoped, R3). It has 15 in-scope consumers across 5 files
   (`bucket-access.ts` ×4, `check-membership.ts` ×1, `bucket-backfill.ts` ×4, `bucket-reconcile.ts`
   ×5, `send-campaign.ts` ×1) — all in files T5 flips, so verify each is gone after T5 rather than
   assuming four — plus 4 permanent calls in PRD 04's `backfill-contact-id.ts`, which keys on
   strings by design. The helper survives with that single consumer; it dies with PRD 07, not here.

**Tested by:** one commit per deletion so a bisect names the culprit, with
`contacts-no-create.test.ts` AND `contacts-many-keys.test.ts` green throughout. Mutation proof for
the adoption-gating removal: with the string rewrites gone, the attach tests
(`contacts-many-keys.test.ts:148`, `:191`, `:470`) and the adoption tests
(`contacts-no-create.test.ts:584`, `:642`) must all still pass; then temporarily remove the
`contact_id IS NULL` predicate and confirm the adoption pair goes red. If they stay green the tests
are vacuous and must be strengthened before the deletion ships.

### T10 — tail: seeds, smoke, docs strings
_Boundary:_ `packages/db` + `apps/api` + `apps/docs` · _Depends:_ T9

`packages/db/src/demo-seed.ts:659,662,665,668` (the `like(…, "demo_%")` cleanup predicates — these must
KEEP matching on `user_id`, since the seed's whole identity model is the `demo_` string prefix; confirm
rather than flip) · `apps/api/scripts/smoke.ts:161,181` · the three documentation strings in
`apps/docs/app/(home)/recipes/_data/`.

**Cost: small**, but easy to forget entirely — the docs strings are invisible to every gate.

**Tested by:** run the seed and the smoke script for real (`skills/verify`), not just type-check.

### T11 — changeset
_Boundary:_ `.changeset` · _Depends:_ T9

Public API changes: `bySubject` exported, `evaluateCondition` context gains `contactId` (T4),
`resolveOrCreateContact`'s adoption semantics change shape. Needs `pnpm changeset:engine-line`.

## Risks / how this can go wrong

1. **Contactless journeys read nothing.** The failure mode of ignoring D2. Silent: a journey runs, its
   history checks return empty, it sends a duplicate email. Caught only by a test that enrolls a
   subject with no contact. Highest-probability defect in this PRD.
2. **The 29 raw-SQL sites compile and lie.** A flipped `js.user_id` → `js.contact_id` on a query whose
   join partner still holds a text key returns zero rows and renders "0 enrollments" in Studio. No gate
   catches this. Mitigation: every raw-SQL test asserts non-zero.
3. **Missing indexes on `contact_id` turn a 5ms read into a table scan.** `user_events` is the largest
   table (`user_events_user_id_idx`, `user-events.ts:57`). PRD 04 must have shipped the mirror indexes;
   verify with `EXPLAIN` on the flipped hot reads (`enrollment-guards.ts:17`,
   `check-membership.ts:223`) before merging T4/T5, not after.
4. **T3's preflight finds production duplicates.** Then T3 grows a data-repair step and a human
   decision. This is the one task whose cost cannot be bounded from the local database.
5. **D8 preservation is forgotten at one of eleven sites** → a bucket count silently changes and the
   PR is blamed for a metrics jump. Mitigation: a single test asserting a before/after count parity on a
   fixture containing an email-only contact.
6. **`preferences.ts:104`'s ON CONFLICT arbiter is flipped without the index existing.** The upsert
   throws 42P10 at runtime, not compile time. T3 must land before T6, and the arbiter change must be in
   the same commit as its index.
7. **A flip lands before T2** → history is lost for anyone mid-anon-to-identified. Enforced by task
   ordering; a reviewer should reject any read flip whose branch does not contain T2.
8. **Two flips in one PR.** Each batch must be its own PR against `feat/identity-model`; a combined
   revert loses the good half.

## Rollback

Every read flip is a pure revert. That is true only because `user_id` continues to be written on every
insert through this entire PRD (D9) and the old unique indexes are retained (D5) — nothing here makes
the string key stale, so a reverted binary reads exactly what it wrote.

- **T4-T8 (any read batch):** `git revert` the batch commit and redeploy. No data step. The
  `contact_id` values written meanwhile are simply unread.
- **T3 (indexes):** `DROP INDEX CONCURRENTLY uq_contact_journey_active` (and the two others). The
  `user_id` indexes still enforce the old invariant, so uniqueness is never unprotected.
- **T2 (adoption stamp):** additive and idempotent; leaving it in place is harmless. If it must go,
  revert the code — the stamped `contact_id` values remain and are correct.
- **T9 (deletions):** the only irreversible-feeling step, and it is not: reverting restores the
  `user_id` rewrites, which then re-run on the next identify and re-converge the key. The window of
  risk is contacts who identified between deploy and revert; their rows carry `contact_id` and a stale
  `user_id`, which the restored `repointOwnHistory` fixes on their next resolve. Note in the PR that a
  T9 revert should be followed by the T2-era backfill script.
- **Full PRD abandon:** revert T1-T9 in reverse order. `contact_id` columns stay (PRD 04's), unread.

## Done when

- All 131 drizzle sites and all 29 raw-SQL sites are either flipped or explicitly documented as
  deliberately still on `user_id` (D9's write targets, `demo-seed.ts`, `cohort-sql.ts:166`,
  `backfill-contact-id.ts`).
- `grep -rn "\.userId" packages/engine/src/lib/enrollment-guards.ts packages/engine/src/buckets/`
  returns only write sites.
- The full gate set from DECISIONS §5 is green, including
  `cd apps/api && HOGSEND_TEST_DATABASE_URL=…/prd06_test pnpm exec vitest run`.
- `contacts-no-create.test.ts` is green in full, with the mechanism assertions rewritten per the table
  below and the outcome assertions untouched.
- `EXPLAIN` on the four hottest flipped reads shows an index scan.
- The T3 preflight returns zero rows against production.

### Which `contacts-no-create.test.ts` tests survive, and in what form

**Must stay green, unchanged — these pin outcomes and are the primary evidence the flip was safe:**

| Test | Line | Why it survives |
| --- | --- | --- |
| `refuses an unseen anonymousId: id null, no contacts row (D1)` | `:146` | Refusal is untouched by this PRD |
| `throws when the highest-precedence supplied key is email (D8)` | `:163` | ditto |
| `throws when the highest-precedence supplied key is discordId (D8)` | `:175` | ditto |
| `accepts email alongside a higher-precedence userId` | `:186` | ditto |
| `leaves resolveOrCreateContact creating on a miss` | `:253` | ditto |
| `refuses to adopt history keyed on another live contact (fill-in-link arm)` | `:584` | **Half the D6 gate.** Green after the ADOPTION-gating role is removed = the NULL predicate really subsumes that half. It says nothing about attach — pair it with `contacts-many-keys.test.ts:148/:191/:470`, which pin the half that survives (D6, C1) |
| `refuses the same theft on the create arm` | `:642` | Same, for the other arm |
| `claims a second device's anon id ONCE, not on every resolve` | `:666` | **The D7 gate** |
| `does not repoint when the anon id IS the new canonical key` | `:384` | Still meaningful: nothing to adopt when the key is already canonical |

**Become mechanism tests and must be rewritten (not deleted) to assert `contact_id`:**

| Test | Line | What changes |
| --- | --- | --- |
| `repoints anon-keyed history onto the new canonical key and reports it in mergedKeys` | `:270` | The five "zero rows under `A`, one row under `U`" blocks (`:319-380`) stop being the contract, because rows no longer move. Replace each with "row's `contact_id` equals the new contact id". The `mergedKeys` assertion at `:318` **stays** (D3) |
| `adopts anon-keyed history when the anon id is attached WITHOUT a key flip` | `:416` | Same rewrite; the scenario (docs sign-in order) stays exactly as valuable |
| `claims a second device's anon id as an alias and adopts its history` | `:507` | Same rewrite |
| `fill-in-links a single existing contact exactly as the creating sibling does` | `:198` | `mergedKeys` assertions stay; any residual-row assertions move to `contact_id` |
| `collide-MERGEs two existing contacts exactly as the creating sibling does` | `:225` | Same |

**Becomes meaningless:** nothing, outright. Every test in this file survives in some form — which is
the point of DECISIONS §4's "behaviour tests are the contract". Any test that CAN be deleted here is
evidence the flip changed behaviour, and that is a stop-the-line signal, not a cleanup.

## Implementation Notes

Shipped 2026-07-29 on `feat/identity-flip-reads` (T1–T3 landed earlier as PR #634).
One commit per batch: T4 `421e5ec1`, T6 `a22b0f74`, T8 `d9808de3`, T7 `c4cb1e81`,
T5 `d778a7b5`, T9 `61746366`. Full suite 2422 green on the private `prd05_test` DB.

Deviations from spec, all documented in the code:

- **T6 arbiter (`preferences.ts`):** the upsert arbiter deliberately STAYS on
  `(user_id, email)` with a catch-and-convert for the contact-scoped 23505 —
  T3 settled this after the PRD was written; the PRD's "move the arbiter" line
  is superseded.
- **`send-campaign.ts` opt-in list scan (T6's `:1064`):** annotated as a D9
  recipient-key echo, not flipped — the scan is population-wide, there is no
  subject to scope by, and the contact retains every key it ever held so the
  per-send resolve still finds the owner.
- **T5 D8 hold:** the backfill selectors keep `isNotNull(contacts.externalId)`
  so the historically external-only matcher cohort does not silently widen.
  Widening it is a real fix but a separate, observable change (OPEN ITEM).
- **T9 mutation proof:** removing the `contact_id IS NULL` predicate turns the
  CREATE-arm theft test red; the fill-in-link arm stays green because its
  guard is the claim refusal (pinned by `contacts-many-keys.test.ts:148/:191/
  :470`). Each arm has exactly one guard and each guard has a pinning test —
  the PRD's "adoption pair goes red" assumed one shared guard.
- **T10:** `demo-seed.ts` cleanup predicates confirmed staying on `user_id`
  (the `demo_` prefix IS the seed's identity model). `smoke.ts` reads by the
  same key it wrote seconds earlier in the same run — self-consistent forever,
  left unchanged. The two repo docs that described the rewrite (CLAUDE.md,
  `docs/posthog-identity-stitching.md`) now describe the stamp.
- **Deferred to a later change:** widening the D8 cohort;
  `mergeContacts`' loser folds keep their rewrite shape (in scope for the
  PRD 07 string-machinery retirement, per D3/D6); `contactKeySql()` survives
  as a contacts-table resolver + the backfill's tool and dies with PRD 07.
