# PRD 08 — Outbound events + catalog sync

## Goal
Add `account.linked`, `account.unlinked` and `account.link_failed` to the outbound spine with
full-current-state versioned payloads, ride the existing `webhook_deliveries.dedupeKey` index, keep
all THREE hand-synced catalog copies in agreement, and re-ingest the two state events onto the
journey plane as scalar-only properties so a journey can trigger on them.

## Locked decisions specific to this PRD
- DECISIONS §5.2: every outbound payload carries FULL CURRENT STATE, never a delta, including
  `{ state: "linked" | "unlinked", version, … }`.
- DECISIONS §5.5: producer-side dedupe is
  `webhook_deliveries.dedupeKey = "al:<provider>:<uid>:v<version>"`, riding the existing
  `(endpointId, dedupeKey)` partial-unique index (`packages/db/src/schema/webhook-deliveries.ts:53-56`).
- DECISIONS §8: exactly three events, appended to `WEBHOOK_EVENT_TYPES`
  (`packages/engine/src/lib/webhook-signing.ts:57`) and hand-synced into
  `packages/cli/src/commands/webhooks.ts:12` and `packages/client/src/types.ts:501`.
- DECISIONS §8: emitted from the commit / intent layer ONLY, never the ingest path. This mirrors the
  locked `group.*` rule, whose implementation is `routes/groups/index.ts:276`, `:332`, `:381`.
- **ONE OWNER PER EMIT SITE, and the store is not one of them** (DECISIONS §15.7). PRD 03's
  `lib/account-links.ts` NEVER calls `emitOutbound`: it returns the mutation facts (including the
  `owner` block) and its callers emit. This matches the repo precedent exactly — `lib/groups.ts`
  never emits, `routes/groups/index.ts` does — and it is the rule PRD 03 already states at its own
  head. An earlier draft put the emit inside the store AND at the routes; the duplicate would have
  been INVISIBLE, because `emitOutbound` does `.onConflictDoNothing({ target: [endpointId,
  dedupeKey] })` on the shared `al:<provider>:<uid>:v<version>` key, so PRD 09's
  `emits exactly one account.unlinked` test would have passed for entirely the wrong reason.
  The emit-site table below is exhaustive; anything not in it does not emit.
- DECISIONS §8: event properties are scalars only. Journeys branch on `eventProperties`, never
  `contactProperties`.
- DECISIONS §8: `account.link_failed` carries NO version and NEVER mints a contact.
- DECISIONS §8: `account.link_started` and `account.updated` are rejected. Do not add a fourth event.
- PRD 01 froze `AccountLinkCallbackError.reason` as exactly
  `"denied" | "exchange_failed" | "state_invalid"`, deliberately the `account.link_failed` reason
  union minus `"vetoed"` (which only the hook path can produce). So the emit is
  `reason: err.reason` with no translation table, and adding a fourth error reason in core is a
  breaking change to this event.

## Payloads

Typed into `OutboundPayloads` in `packages/engine/src/lib/outbound.ts` (the map starting at `:79`).

```ts
"account.linked": {
  state: "linked";
  provider: string;          // AccountLinkProvider meta.id
  providerUserId: string;
  contactId: string;
  userId: string | null;     // contactKey(): external_id ?? anonymous_id ?? id
  email: string | null;      // the CONTACT's email, not the provider-reported one
  username: string | null;   // provider display name
  method: "oauth" | "import";
  relink: boolean;           // true when this displaced a different live owner
  version: string;           // bigint as a decimal STRING (see below)
  at: string;                // ISO 8601
};

"account.unlinked": {
  state: "unlinked";
  provider: string;
  providerUserId: string;
  contactId: string;
  userId: string | null;
  email: string | null;
  reason: "player" | "api" | "relinked";
  version: string;
  at: string;
};

"account.link_failed": {
  provider: string;
  reason: "denied" | "vetoed" | "exchange_failed" | "state_invalid";
  contactId: string | null;
  at: string;
  // NO version, NO state: nothing mutated.
};
```

