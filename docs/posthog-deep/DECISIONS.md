# DECISIONS — deep PostHog integration

Global locked choices. Every PRD in `prds/` inherits these. Settled — do not re-litigate
during BUILD.

Scoped under `docs/posthog-deep/` rather than claiming repo-global `docs/DECISIONS.md`,
because this is one initiative in a repo that already uses `docs/` for shipped subsystem
docs (`tracking.md`, `sms.md`, `groups.md`).

> **Read §8 before §2.** The cohort integration — PRDs 02, 03, and everything sequenced
> behind them — was **parked** on 2026-07-28, and PRD 04 was **cut**. PRDs 00 and 01 and
> the P0 prerequisite shipped and stay. Sections 2.2 and 2.4 through 2.7a below describe
> a system that is **not in the tree**; they are preserved because the analysis is
> expensive and correct, and because the parked branch is meant to be resumable. §8
> records what happened and why; §9 records the design rule the episode produced, which
> outlives PostHog entirely.

## 1. Product definition

Make `@hogsend/plugin-posthog` deep enough that a team already running PostHog adopts
Hogsend as their action layer. PostHog owns analysis; Hogsend owns what happens next.

Strategic framing: PostHog's central noun is the **cohort**. Every PostHog user has
dozens defined and can do nothing with them. Making a cohort drive a TypeScript journey
is the wedge; everything else in this stack supports or follows it.

## 2. Architecture

### 2.1 Non-negotiable posture

- **PostHog stays optional and never load-bearing.** Every feature here degrades to a
  documented no-op when no PostHog credential exists. The engine must build, boot, and
  pass tests with the plugin absent.
- **Engine-over-Studio.** Capabilities land in the engine first. Studio may observe.
- **Replay-safety / exactly-once laws in `CLAUDE.md` apply unchanged.**

### 2.2 The bucket spine carries cohort membership (locked, D1)

A PostHog cohort is modelled as a `kind: "manual"` bucket whose membership is populated
by an external sync. This inherits `entryLimit`, `minDwell`/`maxDwell` anti-flap, the
reconcile cron, and the emission plumbing rather than reimplementing them.

Verified state of the seam:

- `BucketMeta.kind: "manual"` is declared (`packages/core/src/types/bucket.ts:24`) and
  rejected by a single `superRefine` (`packages/core/src/schemas/bucket.schema.ts:114-123`).
- Four independent consumers already skip manual buckets correctly:
  `packages/core/src/registry/bucket.ts:65-68`,
  `packages/engine/src/buckets/check-membership.ts:144-151`,
  `packages/engine/src/workflows/bucket-reconcile.ts:102`,
  `packages/engine/src/workflows/bucket-backfill.ts:90,647`.
- `emitBucketTransition` (`packages/engine/src/lib/bucket-emit.ts`) is generic and
  reusable as-is.
- `bucket_memberships.source` already anticipates a `"manual"` value.
- Journey triggers are **not** subject to the reserved-namespace check
  (`RESERVED_EVENT_NAMESPACES` in `packages/core/src/events.ts:8-23` is enforced only for
  Studio Blueprints and semantic-link names), so `bucket:entered:<id>` works today.

**The gap is a writer.** No membership-mutation path exists anywhere in the codebase.

### 2.3 Identity (foundational, and not in the original brief)

PostHog `person_id` is stored **nowhere** in Hogsend today. The entire integration
operates on `distinct_id` only (`packages/plugin-posthog/src/properties.ts:150-172`
reads `/api/environments/{projectId}/persons/` and never reads `results[0].id`).

A PostHog person has **many** distinct_ids under one `person_id`. Picking "the first
distinct_id" yields a key that changes between polls, producing phantom joins and leaves
every tick.

**Locked:** PostHog person identity is modelled as a **mapped alias**, following the
existing `crm_links` precedent (`packages/db/src/schema/deals.ts:84-107`): own an
internal key, treat every external system's id as a mapped alias. This is a pure FK
side-table join that does **not** touch the `contacts` resolver's identity columns, and
is therefore immune to the string-key value-fold bug class this repo has already been
burned by (fixed 0.36.1).

Resolution rules:

- Resolve a PostHog person to a contact via the **whole** distinct_id set plus email, then
  persist the mapping.
- A mapping miss means **re-resolve**, never "not a member". A miss must never cause a
  membership *removal*.

