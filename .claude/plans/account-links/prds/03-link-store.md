# PRD 03 — Link store: versioning, locking, policy (`@hogsend/engine`)

## Goal
Ship `packages/engine/src/lib/account-links.ts`: the one place a `linked_accounts` row is ever
written. It computes the monotonic version under a Postgres advisory lock keyed on the
`(provider, providerUserId)` pair, enforces the live-owner rule, performs a relink as a two-version
soft-unlink-then-insert, enforces `multiple: false` through the `singleton` column plus
`onConflict`, seals tokens, and invokes `afterLink` / `afterUnlink` after commit. This is the heart
of the feature: every later PRD (07 callback, 09 data plane, 11 manage page, 14 property sync, 04
merge) writes through this module and nowhere else.

## Locked decisions specific to this PRD

- The whole consistency contract is DECISIONS §5 and is NOT re-negotiable here: version is
  monotonic per pair across live AND unlinked rows, every mutation gets its own version, a relink
  burns TWO versions, the advisory lock is `pg_advisory_xact_lock(hashtext(...))` on the pair, and
  the `(provider, provider_user_id, version)` unique index is the lost-race backstop that must
  surface as a retryable 23505.
- **`version` is a `bigint` and crosses every boundary as a STRING** (DECISIONS §5.1). Postgres
  `bigint` exceeds `Number.MAX_SAFE_INTEGER`, so this module reads it as `string`/`bigint`, never
  through `parseInt`/`Number()`, and serializes it with `String(row.version)`. The
  `COALESCE(MAX(version), 0) + 1` computation stays in SQL so the increment happens in Postgres, not
  in JS. Every result type this module returns types `version` as `string`, and every downstream PRD
  (04 merge, 08 payloads, 09 routes, 12 SDK, 15 admin) inherits that. A silently rounded version
  breaks the consumer's `incoming.version > stored.version` guard in exactly the case it exists for.
- **The store exports a transaction-scoped `unlinkAccountInTx`** in addition to the public
  `unlinkAccount` (DECISIONS §7). PRD 04's merge already runs inside a transaction holding
  contact-key advisory locks, so it cannot call the public entry point: on a different connection it
  blocks forever on the merge's row locks, and on the same connection it nests. See T3b.
- Security: only a completed hosted callback may MOVE a link (DECISIONS §6.1). The store takes
  that as an explicit input flag; it does not infer it from `method`.
- `POST /v1/accounts/import` is INSERT-ONLY where no live owner exists (DECISIONS §6.2). The store
  is where that is enforced, not the route.
- `beforeLink` is invoked by PRD 07's callback, NOT here (DECISIONS §9 makes it the pre-write
  veto and PRD 07 owns the flow). The store ACCEPTS an already-vetoed decision and must never
  re-run it. Postures for `afterLink` / `afterUnlink`: post-commit, at-least-once, fail-open,
  bounded by `ACCOUNT_LINK_HOOK_TIMEOUT_MS` from PRD 01. Precedent:
  `packages/engine/src/cold-connect/index.ts:222-233`.
- **THIS STORE IS THE SOLE INVOKER of `afterLink` and `afterUnlink`** (DECISIONS §15.4). No route,
  hosted page, SDK path or cron calls them. Callers pass `hooks: container.accountLinkHooks` in and
  call nothing themselves. The original stack specified the invocation in both places, which would
  have fired every customer hook twice per link, and because the hooks are documented at-least-once
  nothing would have failed loudly: the customer's in-band write would just have run twice, forever.
  T6 carries a COUNTING test, not a "was it called" test.
- **The store never resolves or mints a contact.** `LinkAccountInput.contactId` is an
  already-resolved `string`, and it stays that way. The cold path's resolve belongs to PRD 07's
  route (DECISIONS §6.10), which must run it strictly after `beforeLink` allows and BEFORE this
  module's transaction opens: `resolveOrCreateContact` takes its own contact-key advisory locks
  (`lib/contacts.ts:1203/:1223`), so calling it inside the pair lock reintroduces the exact deadlock
  `unlinkAccountInTx` exists to avoid.
- **Every mutation result carries an `owner` block** read by a join to `contacts` INSIDE the locked
  transaction (DECISIONS §15.5). PRD 08's payloads and PRD 01's hook contexts need `userId` and
  `email`, which live on `contacts` and on neither this table nor a bare row projection, and no
  caller is allowed to invent a lookup at emit time. Reading it inside the lock is also what makes
  the payload a true point-in-time full state.
- Tokens are sealed with the existing AES-256-GCM helper (DECISIONS §3.3 / §10), the one in
  `packages/engine/src/lib/provider-credentials.ts:107-174`.
- Outbound event EMISSION is PRD 08, not this PRD. The store RETURNS the full facts each mutation
  produced (state, version, relink, reason, at) so PRD 08 emits from the intent layer without
  re-reading the database (DECISIONS §8: commit/intent layer only, never the ingest path).
- Advisory lock idiom already in the repo: `packages/engine/src/lib/blueprint-lock.ts:14-20`
  (`SELECT pg_advisory_xact_lock(hashtext(${'bp-graph:' + id}))`) and
  `packages/engine/src/lib/contacts.ts:1223`. There is NO existing pair-keyed lock helper, so this
  PRD adds one. The exact SQL is specified in T2.

## Acceptance criteria (EARS)