**`version` is a decimal STRING, not a number.** `linked_accounts.version` is `bigint NOT NULL`
(DECISIONS §5.1) and JSON numbers lose integer fidelity past `Number.MAX_SAFE_INTEGER`. The customer
rule in DECISIONS §5.3 is a `>` comparison, so the docs (PRD 16) must state that a subscriber
compares with `BigInt()` or a numeric column, never `parseInt`. Serialize with
`String(row.version)`.

This is ONE representation across all three planes, not a quirk of the push plane: PRD 01's hook
contexts (`AfterLinkContext.version`, `AfterUnlinkContext.version`), PRD 03's store results, PRD 09's
route responses, PRD 12's SDK types and PRD 15's admin reads all type it `string` too (DECISIONS
§5.1). A hook that receives a rounded version and writes it into the consumer's own DB, which
DECISIONS §3.2 says is exactly what the in-process plane is FOR, would compare wrong forever. The
failure does not wait for 2^53 real links either: it arrives the first time anyone seeds a high
version in a test or the generator is changed to something snowflake-shaped.

`email` on the two state events is the CONTACT's email, never the provider-reported one. Provider
email is at most a display property (DECISIONS §6.3 / §6.4), and putting it in a field named `email`
next to `contactId` is exactly how a downstream system ends up resolving on it.

**`userId` and `email` come from the store's `owner` block, and from nowhere else** (DECISIONS
§15.5). Neither field exists on `linked_accounts`, so an earlier draft of this PRD required two
fields with no specified source: a delivery agent would have shipped `userId: null, email: null`
(which passes every test enumerated below) or bolted an unspecified join on at emit time. PRD 03 T1
now returns `owner: { contactId, userId, email }`, read by a join to `contacts` INSIDE the
advisory-locked transaction, which is also what makes the payload a true point-in-time full state
rather than a re-read after the lock released. Every emit site takes those three values verbatim.

**`userId` has ONE definition across all three planes: `contactKey()`**, i.e.
`external_id ?? anonymous_id ?? id` (`engine/src/lib/contacts.ts:863-865`). Not raw `externalId`. PRD
01's hook contexts, PRD 09's route responses and PRD 12's SDK types all use the same rule. If the
PUSH plane said `externalId` while the IN-PROCESS plane said `contactKey()`, then for every contact
with a null `externalId` the two planes would emit different values under the same field name, and a
consumer joining PULL/PUSH/IN-PROCESS on `userId` would mismatch on exactly the anonymous contacts
this feature creates most of (cold Steam links).

## Emit points, and the ones that are deliberately NOT emit points

Each row names exactly ONE file. The table is exhaustive.

| Emit | Where (the one owner) | Built by | dedupeKey |
| --- | --- | --- | --- |
| `account.linked`, and `account.unlinked` first on a relink | PRD 07's callback handler, `routes/accounts/callback.ts`, from the facts `linkAccount()` returned | T4 | `al:<provider>:<uid>:v<version>`; a relink is TWO emits at the two distinct versions from the one transaction, monotonic |
| `account.linked` | PRD 09 `POST /v1/accounts/import`, per inserted row | PRD 09 T5 | same key shape, `method: "import"` |
| `account.unlinked` | PRD 09's `DELETE /v1/accounts/:provider/:providerUserId` and `POST /v1/accounts/me/revoke` | PRD 09 T4 / T8b | `al:<provider>:<uid>:v<version>` |
| `account.unlinked` | PRD 11's manage-page revoke | PRD 11 T4 | `al:<provider>:<uid>:v<version>` |
| `account.unlinked` | PRD 04's merge, for a SINGLETON-COLLISION soft-unlink, AFTER the merge transaction commits, off the mutation facts the merge returns | T3 | `al:<provider>:<uid>:v<version>`, `reason: "relinked"` |
| `account.unlinked` | PRD 04's contact DELETION leg, one per live link, after the delete transaction commits, off the facts `unlinkAccountsForContactInTx` returns (DECISIONS §15.3) | T3 | `al:<provider>:<uid>:v<version>`, `reason: "api"` |
| `account.link_failed` | PRD 07's callback handler, at each of the four rejection points | T4 | **none** (see below) |