**Two functions, not one (corrected after critique).** The first draft locked
`resolveOrCreateContact` as the resolver while also requiring a read path that returns
"unresolved" without creating anything. Those cannot both hold:
`resolveOrCreateContact` (`packages/engine/src/lib/contacts.ts:519`) has **no find-only
mode** — its three documented outcomes are create, fill-in-link, and collide-MERGE, and a
zero-candidate call falls through to an unconditional insert. So:

- **`lookupPostHogPerson`** — find-only. Mapping lookup, then value lookup. Returns
  `{ found: contact } | { found: null }` and creates nothing. This is what read paths
  consume: the cohort diff, PRD 06's dry-run, PRD 08's reconciliation.
- **`resolvePostHogPerson`** — creating. Used only where materializing a contact is
  intended, tagged with an explicit `source`.

**Who creates contacts for cohort members, decided:** the sync materializes contacts for
members **carrying an email**, and returns unresolved for anonymous-only members. Both
extremes are wrong — a non-creating sync makes a 40k cohort resolve to near-zero members
for a PostHog-first team on day one, with a "skipped" counter as the only signal; an
always-creating sync mass-mints up to `maxCohortSize` contacts keyed on PostHog
distinct_ids, polluting the consumer's own `externalId` keyspace and their contact counts.
Contacts created per sync tick are bounded and reported.
- Anonymous-only cohort members are imported for size fidelity. Acting on them is
  deferred; existing preference and channel gates already no-op them.

### 2.4 Cohort sync is a slow reconciler, not the fast path (refines D3)

Polling a large cohort at 5-minute cadence is design-invalidating, not a tuning problem:
~20k requests per full pull of a 2M-member cohort, against PostHog limits in the region
of 240/min. Sub-5-minute cohort latency is structurally unavailable regardless, because
PostHog recomputes behavioural cohorts on its own (~hourly) cadence.

**Locked:** the cohort poll is a slow **reconciler** on an independent, configurable
cadence. Latency-sensitive behaviour routes through the **existing** real-time
`/v1/webhooks/posthog` event loop, which is already provisioned by
`packages/engine/src/lib/provision-posthog-loop.ts`. This mirrors the shape the bucket
spine already uses: real-time ingest plus cron backstop.

Verified against PostHog's docs, 2026-07-27:

- **No cohort-entry signal exists.** Hog functions are event-triggered; a cohort can only
  appear as a *filter* on an event trigger, which detects "the person's next event after
  they already matched", not entry. Worse, cohorts used in CDP destination filters must
  contain exclusively person-property filters — **behavioural cohorts error outright**, and
  those are the kind lifecycle teams actually build.
- PostHog's own "Realtime Cohort Calculation" work (issue #39366) is **unshipped**, with
  the cohort-membership-change Kafka publish still outstanding, and is internal
  infrastructure that may not be externally subscribable even when it lands. Re-check in
  6–12 months; do not design against it.
- **Dynamic cohorts recalculate roughly every 24h server-side.** A 5-minute poll is already
  ~288x more frequent than the underlying population changes. Freshness for behavioural
  cohorts has a hard floor set by PostHog's recalculation cadence that no push path fixes.
- Poll also handles **leaves** and static cohorts uniformly, which an event-match push path
  does not help with at all.

**Refinement (adopted): cheap-check before expensive pull.** The cohort LIST endpoint
returns `last_calculation` and `count` per cohort. Poll the cheap list, and only pay for
the full `/persons/` dump when `last_calculation` has advanced since the last observation.
Same cadence, materially cheaper in the common case.

**Rejected: the property-only-cohort push path.** It would require introspecting each
cohort's filter shape and provisioning a separate per-cohort hog function, for a partial
win that silently breaks when someone adds a behavioural condition to the cohort, with no
signal back to Hogsend. Revisit only on a specific customer need, as an opt-in advanced
feature documented as "faster for property-only cohorts, not entry detection".

Bounds:

- A `maxCohortSize` cap (default 100k) refuses to sync a larger cohort with a clear
  error, rather than discovering the limit in production.
- A resumable page cursor persists in `import_jobs` so a rate-limited pull continues next
  tick instead of restarting.
- **Rate limits are per-organization, shared with the customer's own PostHog API usage.**
  Analytics endpoints (which almost certainly covers cohort `/persons/`): 240/min,
  1200/hr. CRUD: 480/min, 4800/hr. Query: 2400/hr. 1200/hr caps a full pull at ~1200 pages
  per hour *across everything else the customer does against PostHog*. Budget
  conservatively; we are a guest in their quota.
