# BACKLOG — identity model

Branch `feat/identity-model`, worktree `.claude/worktrees/identity-model`, branched from `main` at
`baa18a2a` (#621 merged). Each PRD is independently shippable; the schema ones are additive until
PRD 05, which is the commitment step.

| # | PRD | Status | Depends on | Scope |
| --- | --- | --- | --- | --- |
| 01 | [Anonymous-only is a display concern](prds/01-anonymous-display.md) | [x] | — | Studio contacts list filters people who have never identified, instead of the engine refusing to create them. The cheap answer to the original complaint |
| 02 | [Identity table becomes the source of truth](prds/02-identity-source-of-truth.md) | [x] | — | Backfill `contact_aliases` from the identity columns, dual-write on every resolve, `findByKey` reads it first. Additive, reversible |
| 03 | [Many keys per person](prds/03-many-keys-per-person.md) | [x] | 02 | A second/third anonymous id is just another row. Deletes the second-device special case and the "one slot" drop |
| 06 | [Trust is a property of the key](prds/06-trust-policy.md) | [ ] | 02 | `resolve(keys, { create, allowMerge, trustedKinds })`. Trust declared once by the route, not inferred from which arm ran. **Builds BEFORE 05** |
| 04 | [`contact_id` on history tables](prds/04-history-contact-id.md) | [ ] | 02, **03-T1** | Add nullable `contact_id` to the five string-keyed tables, backfill, dual-write. No reads change |
| 05 | [Flip history reads](prds/05-flip-history-reads.md) | [ ] | 04, 06 | The commitment step: ~159 call sites move to `contact_id`, then `repointOwnHistory`, the adoption arms and the provenance guard are deleted |
| 07 | [Demote the identity columns](prds/07-retire-columns.md) | [ ] | 03, 05, 06 | **Rescoped: demote, do not drop.** `NOT NULL` where provable, stop READING the columns for resolution, inventory every straggler. The `contact_key` freeze and the column DROP are cut |

## Legend

`[ ]` not started · `[~]` shipped to a seam, human ask outstanding · `[x]` done

## Plan-critique outcome (applied 2026-07-28)

A three-lens critique panel read the stack against the real code before any build started. Verdict:
*"the front half is safe to build; the back half needed corrections first."* Six confirmed findings,
all applied to the PRDs:

| # | Severity | PRD | What it would have caused |
| --- | --- | --- | --- |
| 1 | blocking | 07 | **Re-stitch storm.** Freezing `contact_key` while `newKey` stays live-derived makes `newKey !== oldKey` permanently true, re-firing `mergeAnalyticsIdentities` on every event forever. Fixed: flip-detection never reads the frozen column; added an explicit did-it-change test |
| 2 | blocking | 05 | **A census no grep can complete.** `ConditionContext` carries the subject as a bare `userId` string, so the blueprint interpreter, flags and agent tools are invisible to both censuses. Fixed: new T1b makes `contactId` a REQUIRED field so `check-types` enumerates callers |
| 3 | major | 01 ↔ 02 | **Phone-only contacts vanish.** PRD 01's swap-in predicate dropped the `phone` leg that PRD 02 deliberately excludes from the alias backfill. Fixed on both sides + pinned by mutation proof |
| 4 | major | 07 | **Three unowned readers of `anonymous_id`** while T8 drops the column — including `collidesWithIdentified`, a security boundary. Fixed: new T6b inventory task; the guard gets its own task and its own adversarial test |
| 5 | major | 02 | **Erasure leak.** The soft-delete filter keyed on `reason`, but `promote` rows carry `from_contact_id: null` and hold the person's own email, so erasure would have left it behind. Fixed: filter on `from_contact_id IS NULL` (structural, not a string match) |
| 6 | major | 05 | Adding a `(contact_id, journey_id)` index without moving the upsert's arbiter to it. Fixed: same-commit arbiter flip + a test that fails if it is missed |

Two of these (1 and 5) are the same failure shape as the bug that shipped in #621: a guard or
invariant expressed as a *derived string* rather than a structural fact. Worth remembering when
reviewing the rest of this stack.

## Senior advisory review (applied 2026-07-28, second pass)

A senior reviewer read the full stack plus all 2,149 lines of `lib/contacts.ts`. Verdict: *"the target
model is right, the sequence is mostly right, PRD 07 is mostly not worth building as specced."*
Five further findings, all applied:

| # | Severity | PRD | What it would have caused |
| --- | --- | --- | --- |
| F1 | **blocking** | 05 | **The arbiter flip breaks every anonymous visitor.** Postgres indexes are `NULLS DISTINCT`, so `(contact_id, journey_id)` does not constrain `contact_id IS NULL` rows — **verified empirically against the real DB**. A contactless re-trigger never fires `ON CONFLICT`, inserts a duplicate, and trips the retained `user_id` index as an unhandled 23505. The arbiter test as specced could not catch it (its fixture has a contact). Fixed: coalesce-arbiter or constraint-only, plus a contactless test written FIRST |
| F2 | major | 02 | **Erasure still leaked, after two attempts to fix it.** `from_contact_id IS NULL` spares ABSORBED rows — but `recordMergeAliases` writes the loser's email, and the loser is usually the same human. Fixed: delete every row for the contact, no predicate. Their retention rationale was void anyway (the alias probe requires `deleted_at IS NULL`) |
| F3 | major | 04 | Best-effort dual-write becomes **silent permanent data loss** post-flip: the backfill is one-shot, so a transient resolve failure leaves a row invisible to every contact-scoped read forever — on `email_preferences` that is mail to an unsubscribed person. Fixed: periodic reconcile sweep (already idempotent) + probe ALERTS rather than reports |
| F4 | major | 06 | The trust vocabulary cannot express *"never merge two identified persons"* — reachable today: two people on one browser without `reset()` merges two real humans. Not fixed here, but 06 now RESERVES the policy shape so the later fix is not a breaking change |
| F5 | minor | 05 | After the string rewrite dies, `<table>.user_id` silently changes meaning from "maintained canonical key" to "key as observed at write time". One schema comment per table |

**Sequencing corrections:** build **06 before 05** (06's 27-row call-site table is written against code
05-T9 deletes; 06-first is far cheaper). **04 now depends on 03-T1** — PRD 03 itself calls that gate a
precondition of 04, and the BACKLOG was missing the edge. And the two backfills contradicted each
other on posture (02 manual, 04 boot-enqueued) from the same DECISIONS clause; 02's is what 05's
correctness rests on, so both go boot-enqueued.

**PRD 07 rescoped from "drop" to "demote."** Dropping `anonymous_id` required freezing the canonical
key into a new column, which brings the re-stitch storm (finding #1 of the first pass), the
flag/holdout re-bucketing risk that PRD's own risk register rates highest, and a two-release drop
choreography. Worse, the freeze is itself a **behaviour change smuggled into a migration**: today a
person's flag bucket re-rolls when their key flips at identify; frozen-at-create means it never does.
That violates DECISIONS §4. Instead demote `anonymous_id` exactly as D3 already demotes `external_id`
— a denormalized mirror, never read for resolution. Cost: one dead column stays. Benefit: T2/T3/T5/T8
and the entire freeze apparatus are deleted.

**On "ship less":** the reviewer explicitly rejected stopping at 01 — it fixes the *complaint*, not
the *class*, and this codebase just shipped a security bug from that class. Stopping after 01+02+03
(~25% of cost) fixes every user-visible symptom but leaves string-keyed history, `repointOwnHistory`
and the theft guard in place — i.e. the generator of the whole #621 chain. There is no cheaper
partial flip: any read left on `user_id` breaks the moment the string rewrite stops.

## Sequencing note

01, 02 and 06 deliver standalone value without touching the 133 call sites. 04→05 is where the real
cost sits and is deliberately last-but-one, so the cheap wins are already banked and reviewable
before that risk is taken. If 05 proves larger than planned, everything before it still stands on
its own and 05 can be split per-table (each of the five is independent).

## Out of scope (decided)

- **Renaming `contact_aliases` to `contact_identities`.** Cosmetic; would touch every consumer for
  no behavioural gain. Revisit once the legacy columns are dropped (PRD 07).
- **Unwinding `allowCreate` / the #621 refusal sites.** Orthogonal and independently valuable — they
  bound row growth. PRD 01 makes them *unnecessary for the display problem*, not wrong.
- **Merging the `phone` key into the identity table.** SMS identity has its own open design
  (`contacts.phone` is not yet a merge-participating `Kind`); folding it in here would smuggle a
  behavioural change into a migration. Recorded as a §7 seam in DECISIONS.
- **Cleanup of existing anonymous-only rows.** Soft-delete only, separately approved (carried over
  from the ghost-contacts stack).