- WHEN `linkAccount` is called for a pair with no existing rows, the system SHALL insert a live row
  with `version = 1` and return `{ status: "linked", relink: false, version: "1" }`.
- WHEN `linkAccount` is called for a pair whose live owner is the SAME contact, the system SHALL
  refresh the display fields (`username`, `verifiedEmail`, `avatarUrl`) and, when tokens are
  supplied, the sealed blob, SHALL NOT bump the version, SHALL NOT emit anything, and SHALL return
  `{ status: "unchanged" }`. There is deliberately no `account.updated` event (DECISIONS §8), so a
  display refresh is not a state transition and must not consume a version the consumer would then
  see as a gap.
- WHEN `linkAccount` is called for a pair whose live owner is a DIFFERENT contact and
  `allowDisplaceLiveOwner` is false, the system SHALL mutate nothing and return
  `{ status: "rejected", reason: "live_owner_conflict" }`.
- WHEN `linkAccount` is called for a pair whose live owner is a DIFFERENT contact and
  `allowDisplaceLiveOwner` is true, the system SHALL soft-unlink the old row with
  `unlink_reason = "relinked"` at version N+1, insert the new live row at version N+2, and return
  `{ status: "relinked", relink: true, version: N+2, previous: { contactId, version: N+1 } }`.
- WHEN the provider declares `multiple: false`, the system SHALL write `singleton = true` on the
  inserted row.
- WHEN the provider declares `multiple: false`, the target contact already holds a live link for
  that provider, and `onConflict` is `"reject"`, the system SHALL mutate nothing and return
  `{ status: "rejected", reason: "singleton_conflict" }`.
- WHEN the provider declares `multiple: false`, the target contact already holds a live link for
  that provider, and `onConflict` is `"replace"`, the system SHALL soft-unlink the contact's
  existing row with `unlink_reason = "relinked"` at that OTHER pair's own next version, then insert
  the new row.
- WHEN a mutation is passed `vetoed: true` (PRD 07 ran `beforeLink` and got a refusal), the system
  SHALL mutate nothing and return `{ status: "rejected", reason: "vetoed" }`.
- WHEN a provider declares it stores tokens and an identity carries them, the system SHALL store
  only the sealed blob and SHALL NEVER write plaintext token material to any column or log line.
- WHEN a provider does not declare token storage, the system SHALL write `tokens = NULL` even if
  the identity carried tokens.
- WHEN two mutations for the SAME pair run concurrently, the system SHALL serialize them on the
  advisory lock, SHALL produce distinct versions, and SHALL leave exactly one live row.
- WHEN two mutations for DIFFERENT pairs run concurrently, the system SHALL NOT block one on the
  other.
- WHEN a mutation nevertheless hits 23505 on `linked_accounts_provider_uid_version_idx`, the system
  SHALL retry the whole transaction up to 3 times and, if still failing, SHALL throw
  `AccountLinkVersionRaceError` rather than write a duplicate version.