- The default poll cadence should be set against the ~24h recalculation reality, not
  against a 5-minute instinct. Configurable, defaulting slow.

### 2.5 The feedback loop is cut structurally, not by convention

`packages/engine/src/lib/bucket-posthog-sync.ts` already writes `hogsend_bucket_<id>` to
PostHog persons on join. Combined with cohort import, that closes a loop: property write
→ PostHog cohort recomputes → poll sees a join → journey runs → property write.

The existing `bucket:*` recursion guard (`check-membership.ts:105-108`) does **not** catch
this: the PostHog round-trip launders the event, re-entering as a poll result rather than
a `bucket:`-prefixed ingest. `minDwell` debounces oscillation, not amplification across
distinct buckets. The loop's period is bounded by PostHog's recompute plus the poll
interval, so it is a *slow* oscillator — it evades fast-loop alarms and surfaces as a
mystery drip of sends over days.

**Locked, in order of reliance:**

1. **Provenance segregation, enforced at binding activation and re-checked every tick.**
   Refuse to activate a binding whose cohort definition references any person-property key
   Hogsend can write. The check **walks nested cohort references** and **fails closed**
   when one cannot be resolved, naming the unreadable cohort.

   Two corrections from critique, both of which the naive version gets wrong:

   - **It keys off a provenance registry, not the `hogsend_*` prefix.** A static prefix is
     evadable using documented features: a bucket with a custom `postHogPropertyKey`, or
     one line of `getAnalytics()?.setPersonProperties()` inside a cohort-triggered
     journey, closes a two-hop loop that passes registration, evades
     write-suppression, and stays under the fuse. The registry covers the default `hogsend_bucket_<id>`, every configured
     `postHogPropertyKey` across the bucket registry, and PRD 07's writeback keys.
     Additionally, engine-originated person writes are namespace-forced (a
     `setPersonProperties` key outside the reserved namespace is rejected or prefixed) so
     the registry is **closed rather than best-effort**.
   - **It cannot run at boot, and must not.** The boot path is synchronous and a live
     PostHog fetch there would make a PostHog outage or an expired token take down every
     API and worker boot — the precise failure mode §2.1 forbids. Making
     `createHogsendClient`/`createApp`/`createWorker` async to accommodate it would be a
     breaking change to the committed public API surface, budgeted nowhere.

   So the guard lives on the **data plane**: enforced when a binding is activated (an async
   admin/CLI operation that can fail the bind) and re-verified at the head of each sync
   tick. A fail-closed result disables **that single binding** — no transitions emitted,
   loud log, admin surface, metric — never the process.

   **Re-checking every tick is not optional.** Cohort definitions are mutable upstream: an
   operator binds a clean cohort, later adds a `hogsend_bucket_a` filter in the PostHog UI
   (which PRD 07 actively encourages), and a registration-only guard never re-runs until
   the next redeploy. The cheap-check LIST poll already hits the endpoint each tick and the
   response carries the cohort's filters, so re-walking is close to free. On drift, halt
   syncing that cohort and surface a loud operator-facing error rather than logging and
   continuing.
2. **Write-suppression on cohort-sourced membership.** A transition whose membership row
   has a cohort/manual `source` does not fire `syncBucketToPostHog`. Today the mirror is
   unconditional (`bucket-emit.ts:143-146`).
3. **A per-contact, per-window person-write fuse.** Not a fix, a numeric backstop for a
   semantic guard that a nested cohort can defeat.
4. **A metric** on cohort-sourced joins per bucket per tick, alarmed on step change.

Precedent worth noting: `ingestEvent` already excludes `source === "posthog"` from the
analytics mirror as an anti-loop measure (`packages/engine/src/lib/ingestion.ts:478-520`).

### 2.6 A failed observation is not an empty cohort

Every existing PostHog call soft-fails to `{}`. Correct for person reads; catastrophic
for a cohort diff, where an empty list reads as *"every member left"* and produces a mass
`bucket:left` emission, mass journey exits, and every leave-reaction firing at once.

**Locked:** the sync distinguishes "successfully observed an empty cohort" from "failed to
observe". Any page failure **aborts the whole diff**; leaves are never emitted from a
partial read. This is the first test written in PRD 02.

Two extensions from critique, because the narrow version leaves the catastrophe reachable
by two other routes:

