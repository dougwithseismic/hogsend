# Bucket subsystem — contact identity-key asymmetry

Found 2026-07-28 while verifying a residual from #621. Written to be self-contained: someone
picking this up cold should need nothing from the people who wrote it.

**Status at time of writing.** Three of the four blast profiles are resolved:
Profile 1 (real-time criteria lookup) shipped in **#624**; Profiles 2 and 3 (the cron leave/dwell
passes and the bucket accessor) shipped TOGETHER in **#625**, with the first-tick guard described
below. What REMAINS is listed under "Still open" at the end — where §1 also resolves the question the
guard section used to leave open, namely whether the shipped guard covers a join burst. It does not,
and the reason is the load-bearing idea in this document. A `README.md` may sit beside this file
describing the cron fix as "NOT SHIPPED" — that README predates #625 and is stale; this document is
authoritative.

## The one-sentence version

`bucket_memberships.user_id` holds the CANONICAL contact key
(`external_id ?? anonymous_id ?? id`), but most of the bucket subsystem looks the contact up by
`contacts.external_id` alone — so every contact with a NULL `external_id` (email-only, keyed on its
uuid; anonymous, keyed on its `anonymous_id`) is invisible or mis-evaluated across roughly a dozen
query sites, with four materially different blast profiles.

## Why the codebase already knows this is wrong

`workflows/bucket-reconcile.ts`, the cron JOIN candidate scan, was converted to the coalesce key and
carries the reasoning verbatim:

> The membership/event tables key on the RESOLVED string key (`external_id ?? anonymous_id ??
> contact.id`), NOT necessarily `external_id` … Joining on `contacts.externalId` would force
> `external_id NOT NULL` for every candidate … and silently drop exactly the dormant email-only
> contacts this cron exists to reconcile.

That correction was applied to the join scan and never propagated to the rest of the subsystem.
`lib/contacts.ts` exports `contactKeySql()` — `coalesce(external_id, anonymous_id, id::text)` — which
is the correct expression everywhere below.

## Site inventory, by blast profile

Line numbers are as of `origin/main` @ `baa18a2a` and drift; grep
`innerJoin(contacts, eq(contacts.externalId` and `eq(contacts.externalId, userId)` to re-derive.

### Profile 1 — wrong answer, incremental (SAFE to fix) — **SHIPPED in #624**

- `buckets/check-membership.ts:192` — real-time membership check's contact lookup.

Fixed in `6018ff58` ("bucket criteria read the contact behind an email-only member"). Two defects:
property legs evaluated against `{}` instead of real state, and — the worse half — the soft-delete
guard reads `deletedAt` off the row that lookup returns, so finding nothing left the flag false and a
**soft-deleted** email-only/anonymous contact could still transition buckets and emit.

Safe because it is the REAL-TIME path: each contact is re-evaluated only when they next generate an
event, so the change lands incrementally rather than as a sweep. The soft-delete half only ever
STOPS emissions.

### Profile 2 — emission on a cron sweep (NOT safe without a guard) — **SHIPPED in #625**

- `workflows/bucket-reconcile.ts:424` — `reconcileBucketLeaves` (criteria leaves)
- `workflows/bucket-reconcile.ts:459` — `reconcileCompositeLeaves`
- `workflows/bucket-reconcile.ts:537` — `reconcileBucketTtlLeaves` (maxDwell TTL)
- `workflows/bucket-reconcile.ts:715` — the dwell pass
- `workflows/bucket-backfill.ts:356` — `reevalLeaves`
- `workflows/bucket-reconcile.ts:1195` — `loadContactProperties`, consumed at `:257`
  (`bucketExpiryTask`'s should-leave re-confirm, gates a LEAVE emission) and `:1100` (the cron join
  confirm, gates `reconcileJoinOne` → `bucket:entered` at `:1262`)
- `workflows/bucket-backfill.ts:468-472` — `selectEventMatchers`: PROJECTS `contactKeySql()` while
  JOINING `contacts.externalId` **in the same query**, which is internally incoherent regardless of
  anything else. Its output feeds `reevalLeaves` (emits) and backfill enrollment, so it changes
  membership.

The five join sites plus the guard shipped in #625. The last two entries above —
`loadContactProperties` and the backfill matcher — were deliberately PULLED OUT and are still open;
see "Still open".

### Profile 3 — public read + consumer branching (no emissions) — **SHIPPED in #625**

- `buckets/bucket-access.ts:77` — `count()` under-reports bucket size (Studio shows it)
- `buckets/bucket-access.ts:101` — `has()` returns **false for a real member**, so consumer code
  branching on it takes the wrong path
- `buckets/bucket-access.ts:149`, `:160` — `members()`

