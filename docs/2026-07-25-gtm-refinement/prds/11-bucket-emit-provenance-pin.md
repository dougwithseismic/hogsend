# PRD 11 — Bucket transitions mint phantom contacts for anonymous visitors

**Depends on:** — · **Status:** `[ ]` · **Priority: P1** ·
**Tracked as [#608](https://github.com/dougwithseismic/hogsend/issues/608)**

## Goal

Stop `emitBucketTransition` from minting a duplicate contact row every time an anonymous-only
contact enters or leaves a bucket.

## Why

Found during PRD 07's review, **reproduced live** against the worktree database. It is **not caused
by this release** — every existing bucket (`power-users`, `went-dormant`, `trial-expiring-soon`) has
the same exposure, and has had it for as long as bucket transitions have re-ingested.

`emitBucketTransition` (`packages/engine/src/lib/bucket-emit.ts:118`) re-ingests every transition
through `ingestEvent` carrying `userId` + `userEmail` and **no `contactId`**:

```ts
await ingestEvent({
  db, registry, hatchet, logger,
  event: { event: eventName, userId, userEmail: userEmail ?? "", … },
});
```

`userId` here is the contact's canonical key — `COALESCE(external_id, anonymous_id, id)`. But
`resolveOrCreateContact` treats a bare `userId` as an **external** key: it probes
`contacts.external_id`, then `contact_aliases` filtered to `alias_kind = 'external'`, then a
uuid-shaped fallback against `contacts.id`. It **never probes `contacts.anonymous_id`**, and an
anonymous key is aliased under kind `anonymous`, so that leg misses too. All three miss, and the
create arm inserts a new row with `external_id` set to the anonymous id.

The engine already documents this exact hazard and its exact remedy at
`packages/engine/src/lib/contacts.ts:539-551` — `contactId` is the engine-internal provenance pin
that makes the resolver bind to a known row "instead of minting a phantom `external_id` twin".
`refineContact` passes it (`refine.ts:108`). `emitBucketTransition` does not.

**Reproduction** (captured while building PRD 07; an anonymous-only contact scored above the bar):

```
ROWS:
  { id: cbf69b14…, ext: null,             anon: "probe-…", src: null,     props: { gtmScore: 42 } }
  { id: 0e83ecb4…, ext: "probe-…",        anon: null,      src: "bucket", props: {} }
EVENTS: ["bucket:entered:gtm-qualified", "gtm.scored"]
```

The score write landed correctly (it carries the pin). The **bucket transition** minted the twin —
`source: "bucket"` names the producer.

### Blast radius

- **Anonymous-only contact, no email** — a phantom twin per bucket transition. The twin is empty, so
  it never satisfies criteria and never converges; it is pure table pollution plus a split identity.
- **Anonymous contact WITH an email** — no twin (the email key resolves), but `fillInLink` stamps a
  synthetic `external_id` equal to the anonymous id onto the real row, permanently mutating that
  contact's identity state as a side effect of a bucket transition.
- A browser visitor tracked with a publishable key and never identified is the **normal** shape here
  — `gatePublishableIdentity` (`routes/_shared.ts:52-53`) explicitly allows an anon-only write as
  "the secure default". This is not an exotic edge case.

## Locked decisions

- **Thread the resolved contact id; do not make `emitBucketTransition` look it up.** A lookup inside
  the emit adds a query per transition and re-derives something every caller already has or can get
  cheaply. `contactId` becomes an optional field on the emit options.
- **Optional, not required.** Seven call sites across three files; a required field would force every
  one to be correct in a single commit. Optional lets them be fixed and verified one at a time, and a
  caller that genuinely cannot supply it degrades to exactly today's behaviour.
- **Do not change `resolveOrCreateContact`.** Making it probe `anonymous_id` for a bare `userId`
  would change identity resolution for every public ingest path — a far larger blast radius than the
  bug. The pin is the sanctioned mechanism and it already exists.

## Acceptance criteria (EARS)

1. WHEN an anonymous-only contact enters a bucket the system SHALL record the transition against the
   existing contact row and SHALL NOT create a second contact.
2. WHEN an anonymous-only contact leaves a bucket the system SHALL behave as in AC 1.
3. WHEN a contact resolved by email has a bucket transition emitted the system SHALL NOT stamp a
   synthetic `external_id` onto that contact.
4. WHEN a transition is emitted from the reconcile cron or the backfill workflow the system SHALL
   carry the same provenance pin as the real-time path.
5. WHEN a caller cannot supply a contact id the system SHALL behave exactly as it does today (no
   regression for the external-id path, which is the overwhelming majority of rows).

## Tasks

### T11.1 — Accept the pin
_Boundary:_ `packages/engine/src/lib/bucket-emit.ts`

Add an optional `contactId?: string` to the emit options and thread it into all three `ingestEvent`
calls in that file (per-bucket alias, generic form, and any other). Nothing else changes.

_Test:_ a node:test asserting the pin is forwarded when present and omitted when absent.

### T11.2 — Supply it from the real-time path
_Boundary:_ `packages/engine/src/buckets/check-membership.ts` · _Depends:_ T11.1

Two call sites (~306 enter, ~395 leave). `checkBucketMembership` is called from `ingestEvent`, which
has already resolved the contact — thread the row id down rather than re-querying.

_Test:_ the AC 1 + AC 2 integration test. `apps/api/src/__tests__/gtm-qualified-ingest.test.ts`
already contains a test named **"KNOWN DEFECT (PRD 11)"** that pins the current buggy shape
(`toHaveLength(2)`). **That test is the target: it will fail when this lands.** Change it to
`toHaveLength(1)`, drop the twin assertions, and delete the defect docblock.

### T11.3 — Supply it from the cron and backfill paths
_Boundary:_ `packages/engine/src/workflows/` · _Depends:_ T11.1

Five call sites: `bucket-reconcile.ts` (~277, ~559, ~698, ~1075) and `bucket-backfill.ts` (~394).
These are the paths that could mint at scale — a reconcile sweep over a large anonymous population
would mass-produce twins. Both already select from `contacts`, so the id is at hand.

_Test:_ AC 4, against the reconcile path specifically.

### T11.4 — Clean up existing twins
_Boundary:_ `packages/db` or a one-shot workflow · _Depends:_ T11.2, T11.3

Any deploy that has run buckets against anonymous traffic already has these rows. Identify them
(`source = 'bucket'`, `external_id` matching another contact's `anonymous_id`, empty `properties`)
and merge or soft-delete them. **This one needs a human decision before it runs** — it is a data
migration against real rows, and merge-vs-delete is a product call, not a code call.

## Seams

**T11.4 needs an explicit go-ahead.** Everything else is ordinary in-repo work.

## Done when

Five acceptance criteria pass, the `KNOWN DEFECT (PRD 11)` test has been inverted to assert the
correct behaviour, and gates are green.

## Implementation Notes

_(filled in during build)_