- WHEN a `multiple: false` replace touches two different pairs, the system SHALL acquire BOTH
  advisory locks, sorted, as the FIRST statement of the mutation transaction, so two mirror-image
  concurrent replaces cannot deadlock. Acquiring the second lock later, once the probe has revealed
  which pair to displace, does NOT satisfy this: two transactions that each already hold the other's
  second target deadlock, and Postgres resolves that by killing one with `40P01`. The set of locks
  is therefore decided BEFORE the transaction opens (T3's pre-read) and re-verified inside it.
- WHEN a mutation hits `40P01` (deadlock detected) or `40001` (serialization failure), the system
  SHALL retry the whole transaction on the same bounded schedule as the version-index 23505. These
  are by definition transient and the transaction has already been rolled back, so a retry is the
  only correct response; surfacing one is a 500 on a player's callback for no reason.
- WHEN `unlinkAccount` or `unlinkAccountInTx` is passed `expectContactId` and the live owner of the
  pair is a DIFFERENT contact, the system SHALL mutate nothing and return
  `{ status: "rejected", reason: "not_owner", currentOwnerContactId }`.
- WHEN `expectContactId` is passed, the system SHALL evaluate the guard INSIDE the pair's advisory
  lock, after the live-owner probe and before the write. Evaluating it in the caller's application
  code (read, compare, then unlink by pair) is a read-then-write race: a hosted callback relinking
  the pair in between lets contact A's revoke destroy contact B's just-proven link.
- WHEN a mutation succeeds, the system SHALL return `owner: { contactId, userId, email }` read from
  `contacts` inside the same transaction, where `userId` is `contactKey()`
  (`external_id ?? anonymous_id ?? id`) and never raw `externalId`.
- WHEN `unlinkAccount` is called for a live pair, the system SHALL set `unlinked_at`,
  `unlink_reason`, and a fresh version, and SHALL return that version.
- WHEN `unlinkAccount` is called for a pair with no live row, the system SHALL mutate nothing and
  return `{ status: "not_found" }`, SHALL NOT consume a version, and SHALL NOT throw.
- WHEN `afterLink` or `afterUnlink` throws or exceeds `ACCOUNT_LINK_HOOK_TIMEOUT_MS`, the system
  SHALL log a warning and SHALL still return success, because the write already committed.
- WHEN one successful `linkAccount` completes with an `afterLink` hook configured, the system SHALL
  invoke that hook EXACTLY ONCE. No caller invokes it a second time (DECISIONS §15.4).
- WHEN a hook is invoked, the system SHALL invoke it strictly AFTER the transaction has committed,
  so a hook that reads the pull plane sees its own write.
- WHEN any result carries a `version`, the system SHALL type and return it as a `string` and SHALL
  NOT pass it through `parseInt` or `Number()` (DECISIONS §5.1).
- WHEN a pair's stored version exceeds `Number.MAX_SAFE_INTEGER`, the system SHALL compute, store
  and return the next version without loss of precision.
- WHEN `unlinkAccountInTx` is called with a caller's transaction handle, the system SHALL acquire
  the pair lock re-entrantly, bump the version and soft-unlink the row, and SHALL NOT open its own
  transaction, invoke a hook, or emit an event.
- WHEN the caller's transaction rolls back, the system SHALL leave no trace of an
  `unlinkAccountInTx` mutation.

## Tasks

### T1 — Module skeleton, types and errors
_Boundary:_ `packages/engine`
_Depends:_ PRD 01, PRD 02

Create `packages/engine/src/lib/account-links.ts` in the house service-module style of
`packages/engine/src/lib/groups.ts:1-30` (single-object-in / result-object-out, `db` injected,
typed error classes, doc comments that state WHY).

```ts
export type LinkMutationStatus = "linked" | "relinked" | "unchanged" | "rejected";

export interface LinkedAccountRecord {
  id: string;
  contactId: string;
  provider: string;
  providerUserId: string;
  username: string | null;
  verifiedEmail: string | null;
  avatarUrl: string | null;
  method: "oauth" | "import";
  singleton: boolean;
  /** bigint. STRING at every boundary — never a JS number (DECISIONS §5.1). */
  version: string;
  linkedAt: Date;
  unlinkedAt: Date | null;
  unlinkReason: string | null;
  tokensRevokedAt: Date | null;
  /** Always redacted to a boolean. The blob NEVER leaves this module. */
  hasTokens: boolean;
}

/**
 * The contact facts every downstream plane needs, read by a join to `contacts`
 * INSIDE the mutation's transaction (DECISIONS §15.5). PRD 08's payloads carry
 * `userId` and `email`; PRD 01's hook contexts carry the same two. Neither lives
 * on `linked_accounts`, and neither may be looked up at emit time — a second
 * read after the lock released is no longer the state that was committed.
 */
export interface LinkOwner {
  contactId: string;
  /** `contactKey()` = `external_id ?? anonymous_id ?? id`, contacts.ts:863-865.
   * ONE definition across PULL, PUSH and IN-PROCESS, so a consumer can join on
   * it. NOT raw `externalId`. */
  userId: string | null;
  /** The CONTACT's email. Never `linked_accounts.verified_email`. */
  email: string | null;
}

export interface LinkAccountInput {
  db: Database;
  provider: string;
  identity: LinkedIdentity;
  /**
   * ALREADY RESOLVED by the caller. The store never resolves, never mints, and
   * never accepts an `anonymousId`: the cold-path resolve is PRD 07's
   * (DECISIONS §6.10) and `resolveOrCreateContact` takes its own contact-key
   * advisory locks, which cannot be nested inside the pair lock.
   */
  contactId: string;
  method: "oauth" | "import";
  /** From the provider definition; the CALLER resolves the default (`true`). */
  multiple: boolean;
  /** Only consulted when `multiple === false`. */
  onConflict: "replace" | "reject";
  /** From `capabilities.tokens`. False ⇒ tokens are dropped, not stored. */
  storeTokens: boolean;
  /**
   * TRUE only from a completed hosted callback (DECISIONS §6.1). The import
   * path (§6.2) passes FALSE and is therefore structurally insert-only: it
   * cannot graft a link off its current owner no matter what it sends.
   */
  allowDisplaceLiveOwner: boolean;
  /** PRD 07 already ran `beforeLink` and it REFUSED. The store must not re-run
   * the hook; it just records the refusal. */
  vetoed?: boolean;
  hooks?: AccountLinkHooks;
  logger?: Logger;
}

export type LinkAccountResult =
  | { status: "linked"; row: LinkedAccountRecord; relink: false; version: string;
      owner: LinkOwner }
  | { status: "relinked"; row: LinkedAccountRecord; relink: true; version: string;
      owner: LinkOwner;
      previous: { contactId: string; version: string; owner: LinkOwner } }
  | { status: "unchanged"; row: LinkedAccountRecord; version: string; owner: LinkOwner }
  | { status: "rejected";
      reason: "live_owner_conflict" | "singleton_conflict" | "vetoed";
      currentOwnerContactId?: string };

export interface UnlinkAccountInput {
  db: Database;
  provider: string;
  providerUserId: string;
  reason: "player" | "api" | "relinked";
  /**
   * Guard: only unlink when this contact is the live owner. Omit for admin.
   *
   * REQUIRED on both player-facing revokes (PRD 09's `/accounts/me/revoke` and
   * PRD 11's manage page). It is evaluated INSIDE the pair lock, after the
   * live-owner probe, which is the whole point: a caller that reads the row,
   * compares in application code, then unlinks by pair has a window in which a
   * hosted callback relinks the pair, and contact A's revoke then destroys
   * contact B's just-proven link. This is the same read-then-write hazard PRD 09
   * forbids for the import path.
   */
  expectContactId?: string;
  revoke?: (tokens: LinkTokens) => Promise<void>;
  hooks?: AccountLinkHooks;
  logger?: Logger;
}

export type UnlinkAccountResult =
  | { status: "unlinked"; row: LinkedAccountRecord; version: string; owner: LinkOwner }
  | { status: "not_found" }
  | { status: "rejected"; reason: "not_owner"; currentOwnerContactId: string };

/**
 * Transaction-scoped unlink, for a caller that ALREADY holds a transaction
 * (today: PRD 04's contact merge, which holds contact-key advisory locks and
 * therefore cannot call the public `unlinkAccount`). Takes the pair lock
 * re-entrantly, bumps the version, soft-unlinks. No hooks, no events, no
 * commit. DECISIONS §7.
 */
export async function unlinkAccountInTx(tx: Tx, opts: {
  rowId: string;
  provider: string;
  providerUserId: string;
  reason: "player" | "api" | "relinked";
  /** Same guard as the public entry point, evaluated under the pair lock. */
  expectContactId?: string;
}): Promise<{ version: string; owner: LinkOwner }>;

export class AccountLinkVersionRaceError extends Error {}
```

**Drizzle returns `bigint` columns as strings** with the `postgres` driver, which is the behaviour
this module depends on. Do NOT configure a numeric parser for the column and do NOT map it through
`Number()` in `toLinkedAccountRecord()`: the string is carried verbatim to every caller.

Read helpers, also here (PRD 09 routes call these, they never hand-roll a query):
`getLiveLink({ db, provider, providerUserId })`, `listLiveLinksForContact({ db, contactId })`,
`listLinkHistory({ db, provider, providerUserId })`. All three project through
`toLinkedAccountRecord()`, the ONE function that maps a row to the public shape, which is where
`tokens` is collapsed to `hasTokens`. Nothing else in the engine may select `linkedAccounts.tokens`
except the property-sync path in PRD 14.

Tests: `apps/api/src/__tests__/account-link-store.test.ts` (new). Start with
`toLinkedAccountRecord never surfaces the sealed blob`.

### T2 — The advisory lock
_Boundary:_ `packages/engine`
_Depends:_ T1

There is NO pair-keyed advisory-lock helper in the repo today. The existing users are
`packages/db/src/migrate.ts:57` (a static int key), `packages/engine/src/lib/boot-api-key.ts:57`,
`packages/engine/src/lib/seed-posthog-destination.ts:64`,
`packages/engine/src/lib/blueprint-lock.ts:20`, `packages/engine/src/lib/contacts.ts:1223` and
`apps/cloud/src/services/builds.ts:236`. This PRD adds one for the link pair, modelled on
`blueprint-lock.ts`.

Exact SQL, in `account-links.ts`:

```ts
/**
 * Serialize every mutation for ONE platform account. `hashtext` folds the
 * string into the int4 the single-arg `pg_advisory_xact_lock` overload takes;
 * the lock is TRANSACTION-scoped, so it releases on COMMIT or ROLLBACK with no
 * unlock call and no leak on a thrown error. Same idiom as
 * `lib/blueprint-lock.ts:20` and `lib/contacts.ts:1223`.
 *
 * The key is `al:<provider>:<providerUserId>`. The `al:` prefix keeps it from
 * colliding with the `bp-graph:` and `<kind>:<value>` namespaces already in
 * use; `hashtext` collisions across namespaces are possible in principle and
 * cost only a spurious wait, never a correctness bug.
 */
function pairLockKey(provider: string, providerUserId: string): string {
  return `al:${provider}:${providerUserId}`;
}

async function lockPairs(tx: Tx, keys: string[]): Promise<void> {
  // SORTED, deduped: when a `multiple:false` replace has to touch TWO pairs,
  // two mirror-image concurrent replaces taking them in opposite orders is a
  // textbook deadlock. A total order removes the cycle.
  for (const key of [...new Set(keys)].sort()) {
    await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext(${key}))`);
  }
}
```

Tests: `acquires locks in sorted order` (spy on the executed SQL, assert the argument order for a
reversed input), plus the real concurrency test in T7.

### T3 — Version computation and the mutation transaction
_Boundary:_ `packages/engine`
_Depends:_ T2

**Step 0, OUTSIDE the transaction: the singleton pre-read.** When `multiple === false`, read the
contact's current live singleton row for this provider before opening the mutation transaction:

```sql
SELECT provider, provider_user_id FROM linked_accounts
 WHERE contact_id = :contactId AND provider = :provider
   AND unlinked_at IS NULL AND singleton
 LIMIT 1