NOT emit points, and each needs a comment where a future reader would expect one:
- **PRD 03's store, `lib/account-links.ts`.** It returns facts; its callers emit. This is the
  `lib/groups.ts` precedent and DECISIONS §15.7. A store emit plus a route emit for the same
  mutation is silently deduped by the `(endpointId, dedupeKey)` index, so the duplicate does not
  fail a test, it just costs a wasted build cycle and hides which layer owns the fact.
- `ingestEvent` and any journey-plane re-ingest. The `group.*` precedent is explicit that the intent
  layer emits and the ingest path does not.
- PRD 04's merge REPOINTING. Moving a link to the surviving contact of a merge is not a new identity
  fact, and emitting from there would double-report every merge. The merge's SINGLETON-COLLISION
  soft-unlink is a different thing and IS an emit point (the row added to the table above): that one
  really did end a link, at its own new version, and a consumer that never hears about it records
  the wrong owner forever.
- `adoptOrphanHistory`. Not because it must stay quiet, but because it never touches
  `linked_accounts` at all: `contact_id` is `NOT NULL` there and the function only stamps rows whose
  `contact_id IS NULL`, so it is a proven no-op (DECISIONS §7, PRD 04 T3). There is nothing to
  emit.
- PRD 14's property-sync cron and `tokens_revoked_at` write. DECISIONS §8 rejected `account.updated`
  precisely so this stays quiet; a customer who cares reads `tokensRevokedAt` from the pull plane.

**`account.link_failed` gets no dedupeKey.** It has no version, so there is no monotonic value to key
on, and a NULL `dedupeKey` is never blocked because Postgres treats multiple NULLs as distinct
(`webhook-deliveries.ts:51-52`, and `outbound.ts:506-507` says the same). Two genuine failures in a
row are two genuine facts, and suppressing the second would hide a brute-force pattern.

## Acceptance criteria (EARS)

- WHEN `linkAccount()` commits, the system SHALL emit `account.linked` with
  `dedupeKey = "al:<provider>:<providerUserId>:v<version>"` and a payload carrying the FULL current
  state.
- WHEN the same `linkAccount()` emit runs twice with the same version (a retry), the system SHALL
  insert no second `webhook_deliveries` row, via the existing `onConflictDoNothing` on
  `(endpointId, dedupeKey)` (`outbound.ts:576-578`).
- WHEN a relink occurs, the system SHALL emit `account.unlinked` then `account.linked` with two
  DISTINCT, strictly increasing versions, and the unlinked payload SHALL carry `reason: "relinked"`.
- WHEN an emit fails for any reason, the system SHALL NOT fail the link. `emitOutbound` already never
  throws (`outbound.ts:508-518`); every call site SHALL still be written as
  `void emitOutbound(…).catch(logger.warn)` per that contract.
- WHEN `account.link_failed` is emitted for an unresolvable contact, the system SHALL send
  `contactId: null` and SHALL NOT create a `contacts` row by any path.
- WHEN the engine catalog gains the three events, the system SHALL keep
  `packages/cli/src/commands/webhooks.ts` and `packages/client/src/types.ts` in exact set agreement,
  enforced by the EXISTING drift test at
  `packages/engine/src/lib/webhook-catalog-sync.test.ts:98-112`.
- WHEN a journey declares
  `defineJourney({ meta: { trigger: { event: "account.linked", where: b => b.prop("provider").eq("steam") } } })`,
  the system SHALL enroll that journey on a Steam link and SHALL NOT enroll it on a Twitch link.
- WHEN the two state events re-ingest onto the journey plane, every property the journey can branch
  on SHALL be a scalar (`string | number | boolean | null`), with no nested object or array.
