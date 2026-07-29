# PRD 07 — Demote the identity columns

> ## RESCOPED — demote, do not drop (senior review, 2026-07-28)
>
> **What changed.** The column DROP and the `contact_key` freeze that enabled it are CUT. Instead
> `anonymous_id` is demoted exactly as D3 already demotes `external_id`: a denormalized mirror,
> written for display and debugging, never read for resolution.
>
> **Why.** Dropping the column forced freezing the canonical key into a new column, and that freeze
> brought three problems the rest of the PRD then had to defend against:
> 1. the **re-stitch storm** (finding #1 of the first critique pass) — frozen `oldKey` versus
>    live-derived `newKey` makes the flip test permanently true;
> 2. the **flag/holdout re-bucketing risk**, which this PRD's own risk register rates highest;
> 3. a two-release drop choreography with a hard ordering constraint between T7 and T8.
>
> And the freeze is a **behaviour change smuggled into a migration**, which DECISIONS §4 bans
> outright: today a person's flag bucket re-rolls when their canonical key flips at identify;
> frozen-at-create means it never does. That may well be the better semantics — it is not this
> PRD's call to make silently. If we want stable bucketing, that is its own PRD with its own
> before/after evidence.
>
> **Price:** one unused column stays on `contacts`, and "the columns are gone" stays symbolically
> unfinished. Cheap.
>
> **Cut:** T2, T3, T5, T8, and every reference to `contacts.contact_key`.
> **Survives:** T1 (census), T4 (`NOT NULL` where provable), T6b (the straggler inventory — including
> the `collidesWithIdentified` ownership catch, which is the most valuable task in this PRD), T7
> (read/write demotion), T9 (changeset).
>
> The body below still describes the drop. Treat it as rationale for WHY the drop is hard, not as
> the task list. Re-spec the surviving tasks against this box before building.

## Re-spec (2026-07-29, BUILD) — the operative task list

Grounded in a fresh grep census and the production census (T1). The body below this section is
rationale only.

### T1 — census. DONE.

`scripts/identity-census.sql` (read-only; one statement) + `apps/api/src/__tests__/identity-census.test.ts`
(discriminating: baseline → run-namespaced fixtures → exact deltas, inside one REPEATABLE READ
transaction rolled back at the end, so the shared suite never sees the fixtures). Production numbers
are in Implementation Notes: **zero `contact_id` nulls on all five tables, alias parity clean,
totals tiny** — this repo's Railway deploy is the reference instance; real traffic lives in the
dogfood project's own stack. Consequence: the census gates nothing here. T4 is decided by the code
audit alone, and the same script is the tool an operator runs on a REAL deployment before trusting
the flip.

### T4 — comments + tests. NO migration.

The audit says `NOT NULL` is unreachable on ALL five tables, not just the three D4 predicted:

- `user_events`, `bucket_memberships`, `email_sends` — per D4 (refusal path; raw-address sends).
- `journey_states` — enrollment writes `contactId: opts.contactId ?? null`
  (`execute-journey-run.ts`); a refused anon event still reaches Hatchet, so a journey triggering on
  it enrolls a contactless subject. Supported, permanent.
- `email_preferences` — both writers accept `contactId: string | null` and the fallback
  `lookupContactIdByKey` can legitimately miss (`lib/preferences.ts`, `routes/admin/preferences.ts`).

So T4 ships: a D4 schema comment on each of the five `contact_id` columns naming its
null-producing writer, plus behaviour tests pinning the contactless write for `journey_states` and
`email_preferences` (the other three are already pinned by `observation-paths.test.ts` /
`observation-bucket-expiry.test.ts` / the raw-address send path).

### T6b — the security task: guards move onto the identity table.

Verified registry status: `contact_aliases` IS the full live-key registry — PRD 02 T3 backfill +
the resolve-time dual-write (`ALIAS_REASON_RESOLVE`) + the claim/merge writers. The row-uuid
pseudo-key is deliberately NOT aliased, so both guards keep their `eq(contacts.id, value)` PK arm.

Rework `collidesWithIdentified` and `keysAnotherContact` (`lib/contacts.ts`) to probe
`contact_aliases` IN ADDITION TO the identity columns — not instead of them. The rescope box said
"rather than the columns", but that assumed registry completeness; a consumer who upgraded past
0.57 without running `identity-alias-backfill` has pre-upgrade keys in the columns only, and an
alias-only guard would fail OPEN there (allow claiming a victim's unaliased key). A security guard
keeps the column leg as the unbackfilled-registry backstop; the ALIAS leg is what adds the new
protection. This also matches the engine's own resolver shape — `findByKey` is column-first with
alias fallback by PRD 02 design — so the durable rule this PRD enforces is: **the resolver and the
two guards are the ONLY code allowed to touch the identity columns for lookup; every scattered
site routes through them.** Two DELIBERATE semantic changes from the alias leg, each with its own
test:

1. **Identified contact's email, presented as an anon id.** Today the column guard allows it when
   an `external_id` exists (the email keys no history). The alias leg (`alias_kind <> 'anonymous'`)
   rejects it. A tightening in the safe direction; test it as intended behaviour, and check no
   existing test pins the old allow.
2. **Stale merge-loser keys.** The column guard is BLIND to them (loser rows are soft-deleted).
   The alias probe rejects them (stale keys stay aliased to the survivor). This closes the hole that
   T7's stamp-only loser folds would otherwise open: a frozen loser `user_id` plus the string-keyed
   fallback read would let a caller present a victim's stale key as `?anonymousId=`.
   **ORDERING LAW: T6b lands before T7's fold change.**

Ship with the adversarial test: a publishable caller passing a victim's `external_id` (and a
victim's stale pre-merge key) as `?anonymousId=` still gets a 403 on the feed and no arrival stamp.
Mutation-proof it: break the replacement probe and watch the test go red.

Also: `contactSearchFilter` GAINS an `EXISTS`-ilike leg over `contact_aliases` (search should find
a contact by ANY of its historical keys, which the one-slot column cannot); the column legs stay
(strictly-more-results, and the same backstop argument). `identifiedContactFilter` is NOT swapped:
under demote-forever the columns stay written mirrors, so its `IS NOT NULL` legs stay exact — the
inline FUTURE note gets updated to say so.

### T7 — flip the residual resolution reads; retire the loser-fold rewrites.

The fresh census found MORE live resolution reads than the stale list below predicted — including
`eq(contactKeySql(), <presented key>)` sites in the bucket subsystem. Flip every site that maps a
caller-presented key string to a contact row so it routes through the RESOLVER (`findByKey` /
`resolveContactNoCreate`), which owns the column+alias dual probe; raw-SQL contexts that cannot
call TS get the same dual shape inline, annotated.
NOT flipped, by design: display projections of the columns, D8's deliberate
`isNotNull(contacts.externalId)` cohort guards, the PRD-04 backfill/reconcile BRIDGE machinery
(string-matching is its job; annotate), and `contactKey(row)` derivations from an
already-resolved row (columns keep being written under demote, so the derivation stays correct).
Writes are UNCHANGED — `external_id`/`anonymous_id` keep being written as display mirrors.
Retire `mergeContacts`' loser-fold `user_id` rewrites to stamp-only (AFTER T6b, per the ordering
law). The ten #621 behaviour tests stay green unmodified; if one needs editing, stop and escalate.

The classified site table lives in Implementation Notes once recon lands.

### T9 — MINOR changeset (the rescope makes this non-breaking) + docs.

Nothing drops, no public export changes, serializers unchanged. The changeset explicitly names
what did NOT change: both columns survive as mirrors, `externalId` serialization, the `contactKey`
wire field, flag/holdout assignments. Docs: update `docs/posthog-identity-stitching.md` /
`docs/audience-model.md` where they describe column-based resolution.

### Confirmed cut

T2/T3/T5/T8; `contacts.contact_key` never exists; `contactKey()`/`contactKeySql()` SURVIVE as
derivations (grep-to-zero applies to `eq()`-style resolution probes, not the coalesce). The
serializer `anonymousIds: string[]` change is dropped too — it was drop-driven; lean-first says
don't build it.

## Goal

Finish the model: make `contacts.id` the only thing that identifies a person and make the identity
table the only thing that RESOLVES one. Concretely — apply `NOT NULL` to `<table>.contact_id` on
every history table where a null is genuinely impossible, stop reading the identity columns for
resolution, inventory every straggler that still does, and leave the columns in place as
denormalized mirrors.

Three of the four columns the BACKLOG line names do **not** get dropped, and `NOT NULL` is **not**
achievable on all five tables. Both findings are grounded below; this PRD implements the rule in
DECISIONS §4 ("NOT NULL … only after a backfill verifies zero nulls in production") rather than the
outcome the BACKLOG assumed that rule would produce.

## Locked decisions

### D1 — `contacts.email` survives. It is an ADDRESS and a DISPLAY field, not just a key.

The brief asked to check this carefully. It is load-bearing on the send path, not only the identity
path:

- `packages/engine/src/workflows/send-campaign.ts:950` builds the campaign recipient address as
  `lower(trim(coalesce(bucket_memberships.user_email, contacts.email)))`, and `:1093-1121` selects
  `lower(contacts.email)` with a `contacts.email is not null` filter as the second cohort arm. Drop
  the column and campaigns lose their recipient address.
- `packages/engine/src/lib/connector-actions.ts:88` selects `contacts.email` to address a
  member-directed connector action.
- Display/export readers: `routes/admin/deals.ts:251,263`, `routes/admin/groups.ts:766,846`,
  `routes/admin/conversions.ts:196`, `routes/admin/events.ts:74`, `routes/admin/bulk.ts:344,364`
  (CSV export header is literally `externalId,email,…`), `lib/groups.ts:347`, `lib/agent/tools.ts:155`,
  `lib/flags.ts:92` (the flag targeting snapshot's email leg), `lib/sms-inbound.ts:170`.
- Studio renders it at `packages/studio/src/views/contacts/contact-detail-drawer.tsx:191`,
  `views/group-detail-view.tsx:139`, `components/contact-picker.tsx:262`.

So: `contacts.email` is **demoted, not dropped**. What it loses is its identity ROLE — no resolution
read goes through `eq(contacts.email, …)` any more (that moves to `contact_aliases`, PRD 02). It
keeps its column, its `contacts_email_idx` (`schema/contacts.ts:91`) and — deliberately —
`contacts_email_unique_idx` (`:102`). Keeping the unique index costs nothing (the identity table's
`unique(alias_kind, alias_value)` already guarantees one owner per email) and is a free correctness
backstop; removing it is a behavioural change and DECISIONS §4 forbids bundling one with a migration.

### D2 — `contacts.discord_id` and `contacts.phone` survive for the same reason.

`discord_id` is a routing DESTINATION, not only a key: `lib/connector-actions.ts:89` selects it and
the `plugin-discord` DM / mention / role actions address it
(`packages/plugin-discord/src/actions/dm.ts:22`, `mention.ts:24`, `role.ts:26`).
`routes/admin/connectors.ts:327,336` counts linked members off `isNotNull(contacts.discordId)`.
`campaigns/cohort-sql.ts:41` maps the `discord` channel to it.
`phone` is already out of scope per BACKLOG ("Out of scope (decided)"). Both stay, demoted, indexes
intact.

### D3 — `contacts.external_id` is DEMOTED, not dropped. `contacts.anonymous_id` IS dropped.

`external_id` leaves the system as a value in four published places, so dropping the column is a
breaking change to a published package for no structural gain:

- `SerializedContact.externalId` (`packages/engine/src/lib/contacts.ts:202,232`) → the `/v1/contacts`
  200 body (`routes/contacts/index.ts:24`, `z.string().nullable()`) → `@hogsend/client`
  `Contact.externalId` (`packages/client/src/types.ts:66`) and `GroupMember.externalId` (`:228`).
- `ConversionContact.externalId` (`packages/core/src/providers/conversion-destination.ts:18`) — a
  PUBLIC plugin contract. `packages/plugin-meta-capi/src/index.ts:94-96` hashes it into Meta's
  `user_data.external_id` for ad matching. Removing the value silently degrades ad match quality.
- The admin CSV export (`routes/admin/bulk.ts:344,364`) and the `@hogsend/cli` import mappers
  (`packages/cli/src/lib/import-shared.ts`, `import-loops.ts`, `import-customerio.ts`,
  `commands/contacts.ts`, `commands/import.ts`) round-trip it.
- Studio renders it at `views/contacts-view.tsx:199`, `views/contacts/contact-detail-drawer.tsx:191,192`,
  `views/group-detail-view.tsx:139-143`, `views/deals-view.tsx:405`, `components/contact-picker.tsx:288`.

So `external_id` becomes a **denormalized "primary external id"** — the `contact_aliases` row of
kind `external` with the lowest `created_at`, maintained by the identity writer, never read for
resolution, never mutated by `repointOwnHistory`.

`anonymous_id` is the opposite case. It is the literal "one slot" from DECISIONS §1 that PRD 03
makes structurally wrong (many anon ids per person is normal), and it is displayed in exactly two
places — `routes/admin/targeting.ts:214` and `components/contact-picker.tsx:290-291`, both admin-only
— which read a LIST from `contact_aliases` instead. It is dropped, along with
`contacts_anonymous_id_unique_idx` (`schema/contacts.ts:105`).

### D4 — `NOT NULL` is achievable on at most two of the five tables, and the census decides.

DECISIONS §4 gates `NOT NULL` on "a backfill verifies zero nulls in production". That gate FAILS by
construction for three tables, because the #621 refusal path — which DECISIONS §4 also says stays —
writes history rows for a key that owns no `contacts` row:

- **`user_events` — impossible.** `lib/ingestion.ts:391` runs `resolveContactNoCreate` when
  `allowCreate === false`; `:412-417` documents "`contactId` is NULL exactly when the resolve
  REFUSED", and the `userEvents` insert at `:500` happens regardless. A publishable anon event on
  `POST /v1/events` produces a `user_events` row with no contact, permanently, by design.
- **`bucket_memberships` — impossible.** `apps/api/src/__tests__/observation-bucket-expiry.test.ts:17-21`
  states the reachable chain in the repo's own words: "publishable anon-only event ⇒
  `allowCreate: false` ⇒ `contactId` null ⇒ `checkBucketMembership` still runs (bucket eval needs no
  contact row) ⇒ `handleJoin`".
- **`email_sends` — impossible.** `schema/email-sends.ts:31` is `text("user_id")` with no `.notNull()`
  already, because `SendEmailOptions.userId` is optional (`lib/email-service-types.ts:55`). A raw
  address send has no subject.
- **`journey_states` (`schema/journey-states.ts:20`) and `email_preferences`
  (`schema/email-preferences.ts:17`)** are `.notNull()` on `user_id` today and MAY be clean. A
  refused anon event still reaches Hatchet, so a journey triggering on such an event could enroll a
  contactless key. This is a measurement, not an assertion — T1 measures it and T4 applies `NOT NULL`
  only where the count is zero AND a code-path audit shows a null is unreachable.

Where `NOT NULL` cannot land, the invariant is stated and TESTED instead: `contact_id IS NULL` is
legal **only** when the write came from a refusing caller. Tables that keep a nullable `contact_id`
get a schema comment saying so, so the next reader does not read the nullability as an oversight.

### D5 — `contactKey()` the FUNCTION dies. `contactKey` the STRING must be frozen, not recomputed.

The value `external_id ?? anonymous_id ?? id` is not only a join key. It is hashed:

- **Feature flag rollout.** `lib/flags.ts:304-305` `rolloutKey(contactKey, flagKey, i)`, `:323`
  `pickVariant`, gated at `:383` and `:444`. Assignment is "STICKY by construction (a deterministic
  hash of contactKey+flagKey)" (`packages/core/src/flags/types.ts:111`) with **no stored assignment**
  — the string IS the assignment.
- **Global control holdout.** `lib/holdout.ts:53-61` `isGlobalControl(key)` sha256s the key;
  `lib/global-control-readout.ts:139` recomputes `row.external_id ?? row.anonymous_id ?? row.id` for
  the lift readout.

Dropping `anonymous_id` changes that derivation for the entire anonymous population (their key flips
from the anon id to the row uuid). That would silently re-shuffle every percentage rollout and every
holdout arm — a live behavioural change smuggled into a migration, which DECISIONS §4 forbids.

So this PRD adds `contacts.contact_key text` — the canonical key **frozen once** at backfill,
write-once thereafter. It is explicitly **not** a resolvable identity key: nothing looks a contact up
by it, and PRD 06's `resolve()` never consults it. It exists to (a) keep hash inputs byte-identical,
(b) keep serving the `contactKey` wire field, which is published: `routes/events/index.ts:63`
(`z.string()`, required in the 200 body), `packages/js/src/types.ts:186` (required) and `:261`
(nullable), `packages/client/src/types.ts:96` (optional). `contactKey()` and `contactKeySql()`
(`lib/contacts.ts:557,568`) are deleted; their callers read the column.

Because the key is now stored and immutable, `repointOwnHistory` (`lib/contacts.ts:1755`) has nothing
left to rewrite — that is what makes its deletion in PRD 05 final rather than provisional.

### D6 — The DROP is its own release, at least one full release after the last reader is gone.

`railway.toml` runs `preDeployCommand = "tsx packages/db/src/migrate.ts && …"` — migrations apply
**before** the new container serves, while the OLD container is still up. `railway.worker.toml` has
no pre-deploy at all and deploys as a separate service, so the worker can be running the old build
for minutes after the API's migration ran. Drizzle emits explicit column lists in every `SELECT`, and
`@hogsend/db` is bundled into both binaries via tsup `noExternal` — so an old container selecting a
dropped column fails hard at runtime. The boot guard (`apps/api/src/index.ts:111`) only catches the
DB being BEHIND the code; it does not protect old code from a newer schema.

Therefore: T7 (remove the schema field + generate the DROP) MUST NOT ship in the same PR as T5/T6
(stop reading / stop writing), and MUST NOT ship before both `hogsend-api` and `hogsend-worker` are
confirmed running the read-free build.

### D7 — The five `<table>.user_id` text columns are OUT OF SCOPE.

PRD 05 flips reads to `contact_id` but leaves the text columns in place. Dropping them is a separate,
later cleanup with its own rollout hazard (129 non-test references match
`(userEvents|journeyStates|bucketMemberships|emailSends|emailPreferences)\.userId` today). This PRD
touches the `contacts` columns only. Record the residual; do not do it here.

## EARS acceptance criteria

- **WHEN** the `contacts.contact_key` backfill has run, the system **SHALL** hold, for every live
  contact, `contact_key = external_id ?? anonymous_id ?? id::text` — byte-identical to what
  `contactKey()` returned for that row before the backfill.
- **WHEN** a flag with a partial rollout is evaluated for a contact after `anonymous_id` is dropped,
  the system **SHALL** serve the same variant it served before the drop.
- **WHEN** a contact is scored for the global control holdout after `anonymous_id` is dropped, the
  system **SHALL** place it in the same arm as before the drop.
- **WHEN** a new contact is created, the system **SHALL** write `contact_key` exactly once and
  **SHALL NOT** update it on any subsequent fill-in-link or merge.
- **WHEN** `POST /v1/events` succeeds, the system **SHALL** return, in the `contactKey` wire field,
  the **LIVE** canonical key for that contact — i.e. the post-identify value, byte-identical to what
  the route returned before this PRD — and **SHALL NOT** return the frozen `contacts.contact_key`.

  *(Disambiguation, because the two are deliberately allowed to diverge and an earlier revision of
  this PRD asserted both at once. After the freeze a contact created anonymously as `A` and later
  identified as `U` holds `contact_key = 'A'` forever while its live key is `U`. The wire field is
  what a caller polls the feed and correlates events with, so it must track the live key. The frozen
  column exists for one purpose only — a hash input that does not move under a contact's feet — and
  its ONLY readers are `lib/flags.ts:304`, `lib/holdout.ts:53`, and the projections listed in T5.
  Any new reader of `contact_key` needs a stated reason why a moving key would break it.)*
- **WHEN** `POST /v1/events` is called with a publishable key and an unidentified `anonymousId`, the
  system **SHALL** store a `user_events` row with `contact_id IS NULL` and **SHALL NOT** error.
- **WHEN** a history table's `contact_id` has been proven to have zero nulls in production and no
  reachable null-producing path, the system **SHALL** enforce `NOT NULL` on it; **otherwise** it
  **SHALL** leave the column nullable and carry a schema comment naming the refusal path.
- **WHEN** any resolution entry point is given an `external_id`, `anonymous_id`, `email` or
  `discord_id` value, the system **SHALL** resolve it through `contact_aliases` and **SHALL NOT**
  read `contacts.external_id` / `contacts.anonymous_id` to do so.
- **WHEN** `/v1/contacts` or `/v1/groups/:id/members` serializes a contact, the system **SHALL**
  still return `externalId` with the same value as before this PRD.
- **WHEN** a conversion is dispatched to `@hogsend/plugin-meta-capi`, the system **SHALL** still
  populate `user_data.external_id` for a contact that has an external identity.
- **WHEN** the Studio contact drawer opens a contact with three anonymous ids, the system **SHALL**
  list all three, not one.
- **WHEN** `contacts.anonymous_id` has been dropped, the system **SHALL** contain no reference to it
  in `packages/`, `apps/`, or the generated Drizzle schema.

## Tasks

Ordered. Every task ends with the DECISIONS §5 gates verbatim.

### T1 — Census: measure the nulls and the key-freeze delta

_Boundary:_ `scripts/` (repo root; no package code changes) · _Depends:_ PRD 04 backfill shipped,
PRD 05 read-flip shipped

A read-only checked-in SQL script (`scripts/identity-census.sql`) that reports, per history table:
total rows, `contact_id IS NULL` count, and — for the nulls — a breakdown by whether the row's
`user_id` matches any live contact's canonical key. Plus: contacts with `anonymous_id IS NOT NULL AND
external_id IS NULL` (the population whose hash key would move under D5), and a count of
`contact_aliases` rows per kind vs the column population (a divergence here means PRD 02's dual-write
missed something and 07 must not proceed).

**How it is tested:** run against the clean test DB seeded by `packages/db/src/seed.ts` +
`demo-seed.ts` and assert the script parses and returns the expected shape; then run it against
production read-only and paste the numbers into Implementation Notes. This task's DELIVERABLE is the
numbers — T4's scope is undecidable without them.

_Cost: small. This is the cheapest task and the one that unblocks the honest scoping of T4._

### T2 — Add `contacts.contact_key`, backfilled, no reads

_Boundary:_ `packages/db` · _Depends:_ T1

Add `contactKey: text("contact_key")` to `schema/contacts.ts` (nullable). Generate the migration and
hand-edit it to include the backfill:
`UPDATE contacts SET contact_key = coalesce(external_id, anonymous_id, id::text) WHERE contact_key IS NULL`.
Add a partial-unique index on live rows (`WHERE contact_key IS NOT NULL AND deleted_at IS NULL`),
mirroring `contacts_external_id_unique_idx` (`schema/contacts.ts:96`). No code reads it yet.

**How it is tested:** a migration test that inserts contacts in each of the three shapes
(external-only, anon-only, neither) BEFORE the migration, runs it, and asserts `contact_key` equals
what `contactKey()` (`lib/contacts.ts:557`) returns for the same row. That equality is the whole
contract; assert it rather than re-deriving it in the test.

_Cost: small-to-medium. The backfill is a single UPDATE, but on production `contacts` it takes a row
lock per row — check the T1 row count and batch it if it is large._

### T3 — Write `contact_key` on create; never on update

_Boundary:_ `packages/engine` · _Depends:_ T2

Set `contactKey` in the create arm (`lib/contacts.ts:772-777`, alongside `externalId`/`email`/
`anonymousId`/`discordId`) to the same value `contactKey(createdRow)` computes at `:806`. Do **not**
set it in `fillInLink` (`:1123-1127`) or the merge survivor update (`:1418-1423`) — those are exactly
the sites that make today's key mutable, and freezing it is the point.

Note the ordering wrinkle: for a contact with neither `userId` nor `anonymousId` the key is the row's
own uuid, which is not known until after the INSERT. Either write it in the same statement with a
`DEFAULT`/generated expression, or accept a second UPDATE inside the already-open transaction. State
which in Implementation Notes.

**How it is tested:** create a contact each of the three ways; assert `contact_key` matches
`contactKey(row)`. Then drive a fill-in-link (anon → identified) and a collide-merge, and assert
`contact_key` is UNCHANGED on both, while `contactKey(row)` now returns something different — that
divergence is the freeze working, and a test that only asserts equality would pass vacuously.

### T4 — `NOT NULL` where and only where T1 proved it clean

_Boundary:_ `packages/db` · _Depends:_ T1, and PRD 05 shipped and soaked

For each table T1 reported zero nulls on, and for which a code audit finds no reachable
null-producing writer:

```
ALTER TABLE <t> ADD CONSTRAINT <t>_contact_id_not_null CHECK (contact_id IS NOT NULL) NOT VALID;
ALTER TABLE <t> VALIDATE CONSTRAINT <t>_contact_id_not_null;   -- SHARE UPDATE EXCLUSIVE, no rewrite
ALTER TABLE <t> ALTER COLUMN contact_id SET NOT NULL;          -- PG >= 12 uses the validated CHECK
ALTER TABLE <t> DROP CONSTRAINT <t>_contact_id_not_null;
```

A bare `SET NOT NULL` takes ACCESS EXCLUSIVE and full-scans; on `user_events` that is a production
outage. Use the three-step form even on the small tables so the pattern is uniform.

Per D4 the expected outcome is `journey_states` and `email_preferences` only, and possibly neither.
For every table left nullable, add a schema comment on the column naming the refusing caller, and add
a behaviour test asserting the null is produced and tolerated.

**How it is tested:** for each NOT NULL'd table, an insert with `contact_id: null` must throw
`23502`. For each table left nullable, drive the actual refusal path end to end (publishable `pk_`
event with an unseen `anonymousId`, per `__tests__/observation-paths.test.ts`) and assert a row lands
with `contact_id IS NULL` and a 2xx response.

_Cost: medium, and mostly waiting. The `VALIDATE CONSTRAINT` scan on production `user_events` is the
long pole even though it takes a weak lock._

### T5 — Flip the derived readers onto `contact_key`

_Boundary:_ `packages/engine` · _Depends:_ T3

> **BLOCKING PRECONDITION — do not flip `contacts.ts:1041` naively.** That site is `oldKey` in
> `fillInLink`, and it is one half of a COMPARISON: `newKey` (`nextExternalId ?? nextAnonymousId ??
> row.id`) is computed live a few lines below and appears in no task in this PRD. Flip only `oldKey`
> onto the frozen column and the two sides stop being derived the same way, so for any contact
> created anonymously and later identified the frozen `oldKey` stays `A` while the live `newKey` is
> permanently `U`. `newKey !== oldKey` then evaluates TRUE on **every subsequent resolve, forever** —
> re-running `repointOwnHistory` and re-emitting `mergedKeys`, which fires
> `mergeAnalyticsIdentities` on every ingested event for that contact. That is the re-stitch storm
> the comments in `lib/contacts.ts` record as a past production incident, reintroduced by a
> refactor. Today the loop is self-limiting only because `contactKey(row)` RECOMPUTES to the new key
> after the UPDATE.
>
> **The fix: flip-detection must not read the frozen column at all.** Compute an explicit
> `keyFlipped` boolean from the live pre/post column values inside `fillInLink` (and the equivalent
> in the merge arm), and gate `repointOwnHistory` + `mergedKeys` on that. The frozen `contact_key`
> is then used ONLY where a stable identity STRING is wanted — the flag/holdout hash inputs
> (`lib/flags.ts:304`, `lib/holdout.ts:53`), projections, and wire fields — never as an operand in a
> did-this-change test. Keep a private `deriveKey(row)` for that comparison if it reads better; what
> must not happen is one side frozen and the other live.
>
> **Test this explicitly:** resolve the same identified contact twice in a row and assert the second
> resolve reports `mergedKeys === undefined` and performs no repoint. Without that assertion the
> storm ships green, because a single resolve looks perfectly correct.

Replace every call to `contactKey(row)` with `row.contactKey`, and `contactKeySql()` with
`contacts.contactKey`. The complete non-test list (14 sites):

| File:line | What it feeds |
| --- | --- |
| `lib/contacts.ts:403` | `resolveByContactId` → `resolvedKey` |
| `lib/contacts.ts:806,1041,1218` | create-arm key, fill-in-link `oldKey`, merge `survivorKey` |
| `lib/refine.ts:203` | refinement `userId` |
| `lib/agent/tools.ts:191,298` | agent contact lookup + event emit |
| `routes/feed/recipient.ts:178,183` | feed recipient key (the bell's 403 boundary) |
| `routes/admin/reporting.ts:288` | `emailSends.userId` filter |
| `routes/admin/timeline.ts:70` | timeline key for 6 history queries (`:88-162`) |
| `workflows/bucket-backfill.ts:230,468,530` | `contactKeySql()` projections |
| `workflows/bucket-reconcile.ts:922` | `contactKeySql()` projection |

Plus the two raw-SQL re-derivations: `lib/global-control-readout.ts:69-72,139`
(`select id, external_id, anonymous_id …` → `select id, contact_key …`) and
`routes/admin/contacts.ts:364` (`coalesce(${contacts.externalId}, ${contacts.anonymousId}, ${contacts.id}::text)`).

Delete `contactKey()` and `contactKeySql()` (`lib/contacts.ts:557,568`) once the list is empty.

**How it is tested:** a snapshot-style test that, for a fixture set covering all three contact shapes
plus a post-merge survivor and a post-fill-in-link row, asserts `row.contactKey` equals the value the
pre-change `contactKey()` produced (hard-code those strings in the test — a re-derivation would move
with the bug). Plus a flag test: assign a partial-rollout flag to 200 fixture contacts before and
after, and assert the assignment vectors are identical. Plus a holdout test doing the same over
`isGlobalControl`.

_Cost: medium. Mechanically small, but the flag/holdout equivalence tests are the real work and they
are the only thing standing between this PRD and a silent production re-bucketing._

### T6 — Mirror `contactKey` into the two out-of-boundary copies

_Boundary:_ `packages/studio` (then, separately, `apps/api`) · _Depends:_ T5

`packages/studio/src/lib/admin-api.ts:1024` re-implements the derivation client-side
(`contact.externalId ?? contact.anonymousId ?? contact.id`) and is called at
`components/contact-picker.tsx:75,163,262`. Point it at the serialized `contactKey` field instead
(which means adding `contactKey` to the admin contact serializer in
`routes/admin/contacts.ts:22` — a strictly additive response field, so no version bump for Studio).

`apps/api/src/workflows/gtm-score.ts:241,274,276` re-derives it in raw SQL
(`COALESCE(b.external_id, b.anonymous_id, b.id::text) AS user_key`) with a matching comment at `:400`.
This is CONSUMER code in the dogfood app — it is the proof that consumers outside this repo have
written the same SQL, and therefore that dropping `anonymous_id` is a breaking change for them
(see T9).

**How it is tested:** Studio — a component test asserting the picker's emitted key for an anon-only
contact equals the server's `contactKey`. `gtm-score` — the existing
`apps/api/src/__tests__/gtm-score-batch.test.ts` must stay green against the clean database (DECISIONS
§5: the shared `growthhog` DB trips a whole-table walk in it).

### T6b — Inventory: assign every surviving column reader an owner (do this BEFORE T7)

_Boundary:_ none (analysis) · _Depends:_ T5

T7 treats "grep-to-zero" as its acceptance test while ALSO listing sites as "expected already-dead by
PRD 02/06". Three of those are not owned by any task in any PRD, and T8 drops the columns regardless
— so the inventory has to happen as its own step, with an owner named per hit, before anything is
dropped. Run both:

```bash
rg 'contacts\.anonymousId|contacts\.externalId' packages apps --type ts | grep -v __tests__
rg 'externalId \?\? .*anonymousId|external_id, .*anonymous_id' packages apps --type ts
```

Known-unowned, confirmed by reading the code:

| Site | Why it is not covered | Owner it needs |
| --- | --- | --- |
| `lib/contacts.ts:55-84` `collidesWithIdentified` | PRD 02 explicitly puts it in "stays exactly as it is"; PRD 06 never mentions it. **It is a SECURITY boundary** — the feed-403 and arrive-forgery guard | **Its own task with its own security test** (below) |
| `lib/contacts.ts:257-264` `contactSearchFilter` | In no task in any PRD. PRD 01 T2's zero-result escape hatch is justified by it matching anon ids | Rewrite the anon leg as an `EXISTS` over `contact_aliases` |
| `lib/crm-ingest.ts:74-85` | Hand-inlines `externalId ?? anonymousId ?? id`; PRD 03 defers it to "PRD 02 / PRD 07", PRD 07 lists it in neither T5 nor T7 | Add to T5's `contact_key` list |
| `routes/admin/targeting.ts:229`, `routes/admin/contacts.ts:431` | Inline re-derivations outside T5's "complete 14-site list" | Add to T5's list |

**`collidesWithIdentified` gets its own task, not a line in a grep sweep.** It answers "is this value
an identified person's canonical key", and it is what stops a token-less caller claiming someone
else's key as their `anonymousId` to read their feed. Its replacement must probe the identity table
(`alias_kind <> 'anonymous'`) rather than the columns, and must be shipped with the adversarial test
that a publishable caller passing a victim's `external_id` as `?anonymousId=` still gets a 403.
Retiring a security guard by column-drop is how the history-theft bug got into #621; do not repeat it
by attrition.

### T7 — Stop reading and stop writing `external_id` / `anonymous_id` for identity

_Boundary:_ `packages/engine` · _Depends:_ T5, T6b, PRD 02, PRD 03, PRD 06

Two halves, and they are only one task because after PRDs 02/03/05/06 there should be almost nothing
left. Grep-to-zero is the acceptance test; **anything still matching is a site an earlier PRD missed,
and finding those is the actual value of this task.**

READ side — every `eq(contacts.externalId, …)` / `eq(contacts.anonymousId, …)` used for RESOLUTION
must be gone. Expected already-dead by PRD 02/06: `lib/contacts.ts:69-71,121-122,187,1933,1967,2040`
(`findByKey` / `collidesWithIdentified:55-84` / `keysAnotherContact:108-134`), `lib/refine.ts:245-247`,
`lib/timezone.ts:122`, `lib/connector-actions.ts:100-102`, `lib/attribution-backfill.ts:161-165`,
`journeys/execute-journey-run.ts:415-416,565`, `buckets/check-membership.ts:192`,
`routes/feed/recipient.ts:133`, `routes/admin/targeting.ts:213-214`.
Expected already-dead by PRD 05 (joins to a history table's `user_id`): `buckets/bucket-access.ts:77,101,149,160`,
`workflows/bucket-reconcile.ts:424,459,537,715,1095`, `workflows/bucket-backfill.ts:356,471-472,489`,
`workflows/send-campaign.ts:984,1119`, `campaigns/cohort-sql.ts:72,191`, `routes/admin/events.ts:79-87`.

Also re-point the four Drizzle relations that still declare `references: [contacts.externalId]` —
`packages/db/src/schema/relations.ts:98` (bucketMemberships), `:126` (emailPreferences), `:134`
(userEvents), `:143` (journeyStates) — onto `contacts.id` / `<table>.contactId`, and delete the
now-false `contactsRelations` comment at `:58-63`.

WRITE side — `anonymousId` stops being written at `lib/contacts.ts:776` (create), `:1126`
(fill-in-link), `:1422` (merge survivor). `externalId` keeps being written at those three sites but
becomes a DENORMALIZED mirror of the primary `external` identity row (D3), never the thing the
resolver consults. Seed data: `packages/db/src/seed.ts:53` and `demo-seed.ts:671,677`.

Serializers: `serializeContact` (`lib/contacts.ts:221-240`) keeps `externalId` (from the denorm
column) and replaces the `includeAnonymousId` overload with an `anonymousIds: string[]` field read
from `contact_aliases`. That is an admin-only shape change (`routes/admin/contacts.ts:22`,
`components/contact-picker.tsx:290-291`); the PUBLIC `SerializedContact` is unchanged.

**How it is tested:** (1) the grep is the test — a CI-checked `rg` assertion that
`contacts\.anonymousId` matches zero non-schema lines. (2) The full #621 behaviour suite must stay
green unmodified: `apps/api/src/__tests__/{contacts-no-create,ingest-no-create,observation-paths,observation-untouched-paths,observation-derived-reingest,observation-bucket-expiry,identity-provenance,contacts-provenance,anonymous-id-threading,contact-key-roundtrip}.test.ts`.
Per DECISIONS §4 those pin outcomes not mechanism, so they are the primary evidence the flip was safe;
if any needs editing to pass, stop and escalate rather than edit it. (3) Mutation-test at least the
feed 403: break `collidesWithIdentified`'s replacement and assert
`observation-paths.test.ts` goes red — a guard that has never been seen to fail is not a guard.

_Cost: LARGE, and the size is entirely conditional. If 02/03/05/06 landed exactly as specified this is
a day of grepping and deleting. If any of them left a residual read, that residual is a live identity
bug and fixing it here is unbounded. Budget for the second case._

### T8 — Drop `contacts.anonymous_id`. Separate PR, separate release.

_Boundary:_ `packages/db` · _Depends:_ T7 merged, released, and confirmed live on BOTH
`hogsend-api` and `hogsend-worker`

Remove `anonymousId` from `schema/contacts.ts:33` and `contacts_anonymous_id_unique_idx` at `:105`,
run `pnpm db:generate`, verify the emitted SQL is exactly `DROP INDEX` + `ALTER TABLE contacts DROP
COLUMN anonymous_id` and nothing else (drizzle-kit will happily fold in unrelated drift).

Per D6 this MUST be a distinct PR from T7. Confirm both Railway services report the T7 build before
merging; the worker has no pre-deploy gate and no boot guard against a schema that is AHEAD of it.

**How it is tested:** apply the migration against a database seeded and exercised by the full API
suite, then re-run the full API suite. Separately, verify the previous release's build boots against
the post-drop schema **fails** in a controlled way — that failure is what D6 predicts, and confirming
it is what proves the two-release ordering was necessary rather than superstitious.

_Cost: small in code, non-trivial in coordination. The coordination is the deliverable._

### T9 — Changeset + docs

_Boundary:_ `packages/engine` (changeset + docs only) · _Depends:_ T8

**This release is a BREAKING change and needs a MAJOR bump on the engine line, not a minor.**
`pnpm changeset` then `pnpm changeset:engine-line` (root `package.json:17`) to keep the
`@hogsend/*` versions uniform. What breaks:

- `contacts.anonymous_id` no longer exists. Any consumer with raw SQL over it breaks —
  `apps/api/src/workflows/gtm-score.ts:241` is the in-repo proof that this pattern is written in
  consumer code, and `@hogsend/db` exports raw schema (`packages/db/package.json` `main: ./src/index.ts`),
  so consumers reference `contacts.anonymousId` directly.
- `contactKey` / `contactKeySql` are removed from `packages/engine/src/lib/contacts.ts`. They are NOT
  currently in the engine's public export list (`packages/engine/src/index.ts:399-402` exports only
  `resolveContactNoCreate` and `resolveOrCreateContact`), so this is internal — say so in the
  changeset so it is not mistaken for the breaking part.
- `serializeContact({ includeAnonymousId: true })` → `anonymousIds: string[]`.
- NOT breaking, and say so explicitly: the `/v1/events` `contactKey` field, `Contact.externalId`,
  `GroupMember.externalId`, `ConversionContact.externalId`, flag assignments and holdout arms are all
  unchanged. That list is the point of D5 and it is what a consumer reading the changelog needs.

Docs to update: `docs/audience-model.md`, `docs/posthog-identity-stitching.md`, `docs/gtm.md`,
`apps/docs/content/docs/data-api/identity.mdx`, `apps/docs/content/docs/data-api/contacts.mdx`,
plus a migration note for consumers holding raw SQL.

**How it is tested:** `node scripts/release-doctor.mjs` passes; the changeset renders the intended
bump; `pnpm build` succeeds with the docs changes.

## Risks / how this can go wrong

1. **Silent flag / holdout re-bucketing (highest severity).** If T2's backfill is even slightly wrong
   — a trailing space, a `NULL` where the row uuid was expected — every partial rollout and holdout
   assignment silently shifts, and there is NO stored assignment to compare against
   (`packages/core/src/flags/types.ts:111`, `db/src/schema/flags.ts:124`). Mitigated by T5's
   before/after assignment-vector tests, which must run over a fixture set including anon-only
   contacts. If the vectors differ by even one contact, stop.
2. **T7 turns out to be a bug-hunt, not a cleanup.** The task is sized on the assumption that
   02/03/05/06 removed every resolution read. If they did not, T7 discovers a live identity bug
   mid-PRD. DECISIONS §4 says file it, do not fix it in the migration commit — so the realistic
   outcome is T7 splits and this PRD stalls behind a new one. Say so early rather than expanding T7.
3. **The drop breaks a running container.** D6's whole argument. The failure mode is a hard runtime
   error on every request that selects `contacts` — total API outage until the new build is up. The
   worker is worse: no health check, no boot guard, `restartPolicyMaxRetries = 5` and then it stays
   down.
4. **`NOT NULL` on `user_events` gets attempted anyway.** It is the biggest table and the one where a
   naive `SET NOT NULL` would take an ACCESS EXCLUSIVE lock for a full scan. D4 says it is
   structurally impossible, but "impossible" is exactly the kind of claim that gets re-litigated by
   someone reading only the BACKLOG line. The schema comment in T4 is the durable defence.
5. **Nullable `contact_id` hides history from the person who owns it.** After PRD 05 reads
   `contact_id`, a visitor's pre-identification rows (written with `contact_id IS NULL` by the refusal
   path) are invisible on their timeline unless something adopts them at identify time. That
   adoption is PRD 05's replacement for `repointOwnHistory`; **this PRD assumes it exists and does not
   build it.** T1's census breaks the nulls down by "does a live contact now own this key", which is
   precisely the measurement that shows whether the adoption is working. If T1 reports a large
   orphan population, that is a PRD 05 defect and 07 must not proceed.
6. **Demoting `external_id` looks like doing nothing.** The column survives, the index survives, only
   the resolution reads move. A reviewer expecting a DROP will read this as scope-dodging. The
   defence is D3's four published consumers; keep it in the PR description.

## Rollback

Per task, in reverse:

- **T8 (the drop).** Not rollback-able by migration — a dropped column takes its data with it. The
  only true rollback is: re-add `anonymous_id` and re-populate it from `contact_aliases`
  (`WHERE alias_kind = 'anonymous'`), which is possible ONLY because PRD 02 backfilled that table
  first. That dependency is the reason T8 sits last and behind an explicit release confirmation.
  Write the down-migration and TEST it before merging T8, do not assume it.
- **T4 (`NOT NULL`).** `ALTER TABLE <t> ALTER COLUMN contact_id DROP NOT NULL` — instant, metadata
  only, no data loss. Safe.
- **T7 (reads/writes).** Pure code revert. The columns are still present, so the previous build runs
  against the post-T7 schema unchanged.
- **T5/T6 (`contact_key` readers).** Pure code revert; `contactKey()` comes back and derives the same
  value because `external_id`/`anonymous_id` are still there at this point.
- **T2/T3 (`contact_key`).** Additive. Leave the column; nothing reads it after a T5 revert. Drop it
  only if the whole PRD is abandoned.

The ordering is chosen so that everything before T8 is a code revert and only T8 needs a data-restore
plan.

## Done when

- T1's production census is pasted into Implementation Notes, and T4's scope is derived from it
  rather than from D4's prediction.
- `rg 'contacts\.anonymousId'` over `packages/ apps/` returns zero hits outside the migration history.
- The before/after flag assignment vector and holdout arm vector are identical over a fixture set
  that includes anon-only contacts.
- The ten #621 behaviour tests listed in T7 are green **unmodified**.
- `NOT NULL` is present on exactly the tables T1 proved clean, and every table left nullable carries a
  schema comment naming its refusal path.
- The drop shipped as its own release, after both Railway services were confirmed on the read-free
  build.
- A major changeset exists naming the break, and explicitly naming the four things that did NOT break
  (`contactKey` wire field, `Contact.externalId`, `ConversionContact.externalId`, flag/holdout
  assignments).
- DECISIONS §5 gates pass, verbatim, on every task.

## Implementation Notes

### T1 production census (2026-07-29, Railway `Postgres` service — the one `hogsend-api`'s `DATABASE_URL` points at)

| table | total | null_contact_id | null_live_key | null_aliased_key |
| --- | --- | --- | --- | --- |
| user_events | 1 | 0 | 0 | 0 |
| journey_states | 3 | 0 | 0 | 0 |
| bucket_memberships | 0 | 0 | 0 | 0 |
| email_sends | 0 | 0 | 0 | 0 |
| email_preferences | 0 | 0 | 0 | 0 |

Alias parity: 1 external contact, aliased; every `*_unaliased` count 0; `anon_only` 0. The deploy
is the reference instance (real traffic lives in the dogfood project's own Railway stack), so the
census gates nothing — T4's scope came from the code audit (see Re-spec). Orphan population is
zero, so risk #5 (a PRD 05 adoption defect) is clear and 07 may proceed.
