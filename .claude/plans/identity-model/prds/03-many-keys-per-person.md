# PRD 03 — Many keys per person

## Goal

`contacts` holds **one slot per identity kind** (`external_id`, `email`, `anonymous_id`,
`discord_id`). A second value for a kind has nowhere to go, so it is silently dropped — and a later
resolve on that dropped value mints a duplicate person. #621 patched exactly one instance of this
(the second **anonymous** id, via a `contact_aliases` row) and left the shape of the fix welded to
that one case: a bifurcated `if column free / else alias` branch, a bespoke idempotence probe, and a
claim path whose security gate fires on only one of its two arms. This PRD turns "the column is
taken" into a non-event: **every** supplied key that the columns cannot hold becomes an identity
row, on the fill-in-link arm and the merge arm, through one uniform claim path. It is pure engine
code — `contact_aliases` is already `unique(alias_kind, alias_value)`, never `(contact_id,
alias_kind)` (`packages/db/src/schema/contact-aliases.ts:35-38`), so many rows per person per kind
are already legal and **no migration is required**.

## Locked decisions

### What this PRD DELETES

1. **The `if (ctx.anonymousId && !row.anonymousId) … else if (…)` bifurcation**
   (`packages/engine/src/lib/contacts.ts:1078-1099`). Two arms exist only because the column can
   hold one value. They collapse into one claim step: write the column *if it happens to be free*
   (legacy dual-write, retired in PRD 07), and record the identity row **always**.
2. **`anonAliasAlreadyHeld`** (`contacts.ts:139-156`, sole call site `contacts.ts:1095`). Its job is
   "is this a first claim?", which the identity insert can answer for free:
   `.onConflictDoNothing({ target: [aliasKind, aliasValue] }).returning()` returns a row **iff** this
   call was the first to claim `(kind, value)`. That deletes a SELECT from the hottest path in the
   system (every repeat page view from a known device) and makes idempotence structural instead of
   remembered.
   - Behaviour delta, deliberate: today `anonAliasAlreadyHeld` filters on `contactId`, so a value
     already claimed by **another** contact reads as "not held" and falls through to the adoption
     gate. Under `returning()` it reads as "not a first claim" and is skipped outright. Skipping is
     strictly safer, and unreachable in practice — with PRD 02 landed, an identity row owned by
     another contact resolves in `findByKey` and produces a second candidate, i.e. the merge arm,
     not fill-in-link.
3. **`claimedAnonymousId` as a single `let`** (`contacts.ts:1077`, assigned at 1084 and 1098). It
   becomes a `claimed: ResolveKey[]` array — one entry per key this call actually claimed — because
   the point of this PRD is that there can be more than one.