- WHEN `account.link_failed` re-ingests, the system SHALL pass `allowCreate: false` so a failed link
  can never mint a contact.

## Replay safety (state it in the code, not just here)

Linking happens in **route-handler runtime** (PRD 07's callback, PRD 09's data plane), not inside a
Hatchet durable task. So:

- Nothing new enters the Hatchet journal. The positional-journal law that governs `ctx.sleep` /
  `ctx.waitForEvent` / the digest and throttle primitives does not apply here, because no durable
  call is being added to any journey's replay sequence.
- The exactly-once machinery in the tracked mailer (auto-keying off the replay-stable Hatchet run id)
  is not involved and must not be reached for. The idempotency here is DB-level: the advisory lock
  plus the `(provider, provider_user_id, version)` unique constraint from DECISIONS §5.6, plus the
  `(endpointId, dedupeKey)` index on the outbound side.
- `hatchet.events.push` DOES happen, via the journey-plane re-ingest below, but that is the same
  push every ingest performs and it carries an `idempotencyKey`, so a retried callback routes at most
  one enrollment.
- A journey that reacts to `account.linked` is a normal event-triggered journey and obeys every
  existing replay law unchanged. Nothing in this PRD relaxes them.

Put this paragraph, compressed, as a comment above the emit block in `lib/account-link-events.ts`
(T3), because the next person to read it will be looking for the durable-task keying and needs to be
told there is none.

## Tasks

### T1 — Catalog: engine + both vendored copies, in ONE commit
_Boundary:_ `packages/engine`, `packages/cli`, `packages/client`
_Depends:_ —

This is deliberately one task across three packages, against the usual one-package boundary, because
splitting it is precisely the failure mode DECISIONS §8 calls out and the drift test exists to catch.

1. Append `"account.linked"`, `"account.unlinked"`, `"account.link_failed"` to `WEBHOOK_EVENT_TYPES`
   (`packages/engine/src/lib/webhook-signing.ts:57-107`), after the `group.*` block and before
   `impact.digest`, with a doc paragraph in the file header comment in the voice of the `group.*`
   paragraph at `:97-100`: what they mean, and that they are emitted from the intent layer only.
2. Append the same three to `packages/cli/src/commands/webhooks.ts:12-44`. Update the "31-event
   outbound catalog" count in that file's docstring at `:6-11`.
3. Append the same three to the `OutboundEventType` union at `packages/client/src/types.ts:501-527`.
4. Add to `packages/engine/src/lib/webhook-catalog-sync.test.ts` a presence test mirroring the
   `contact.refined` one at `:83-96`:
   ```
   test("AC: the three account.* events are present in ALL THREE hand-synced catalogs", …)
   ```
   asserting each of the three in each of the three catalogs, nine assertions, each with the file
   name in its message. The two set-equality tests at `:98-112` already cover drift generically; the
   named test exists so the failure message says `account.linked` rather than a diff.

Verify the existing regex in that test file handles the new names before trusting it: it is
`/"([a-z]+\.[a-z_]+)"/g` (`webhook-catalog-sync.test.ts:47`), which matches `account.linked`,
`account.unlinked` and `account.link_failed`. Confirm this with a run, not by reading.

Gate: `pnpm --filter @hogsend/engine test` must fail if any ONE of the three files is left unedited.
Prove it by omitting the client edit locally, watching the test fail, then restoring.

### T2 — Payload types
_Boundary:_ `packages/engine`
_Depends:_ T1

Add the three entries to `OutboundPayloads` in `packages/engine/src/lib/outbound.ts` (the interface
opening at `:79`), each with a docstring stating the full-current-state rule and the exact customer
guard from DECISIONS §5.3 verbatim: *upsert keyed on `(provider, providerUserId)`; apply only when
`incoming.version > stored.version`; otherwise discard.*

Note in the `version` field docstring that it is a decimal string because the column is `bigint`.

Test `packages/engine/src/lib/outbound-account-payloads.test.ts`:
- `an account.linked payload type-checks with every documented field`
- `version serializes as a string, not a number` (a runtime assertion on the built payload, since a
  type test alone would not catch `Number(row.version)`)