**A cohort that is gone is not a cohort that is empty.** A 404, 403, or 410 on a bound
cohort — someone deleted, renamed, or permission-revoked it in the PostHog UI, an action a
PostHog admin considers routine housekeeping — must be treated as failed-to-observe. Emit
nothing, mark the binding degraded, surface a named error, and stop retrying silently after
N consecutive failures. The cheap LIST poll must confirm the cohort id is still present
before any `/persons/` result is interpreted as authoritative. Binding removal gets its own
explicit rule: members stay, no leaves are emitted, the binding is marked inactive.

**Identity-resolution failure must not manufacture leaves.** The transport invariant above
is satisfiable while the catastrophe still happens: if the diff compares *resolved
contacts*, a resolver outage during one tick makes members look absent and emits
`bucket:left` for all of them. PostHog is healthy throughout, so the abort never triggers,
and the incident presents as a mystery mass-exit.

Therefore the **diff is computed on PostHog `person_id`, not on resolved contacts.** The
source `person_id` is persisted on the membership at join (a column, or the existing
`bucket_memberships.context` jsonb). Identity resolution is then needed only for the
*join* leg and can never subtract from the observed set. The abort predicate widens from
"a page failed" to "the observation is incomplete", explicitly covering "the resolver
threw".

### 2.7 The cohort poller owns its membership writes, then emits

**Corrected 2026-07-27 after critique. The earlier wording of this section was factually
inverted and would have produced an unbuildable system — recorded here so it is not
reintroduced.**

The wrong version said the poller "calls `emitBucketTransition` and never writes
`bucket_memberships` directly". That is not how the existing producers work.
`emitBucketTransition` (`packages/engine/src/lib/bucket-emit.ts`) **only emits**; every
existing producer writes the membership row itself and *then* calls it. Taken literally,
the old wording yields a system where nothing ever writes membership: leaves have nothing
to diff against, `epoch` has no source so the deterministic idempotency key
(`bucket:<id>:<user>:<kind>:<epoch>`) cannot be computed, and every tick re-emits a join
for every member forever — the exact mass-emission failure this stack exists to prevent.

**The real contract:** a producer OWNS the membership mutation and then emits.

Concretely, the cohort poller routes every join and leave through PRD 01's
`addBucketMember` / `removeBucketMember`, which own the row write, the epoch via
`countPriorMemberships()`, `maxDwellAt` via `computeMaxDwellAt()`, the `entryLimit` gate
via `shouldEmitJoin()`, `minDwell` deferral, and the `emitBucketTransition` call. The
poller calls `emitBucketTransition` directly **never**. That is how PRD 02 inherits epoch,
`entryLimit`, and `minDwell` for free rather than reimplementing them.

`addBucketMember`/`removeBucketMember` therefore have a return shape that is a real
contract PRD 02 consumes: did-emit, epoch, and verdict. They must be callable from a
workflow task (no request container).

### 2.7a Seeding: binding a cohort must not enroll its existing population

The engine already settled this for dynamic buckets and the first draft of this stack
dropped it. `bucket-backfill.ts:56-66` materializes the existing matching population with
`source: "backfill"` and explicitly **suppresses join emission** — "historical matches must
not fire `bucket:entered` into live journeys — the Customer.io rule" — and
`enqueueBucketBackfills` applies it to every newly registered dynamic bucket.

**Locked:** the first observation of a binding materializes membership rows with a
seed source and **no emission**. Only subsequent diffs emit. Enrolling the existing
population requires an explicit `emitOnSeed: true` opt-in.

Backstops, because a sanctioned `maxCohortSize` of 100k makes the blast radius large:

- A per-tick transition cap that aborts and alerts above N.
- A binding preview that reports "would emit N joins" before the first real tick.

Without this, binding a 40k-member cohort to try the headline feature sends 40k emails in
one burst, irreversibly, as the first thing every new user does. Note also the internal
inconsistency this fixes: PRD 06 makes an operator-invoked historical replay dry-run by
default, while the automatic cron path acted on a larger historical population with no
guard at all.

### 2.8 Codegen needs an engine proxy route (revises the original brief)

`hogsend flags generate` is fully offline. A PostHog codegen cannot be: decrypted tokens
never leave the engine by explicit invariant
(`packages/engine/src/routes/admin/provider-credentials.ts`).

**Locked:** a new admin route resolves the token server-side and proxies the definitions
fetch; the CLI does only offline `.d.ts` rendering. Template is
`POST /v1/admin/analytics/provision-loop`
(`packages/engine/src/routes/admin/analytics.ts:157-357`): route-local
`createTokenManager({ db, providerId: "posthog", logger })`, resolve
`getAccessToken() ?? env.POSTHOG_PERSONAL_API_KEY ?? null`, `409 no_posthog_credential`
when neither exists, typed error class mapped to 502 for upstream failures.

