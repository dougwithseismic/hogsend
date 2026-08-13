# PRD 04 — Merge + delete repointing (`@hogsend/engine`)

## Goal
Make contact merge carry `linked_accounts` with it, and make contact DELETION take them away. A
merge soft-deletes the loser contact, so the FK `ON DELETE cascade` never fires and a player's
proven platform link is silently stranded on a dead row: the survivor's panel shows nothing, the
reverse lookup answers with a soft-deleted contact, and the next callback for that platform account
sees a live link owned by a contact that no longer exists. Deletion has the mirror problem, and it
is worse: nothing in this repo hard-deletes a contact either, so a deleted or erased player keeps a
LIVE link forever, the pair stays permanently owned, and the player can never relink their own Steam
account. This PRD adds the repoint to the hand-maintained list in `lib/contacts.ts`, adds the delete
leg (DECISIONS §15.3), and resolves the singleton collision explicitly, without widening
`IdentityKind`.

**Depends on PRD 03**, not only PRD 02: both legs call PRD 03's tx-scoped store helpers
(`unlinkAccountInTx`, and the `unlinkAccountsForContactInTx` this PRD adds beside it), because
`contacts.ts` may never write `linked_accounts` directly. The BACKLOG dependency column understates
this.

## Locked decisions specific to this PRD

- DECISIONS §7: **contact merge must repoint `linked_accounts.contact_id`**, at the hand-maintained
  list at `lib/contacts.ts` ~1867-1936. Missing it silently strands a player's link on a
  soft-deleted contact. The merge leg carries the whole invariant.
- DECISIONS §7: **`adoptOrphanHistory` is a PROVEN NO-OP for links, not a second repoint site.**
  That path stamps rows matching `WHERE user_id = :fromKey AND contact_id IS NULL`
  (`lib/contacts.ts:2545-2574`), and the `contact_id IS NULL` predicate is its documented anti-theft
  guard (`:2529-2533`). `linked_accounts` has no `user_id` column and its `contact_id` is `NOT NULL`
  (PRD 02 T1), so nothing can ever match. Making it match would require a nullable `contact_id` plus
  a key column, which re-opens the orphan-key-awaiting-merge case §7 explicitly says does not exist
  for links. This PRD pins the no-op with tests and leaves a comment at the site.
- DECISIONS §7: **do NOT widen the `IdentityKind` union** (`lib/contacts.ts:516`). It is
  trust-enforced (`ResolvePolicy.trustedKinds` at `:562-570`, `UntrustedKeyKindError` at `:86-93`,
  `ALL_IDENTITY_KINDS` at `:576-581`) and widening it to N dynamic provider kinds is a
  merge-semantics project, not a feature. A link row is only ever created from a callback where
  the contact is already bound, so there is no orphan-key-awaiting-merge case. Provider lookups
  stay a direct query outside the resolver, exactly as `phone` does today (documented at
  `lib/contacts.ts:510-514`).
- Versioning is owned by PRD 03. This PRD does not compute a version, does not hand-roll SQL that
  bumps one, and does not open its own transaction: it calls a tx-scoped helper PRD 03 exports.
- Outbound event emission is PRD 08. This PRD makes the merge and the delete legs RETURN the facts
  of any link mutation they performed; it does not emit. PRD 08 adds the emit at both sites from
  those facts, post-commit.
- **DECISIONS §15.3: contact deletion soft-unlinks every live link.** Inside the SAME transaction as
  `softDeleteContact` (`lib/contacts.ts:2873`) and the admin delete route
  (`routes/admin/contacts.ts:651-671`), and the token blob is HARD-deleted rather than left sealed
  on a historical row. On erasure the personal display fields are nulled too. See T6.

## The exact sites