```

This exists so the FULL SET of pairs the transaction will touch is known before it takes its first
lock. It is a HINT, not a decision: the row may change between the pre-read and the lock, so T4
re-verifies it inside the lock and re-branches on what it finds there. Skip it entirely when
`multiple === true` (there is never a second pair).

`linkAccount` then opens ONE `db.transaction(async (tx) => { … })` containing, in order:

1. `lockPairs(tx, [pairLockKey(provider, providerUserId), ...preReadPairKey].sort())` as the FIRST
   statement, covering every pair this transaction might touch. Everything below runs under it.

   Do NOT acquire the second lock later, after the probe has revealed which pair to displace. That
   staged acquisition is a textbook deadlock: two concurrent displacing callbacks that each already
   hold the pair the other is about to ask for wait on each other, and Postgres breaks the cycle by
   killing one with `40P01`. Sorting only the keys you happen to hold at the time does not give a
   total order; sorting the whole set up front does. If the pre-read missed a pair (it changed under
   us), the re-verification in T4 finds a pair whose lock is not held, and the correct response is
   to abort and let T5's bounded retry re-run the whole thing from the pre-read, NOT to grab another
   lock mid-transaction.
2. The live-owner probe:
   `SELECT * FROM linked_accounts WHERE provider = $1 AND provider_user_id = $2 AND unlinked_at IS NULL LIMIT 1`.
3. The version computation, across ALL rows for the pair, live and unlinked (DECISIONS §5.1):
   ```sql
   SELECT COALESCE(MAX(version), 0) + 1 AS next
   FROM linked_accounts
   WHERE provider = $1 AND provider_user_id = $2
   ```
   Compute it INSIDE the lock, never before opening the transaction, and never from a value the
   caller passed in.
4. The policy branches, exactly as the acceptance criteria enumerate: veto, same-owner refresh,
   different-owner reject, different-owner relink, singleton conflict.
5. The writes.
6. The owner read, still inside the transaction:
   ```sql
   SELECT id, external_id, anonymous_id, email FROM contacts WHERE id = :contactId
   ```
   projected through the same `contactKey()` rule the rest of the engine uses
   (`external_id ?? anonymous_id ?? id`, `lib/contacts.ts:863-865`) into
   `owner: { contactId, userId, email }`. On a relink, do the same read for the DISPLACED contact
   and return it as `previous.owner`. This is what lets PRD 08 emit `userId` and `email` without a
   second query, and PRD 01's hook contexts carry the same block.

Relink is TWO statements and TWO versions:

```
UPDATE linked_accounts
   SET unlinked_at = now(), unlink_reason = 'relinked', version = :next, updated_at = now()
 WHERE id = :oldRowId