No emissions — verified: `bucket-access.ts` contains no insert/update/delete, no
`emitBucketTransition`, no `ingestEvent`, no push and no send, and its only consumers
(`container.ts`, `define-bucket.ts`) just attach it to the bucket object, so no engine-internal
decision path branches on it. Shipped in the SAME commit as Profile 2 for the reason in "Do not
split these" below.

### Profile 4 — changes who receives a broadcast (PRODUCT DECISION) — **OPEN**

- `workflows/send-campaign.ts:984` — the campaign audience query for a bucket. A campaign targeting a
  bucket silently OMITS every email-only/anonymous member today. Fixing it means those people **start
  receiving campaign email**. This is not an engineering call.

### Deliberately excluded

- `workflows/bucket-backfill.ts:489` — joins `userEvents.userId` → `contacts.externalId` for matcher
  counts. Same asymmetry, but a distinct question (event keys, not membership keys); not analysed.

## Do not split these

Fixing Profile 2 without Profile 3 introduces a NEW divergence: the cron would act on members that
`count()`, `has()`, `members()` and campaign audiences still cannot see — dwell fires and leave
emissions for people the bucket reports as absent ("Studio says 40 members but 55 got the email").
Today the subsystem is uniformly blind, which is wrong but consistent. A non-obvious divergence
introduced BY the fix is worse than the original blind spot.

## The first-tick hazard — the load-bearing proof

Any fix to Profile 2 makes a previously-stranded cohort due ALL AT ONCE on the next tick. That
matters because **a bucket reaction is a full journey and can send to a real person**:

`buckets/bucket-reactions.ts:64-68` —

```ts
/** A bucket-reaction handler — same `(user, ctx)` shape as a journey `run`. */
export type BucketOnHandler<K extends "enter" | "leave" | "dwell"> = (
  user: JourneyUser,
  ctx: BucketReactionCtx<K>,
) => Promise<void>;
```

`BucketReactionCtx` is `JourneyContext & ReactionExtras` (`:62`), and a journey `run` calls
`sendEmail()`/`sendSms()` as ordinary imports. `on("dwell", { after: days(30) })` → "sat in
trial-no-activation 30 days → nudge email" IS the feature, not an edge case.

What a stranded member does on the first tick after a naive fix:

- dwell `after` one-shot: `dwellState[label]` unset ⇒ `lastFired == null` ⇒ **fires immediately**,
  however many months late (`bucket-reconcile.ts`, the `if (after != null)` branch of the dwell gate)
- dwell `every`: fires ONCE — the ordinal is `floor((now - anchor)/interval)`, so coalescing, no
  N-fold storm — but still one stale send
- `maxDwellAt <= now()` ⇒ leaves and emits `reason:"maxDwell"`
- plus outbound `bucket.left` webhooks and the PostHog person-property mirror (both gated to
  enter/left, not dwell, in `lib/bucket-emit.ts`)

Delivering a backlog of months-old lifecycle mail to real inboxes is worse than the bug being fixed.

## The guard design (shipped in #625 — preserve the reasoning)

Now live in `workflows/bucket-reconcile.ts` as `claimCoalesceCohort`. The reasoning is recorded here
because the code shows WHAT it does and not why each alternative was rejected.

**It was designed for the LEAVE/DWELL cohort specifically.** It claims members and resets
membership-age clocks, which is the right instrument for an emission that has gone STALE. It does
NOT transfer to a JOIN burst, and that is now settled rather than open: a join is criteria-driven and
therefore true-on-arrival, so there is no stale clock to reset and suppressing it on staleness
grounds would be incoherent. A join burst needs silent enrollment instead — the full reasoning, and
the reason it still wants THIS marker, is under "Still open" §1. Reuse `coalesce_claimed_at`; do not
reuse the clock reset.

**One-shot cohort claim, per bucket.** Before the emitting passes, if this bucket has not been
claimed, find the memberships that were previously invisible — active, and joined to a live contact
on the coalesce key whose `external_id IS NULL` — and RESET their membership-age clocks to now:

- `dwellAnchorAt = now`
- `dwellState = {}`
- `maxDwellAt = now + maxDwell` (re-armed a full window out) when the bucket has a `maxDwell`
- `lastEvaluatedAt = now`

then skip that bucket for that one tick so nothing acts on a cohort mid-reset. Record it on a new
nullable `bucket_configs.coalesce_claimed_at` so it runs exactly once per bucket.

**THE PRINCIPLED LINE, and the part most likely to be lost in a rewrite:** suppress **AGE-driven**
emissions (dwell fires, `maxDwell` leaves) because staleness lives in membership age. **Never**
suppress **CRITERIA-driven** leaves — those evaluate against present-day events and properties, so
they are timely rather than stale, and suppressing them would hold members in a bucket they no longer
match.