**Site 1 — the uuid FK repoint block, `packages/engine/src/lib/contacts.ts:1867-1936.** The
`linked_accounts` repoint belongs here, immediately after `foldGroupMemberships` at `:1936` and
before `recordMergeAliases` at `:1939`. Current code, verbatim:

```ts
    // (vi-c) group_memberships FOLD: another contact_id uuid FK the key
    // rewrites never touch. The loser is SOFT-deleted, so `onDelete: cascade`
    // never fires — without this the loser's memberships are stranded on a dead
    // row (the survivor's drawer shows "no groups", and the group's member
    // count/list disagree). uq(group_id, contact_id) forbids a blind rewrite
    // when BOTH already belong to the same group, so fold-then-rewrite.
    await foldGroupMemberships(tx, survivor.id, loser.id);

    // (ix) RECORD aliases for each loser key → survivor.
    await recordMergeAliases(tx, survivor.id, loser);
```

`foldGroupMemberships` (`contacts.ts:2366-2393`) is the shape to imitate: read the survivor's
occupancy, resolve the collisions, then rewrite the rest. Note the reason the plain repoints at
`:1909-1928` are allowed to be blind UPDATEs is documented at `:1886-1894`: the folds ran FIRST and
already removed every row that would collide inside a contact-scoped unique index. The
`linked_accounts` step is a fold, not a blind UPDATE, for exactly that reason.

**Site 2 — `adoptOrphanHistory`, `packages/engine/src/lib/contacts.ts:2545-2574**, called at
`:2112`. This site needs a COMMENT, not a statement. Per DECISIONS §7 the adopt leg is a proven
no-op for links: the function stamps rows matching `WHERE user_id = :fromKey AND contact_id IS NULL`
and `linked_accounts` has neither a `user_id` column nor a nullable `contact_id`, so a statement
added here could only ever match zero rows. T3 pins that with tests and documents it in place.

**Site 3 — contact deletion, two entry points.** `softDeleteContact`
(`packages/engine/src/lib/contacts.ts:2873`) sets `deletedAt` and touches nothing else; it is what
`DELETE /v1/contacts` calls (`routes/contacts/index.ts:285`). The admin delete route
(`packages/engine/src/routes/admin/contacts.ts:651-671`) soft-deletes AND calls
`deleteIdentityAliasesForContact` in one transaction, which makes it the erasure hook. Both need the
link unlink, and it belongs inside their existing transactions. T5 owns this.

## The hard case, and the defended resolution

Contacts A and B merge. Both hold a LIVE `singleton` row for provider `steam` (two different
`provider_user_id`s: A linked `steamid_1`, B linked `steamid_2`). The naive
`UPDATE linked_accounts SET contact_id = survivor WHERE contact_id = loser` violates
`linked_accounts_contact_provider_singleton_idx` and raises 23505 INSIDE the resolve transaction,
which aborts an ordinary identify call.

Options considered:

1. **Drop the loser's row.** Rejected: a link is an identity fact proven by a completed OAuth
   callback. Deleting it destroys the audit trail and leaves the platform account with no live
   row, so a consumer's mirror keeps the stale `linked` state forever with no unlink to correct it.
2. **Clear `singleton` on both rows so they coexist.** Rejected: `singleton` mirrors the provider's
   `multiple: false` declaration. Silently demoting it means the contact now holds two live links
   for a provider that declared one, and the next `linkAccount` call reads an inconsistent world.
3. **Keep the survivor's row live; soft-unlink the loser's with `unlink_reason = "relinked"`,
   through PRD 03's versioning.** CHOSEN.

Why 3 is right rather than merely convenient: the survivor is, by the merge's own survivor rule
(`pickSurvivor`, preferring identified then oldest), the contact the system considers primary, so
preferring its link is consistent with every other fold in the function. `"relinked"` is the
correct reason from the DECISIONS §8 enum: the link did move as a consequence of an identity
change, and neither `"player"` (nobody clicked anything) nor `"api"` (no API call was made) is
true. And going through the version machinery is not optional: the loser's row belongs to its own
`(provider, provider_user_id)` pair with its own monotonic sequence, so an `UPDATE … SET
unlinked_at = now()` without a version bump produces a row whose state changed while its version
did not. A consumer applying the DECISIONS §5.3 rule (`apply only when incoming.version >
stored.version`) would then discard the unlink forever and permanently record the wrong owner. The
version bump is the whole point of §5, and a merge is precisely the reordering-prone path it was
written for.