- `a version above Number.MAX_SAFE_INTEGER round-trips through the payload without loss` — build a
  payload from a row whose version is `9007199254740993n`, `JSON.stringify` it, parse it back, and
  assert the field is exactly `"9007199254740993"` (DECISIONS §5.1)

### T3 — The shared emit helpers, plus the merge and delete emit sites
_Boundary:_ `packages/engine`
_Depends:_ T2, 03, 04

New file `packages/engine/src/lib/account-link-events.ts` — the ONE place a payload and a dedupe key
are built, so the six emit sites across four PRDs cannot drift:

```ts
export function buildDedupeKey(provider: string, providerUserId: string, version: string): string;
export function buildAccountLinkedPayload(facts: LinkAccountResult & { … }): OutboundPayloads["account.linked"];
export function buildAccountUnlinkedPayload(facts: { … owner: LinkOwner … }): OutboundPayloads["account.unlinked"];
export function buildLinkFailedPayload(args: { provider: string; reason: …; contactId: string | null }): OutboundPayloads["account.link_failed"];
```

`version` is a string in, string out; it is never parsed. `userId` and `email` are read off the
`owner` block the store returned and are never looked up here.

Every call site (in this PRD and in 09 and 11) uses the shape at `routes/groups/index.ts:276-282`:

```ts
void emitOutbound({
  db, hatchet, logger,
  event: "account.linked",
  payload: buildAccountLinkedPayload(facts),
  dedupeKey: buildDedupeKey(provider, providerUserId, version),
}).catch(logger.warn);
```

including the `void … .catch(logger.warn)` defence-in-depth the `emitOutbound` docstring asks for
(`outbound.ts:512-514`).

**This task also owns the two PRD 04 emit sites**, because PRD 04 ships before this one and
deliberately only RETURNS facts:

1. The merge's singleton-collision unlink, emitted from the merge's caller after the transaction
   commits, off the mutation facts on the merge result. It cannot emit from inside
   `foldLinkedAccounts`: that runs inside the merge transaction, and DECISIONS §8 puts emission at
   the commit/intent layer so a rolled-back merge cannot have announced an unlink that never
   happened.
2. The contact-deletion leg (DECISIONS §15.3), one `account.unlinked` per row with `reason: "api"`,
   emitted after `softDeleteContact` / the admin delete route's transaction commits, off the facts
   `unlinkAccountsForContactInTx` returned. Without this a customer's mirror records a deleted player
   as still linked, forever.

**`grep -n "emitOutbound" packages/engine/src/lib/account-links.ts` must return ZERO hits**, and this
PRD adds a test asserting exactly that, so the store-emit variant cannot come back invisibly.

Tests `packages/engine/src/lib/account-links-emit.test.ts` and
`apps/api/src/__tests__/account-link-merge.test.ts`:
- `buildDedupeKey escapes nothing and is a pure template` (a regression pin, so nobody adds
  URL-encoding to it later and silently breaks dedupe across versions)
- `buildAccountLinkedPayload carries owner.userId and owner.email, not the provider email`
- `the store module contains no emitOutbound call` (source grep assertion)
- `a merge singleton-collision unlink emits one account.unlinked with reason "relinked"`
- `a rolled-back merge emits nothing`
- `deleting a contact emits one account.unlinked per live link with reason "api"`
- `a duplicate emit at the same version inserts no second delivery row`
- `an emit failure does not fail the mutation`

### T4 — The callback emits: `account.linked` and `account.link_failed`
_Boundary:_ `packages/engine`
_Depends:_ T2, T3, 07

In `packages/engine/src/routes/accounts/callback.ts`:

- On a successful `linkAccount`, emit `account.linked` from the returned facts. On a relink, emit
  `account.unlinked` (the displaced owner, at the LOWER version) FIRST, then `account.linked`. That
  order is what makes the consumer's monotonic guard land correctly if the two deliveries arrive out
  of order: `N+1` is not greater than `N+2`, so the late unlink is discarded rather than permanently
  recording the wrong owner.