Generated types are **observed, not declared**: properties optional by default, `--check`
for drift, strictness opt-in.

### 2.9 Credentials — already sufficient

The OAuth scopes granted by `hogsend connect posthog` already include `cohort:read`,
`cohort:write`, `feature_flag:read`, `event_definition:read`, `property_definition:read`,
`person:read`, `person:write`, `query:read` (`packages/cli/src/lib/oauth.ts:35-39`,
mirrored in `packages/engine/src/lib/posthog-scopes.ts:18-30`). They were deliberately
front-loaded so future features activate without forcing a reconnect.

**No scope changes. No reconnect for existing users. No consent-screen change.**

Always obtain tokens through `createTokenManager().getAccessToken()`, never by reading
`getProviderCredential` raw — the manager owns expiry and refresh.

### 2.10 `posthog-node` provides nothing here

Verified against the installed SDK (v5.35.1): zero helpers for cohorts, event definitions,
property definitions, or surveys. Every one is a hand-rolled `fetch`, following the
existing pattern in `properties.ts`. Reuse `createRateLimitedFetch` — it already handles
request spacing, 429s, `Retry-After`, and exponential backoff.

**It must move first.** It currently lives in `packages/cli/src/lib/import-shared.ts:96-148`,
and neither `plugin-posthog` nor `engine` can import from `@hogsend/cli` — that is a
workspace dependency cycle which under pnpm either fails to build or produces a
nondeterministic tsup bundle. Mandating reuse from where it sits would block the first task
of the headline PRD on a refactor no PRD owns, and the likely improvisation is
reimplementing the limiter three times slightly differently.

**Locked:** a prerequisite task moves `createRateLimitedFetch` into `@hogsend/core`, with
`packages/cli` re-exporting it for back-compat. Core is cycle-free here: both
`plugin-posthog` and `engine` already depend on it, and it depends on neither. That task is
a declared dependency of the cohort client, the codegen proxy, and the backfill puller.

## 3. Explicit non-goals

1. **Cohort *definition* translation into bucket criteria.** Import membership only. This
   single decision keeps the cohort sync shippable in weeks rather than quarters.
2. **PostHog feature flags as journey conditions.** No `FlagProvider` seam exists; Hogsend
   flags are already native and already support `FlagTargeting: { type: "bucket" }`
   (`packages/core/src/flags/types.ts:13`), so syncing the cohort gives the same
   capability. Cut by the user, 2026-07-27. Surveys are unaffected and stay in scope.
3. **Virtual-clock backfill.** No fast-forwarding of `ctx.sleep` during replay — enormous
   blast radius against the replay-safety laws. Backfilled enrollments run forward in real
   time from now.
4. **Sub-5-minute cohort latency.** Structurally unavailable. Documented, not chased.

## 4. Quality gates

Verbatim commands, run per task. Turbo fan-out OOMs on CI without a concurrency bound
(exit 137 reads as "runner shutdown", not a type error).

```
pnpm exec turbo run check-types --concurrency=2
pnpm lint
pnpm exec turbo run test --concurrency=2
pnpm exec turbo run build --concurrency=2
```

**Note on `lint`:** there is no turbo `lint` task in this repo — `turbo run lint` fails with
"Could not find task 'lint' in project". The root `pnpm lint` (`biome check .`) is the real
gate. Corrected 2026-07-27 after wave 1 reported it.

**Known pre-existing local test failures**, not caused by this work and not to be chased by
delivery agents: `@hogsend/api` fails 3 files with `relation "enrichment_lookups" does not
exist` (a stale local test DB needing `cd packages/db && pnpm db:migrate`), and
`gtm-score-batch`'s keyset-walk test depends on local `contacts` table size.
`campaigns-dataplane` has a timing-sensitive flake that passes in isolation. Verify any new
failure against a stashed clean tree before attributing it to a change.

Plus, per task: a real check of the affected surface, not just green tests. A wrong test
certifies rather than fails — mutation-test any guard written for a shipped bug.

## 5. Conventions

- Conventional Commits, one commit per task, no `Co-Authored-By`, no AI/vendor mention.
- `pnpm add <pkg>@latest`; never hand-edit versions.
- TDD: failing test first, then green.
- Biome; 2-space, double quotes, semicolons, 80 cols.
- New engine npm deps must mirror into `packages/create-hogsend/template/_package.json`.
- Work happens in the worktree `.claude/worktrees/posthog-deep`, branch
  `feat/posthog-deep-integration`.