The mechanical consequence, which the builder must not work around: `unlinkAccount` from PRD 03
opens its own transaction and takes its own advisory lock. Calling it from inside the merge
transaction is not possible: on a different connection it would block forever on the merge's row
locks, and on the same connection it nests. DECISIONS §7 settles this: **PRD 03 exports the
transaction-scoped `unlinkAccountInTx` as a first-class part of its surface**, and this PRD is its
one caller outside the module:

```ts
export async function unlinkAccountInTx(tx: Tx, opts: {
  rowId: string;
  provider: string;
  providerUserId: string;
  reason: "player" | "api" | "relinked";
  expectContactId?: string;
}): Promise<{ version: string; owner: LinkOwner }>;
```

It does the lock acquisition (`lockPairs`, re-entrant within the transaction), the
`COALESCE(MAX(version),0)+1` computation and the soft-unlink UPDATE, and nothing else: no hooks, no
events, no commit. The returned `version` is a STRING, because `linked_accounts.version` is a
`bigint` that can exceed `Number.MAX_SAFE_INTEGER` (DECISIONS §5.1); this PRD threads it outward
verbatim and never converts it to a `number`. It stays inside `lib/account-links.ts` (the module
boundary rule from PRD 03 holds: `contacts.ts` must not write `linked_accounts` directly).

**Known lock-order hazard, stated rather than hidden.** The merge transaction already holds
contact-key advisory locks (`contacts.ts:1223`) and then takes pair locks; the store takes pair
locks and then touches `linked_accounts` rows belonging to contacts. The two never take the SAME
two advisory locks in opposite orders, so there is no advisory-lock cycle, but a row-lock cycle
between a merge and a concurrent link on the same rows is possible in principle. Postgres detects
it and aborts one side with 40P01, which surfaces as a failed resolve or a failed link that the
caller retries. Mitigation, not elimination: take the pair locks as LATE as possible in the merge
(the position specified above, immediately before `recordMergeAliases`), so the window is a few
statements wide. Do not attempt a global lock ordering across the two subsystems for v1; record
this paragraph in the code comment.

## Acceptance criteria (EARS)

- WHEN contacts merge and only the loser holds live links for a provider, the system SHALL repoint
  those rows to the survivor, preserving `version`, `linked_at`, `method` and the sealed tokens.
- WHEN contacts merge and both hold a live NON-singleton link for the same provider, the system
  SHALL repoint the loser's rows and leave both live, because `multiple: true` needs no
  arbitration (DECISIONS §7).
- WHEN contacts merge and BOTH hold a live `singleton` link for the same provider, the system
  SHALL keep the survivor's row live and soft-unlink the loser's with `unlink_reason = "relinked"`
  at that pair's own next version, and SHALL NOT raise 23505.
- WHEN contacts merge and both hold a live `singleton` link for the same provider AND the SAME
  `provider_user_id` (only reachable if a live-uniqueness violation already exists), the system
  SHALL keep the survivor's row and soft-unlink the loser's, the same as the different-id case.
- WHEN contacts merge and the loser holds only UNLINKED (historical) link rows, the system SHALL
  repoint them too, so the survivor's history is complete and no row references a soft-deleted
  contact.
- WHEN a merge repoints or soft-unlinks link rows, the system SHALL return the facts of each
  mutation on the merge result so PRD 08 can emit `account.unlinked` after the transaction commits.
- WHEN a merge repoints link rows, the system SHALL NOT emit any outbound event from inside the
  transaction (DECISIONS §8: commit/intent layer only).
- WHEN a merge completes, the system SHALL leave zero `linked_accounts` rows whose `contact_id`
  references a soft-deleted contact that participated in the merge.
- WHEN a contact is soft-deleted (`softDeleteContact`, or the admin delete route), the system SHALL
  soft-unlink every live link that contact holds, in the SAME transaction, each at its own pair's
  next version, with `unlink_reason = "api"`.
- WHEN a contact is deleted, the system SHALL hard-delete the `tokens` blob on those rows
  (`tokens = NULL`), because a sealed grant belonging to a deleted person is retained secret
  material with no owner to revoke it.