4. **The "the column keeps the FIRST device's id" comment block** (`contacts.ts:1090-1095`) and the
   `contacts.anonymous_id`-shaped reasoning in the second-device comment (`contacts.ts:1159-1162`).
   The behaviour they describe survives; the framing ("the column is the real slot, the alias is the
   consolation prize") is what this PRD removes.

### What this PRD MUST NOT delete

1. **`keysAnotherContact` (`contacts.ts:106-136`) stays, unchanged, and gains call sites.** It is
   the **security** guard against history theft: resolution probes only the *anonymous* namespace,
   so "no contact resolved by this value" does not mean "nobody owns this value" — it may be another
   live contact's `external_id`, or the row uuid of a contact with neither key
   (`contacts.ts:123-126`). While history is keyed by the derived string
   `contactKey = external_id ?? anonymous_id ?? id` (`contacts.ts:557-559`), moving rows by string
   match is a theft primitive, and this function is the only thing standing in front of it — the
   publishable clamp does **not** fire on the shapes that reach adoption (`restrictToAnonymous`
   requires `!userId`, `contacts.ts:695-700`). It becomes safe to delete only in **PRD 05**, when
   history is keyed by `contact_id` and there is nothing a string can name. Its two current call
   sites (`contacts.ts:811` create arm, `contacts.ts:1070` fill-in-link) both stay.
   Pinned by `apps/api/src/__tests__/contacts-no-create.test.ts:583-664`.
2. **`repointOwnHistory` (`contacts.ts:1755-1785`) stays**, with all three call sites
   (`contacts.ts:813`, `1133`, `1177`, plus the merge-arm survivor flip at `1426`). PRD 05 deletes
   it.
3. **The `contacts.*_id` column writes stay** (dual-write). PRD 07 retires the columns; writing them
   is what keeps every column-only reader (inventory below) working through this PRD.
4. **The create arm's adoption block (`contacts.ts:806-820`) stays as-is.** The create arm writes no
   aliases today — that is PRD 02's dual-write to add, not this PRD's.
5. **`PublishableAnonymousMergeError` and both clamp sites (`contacts.ts:840-842`, `869-871`) stay
   untouched.**

### Scope decisions

- **Adoption stays anonymous-only.** Claiming a key adds a resolution edge; adopting one **moves
  rows**. This PRD widens claiming to all four kinds and widens adoption to nothing. A newly claimed
  `external` key's string-keyed history is *not* repointed here — and it does not need to be: PRD
  04's backfill maps `user_events.user_id → contact_id` **through the identity table**, so the row
  this PRD writes is precisely the datum that reunites those rows, with no physical rewrite and no
  new theft surface. Claiming without adopting is therefore not a half-measure; it is the cheaper
  and safer half, and PRD 04 completes it.
- **`email` and `discord` claims need no `keysAnotherContact` gate.** Neither is ever a canonical
  key (`contactKey` = `external_id ?? anonymous_id ?? id`), so neither ever keyed history, so there
  is nothing to steal. `external` and `anonymous` claims are gated.
- **A refused claim is silent + logged, never an exception.** Throwing would 500 an ingest that
  looks legitimate to its caller. One `logger.warn("identity.claim.refused_foreign_key")` with
  `{ kind, contactId }` — never the value, which is another person's identifier.
- **No new table, no migration, no `@hogsend/db` change.** Verified: the only unique index on
  `contact_aliases` is `(alias_kind, alias_value)`.

### The security gap this PRD closes (found while reading, not previously known)

`keysAnotherContact` gates the *else* arm's claim (`contacts.ts:1089`) but **not** the *if* arm's
(`contacts.ts:1078-1084`, whose comment at 1079-1080 asserts "column write + alias … stay
unconditional"). So a contact with `anonymous_id IS NULL` — the shape the docs server-side fold
produces, a row born carrying only `external_id` + `email` — can have **another live contact's
canonical key** written into its `anonymous_id` column *and* aliased to it:

```
victim   = resolveOrCreateContact({ userId: V })            // canonical key = V
attacker = resolveOrCreateContact({ userId: A, email: E })  // anonymous_id IS NULL
           resolveOrCreateContact({ userId: A, anonymousId: V })
           → findByKey('anonymous', V) misses (V sits in victim's external_id column)
           → one candidate (attacker) → fillInLink → if-arm → set.anonymousId = V
                                                          → alias ('anonymous', V) → attacker
```

Adoption is still blocked (`foreignAnonKey`), so **no rows move today** — which is why
`contacts-no-create.test.ts:584` passes: its attacker already holds an `anonymous_id`, so the *else*
arm runs and the gate fires. The if-arm is untested.

It becomes a **history-theft escalation the moment PRD 04 lands**: that backfill resolves history
strings to `contact_id` via the identity table, so `('anonymous', V) → attacker` hands the victim's
`user_events` to the attacker in bulk, with no repoint and no gate in sight. Closing it is therefore
a precondition of PRD 04, and it belongs here because this PRD is the one that touches the claim
path.

The same class exists one line up. `if (ctx.userId && !row.externalId)` (`contacts.ts:1045-1049`) is
also ungated, and it is *worse*: attaching an `external_id` **flips the canonical key**, so
`repointOwnHistory(oldKey → newKey)` at `contacts.ts:1133` moves the claimant's history **into** a
string another live contact is already keyed on (a contact whose canonical key is its
`anonymous_id`, which `findByKey('external', …)` never probes). Two people's rows then share one
`user_id` string. Both arms get the same gate.

## EARS acceptance criteria

- **WHEN** an identify supplies an `anonymousId` for a contact whose `anonymous_id` column is
  already held by a different value, the system **SHALL** record the new value as an identity row,
  adopt its orphaned history, resolve it to the same contact on a later lookup, and mint no second
  contact.
- **WHEN** an identify supplies an `email` / `external` / `discord` value for a contact whose
  corresponding column is already occupied by a different value, the system **SHALL** record the
  supplied value as an identity row for that contact and **SHALL NOT** overwrite the column.
- **WHEN** a later resolve supplies only that second value, the system **SHALL** resolve it to the
  same contact and **SHALL NOT** create a new one.
- **WHEN** the same second value is supplied again on a subsequent resolve, the system **SHALL NOT**
  re-report it in `mergedKeys`, **SHALL NOT** re-run a history repoint, and **SHALL** leave exactly
  one `contact_aliases` row for that `(kind, value)`.
- **WHEN** a supplied `anonymousId` or `userId` is already the canonical key of a **different** live
  contact, the system **SHALL NOT** write it to a column, **SHALL NOT** record an identity row for
  it, **SHALL NOT** move any history, and **SHALL NOT** report it in `mergedKeys` — on the if-arm
  and the else-arm alike.
- **WHEN** a collide-MERGE supplies an identity value the survivor's columns cannot hold, the system
  **SHALL** record it as an identity row on the survivor rather than dropping it.
- **WHEN** the feed resolves a publishable anonymous recipient whose anon id is held as an identity
  row rather than in the column, the system **SHALL** resolve the owning contact and thread it as
  provenance, instead of treating the recipient as having no contact.
- **WHEN** any of the above runs, `resolveOrCreateContact`'s published result type **SHALL** be
  unchanged.

## Tasks

Ordering is deliberate: the security gate lands **first**, as its own commit, so the refactor that
follows inherits one consistent rule rather than porting an inconsistency (DECISIONS §4: a revealed
bug is not bundled into another step).

### T1 — gate every canonical-capable claim on `keysAnotherContact`
_Boundary:_ `packages/engine` · _Depends:_ PRD 02

Extend the existing gate to the two ungated attach sites: the `external_id` fill
(`contacts.ts:1045-1049`) and the if-arm `anonymous_id` fill (`contacts.ts:1078-1084`). Hoist the
`foreignAnonKey` probe (`contacts.ts:1067-1070`) into a small `claimsAnotherContact(kind, value)`
helper over the same `keysAnotherContact`, memoised per value so the hot path still issues at most
one query per supplied key. A refused claim skips the column write, the alias, the adoption and the
`mergedKeys` report, and logs `identity.claim.refused_foreign_key`.

_Cost: small (≈40 lines), but it is the highest-risk task in the PRD because it changes what an
existing, reachable code path does._

**Tested by** a new `apps/api/src/__tests__/contacts-many-keys.test.ts`, written RED first, with two
cases mirroring `contacts-no-create.test.ts:584` but arranged so the **if**-arm runs (attacker
contact created with `{ userId, email }` and no `anonymousId`):
1. victim's `external_id` named as the attacker's `anonymousId` → attacker's
   `contacts.anonymous_id` stays NULL, no `('anonymous', V)` row in `contact_aliases`, victim's
   `user_events` unmoved, `mergedKeys` excludes V.
2. a contact whose canonical key is its `anonymous_id` (`{ anonymousId: W }`, no `external_id`); a
   second contact resolves `{ email: E2, userId: W }` → `external_id` not written, no
   `('external', W)` alias, and **zero** `user_events` rows move between the two `user_id` strings.

Mutation check: reverting only the if-arm gate must fail case 1; reverting only the external gate
must fail case 2.

### T2 — one uniform claim path in `fillInLink`
_Boundary:_ `packages/engine` · _Depends:_ T1

Replace `contacts.ts:1034` (`promoted`), `1045-1099` (the four per-kind attach branches) and
`1183-1196` (the trailing alias loop) with a single ordered pass over the supplied keys:

```
for each supplied (kind, value) not already equal to the row's column value:
  if (kind is 'external' | 'anonymous') and claimsAnotherContact(value) → skip + warn
  if the column for `kind` is free → set it (legacy dual-write)
  insert contact_aliases (kind, value, reason 'promote')
      .onConflictDoNothing({ target: [aliasKind, aliasValue] }).returning()
  if a row came back → claimed.push({ kind, value })
```

The insert **moves before** the adoption block (it currently runs after it, at
`contacts.ts:1183`) — same transaction, so nothing observable changes, but its `returning()` is now
the first-claim signal that adoption reads. Adoption (`contacts.ts:1171-1181`) then iterates
`claimed.filter(k => k.kind === 'anonymous')`, keeping both existing exclusions (`!== newKey`,
`!== oldKey`) and appending to `mergedKeys` as it does today. Delete `anonAliasAlreadyHeld`.

This task changes **no** externally observable behaviour for `anonymous` — it is a shape change that
makes the other three kinds fall out for free in T3.

_Cost: medium. `fillInLink` is 180 lines of dense, comment-heavy, security-relevant code and the
rewrite touches most of it. The comments are load-bearing documentation of past incidents and must
be carried forward, not dropped._

**Tested by** the existing suite alone — this is the task whose evidence is that nothing broke.
Must stay green with **zero** edits: `contacts-no-create.test.ts` `describe`s at lines 269, 415,
506, 583 (including the idempotence case at 666), and `identity-merge.test.ts` at lines 339, 619,
674, 715. Any test edit needed here is a signal the refactor changed behaviour and must be raised,
not accommodated.

### T3 — claim `email`, `external` and `discord` second values
_Boundary:_ `packages/engine` · _Depends:_ T2

With T2's loop in place this is the removal of three `!row.<column>` preconditions from the claim
decision (they survive as the *column-write* precondition only). No adoption is added for any of
them.

**Tested by** three cases in `contacts-many-keys.test.ts`:
1. `{ userId: U, email: E1 }` then `{ userId: U, email: E2 }` → `contacts.email` still `E1`, an
   `('email', E2)` row exists for that contact, and a later `{ email: E2 }` resolve returns the same
   `id` with `created: false`. Also assert `resolveRecipient({ userId: U }).email === E1` — the
   send target must not drift to the second address.
2. same shape for `discordId`.
3. `{ email: E, userId: U1 }` then `{ email: E, userId: U2 }` (with `U2` owned by nobody) →
   `contacts.external_id` still `U1`, `('external', U2)` row exists, later `{ userId: U2 }` resolves
   to the same contact, and — asserted explicitly, because it is the deliberate limit of this PRD —
   `user_events` keyed on `U2` are **still** keyed on `U2` (PRD 04 reunites them).

### T4 — the merge arm claims supplied keys the survivor cannot hold
_Boundary:_ `packages/engine` · _Depends:_ T2

`mergeContacts` has the same drop at `contacts.ts:1342-1366`: each `if (!survivor.<column>)` block
picks one value from `ctx.<key> ?? <first loser holding one>` and discards the rest. Loser-held keys
already survive as identity rows via `recordMergeAliases` (`contacts.ts:1788-1872`), so the only
real gap is the **call-supplied** key when the survivor's column is already occupied. Route it through
T2's claim helper after the survivor update (`contacts.ts:1400-1403`) and after the loser
soft-delete (`contacts.ts:1390-1398`), so the partial-unique live indexes are already free.

_Cost: small, but it must land after the soft-delete for the same index reason documented at
`contacts.ts:1387-1389`; getting the order wrong self-collides._

**Tested by** a case in `contacts-many-keys.test.ts`: two contacts that collide on `anonymousId`,
resolved with a `userId` neither holds and an `email` the survivor already has a different value
for → survivor keeps its `email` column, an identity row exists for the supplied one, and both
resolve back to the survivor. Existing merge tests (`identity-merge.test.ts:384`, `545`, `715`,
`914`) must stay green unedited.

### T5 — the feed's anonymous recipient resolves through identity rows
_Boundary:_ `packages/engine` · _Depends:_ T2

`resolveFeedRecipient` (`packages/engine/src/routes/feed/recipient.ts:128-148`) finds the anon
contact **only** via `eq(contacts.anonymousId, params.anonymousId)`. A second device whose id lives
in an identity row therefore returns `contactId: undefined` and forces `allowCreate: false`
(`recipient.ts:147`), so that device's feed reads under its own raw anon key — which adoption has
already repointed away — and shows empty. This is live on `main` since #621; this PRD makes it the
common case, so it is fixed here. Add the `contact_aliases` fallback (the same two-step
`resolveViaAlias` shape already at `contacts.ts:2066-2089`).

**Tested by** an integration case: claim a second anon id via `resolveOrCreateContact`, then call
the feed recipient resolution with that id and assert a `contactId` comes back and `allowCreate` is
not forced off.

### T6 — changeset + doc line
_Boundary:_ `.changeset` + `docs` · _Depends:_ T1-T5

One `patch`/`minor` changeset for `@hogsend/engine` plus `pnpm changeset:engine-line` (DECISIONS
§6). It must name the security tightening in T1 explicitly — an operator whose ingest legitimately
supplies a `userId` that is some other contact's canonical key will see claims start being refused,
and needs the log line's name to find them. Add a short "a person may hold many keys per kind"
paragraph to `docs/posthog-identity-stitching.md`.

## Risks / how this can go wrong

- **T1 refuses a legitimate claim.** `keysAnotherContact` also matches `contacts.id` for
  uuid-shaped values (`contacts.ts:126`), and browser anon ids *are* uuid-shaped, so a value that
  equals some contact's row uuid is refused. That requires a uuid collision — but a **synthetic**
  id (an import that set `external_id` to a value another system uses as an anon id) can trip it for
  real. Mitigation: the warn log names the kind and the contact id, so it is greppable; and the
  refusal is a no-op, never an error, so the ingest still stores.
- **T2 silently loses a behaviour the comments encode.** `fillInLink`'s comment blocks document
  three separate past incidents (the docs sign-in order, the second-device drop, the re-stitch
  storm). The mitigation is the "zero test edits" rule on T2 — the #621 behaviour tests are the
  contract (DECISIONS §4), and this is exactly the step they were written for.
- **T3 widens who a key resolves to.** Claiming `('email', E2)` means anyone who can assert `E2` on
  a resolve steers future `E2` traffic to this contact. That is *already* true of the column write
  it generalises, and the trust question — who may assert which kind — is PRD 06's whole subject.
  Do not attempt a trust rule here; it would collide with PRD 06.
- **Publishable 403s on a stale anon id.** Once a second anon id is an identity row on an
  **identified** contact, an anon-only `pk_` write carrying that id resolves to a contact with an
  `external_id` and throws `PublishableAnonymousMergeError` (`contacts.ts:840-842`) → 403. Verified
  mitigation: `@hogsend/js` `reset()` mints a **fresh** anon id (`packages/js/src/identity/
  identity-store.ts:121-131`), so a logout does not reuse a claimed id. Residual: an app that clears
  its own session without calling `hogsend.reset()`. Pre-existing since #621, not introduced here.
- **Column-only readers stay blind to second keys.** Inventory, all reading `contacts.anonymous_id`
  directly rather than through `findByKey`: `lib/connector-actions.ts:102`, `lib/refine.ts:247`,
  `journeys/execute-journey-run.ts:416`, `routes/admin/events.ts:80,87`,
  `routes/admin/targeting.ts:214`, `routes/admin/contacts.ts:364`, `lib/crm-ingest.ts:77`. They are
  **not** regressed by this PRD (today the second key does not exist at all), but they become
  knowably incomplete. Left to PRD 02 (source of truth) / PRD 07 (column retirement) rather than
  fixed here, because fixing them is a read-path flip and this PRD is a write-path change — mixing
  them breaks the additive-then-flip rule. Only `routes/feed/recipient.ts` is fixed here (T5),
  because there it produces a user-visible empty feed.
- **Concurrency.** Two devices identifying at once for the same person serialize on the
  `pg_advisory_xact_lock` per key (`contacts.ts:734-739`), and the claim insert is
  `onConflictDoNothing` on the unique index, so the loser of a race records nothing and reports
  nothing rather than throwing. No new lock is introduced.

## Rollback

Pure engine code — no migration, no schema change, so rollback is `git revert` of the PRD's commits
and a patch release. The identity rows written while it was live are **left in place** and are
harmless: `contact_aliases` rows are read by `findByKey`'s pre-existing alias fallback
(`contacts.ts:319-338`), so an extra `('email', E2) → contact` row behaves exactly like a
post-merge alias, which the reverted code already understands. Nothing needs cleaning.

Per-task rollback is independent: T1 alone can be reverted (re-opening the gap, which is inert until
PRD 04 lands), and T5 alone can be reverted. T3/T4 reverting after T2 is fine; reverting T2 while
keeping T3 is not — revert them together.

## Done when

- All six tasks land, each as its own commit.
- `apps/api/src/__tests__/contacts-many-keys.test.ts` exists and covers every EARS clause above.
- `contacts-no-create.test.ts` and `identity-merge.test.ts` pass **with no edits** — that is the
  evidence T2 was a refactor.
- `keysAnotherContact` and `repointOwnHistory` are still present and still called; a grep proving so
  is part of the PR description, because deleting them is the single most tempting and most
  dangerous simplification available in this file, and it is PRD 05's to make.
- `anonAliasAlreadyHeld` is gone and no caller remains.
- Gates, verbatim (DECISIONS §5):

```
pnpm lint
pnpm exec turbo run check-types --concurrency=2
cd apps/api && HOGSEND_TEST_DATABASE_URL=postgresql://growthhog:growthhog@localhost:5434/ghost_clean pnpm exec vitest run
cd packages/engine && pnpm test
```

## Implementation Notes

Shipped `47ad0239`. Changeset `many-keys-per-person`. Tests: `contacts-many-keys.test.ts` (10).
Full suite at completion: **2078 passed / 0 failed** on a dedicated `ident_test` database.

**`fillInLink` now plans and executes rather than deciding per key.** The supplied keys are ordered
once, and a single executor — `claimIdentityKey(tx, row, key, foreignMemo)` returning
`"refused" | "claimed" | "held"` — gates, records and classifies each one. The merge arm calls the
**same** executor for keys the survivor's columns could not hold. That is the point: the gate cannot
diverge between arms again, and arm divergence is exactly how the earlier theft hole shipped (a
guard applied on adoption and not on claim).

**The security gate widened rather than relaxed.** Claiming any `external` or `anonymous` key is now
refused when the value is another live contact's canonical key — previously enforced on adoption
only. That closes the arm where a victim's anonymous-canonical key, named as a `userId`, was
invisible to the external probes and would have flipped the caller's canonical key onto the victim's
string. Refusal is silent to the caller and logged without the value.

**First-claim detection is the unique index, not a probe.** The claim insert conflicts, returns
nothing, and re-fires nothing. A browser identifying on every page load re-reports no merge — the
re-stitch storm prevented structurally instead of remembered.

**The bell stops stranding a second device.** `routes/feed/recipient.ts` falls back to the identity
table, so a device held as an alias resolves to its contact with provenance instead of being refused
and left under a raw device id.

**Mutation gate.** Replacing the `claimIdentityKey` provenance gate condition with `if (false)` was
caught by **five named tests**. `repointOwnHistory` verified intact at all five call sites.

`repointOwnHistory`, `collidesWithIdentified` and the publishable clamps are deliberately untouched.
They stay until history is keyed by `contact_id` (PRD 04 → 05).