- Four `account.link_failed` call sites, one per reason. No dedupeKey. `contactId` is the sealed
  state's `contactId` when the state verified, and `null` in the `state_invalid` case, since a state
  that did not verify carries nothing trustworthy. On the COLD path it is `null` before the resolve
  and the resolved id after it.

Test `apps/api/src/__tests__/accounts-link-failed-emit.test.ts`:
- `state_invalid emits with contactId null`
- `vetoed emits with the sealed contactId`
- `a link_failed emit creates no contacts row` (count the table before and after; this is the
  DECISIONS §8 "never mints a contact" guard, and counting is what makes it non-vacuous)
- `a successful callback emits exactly one account.linked` (count delivery rows for a seeded
  endpoint; `toHaveLength(1)`, never `toBeGreaterThan(0)`)
- `a relink emits unlinked at the lower version before linked at the higher one`

### T4b — Register the delivery-asserting tests in the `WEBHOOK_FANOUT` barrier
_Boundary:_ `apps/api`
_Depends:_ T4

`apps/api/vitest.config.ts` runs most test files in parallel, but `emitOutbound` selects webhook
endpoints GLOBALLY (`lib/outbound.ts:515-516`, `isNull(webhookEndpoints.organizationId)`) and writes
one delivery row per endpoint (`:566`). Any test that seeds a global endpoint and counts `account.*`
delivery rows therefore sees rows produced by any OTHER file emitting the same events concurrently,
and an endpoint-scoped `toHaveLength(1)` intermittently sees 2. That is what the serial
`WEBHOOK_FANOUT` project (`vitest.config.ts:20`, `:127-140`) exists for; the file's own rationale is
at `:2-38`.

Append every new test file that **seeds a webhook endpoint and asserts on delivery rows** to
`WEBHOOK_FANOUT`, with a one-line comment naming why. As of this PRD that is:

- `accounts-link-failed-emit.test.ts` (T4)
- `accounts-callback.test.ts` (PRD 07: it emits four `account.link_failed` reasons and now counts
  `account.linked`)
- `accounts-journey-trigger.test.ts` (T5)

Do NOT add pure emitters that assert nothing about deliveries. Emitting is not the membership
criterion; the config's `rg -l` line is a drift HINT, not a derivation, and it already matches
several files that are deliberately absent (`mailer.test.ts`,
`contact-scoped-uniqueness.test.ts`, `contact-id-dualwrite-preferences.test.ts`).

**PRDs 09 and 11 must re-run this step** for any delivery-asserting file they add
(`accounts-dataplane.test.ts`, the manage-page revoke test). Their Done-when lists carry the same
line.

Test: run `cd apps/api && pnpm test` twice; a delivery-count assertion that is order-dependent will
surface. Also confirm the file appears in the `WEBHOOK_FANOUT` array and not only in the comment.

### T5 — Journey plane re-ingest
_Boundary:_ `packages/engine`
_Depends:_ T3

Alongside each outbound emit, re-ingest onto the journey plane via `ingestEvent`
(`packages/engine/src/lib/ingestion.ts:331`) so `defineJourney({ trigger: { event: "account.linked" } })`
works with no new machinery.

```ts
await ingestEvent({
  db, registry, hatchet, logger, analytics,
  event: {
    event: "account.linked",
    userId: contactExternalId ?? undefined,
    eventProperties: {
      provider,            // string
      providerUserId,      // string
      username,            // string | null
      method,              // "oauth" | "import"
      relink,              // boolean
      version,             // string
      state: "linked",     // string
    },
    source: "account_link",
    idempotencyKey: `al:${provider}:${providerUserId}:v${version}`,
  },
});
```