- WHEN a contact is ERASED (the admin delete route, which already deletes identity aliases), the
  system SHALL additionally null `verified_email`, `username` and `avatar_url` on the historical
  rows, keeping only `(provider, provider_user_id, version, unlinked_at, unlink_reason)`. The
  version sequence must survive erasure so the pair stays monotonic; the personal data must not.
- WHEN a contact is deleted, the system SHALL return the facts of each unlink so PRD 08 emits one
  `account.unlinked` per row after the transaction commits, and mirrors converge. Without that emit
  a customer's mirror records the deleted player as still linked, forever.
- WHEN a contact whose links were deleted is followed by a fresh player re-registering and linking
  the SAME platform account, the system SHALL accept the link, including under
  `onConflict: "reject"`. This is the criterion the whole deletion leg exists for: a live row that
  outlives its owner locks the pair permanently, so an erased player can never relink their own
  account.
- WHEN `adoptOrphanHistory` runs, the system SHALL leave `linked_accounts` untouched, because
  `contact_id` is `NOT NULL` and there is no orphan link row to stamp (DECISIONS §7).
- WHEN a merge or an unlink reports a `version`, the system SHALL carry it as a STRING end to end
  and SHALL NOT pass it through `parseInt` or `Number()` at any boundary (DECISIONS §5.1).
- WHEN this PRD ships, the system SHALL NOT add any member to `IdentityKind`
  (`lib/contacts.ts:516`) or to `ALL_IDENTITY_KINDS` (`:576`), and SHALL NOT add a per-provider
  alias in `recordMergeAliases` (`:2576-2629`).

## Tasks

### T1 — Consume PRD 03's `unlinkAccountInTx`
_Boundary:_ `packages/engine`
_Depends:_ PRD 03

`unlinkAccountInTx` is a required export of PRD 03 (DECISIONS §7), living in
`packages/engine/src/lib/account-links.ts` and reusing `lockPairs` plus the version computation
already there: no hooks, no events, no transaction of its own, and a `version` returned as a string.
This PRD is its only caller outside that module.

Verify the export exists and matches the signature above before starting T2. If PRD 03 shipped
without it, add it there rather than here, so the module boundary rule holds (`contacts.ts` must
not write `linked_accounts` directly).

Tests owned by PRD 03, in `apps/api/src/__tests__/account-link-store.test.ts`:
`unlinkAccountInTx bumps the version inside a caller's transaction` and
`unlinkAccountInTx rolls back with its caller`. Confirm both are present and green.

### T2 — `foldLinkedAccounts` and the merge site
_Boundary:_ `packages/engine`
_Depends:_ T1

Add to `packages/engine/src/lib/contacts.ts`, next to `foldGroupMemberships` (`:2366-2393`):

```ts
/**
 * linked_accounts FOLD. `linked_accounts_contact_provider_singleton_idx` is a
 * PARTIAL unique index on (contact_id, provider) WHERE unlinked_at IS NULL AND
 * singleton, so a blind repoint raises 23505 whenever survivor and loser both
 * hold a live singleton link for the same provider. Resolution: the survivor's
 * row stays, the loser's is SOFT-unlinked with reason "relinked" through the
 * store's versioning helper (never raw SQL — an unlink whose version does not
 * advance is discarded forever by the consumer's monotonic guard, DECISIONS
 * §5.3), and everything else repoints.
 *
 * `multiple: true` links (singleton = false) and already-unlinked history rows
 * need no arbitration: they are outside the partial index, so they just move.
 */
async function foldLinkedAccounts(
  tx: Tx,
  survivorId: string,
  loserId: string,
): Promise<Array<{ provider: string; providerUserId: string; version: string;
                  contactId: string; reason: "relinked" }>>;
```

Implementation order:

1. `SELECT provider FROM linked_accounts WHERE contact_id = :survivorId AND unlinked_at IS NULL
   AND singleton` — the survivor's occupied providers.