**Nothing is emitted and nothing is silently swallowed.** Every age-driven emission still happens,
measured from the moment the cron could first see the member. This is why the design resets clocks
rather than stamping "already fired" or silently flipping rows to `left`.

**Skip the tick ONLY when rows were actually reset.** An empty cohort records the claim and proceeds
normally. The first cut returned `true` unconditionally and broke **12 existing tests** across
`buckets.test.ts` and the bucket suites, which run reconcile once and expect emissions. That was a
design flaw, not a test problem: a deployment with no email-only or anonymous members should pay
nothing. With the narrowed version, no existing test needed modifying and all 59 bucket tests pass
unchanged.

**Why a per-bucket watermark and not something cheaper.** Per-MEMBERSHIP claiming is wrong: a
membership created after the fix, for an email-only contact, would match the same "previously
invisible" predicate and get silently claimed, losing its first legitimate dwell fire. Deriving the
cohort from `lastEvaluatedAt` staleness is also unsound — the composite pass only stamps a
`BATCH_SIZE` window and the dwell pass only stamps rows it fires for, so a legitimately-visible member
can carry an old `lastEvaluatedAt`. A one-shot per-bucket flag is the only heuristic-free
discriminator, and it needs one persisted bit.

## Still open

### 1. `loadContactProperties` + `bucket-backfill.ts:468-472` — its own piece, its own guard

#### The idea to keep: a stale burst and a true burst are not the same problem

The guard that shipped in #625 defers AGE-driven emissions, and the instinct on reading this section
will be to reuse it. Do not, and the reason is worth stating precisely.

**A dwell/TTL burst is STALE.** The member crossed the threshold months ago and nobody was watching.
When the emission finally fires, the message it carries is *factually wrong on arrival* — "you have
been inactive for 7 days" delivered on day 300. Suppressing it is not censorship of a true statement;
it is declining to assert something false. That is why resetting the age clocks is the right
instrument: it makes the next assertion true again.

**A join burst is TRUE.** The contact matches `plan == "pro"` right now. `bucket:entered` is a
correct statement about the present moment, and the only thing wrong with it is that it should have
been made earlier. Nothing about it becomes false by being late.

So the age-clock guard is not merely unnecessary for a join burst — it is **incoherent** for one. It
would suppress a correct statement on staleness grounds, and there is no clock to reset that would
make the statement more true than it already is. This document's own principled line says the same
thing from the other end: criteria-driven transitions are legitimately timely, and only age-driven
ones can go stale.

The real objection to a join burst is therefore not correctness but VOLUME, and it needs a different
instrument. See "the instrument" below.

#### The independence check

**This was originally scoped INTO the "safe" Profile 1 PR and pulled out after an independence
check.** Recording the check, because the scope error is easy to repeat.

`buckets/check-membership.ts` (shipped, #624) is the REAL-TIME path — incremental, one contact per
event, no sweep. Genuinely safe.

`workflows/bucket-reconcile.ts` `loadContactProperties` is NOT. Both callers gate emissions, and they
move in OPPOSITE directions — which is why they cannot be reasoned about as one change:

- `bucketExpiryTask`'s should-leave re-confirm — with `{}` a property criterion evaluates false, so
  `stillMember` is false and the woken timer LEAVES. With real properties it is more often true and
  the timer skips. Fixing this **reduces** emissions. Safe direction.
- the cron join confirm — `isMember` gates `reconcileJoinOne`, which emits `kind: "entered"` → enter
  reactions → journeys → **sends**, across a `BATCH_SIZE` sweep of candidates. Fixing this
  **increases** emissions. This is the entire hazard.

Concrete failing scenario: a bucket with criteria `plan == "pro"`. An email-only contact genuinely on
Pro was never joined, because the property leg saw `{}`. Fix the lookup and the next tick finds them,
`evaluateCondition` returns true, `reconcileJoinOne` emits `bucket:entered`, and the enter reaction
sends a welcome email — for the whole cohort at once.

#### Nothing bounds it

`firstTimeBackfillIncomplete` does not help: it covers only the first-time backfill window.

`entryLimit` does not help either, and an earlier draft of this document got that wrong. It claimed
`shouldEmitJoin` "suppresses some via `entryLimit`, not all". It suppresses **none** of this cohort.
`buckets/check-membership.ts` opens that function with:

```ts
if (priorCount === 0) return true;   // First-ever join always emits.
```

The newly-visible cohort has never been enrolled, so `priorCount === 0` holds for every member of it
by definition, and the `entryLimit` switch below is never reached. `BATCH_SIZE` only spreads the
burst across ticks while the cohort drains. The burst is unbounded in total.

#### The instrument: silent enrollment, which this codebase already uses

`workflows/bucket-backfill.ts` contains exactly ONE `emitBucketTransition` call site — `:405`, inside
`reevalLeaves`. The enrollment insert emits nothing. So the first-time backfill **materializes a
historical join cohort completely silently**, and `firstTimeBackfillIncomplete` exists to hold the
cron join path off until it has done so; its own comment says it "keeps the cron JOIN path from
emitting a historical blast on first deploy".

That is the answer, and it is already policy. For the previously-invisible cohort: write the
membership row (so `count()`, `members()` and Studio reflect reality) and skip the `bucket:entered`
emission; emit normally for genuinely new joins thereafter. Not a new rule — the existing rule
applied consistently to a cohort that was invisible for a different reason.

**This needs no product decision**, which distinguishes it sharply from §2 below. Nobody receives
mail they would not otherwise have received; the cohort simply gets the enrollment it should always
have had, minus a retroactive welcome.

#### It depends on #625, and must not duplicate its marker

Silent enrollment has to happen exactly once per bucket, which needs a per-bucket one-shot marker.
#625 already adds one — `bucket_configs.coalesce_claimed_at` — for the **identical cohort** (contacts
whose canonical key is not their `external_id`). The action differs (reset age clocks vs enroll
silently); the cohort and the once-per-bucket semantics are the same. **Reuse it.**