Rules:
- **Scalars only** in `eventProperties`. No `raw`, no nested provider profile, no arrays. DECISIONS
  §8, and the same correction already written into the cold-connect config docs
  (`packages/engine/src/cold-connect/index.ts:45-49`): a property a journey branches on MUST be a
  scalar `eventProperties` entry, because `contactProperties` never reach the Hatchet payload.
- The `idempotencyKey` reuses the dedupe key, so a retried callback routes at most one enrollment.
  This is the `cc:confirm:` idiom (`cold-connect/index.ts:216`).
- `account.link_failed` re-ingests with `allowCreate: false` (`ingestion.ts:363-376`), which is what
  structurally enforces "never mints a contact" rather than relying on the caller passing no identity.
- This is a re-ingest, NOT a second emit. `emitOutbound` is called once, from the intent layer, and
  the ingest path never emits. Comment that explicitly at the call site, because two calls sitting
  next to each other is exactly how someone later "simplifies" one into the other.

Tests `apps/api/src/__tests__/accounts-journey-trigger.test.ts`:
- `a journey triggered on account.linked enrolls on a link`
- `a where clause on provider selects steam and skips twitch` (the DECISIONS §8 headline case)
- `every eventProperty is a scalar` (iterate and assert `typeof`, so a future field addition of an
  object fails here rather than silently in a journey)
- `a repeated ingest at the same version enrolls once`
- `account.link_failed does not create a contact`

### T6 — Changesets
_Boundary:_ `packages/engine`, `packages/cli`, `packages/client`
_Depends:_ T1 to T5

Three changesets, or one changeset naming all three packages: `@hogsend/engine` minor,
`@hogsend/cli` minor, `@hogsend/client` minor. All three have a public-surface change (the catalog is
public surface on all three), so all three need `pnpm build` per DECISIONS §4.

## Seams
None. Nothing here needs a real credential or a real subscriber endpoint. The delivery spine is
already built and tested.

## Done when
- [ ] The three events are in `WEBHOOK_EVENT_TYPES`, in the CLI tuple, and in the client union.
- [ ] `webhook-catalog-sync.test.ts` has a named account.* presence test and was PROVEN to fail with
      any one copy left unedited.
- [ ] The CLI docstring's event count is updated.
- [ ] `OutboundPayloads` carries the three typed payloads, `version` as a decimal string, with the
      verbatim customer guard in the docstring.
- [ ] Emits are at the intent layer only, one owner per site per the emit table, with
      `lib/account-link-events.ts` as the single payload + key source.
- [ ] `grep -n "emitOutbound" packages/engine/src/lib/account-links.ts` returns nothing, asserted by
      a test.
- [ ] `userId` and `email` on both state payloads come from the store's `owner` block, with a test
      asserting they are the contact's key and email rather than nulls or the provider-reported
      email.
- [ ] The contact-deletion leg emits one `account.unlinked` per live link.
- [ ] Every new delivery-asserting test file is registered in `WEBHOOK_FANOUT` in
      `apps/api/vitest.config.ts` with a comment.
- [ ] A relink produces two emits with strictly increasing versions, unlinked first.
- [ ] `account.link_failed` carries no version, no dedupeKey, and provably creates no contact.
- [ ] Both state events re-ingest with scalar-only properties and the dedupe key as
      `idempotencyKey`; a `where`-filtered journey trigger works.
- [ ] The replay-safety paragraph is a comment in the store, stating that linking is route-handler
      runtime and adds nothing to the Hatchet journal.
- [ ] Changesets added for `@hogsend/engine`, `@hogsend/cli`, `@hogsend/client`.
- [ ] `pnpm lint`
- [ ] `pnpm -C $WT/packages/<pkg> exec tsc --noEmit` for every package touched (NOT root `check-types` — vacuous, DECISIONS §4).
- [ ] `pnpm -C $WT exec turbo run test --filter='!@hogsend/api'` (the `exec` is load-bearing — DECISIONS §4).
- [ ] `cd apps/api && pnpm test`
- [ ] `pnpm build`
- [ ] `pnpm --filter @hogsend/engine test`

## Implementation Notes