2. `SELECT id, provider, provider_user_id FROM linked_accounts WHERE contact_id = :loserId AND
   unlinked_at IS NULL AND singleton AND provider = ANY(:occupied)` — the collisions.
3. For each collision, `await unlinkAccountInTx(tx, { rowId, provider, providerUserId, reason:
   "relinked" })`, collecting the returned version into the result array.
4. `UPDATE linked_accounts SET contact_id = :survivorId, updated_at = now() WHERE contact_id =
   :loserId` — everything remaining, live and historical.

Step 4 runs LAST and unconditionally, which is what carries the just-unlinked rows over too: an
unlinked row is outside every partial index, so it moves without conflict, and leaving it behind
would strand history on the soft-deleted loser.

Call it at `contacts.ts:1937`, between `foldGroupMemberships` (`:1936`) and `recordMergeAliases`
(`:1939`):

```ts
    // (vi-d) linked_accounts FOLD — the same stranding failure as (vi-c), with
    // an extra wrinkle: the singleton partial-unique index forbids a blind
    // repoint. See foldLinkedAccounts.
    linkMutations.push(...(await foldLinkedAccounts(tx, survivor.id, loser.id)));
```

`linkMutations` is declared alongside `safeLoserKeys` / `identifiedLoserKeys` at
`contacts.ts:1792-1793` and returned from `mergeContacts` (`:2119-2125`) as
`linkUnlinks: linkMutations.length > 0 ? linkMutations : undefined`. Thread it out through the
same result shape the merge already uses; PRD 08 reads it post-commit. Do not emit here.

Also extend the `ContactResolveResult`-shaped interfaces that carry `mergedKeys` outward
(`contacts.ts:1066`, `:1441`, `:1502`, `:1571`, `:2808`) with the same optional field, so the fact
survives to the resolve caller. Optional and additive: every existing caller compiles untouched.

Tests: `apps/api/src/__tests__/account-link-merge.test.ts` (new, real DB, run-namespaced,
`afterAll` cleanup scoped to the namespace):

1. `merge repoints the loser's live links to the survivor`
2. `merge repoints the loser's historical unlinked links`
3. `merge leaves both live when the provider is multiple:true`
4. `merge soft-unlinks the loser's singleton link and keeps the survivor's`
5. `the merge-unlinked row's version is that pair's next version, not a copy`
6. `merge does not raise 23505 on the singleton index` (the regression this PRD exists for: it
   must FAIL with `foldLinkedAccounts` removed and the blind UPDATE in its place)
7. `no linked_accounts row references a soft-deleted contact after a merge`
8. `the merge result reports the unlink facts`
8b. `a version above Number.MAX_SAFE_INTEGER survives the merge unlink`. **Seed so the RESULT lands
    on an ODD value — seed `9007199254740994`, so the merge unlink returns `"9007199254740995"` —
    and assert that string exactly.** Do NOT seed `...993` expecting `...994`: that was this stack's
    original prescription and it is VACUOUS, because `...994` is even and exactly representable in
    float64, so `Number()` round-trips it unchanged and the assertion passes on broken code. Only an
    odd value above 2^53 catches the rounding (`Number("9007199254740995")` is `...996`). See
    DECISIONS §5.1, which now carries this rule for every PRD that asserts on `version`.

### T3 — `adoptOrphanHistory`: the documented no-op
_Boundary:_ `packages/engine`
_Depends:_ T2

Add a comment INSIDE `adoptOrphanHistory` (`contacts.ts:2545-2574`), after the
`journey_states / bucket_memberships / email_preferences` fold block at `:2562-2573`:

```ts
  // linked_accounts is deliberately ABSENT here, and that is not an omission.
  // This function stamps rows that sat under a text key with NO owner
  // (`WHERE user_id = :fromKey AND contact_id IS NULL`). `linked_accounts` has
  // no `user_id` column and its `contact_id` is NOT NULL: a link row can only
  // be created from a callback where the contact is already bound (DECISIONS
  // §7), so an orphan link row is unrepresentable. The merge path DOES carry
  // links — see foldLinkedAccounts. Do not "fix" this by adding a statement;
  // add a test instead if you doubt it.
```