INSERT INTO linked_accounts (…, version) VALUES (…, :next + 1)
```

The old row's version bump is what makes the consumer's `incoming.version > stored.version` guard
work: a consumer that receives the `account.unlinked` for the old owner AFTER the `account.linked`
for the new one discards it, because N+1 is not greater than N+2. Emitting the unlink at the OLD
row's original version would make the late unlink win and permanently record the wrong owner.
That is the exact failure DECISIONS §5 exists to prevent, so this ordering is load-bearing and the
test in T7 must pin it.

Tokens: when `storeTokens` is true and `identity.tokens` is present, seal with the AES-256-GCM
construction in `lib/provider-credentials.ts`. That module's `encryptJson`/`decryptJson` are
currently module-private (`provider-credentials.ts:121` and `:138`); export them (or a thin
`sealJson`/`unsealJson` pair) rather than copying the crypto, so there is ONE construction in the
engine and one place a secret rotation is handled. Keep the same failure posture: an undecryptable
blob throws loudly rather than silently degrading.

Tests in `account-link-store.test.ts`: `first link gets version 1`,
`relink burns two versions and the unlink version is lower than the link version`,
`same-owner call refreshes display fields without bumping the version`,
`import cannot displace a live owner`, `oauth callback can displace a live owner`,
`stores a sealed blob that is not the plaintext token`,
`drops tokens when storeTokens is false`,
`a version above Number.MAX_SAFE_INTEGER round-trips as a string` — seed the pair at
`9007199254740993`, mutate, and assert the returned `version` is `typeof "string"` and strictly
equals `"9007199254740994"`, and that the stored column matches when read back as text. Any
`Number()`/`parseInt` on the path rounds and the assertion fails. Plus
`returns owner.userId as the contact key and owner.email as the contact's own email` — seed a
contact with a null `externalId` and a set `anonymousId`, and assert `owner.userId` is the anonymous
id (not null, not the external id) and `owner.email` is the contact's address, not
`identity.verifiedEmail`. That last clause is the one that catches an agent wiring the
provider-reported email into the payload.

### T3b — `unlinkAccountInTx`
_Boundary:_ `packages/engine`
_Depends:_ T3

Export the transaction-scoped unlink declared in T1. It is a required part of this module's public
surface, not an afterthought: PRD 04's merge is its caller and cannot use `unlinkAccount` (DECISIONS
§7).