## 6. Publish mode

Branch + PR + squash merge, per standing authorization. Commit freely as tasks complete.
Do not merge to `main` without Doug's nod on the preview.

## 7. Seams requiring human input

- A real PostHog project with populated cohorts, for end-to-end verification beyond fakes.
- PostHog's published rate-limit numbers, to tune `minIntervalMs` (nothing in the repo
  encodes them).
- Any PostHog CDP catalog submission (PRD 10) is outward-facing and needs explicit
  approval.

## 8. The cohort integration is parked; PRD 04 is cut (2026-07-28)

**What shipped and stays on `feat/posthog-deep-integration`:** the P0 prerequisite (the
rate-limited fetch, moved into `@hogsend/core`), PRD 00 (`posthog-identity-map`), and
PRD 01 (`manual-bucket-membership`). PRD 01 is the valuable standalone engine primitive
— it has no PostHog coupling and stands on its own, exactly as §BACKLOG sequencing
predicted it would.

**What is parked:** PRD 02 (`posthog-cohort-sync`) was built, reviewed, and then reverted
off the working branch. PRD 03 (`cohort-loop-guard`) is consequently not startable: it
exists only to guard a loop that PRD 02 closes.

**Where the work is, stated plainly so it can be recovered.** Work that cannot be found
again has been deleted, whatever the doc says.

- Branch **`parked/posthog-cohort-sync`**, seven commits, `b2ada111..1d7d91db`.
- The **first** of those seven, `b2ada111` (`refactor(engine): let
  liveContactByCanonicalKey take a column`), was cherry-picked forward and is on the
  working branch as `25b8674f`, because PRD 00 depends on it. So the cohort-specific work
  is the six commits `3d851442..1d7d91db`, and a resumption starts there.
- The last of those, `1d7d91db` (`docs(posthog): mark PRD 02 shipped`), is the false
  shipped-claim. It exists only on the parked branch; on the working branch PRD 02 reads
  parked, as it should.

**Why parked, and it is not a quality judgement.** Two reasons.

First, PostHog is repositioning away from being the passive data layer that other tools
act upon. A deep bet on their cohort surface is worth less than it looked when this stack
was specced, and §2.4's finding — that there is no cohort-entry signal, that the
realtime-cohort work is unshipped, and that behavioural cohorts error outright in CDP
destination filters — reads differently once the vendor is moving in that direction on
purpose.

Second, and more decisively: of roughly 26k lines built, about 20k were the cohort
integration. The ~6k underneath it — the rate-limited fetch in core, the fix for bucket
membership missing anonymous contacts and matching soft-deleted merge losers, and the
whole manual-bucket membership primitive — is vendor-neutral engine capability worth more
than the integration sitting on top of it. Parking the top and keeping the base is the
trade.

**PRD 04 (`cohort-trigger-sugar`) is cut, not deferred.** It was the original source of
the `trigger: { cohort: "some-name" }` magic string that started this review. With the
cohort bet parked there is no cohort-bound bucket to sugar, and the decision is not to
ship the cohort trigger. `trigger: { event: "bucket:entered:<id>" }` remains legal
end-to-end today with zero engine changes (§2.2), which is the whole capability minus the
sugar.

**Consequence worth stating plainly: `AudienceSource` was dropped.** That descriptor was
designed to replace the raw `cohortId: number` on a bucket binding, and it existed solely
to fix the cohort binding's magic number. With the cohort bet parked it has zero
consumers, and building a vendor-source abstraction with no vendors behind it is
speculative machinery.

## 9. A declared reference is passed as the object, never as a name

This is the durable design rule the episode produced. It outlives PostHog, it is not
scoped to this initiative, and it is the lasting output of the review that parked the
stack.

**A reference to something declared in the consumer's own repo is passed as the typed
object, never as an unchecked name.** The consumer authored the thing; the type system can
see it; passing a bare string throws that away and converts a compile error into a runtime
wrong answer.

**And this applies to READ paths as much as WRITE paths.** That asymmetry is the
recurring defect class found here: sends were narrowed against a registry while the
corresponding history reads took bare strings. A typo therefore compiled, and quietly
returned a wrong answer instead of erroring — a "this user has not received that email"
that is indistinguishable from the truth, on a code path whose entire job is to decide
whether to send again.