Tests, in `account-link-merge.test.ts`:

9. `adoptOrphanHistory leaves a contact's link rows untouched` — create a link, run a resolve that
   triggers adoption for that contact's key, assert the link row's `contact_id`, `version` and
   `updated_at` are unchanged.
10. `linked_accounts.contact_id is NOT NULL` — assert against `information_schema.columns`, which
    is what makes the no-op provable rather than asserted.

### T4 — Guard the identity model
_Boundary:_ `packages/engine`
_Depends:_ T2

No production change. Add to `account-link-merge.test.ts`:

11. `IdentityKind is not widened` — assert `ALL_IDENTITY_KINDS` (exported from `@hogsend/engine`)
    deep-equals `["external", "email", "anonymous", "discord"]`. A future PRD that adds "steam" as
    a resolver kind then has to delete this test deliberately, which is the point (DECISIONS §7,
    §12).
12. `merge records no per-provider alias` — after a merge that carried links, assert
    `contact_aliases` gained no row whose `alias_kind` is a provider id.

### T5 — Contact deletion and erasure (DECISIONS §15.3)
_Boundary:_ `packages/engine`
_Depends:_ T1

Two halves: a store helper, and two call sites.

**(a) `unlinkAccountsForContactInTx`, in `packages/engine/src/lib/account-links.ts`** beside
`unlinkAccountInTx` (the module boundary rule from PRD 03 holds — `contacts.ts` never writes
`linked_accounts`):

```ts
/**
 * Soft-unlink EVERY live link a contact holds, inside the caller's transaction.
 * The caller is contact deletion: `softDeleteContact` and the admin delete
 * route. Nothing in this repo hard-deletes a contact, so without this a live
 * link outlives its owner forever — the pair stays owned by a dead contact, and
 * under `onConflict: "reject"` an erased player can NEVER relink their own
 * platform account. Each row gets its own pair's next version under that pair's
 * advisory lock, exactly like the merge leg, so a consumer's monotonic guard
 * accepts the unlink.
 */
export async function unlinkAccountsForContactInTx(
  tx: Tx,
  contactId: string,
  opts: { reason: "api"; erase?: boolean },
): Promise<Array<{ provider: string; providerUserId: string; version: string;
                   contactId: string; owner: LinkOwner; reason: "api" }>>;
```

Behaviour: select the contact's live rows; take the pair locks for ALL of them, sorted, before the
first mutation (the T3-of-PRD-03 rule applies here too, and a delete can touch many pairs at once);
soft-unlink each at its own next version with `unlink_reason = "api"`; set `tokens = NULL` on those
rows unconditionally. When `erase` is true, also null `verified_email`, `username` and `avatar_url`
on EVERY row for that contact, live and historical. It opens no transaction, invokes no hook and
emits nothing.

**(b) The two call sites.**

1. `softDeleteContact` (`lib/contacts.ts:2873`) currently just sets `deletedAt`. Wrap it in a
   transaction (or extend the existing one) and call
   `unlinkAccountsForContactInTx(tx, contactId, { reason: "api" })` before the update, threading the
   returned facts out on the result so PRD 08 can emit. This is also the path
   `DELETE /v1/contacts` takes (`routes/contacts/index.ts:285`).
2. The admin delete route (`routes/admin/contacts.ts:651-671`) already runs the soft-delete plus
   `deleteIdentityAliasesForContact` in ONE transaction. That is the erasure hook, so it calls the
   same helper with `{ reason: "api", erase: true }` inside that transaction.

If both paths end up calling it (the admin route via `softDeleteContact`), make it idempotent by
construction: a second call finds no live rows and returns an empty array. Do not guard by a flag.

Tests, in `apps/api/src/__tests__/account-link-delete.test.ts` (new, real DB, run-namespaced):

1. `a soft-deleted contact holds no live link`
2. `each deleted link gets its own pair's next version` (not a copy, not a shared value)
3. `deleting a contact nulls the token blob`
4. `an erasure nulls verified_email, username and avatar_url but keeps the version`
5. `a pair whose owner was deleted can be relinked under onConflict reject` — the player-facing
   criterion. **Mutation guard:** remove the `unlinkAccountsForContactInTx` call from
   `softDeleteContact` and this test must fail with `live_owner_conflict`. Record the observation in
   Implementation Notes.