It reuses `lockPairs` (re-entrant inside the caller's transaction) and the same
`COALESCE(MAX(version), 0) + 1` computation, then issues the soft-unlink UPDATE with
`unlinked_at = now()`, the given `unlink_reason` and the new version. It does nothing else: no
transaction of its own, no hooks, no outbound events, no token revoke. Its lifecycle is the
caller's, so a caller rollback erases it.

Document at the site that its ONLY caller outside this module is the merge, and that the public
`unlinkAccount` is a thin wrapper opening the transaction and adding the hook/revoke posture around
the same core.

Tests in `account-link-store.test.ts`:
`unlinkAccountInTx bumps the version inside a caller's transaction`,
`unlinkAccountInTx rolls back with its caller`,
`unlinkAccountInTx invokes no hook and opens no transaction of its own`,
`unlinkAccountInTx returns the version as a string`.

### T4 — `multiple: false` and `onConflict`
_Boundary:_ `packages/engine`
_Depends:_ T3

Inside the same transaction, after the live-owner branch and before the insert, when
`multiple === false`, RE-VERIFY the pre-read from T3 step 0 under the lock:

```sql
SELECT * FROM linked_accounts
 WHERE contact_id = :contactId AND provider = :provider
   AND unlinked_at IS NULL AND singleton
 LIMIT 1
```

- No row: insert with `singleton = true`.
- Row present and `onConflict === "reject"`: return `{ status: "rejected", reason:
  "singleton_conflict" }` with no writes.
- Row present and `onConflict === "replace"`: that row is a DIFFERENT `(provider,
  providerUserId)` pair, so it has its OWN version sequence, and its lock is ALREADY HELD because
  T3 step 0's pre-read put it in the sorted set the transaction locked as its first statement.
  Compute that pair's own `MAX(version) + 1`, soft-unlink it with `unlink_reason = 'relinked'` at
  that version, and insert the new row.
- Row present but naming a pair the pre-read did NOT see (it changed between the pre-read and the
  lock): its lock is not held, so do NOT acquire one here. Throw the internal
  `AccountLinkLockSetChangedError`, which T5 treats as retryable: the retry re-runs the pre-read and
  locks the correct set from the start. This is rare by construction (it needs a concurrent mutation
  on the contact's other pair inside a few milliseconds) and a retry is cheap, whereas grabbing a
  lock mid-transaction is the deadlock this design exists to remove.

The `singleton` COLUMN is the enforcement, not the code path: the partial unique index
`linked_accounts_contact_provider_singleton_idx` is what makes a bug here a 23505 instead of a
silent second link. Say so in the code comment.

Tests: `rejects a second link under multiple:false with onConflict reject`,
`replaces the existing link under multiple:false with onConflict replace`,
`locks both pairs before the probe under multiple:false` (spy the executed SQL: the two
`pg_advisory_xact_lock` calls precede the first SELECT against `linked_accounts`, and they are in
sorted key order for a reversed input),
`the replaced row gets its own pair's next version, not the new pair's`,
`multiple:true allows many live links for one contact`,
`inserting a duplicate singleton directly violates the index` (drive the DB, proving the guard is
backed by a constraint and not only by the branch above).

### T5 — Retry: the version constraint, deadlocks, and a changed lock set
_Boundary:_ `packages/engine`
_Depends:_ T3

Wrap the transaction in a bounded retry:

```ts
const MAX_VERSION_RACE_RETRIES = 3;
```

The RETRYABLE set is exactly three things:

| Condition | Why retryable |
| --- | --- |
| 23505 on `linked_accounts_provider_uid_version_idx` | The lost-race backstop fired; another transaction burned the version we read |
| `40P01` (deadlock detected) or `40001` (serialization failure) | Postgres already rolled the transaction back and chose us as the victim. Transient by definition. Not retrying it turns a routine lock cycle into a 500 on a player's OAuth callback, and the T3 lock ordering makes it rare rather than impossible |
| `AccountLinkLockSetChangedError` (T4) | The pre-read's pair set went stale; re-running from the pre-read locks the right set |

Detect the SQL conditions by walking `err.cause` for `code` and, for the 23505 case,
`constraint === "linked_accounts_provider_uid_version_idx"`. Drizzle wraps the postgres error, so
the code is on the cause, not the top-level error, and string-matching the message is not
acceptable. Any OTHER 23505 (the live index, the singleton index) is NOT retryable: it means a
policy branch above was wrong or a concurrent mutation legitimately won, and retrying would loop.
Rethrow those.

After the retries are exhausted, throw `AccountLinkVersionRaceError` naming the pair. Never write a
duplicate version, never fall back to `version + 1` computed outside the lock.

Tests: `retries once and succeeds when the version index conflicts`, driven by injecting a
one-shot conflict (insert the colliding row from a second connection between the version read and
the insert, or stub the tx executor); `does not retry a live-index conflict`;
`throws AccountLinkVersionRaceError after three failures`; `retries a 40P01`, driven by a stubbed
executor that throws a synthetic `{ code: "40P01" }` on the first attempt and succeeds on the
second, asserting the call resolves and exactly one live row exists;
`retries a stale lock set and locks the new pair from the start`.

### T6 — Post-commit hooks (this module is their ONLY invoker)
_Boundary:_ `packages/engine`
_Depends:_ T3, T4

**DECISIONS §15.4: the store is the sole invoker of `afterLink` and `afterUnlink`.** PRD 07's
callback, PRD 09's routes, PRD 10's pages and PRD 11's manage page all pass
`hooks: container.accountLinkHooks` into this module and call nothing themselves. Awaiting the hook
here also satisfies DECISIONS §9's "afterLink runs before the success page renders", because the
route is awaiting `linkAccount`.

After `db.transaction()` RESOLVES (never inside it, or a hook that reads the pull plane sees a
snapshot that may still roll back), invoke:

- `afterUnlink` for the displaced row on a relink, then `afterLink` for the new row. That order
  mirrors the outbound event order in DECISIONS §5.
- `afterUnlink` for `unlinkAccount`.

Each call is bounded by `ACCOUNT_LINK_HOOK_TIMEOUT_MS` (PRD 01) via `Promise.race` against a
timer, wrapped in try/catch, and a failure logs `logger.warn("accountLink afterLink threw", { … })`
and continues. Copy the posture and the log shape from
`packages/engine/src/cold-connect/index.ts:222-233`. Never let a hook failure change the returned
result: the write committed, and reporting failure would make the caller retry a completed
mutation.

`beforeLink` is NOT invoked here. Add an explicit comment saying so and pointing at PRD 07, so
nobody later "fixes" the asymmetry by moving the veto into the store, where it would run after the
transaction opened and hold a lock across a customer's network call.

Tests: `afterLink runs after commit and sees its own row`,
`afterLink throwing does not fail the link`, `afterLink exceeding 5s does not fail the link`,
`relink invokes afterUnlink before afterLink`, `the store never invokes beforeLink`, and the
counting one: `a successful linkAccount invokes afterLink exactly once` — a counter hook asserted
`toBe(1)`, not `toHaveBeenCalled()`. PRD 07 owns the end-to-end sibling
(`a successful callback invokes afterLink exactly once`); this is the unit-level half. A
"was it called" assertion passes just as happily when the hook fires twice, which is the exact bug
DECISIONS §15.4 exists to close.

### T7 — The genuine concurrency test
_Boundary:_ `apps/api`
_Depends:_ T2-T5

`apps/api/src/__tests__/account-link-store-concurrency.test.ts`, against the real test database.
This is the test the whole PRD exists for, so it must be a real race, not a simulated one.

- Build TWO independent database handles (two `createHogsendClient` containers, or two
  `postgres()` clients) so the two mutations occupy different connections and can genuinely
  interleave. A single connection serializes for free and would certify nothing.
- Fire N concurrent `linkAccount` calls (N >= 8) for the SAME `(provider, providerUserId)` with
  DIFFERENT target contacts, all with `allowDisplaceLiveOwner: true`, via `Promise.all`.
- Assert: exactly ONE live row for the pair; the multiset of versions across all rows for the pair
  is exactly `1..k` with NO duplicates and NO gaps; every row's `version` is unique; the surviving
  live row holds the highest version.
- A second case fires concurrent `linkAccount` + `unlinkAccount` for the same pair and asserts the
  same version invariants.
- A third case fires concurrent mutations for DIFFERENT pairs and asserts they do not serialize
  (assert on completion, not on wall-clock timing, which is flaky in CI: assert both succeeded and
  each got `version = 1`).
- **A fourth case is the mirror-image singleton swap**, the one the T3 lock ordering exists for.
  Two contacts C1 and C2, two pairs A and B, a `multiple: false` / `onConflict: "replace"` provider.
  Seed it so pair A is live-owned by C2 AND held as C2's singleton, while pair B is live-owned by C1
  AND held as C1's singleton. Then fire concurrently, on two connections, C1 linking A and C2
  linking B, both with `allowDisplaceLiveOwner: true` (two players swapping platform accounts). It
  must not surface `40P01`, must leave exactly one live row per pair, and must leave no duplicate
  versions. Run it in a loop of at least 20 iterations, since a deadlock is timing-dependent and one
  pass proves little. **Mutation guard:** move the second `lockPairs` key acquisition back inside
  the T4 branch (the staged form) and this case must start failing with `40P01`. Record the
  observation in Implementation Notes.
- A fifth case pins `expectContactId`: `a revoke racing a relink does not unlink the new owner's
  link`. Contact A holds pair P; fire A's `unlinkAccount({ expectContactId: A })` concurrently with
  a displacing `linkAccount` moving P to contact B, repeated enough times to hit both orderings.
  Whichever wins, the end state must never be "B's fresh link was unlinked by A's revoke": either
  A's unlink lands first and B's link then supersedes it, or B's link lands first and A's unlink
  returns `not_owner` having mutated nothing. **Mutation guard:** dropping `expectContactId` from
  the call must make it fail.

**A guard without a test that fails when the guard is removed is a vacuous green** (DECISIONS §4).
So this task is not done until the builder has, by hand, commented out the `lockPairs` call in T2,
re-run this suite, and OBSERVED it fail (duplicate versions or a 23505 escaping). Record that
observation in Implementation Notes. If the suite still passes without the lock, the test is
measuring nothing and must be strengthened (raise N, add a jitter delay between the version read
and the insert behind a test-only seam) before the PRD is accepted.

Namespacing: every contact and `providerUserId` this suite creates carries a per-run prefix, and
`afterAll` deletes exactly that namespace, following
`apps/api/src/__tests__/resolve-policy-trusted-kinds.test.ts:43-70`.

### T8 — Changeset
_Boundary:_ `.changeset`
_Depends:_ T1-T7

Minor changeset for `@hogsend/engine`.

## Seams
None. The store is provider-agnostic: every test drives it with a hand-built `LinkedIdentity`, so
no Steam or Twitch credential is required. Real credentials are the PRD 07 seam.

## Done when
- [ ] `packages/engine/src/lib/account-links.ts` exists and is the ONLY module in the repo that
      writes `linked_accounts`. Verify: `grep -rn "linkedAccounts" packages/engine/src | grep -v
      "lib/account-links.ts"` shows reads only (and, after PRD 04, the merge repoint).
- [ ] Every mutation runs inside one transaction that took EVERY pair advisory lock it will need,
      sorted, as its FIRST statement. No `lockPairs` call appears after the first SELECT against
      `linked_accounts`.
- [ ] `40P01` and `40001` are in the retryable set alongside the version-index 23505.
- [ ] The mirror-image singleton-swap concurrency case passes, AND has been observed to fail with
      `40P01` under the staged-locking mutation. The observation is recorded in Implementation
      Notes.
- [ ] `expectContactId` is evaluated inside the locked transaction and has a test that fails when
      the argument is dropped at the call site.
- [ ] Every successful result carries `owner: { contactId, userId, email }`, read inside the
      transaction, with `userId` computed by the `contactKey()` rule.
- [ ] `afterLink`/`afterUnlink` are invoked here and NOWHERE else:
      `grep -rn "afterLink\|afterUnlink" packages/engine/src | grep -v "lib/account-links.ts"`
      returns only type imports and comments.
- [ ] The version is computed as `COALESCE(MAX(version), 0) + 1` over all rows for the pair, live
      and unlinked, inside the lock.
- [ ] The concurrency suite passes, AND has been observed to FAIL with the advisory lock removed.
      The observation is recorded in Implementation Notes.
- [ ] No plaintext token appears in any column, log line, error message, or the
      `LinkedAccountRecord` shape.
- [ ] `version` is typed `string` in every exported type, and
      `grep -n "parseInt\|Number(" packages/engine/src/lib/account-links.ts` returns nothing on a
      version path. The above-`MAX_SAFE_INTEGER` round-trip test passes.
- [ ] `unlinkAccountInTx` is exported, takes a caller's `tx`, and PRD 04 can call it without
      opening a nested transaction.
- [ ] `pnpm lint` green.
- [ ] `pnpm check-types` green.
- [ ] `cd apps/api && pnpm test` green.
- [ ] `pnpm build` green.
- [ ] A changeset exists for `@hogsend/engine`.
- [ ] One conventional commit, e.g. `feat(engine): add the account link store`.

## Implementation Notes

### Mutation-guard observations (the PRD requires these to be recorded)

All three were performed by hand against `growthhog_test`, with the module restored byte-identical
afterwards and the suite re-run green each time.

1. **The advisory lock (T2/T7).** Commenting out `await lockPairs(tx, lockedKeys)` inside
   `linkAccount`'s transaction fails **3 of the 5** concurrency cases — including the N=10 same-pair
   race (duplicate/gapped versions) and the `expectContactId` revoke race, which starts returning
   `relinked` where it must return `linked`. The suite is therefore measuring the lock, not the
   happy path.
2. **Up-front sorted locking vs the staged form (T3/T7 case 4).** Reducing the first statement to
   `lockPairs(tx, [targetKey])` and acquiring the singleton pair's lock LATE, inside the T4 branch
   once the probe revealed it, makes `mirror-image multiple:false replaces never deadlock` fail —
   and it fails by BLOCKING: the case runs 25.4s (against ~0.9s for the whole suite normally) as the
   two transactions wait on each other before Postgres breaks the cycle. This is the concrete
   evidence for the design decision in T3 step 0: the pre-read exists so the full lock set is known
   before the first lock is taken.
3. **`40001` in the retryable set (T5).** Narrowing `pg.code === "40P01" || pg.code === "40001"` to
   just `40P01` fails exactly one test, `retries a 40001`. That test was ADDED during review — the
   delivered suite covered `40P01` only, so deleting the `40001` half of the OR was a silent no-op,
   which is the vacuous green DECISIONS §4 forbids. The two codes now have one case each.

### Review decisions

- **The engine's public surface was narrowed.** `lockPairs`, `pairLockKey`,
  `MAX_VERSION_RACE_RETRIES` and `AccountLinkLockSetChangedError` were initially exported from
  `packages/engine/src/index.ts`, which is the committed semver boundary. They are internal
  mechanics — how the store happens to take advisory locks, and an internal retry signal — so they
  moved to the existing `@hogsend/engine/testing` subpath, which is the house pattern for exactly
  this (`journey-variant.test.ts` uses it). The lock-ORDER tests import them from there.
- **`provider-credentials.ts` exposes one name per operation.** The first cut exported
  `encryptJson`/`decryptJson` AND added `sealJson`/`unsealJson` aliases — four public names for two
  functions. The raw names went back to module-private; the two aliases are the whole external
  surface, since they are what the store actually imports.
- **A 16-finding adversarial review panel confirmed nothing.** That ratio was itself investigated
  rather than accepted: the refutations were read individually. They hold up — most findings were
  either scope boundaries the PRD draws explicitly (the `revoke()` leg and its tests belong to
  PRD 14 T6 by name), stale by timing (the T7 file was being written while the panel read), or
  correct-but-not-defects. Two were worth recording:
  - The claim that the singleton `replace` branch ignores `allowDisplaceLiveOwner` and so breaks
    insert-only import is **refuted**: that branch displaces a row belonging to the REQUESTING
    contact on a different pair, whereas the flag governs taking the target pair from a DIFFERENT
    contact. The import boundary is enforced in PRD 09's route, which already has the named test.
  - The claim that plaintext `identity.tokens` leaks into the customer `afterLink` hook is
    **refuted**: `AfterLinkContext extends BeforeLinkContext`, whose `identity: LinkedIdentity` is
    the locked PRD 01 contract, and the hook is the consumer's own in-process function in the same
    process whose provider minted those tokens. No trust boundary is crossed. The
    "blob never leaves this module" invariant is scoped to the SEALED DB column, which is separate.

### Pre-existing test failures (not caused by this PRD)

The full `apps/api` suite has two failures that reproduce on a clean tree with this work stashed:
`health-activity.test.ts` (fails identically at HEAD) and `gtm-score-batch.test.ts` (passes alone in
4.6s, times out at 30s under full-suite load — contention). The two new suites total 7.8s and are
not the cause. Both are left alone deliberately; fixing them is not this PRD's scope.