Adding a second column would also collide on migration numbering: main topped out at
`0067_watery_sir_ram` and #625 holds `0068_smiling_bastion`, so a parallel branch would produce a
second 0068 and `release-doctor.mjs` fails on "no duplicate migration numbers (parallel-PR
collision)" the moment both merge.

#### `selectEventMatchers`: re-derive its safety on the base you ship against

`bucket-backfill.ts:468-472` PROJECTS `contactKeySql()` while JOINING `contacts.externalId` in one
query — internally incoherent regardless of anything else. It feeds `reevalLeaves` (which emits) and
the backfill enrollment (which does not).

**Its safety argument FLIPS depending on whether #625 is present, so do not inherit this paragraph —
redo it.** Without #625, `reevalLeaves`' `activeMembers` still joins `contacts.externalId`, so the
cohort can never be a leaver and a wider matcher set cannot change leave emissions at all. With #625,
`activeMembers` includes the cohort, so a wider matcher set means FEWER leavers. Both happen to be
safe directions, but the reason differs, and a conclusion that is true for the wrong reason is one
refactor away from being false.

### 2. `send-campaign.ts:984` — product decision

A bucket-targeted campaign silently OMITS email-only and anonymous members. Correcting it means those
people START receiving campaign email. Not an engineering call; with the product owner.

### 3. Two things never verified

- **Whether the leave side needs its own equivalent of the backfill in-flight race guard.**
  `firstTimeBackfillIncomplete` protects the JOIN path from racing a first-time backfill's silent
  materialization. Whether the leave/dwell passes need the same protection was never traced.
- **Real-world population size.** Only the dev DB was measured, and it is zero. See below.

## Measurements, with their limits

Dev DB (`growthhog` on localhost:5434), 2026-07-28:

- 180 live contacts with `external_id IS NULL` — 174 anonymous-keyed, 6 uuid-keyed email-only
- **0** of them are active bucket members, so the local blast is zero
- 54 of 55 active memberships resolve to no contact at all — these are `bkt-<timestamp>` TEST
  FIXTURES whose contacts were swept, not real data. Discount them.

**Do not generalise from that zero.** The engine is published to deployments nobody here can measure.
The guard exists because the population is unbounded in principle, not because it was observed.

Useful query for a real deployment:

```sql
select count(*) as newly_visible_memberships,
       count(*) filter (where bm.max_dwell_at is not null and bm.max_dwell_at <= now())
         as would_ttl_leave_on_first_tick
from bucket_memberships bm
join contacts c
  on coalesce(c.external_id, c.anonymous_id, c.id::text) = bm.user_id
 and c.deleted_at is null
where bm.status = 'active' and bm.deleted_at is null and c.external_id is null;
```

## Scope correction worth recording

An earlier note claimed #621 (observation no longer mints contacts) made this worse by growing the
stranded population. **That was wrong and was retracted.** Memberships whose key owns NO contact row
stay invisible under BOTH the old and the new join — both are INNER joins to `contacts`. The fix
rescues only contacts that EXIST with a NULL `external_id`, which is a PRE-EXISTING population
unrelated to #621.

Separately: the original R3 concern — that `contactId: map.get(row.userId)` in the reconcile/backfill
emits could miss and mint an `external_id = <anonId>` row — was investigated and is **NOT A BUG**.
Every producer is inner-joined to `contacts` and `BucketLeaver.contactId` is a required non-nullable
`string`, so the map cannot miss. The fast-expiry timer carries no pin by design but does inherit
`allowCreate`.