6. `deletion returns one unlink fact per live link` (PRD 08 emits from these)
7. `deleting a contact with no links is a no-op and returns an empty array`

### T6 — Changeset
_Boundary:_ `.changeset`
_Depends:_ T1-T5

Patch changeset for `@hogsend/engine`: a correctness fix in the merge and delete paths, plus the
additive result fields.

## Seams
None.

## Done when
- [ ] `foldLinkedAccounts` exists in `lib/contacts.ts` and is called between `foldGroupMemberships`
      and `recordMergeAliases`.
- [ ] `contacts.ts` contains no direct `UPDATE`/`INSERT` of a `version` value; every version comes
      from `unlinkAccountInTx`.
- [ ] The `adoptOrphanHistory` comment is in place and tests 9 and 10 pass.
- [ ] Test 6 has been observed to FAIL when `foldLinkedAccounts` is replaced by a blind
      `UPDATE … SET contact_id = survivor` (a guard without such a test is a vacuous green,
      DECISIONS §4). Record the observation in Implementation Notes.
- [ ] `unlinkAccountsForContactInTx` exists in `lib/account-links.ts` and is called from BOTH
      `softDeleteContact` and the admin delete route, inside their existing transactions.
- [ ] Test T5.5 has been observed to FAIL when that call is removed. The observation is recorded in
      Implementation Notes.
- [ ] `ALL_IDENTITY_KINDS` and `IdentityKind` are byte-identical to the pre-PRD versions.
- [ ] `pnpm lint` green.
- [ ] `pnpm check-types` green.
- [ ] `cd apps/api && pnpm test` green (the whole suite, not just the new file: this touches the
      merge path every identity test drives).
- [ ] `pnpm build` green.
- [ ] A changeset exists for `@hogsend/engine`.
- [ ] One conventional commit, e.g. `fix(engine): repoint linked accounts on contact merge`.

## Implementation Notes

### Mutation-guard observations

Both performed by hand against `growthhog_test`, file restored and re-verified green each time.

1. **The singleton fold (T2, test 6).** Replacing `foldLinkedAccounts` with the blind
   `UPDATE linked_accounts SET contact_id = :survivor WHERE contact_id = :loser` fails **6 tests**
   with exactly the predicted error: `PostgresError 23505`, `constraint_name:
   "linked_accounts_contact_provider_singleton_idx"`, `Key (contact_id, provider)=(…) already
   exists`. This is the regression the PRD exists for — two contacts each holding a live Steam link
   would abort an ordinary identify call.
2. **The delete leg (T5).** Removing the `unlinkAccountsForContactInTx` call from
   `softDeleteContact` fails **5 tests**, the decisive one being `a pair whose owner was deleted can
   be relinked under onConflict reject` → *expected 'rejected' to be 'linked'*. That is the
   user-facing consequence stated plainly: without this leg an erased player can never relink their
   own platform account. `deleting a contact nulls the token blob` also fails, leaving a sealed
   grant with no owner to revoke it.

### Notes

- `unlinkAccountsForContactInTx` was added to `lib/account-links.ts`, NOT to `contacts.ts`. The
  module boundary from PRD 03 holds: `contacts.ts` never writes `linked_accounts` directly. It takes
  all pair locks sorted+deduped before its first mutation, since one deletion can touch many pairs.
- The corrected (non-vacuous) bigint form is used: the merge unlink is seeded at `…994` so the
  result lands on the ODD `…995`. See DECISIONS §5.1.
- `IdentityKind` / `ALL_IDENTITY_KINDS` are untouched, confirmed by diff.
- Full `apps/api` suite: 2527 passed, 1 failed — `health-activity.test.ts`, which fails identically
  at HEAD and is not from this work. `gtm-score-batch.test.ts` passed this run, confirming its
  earlier timeout was DB contention rather than a defect.
