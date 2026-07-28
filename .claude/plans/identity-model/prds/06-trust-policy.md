# PRD 06 — Trust is a property of the key

> **Re-anchored 2026-07-28** after PRDs 01/02/03 landed. Every `lib/contacts.ts` anchor below was
> re-derived against the post-03 file (~+140 lines); route anchors held almost exactly. A senior
> advisory pass over the re-anchored spec produced four substantive corrections, all applied:
> the public `create` shape (L1), T4's false one-call promise, the deletion of the `upsertContact`
> task (dead code), and T2's namespacing requirement. See §Advisory corrections.

## Goal

Today the resolver infers a caller's trust from two loose booleans (`restrictToAnonymous`,
`allowCreate`) and then re-derives what they mean from *which keys happen to be present*
(`contacts.ts:835-840`). That inference is why the history-theft class exists: `keysAnotherContact`
(`contacts.ts:133-163`) had to be bolted on because the ADOPT arms could not tell "this caller is
authorized to name this key" from "resolution happened to miss". Replace the inference with an
explicit `ResolvePolicy` object the caller declares once — `{ create, allowMerge, trustedKinds }` —
so trust travels with the call instead of being reconstructed inside the resolver.

This PRD is a **pure refactor**. Every reachable input must produce a byte-identical outcome. It
adds a second, equivalent way to say the same thing (additive), moves every caller onto it (flip),
and deliberately does **not** delete the legacy fields — that removal is a breaking public-API change
and is out of scope here (see §Locked decisions, L7).

## Locked decisions

### L1 — the policy shape, and why `create` and `allowMerge` cannot be collapsed

```ts
/** Already exists, unexported, at contacts.ts:415. This PRD exports it. */
export type IdentityKind = "external" | "email" | "anonymous" | "discord";

export interface ResolvePolicy {
  /**
   * MINT policy. `"on-miss"` is today's create arm (contacts.ts:891-973).
   * `"refuse-on-miss"` is D1's observation refusal (contacts.ts:902-910).
   * The refusal KEY is never accepted from the caller — see below.
   */
  create: "on-miss" | "refuse-on-miss";
  /**
   * MERGE/ATTACH policy. `"any"` is unchanged. `"anonymous-only"` is today's
   * `restrictToAnonymous` clamp — read at exactly three sites: the provenance
   * pin gate (contacts.ts:867), the fill-in-link refusal (contacts.ts:983-985),
   * and the collide-MERGE refusal (contacts.ts:1012-1014).
   */
  allowMerge: "any" | "anonymous-only" | "never-identified-pair";
  /** The key kinds THIS CALLER is authorized to assert. */
  trustedKinds: readonly IdentityKind[];
}
```

**The refusal key stays DERIVED. It is never part of the public shape.** An earlier draft of this
PRD specified `create: "on-miss" | { refuseWithKey: string }`, reasoning that carrying the key made
it impossible to refuse without supplying one. That is backwards, and shipping it would have been a
safety regression.

No caller supplies the refusal key today. `resolveContactNoCreate` **derives** it —
`const refuseCreateWithKey = userId ?? anonymousId` (`contacts.ts:1131`) — and throws the D8 error
when it cannot (`:1132-1138`). Derivation is what *enforces* the invariant "the refusal key is
always the key the create arm would have made canonical". Accepting one from a caller relaxes that
enforcement to a convention: any policy-declaring caller could refuse with an arbitrary string, and
a key diverging from `userId ?? anonymousId` strands the event's history under a key no contact will
ever own. That is precisely this stack's bug class — an invariant carried by a caller-supplied
string instead of a structural fact. The public discriminant is therefore a plain two-value enum,
and the key remains derived + D8-enforced inside `resolveContactNoCreate`.

**Reserve the third `allowMerge` value now, even though this PRD does not implement it.**

The vocabulary as shipped cannot express the one rule every mature identity system enforces:
*never merge two ALREADY-IDENTIFIED persons.* That gap is reachable today with entirely legitimate
credentials — person A signs in on a browser (their anon id `V` is claimed onto A's identified
contact), person B then signs in on the SAME browser without `reset()`. The resolve
`{ userId: B, anonymousId: V }` finds two candidates, both identified, and `mergeContacts` folds two
real humans into one: `pickSurvivor` (`contacts.ts:672-693`) prefers identified-then-oldest and does
not care that both are identified. Only the ANALYTICS side notices, via `mergedIdentifiedKeys` — the
database merge has already happened. Shared computers, family devices and kiosks make this an
ordinary event, not an attack.

This PRD is a behaviour-preserving refactor (D8), so it must NOT fix that here — it would forfeit the
byte-identical proof structure, and the behaviour is old rather than new. But the type must leave
room, and the guard-rails must have teeth (see §Done when, F4 items): a reserved value, a test
pinning today's behaviour on BOTH hooks the eventual fix will flip, and a filed issue whose number is
recorded before merge. A documented reserved value is honest; an undocumented one is the trap.

DECISIONS §4 says `allowCreate` and the #621 refusal sites stay and must not be unwound. They are
two **fields**, never one. Concretely they answer different questions and their values **disagree at
a real, shipped call site**: `routes/tracking/arrive.ts:201` passes `restrictToAnonymous: !isToken`
one line above `:220`'s `allowCreate: isToken` — opposite polarity, same request. And at
`routes/events/index.ts:186` + `:191` they co-occur as `true`/`false` for the same publishable
observation-only write. That polarity disagreement — not the shape of the union — is the whole
anti-collapse argument, and it survives the L1 correction above intact.

### L2 — `trustedKinds` replaces an *inference*, not a *check*

The clamp today is derived, not declared:

```ts
// contacts.ts:835-840
const restrictToAnonymous =
  opts.restrictToAnonymous === true &&
  !userId && !email && !discordId && !!anonymousId;
```

The supplied keys are built two lines later (`contacts.ts:842-846`). So
`!userId && !email && !discordId && !!anonymousId` is *exactly* `suppliedKinds === ["anonymous"]`.
The policy predicate is therefore provably equivalent:

```ts
const clamped =
  policy.allowMerge === "anonymous-only" &&
  suppliedKinds.length === 1 &&
  suppliedKinds[0] === "anonymous";
```

This is an algebraic identity over the same four locals (normalized at `:824-827`), not a judgement
call — which is what makes T1 mechanically safe. **Verified to survive 02/03:** PRD 03 did not change
key construction, `keys` has no other producer, `type Kind` (`:415`) still has exactly the four
members, and `phone` is still not a resolver input (`import-contacts.ts` attaches it outside the
resolver via `attachPhone`). `trustedKinds` is **not** used to derive the clamp; it is a new,
independent declaration (see L3).

Ordering note: the pin gate (`:867`) reads the clamp before candidates resolve but after keys are
built (`:842-853`), so policy normalization at the top of `resolveContactShared` sees everything it
needs. No ordering hazard.

### L3 — `trustedKinds` is declared in T3/T4 and enforced in T5, as two commits

DECISIONS §3 Z: "A publishable browser key may only ever assert `anonymous`; a secret key anything;
a verified `userToken` upgrades `external`." `gatePublishableIdentity` (`routes/_shared.ts:42-83`)
already enforces exactly that, one layer above the resolver:

- `:53` — publishable with no claimed identity ⇒ allowed (anon-only default).
- `:56-64` — publishable claiming an identity with no `userToken` ⇒ 403.
- `:70-75` — a verified token binds a `userId` only; any asserted `email` ⇒ 403, and a `userId`
  mismatching the token ⇒ 403.

And neither public body admits a `discordId`: `routes/events/index.ts:9-48` and
`routes/contacts/index.ts:45-55` accept only `email`/`userId`/`anonymousId`/`userToken`.

**The unreachability proof has three legs, not one.** The gate covers `/v1/events`, `/v1/contacts`
and all three `lists` handlers. It does **not** cover the other two browser-facing surfaces, which
are unreachable for different reasons: `arrive`'s keys are derived from the first-write-wins stamp
(one key per leg, matching the declared kinds), and `feed`'s publishable arm never reaches
`resolveContactShared` at all — its re-ingests are L4 full-trust with a server-derived subject. A
future reviewer must not verify T5 by gate coverage alone.

So resolver-level enforcement of `trustedKinds` is unreachable from every browser-facing route today.
Adding the throw is therefore behaviour-identical for all reachable inputs, but it is not a no-op in
the strict sense — it is defence in depth against a future route that forgets the gate. It ships as
its own task (T5) so a reviewer can drop it without touching T1-T4.

### L4 — the trap: an engine-internal re-emit is a SERVER-trusted caller, even when a publishable request caused it

`routes/feed/index.ts:469` re-ingests with `userId: args.recipientKey`, and on the publishable anon
arm `recipientKey` **is the raw browser anon id** (`routes/feed/recipient.ts:115-161`). That is an
`anonymous`-valued string presented under the `external` kind. A naive reading of "this request came
in on a pk_ key, so `trustedKinds: ["anonymous"]`" would make T5 throw on every bell mark/clear for
an anonymous visitor.

Today's code already draws the correct line: `emitMarkEvents` passes **no** `restrictToAnonymous`
(`routes/feed/index.ts:45-82`, ingest at `:58`, userId at `:69`, pin at `:74`) — it is a
server-derived subject with an unforgeable `contactId` pin, not a caller assertion. The rule the
policy makes explicit:

> `trustedKinds` describes the keys **as supplied by the caller of the resolver**. An engine-internal
> re-emit whose subject was derived server-side is a fully trusted caller regardless of what
> authenticated the originating HTTP request. What it inherits from that request is `create` (the
> D1 refusal), never `allowMerge` and never `trustedKinds`.

**The `contactId` pin is a SUBJECT declaration, orthogonal to the policy.** It says *who* this
resolve is about; the policy says *what this caller may do*. It stays a sibling option on
`ResolveContactOptions` and is never folded into `ResolvePolicy` — folding them would make a
provenance pin look like a trust grant.

The same shape recurs at `journeys/journey-context.ts:1313-1318` (`ctx.trigger`),
`journeys/execute-journey-run.ts:422-434`, and the bucket chain (`lib/ingestion.ts:901` →
`buckets/check-membership.ts` → `lib/bucket-emit.ts:156,179` →
`workflows/bucket-reconcile.ts:310`) — all of which thread `allowCreate` and nothing else. That is
already correct and must stay correct. **Verified post-03: 02/03 added no new re-emit path.**

### L5 — every current caller, and the policy it declares

**15 non-test resolver call expressions across nine files**, plus 27 `ingestEvent`/
`ingestTransformResult` expressions that declare trust on their behalf (re-verified by grep over
`packages` + `apps`, excluding `*.test.ts` and `__tests__/`). **02/03 added ZERO new resolver or
ingest callers.**

| # | Call site | Caller class | `create` | `allowMerge` | `trustedKinds` | Evidence / why |
| --- | --- | --- | --- | --- | --- | --- |
| 1 | `routes/events/index.ts:174-191` (publishable, observation-only) | browser | `"refuse-on-miss"` | `"anonymous-only"` | `["anonymous"]` | `observationOnly` at `:164-170`; `:186` clamps, `:191` refuses |
| 2 | `routes/events/index.ts:174-191` (publishable, token-proven `userId`) | browser + token | `"on-miss"` | `"anonymous-only"` (inert) | `["anonymous","external"]` | `:186` still passes `true`, but the derived clamp is false because `userId` is present (`contacts.ts:835-840`). Keep passing `"anonymous-only"` so the derivation is unchanged — do NOT "optimise" it to `"any"` |
| 3 | `routes/events/index.ts:174-191` (secret key) | server | `"on-miss"` | `"any"` | all four | `c.get("publishable")` false at `:186`/`:191` |
| 4 | `routes/contacts/index.ts:160-172` (publishable) | browser | `"on-miss"` | `"anonymous-only"` | `["anonymous"]`, `+["external"]` with a verified token | `:171`; gate at `:155-156`; 403 translation at `:174-176`. This route NEVER refuses to create — `allowCreate` is not passed here at all |
| 5 | `routes/contacts/index.ts:160-172` (secret) | server | `"on-miss"` | `"any"` | all four | same line, `publishable` false |
| 6 | `routes/tracking/arrive.ts:195-220` (anon leg) | browser | `"refuse-on-miss"` | `"anonymous-only"` | `["anonymous"]` | `:201` `!isToken`, `:220` `isToken`. The POLARITY comment at `:213-219` is the canonical proof the two fields are independent |
| 7 | `routes/tracking/arrive.ts:195-220` (token leg) | server-minted identity | `"on-miss"` | `"any"` | `["anonymous","external"]` | same lines, `isToken` true |
| 8 | `routes/feed/recipient.ts:115-161` → `routes/feed/index.ts:58,428,456,466,487` (anon arm, no row AND no alias) | engine-internal re-emit | `"refuse-on-miss"` | `"any"` | all four (L4) | **CHANGED BY PRD 03.** `:159` sets `allowCreate: false` only when BOTH the column probe and the `resolveViaAlias` fallback (`:147-149`) miss. A second device's anon id now gets a `contactId` pin (row 9's shape) instead of a refusal. Mapping keys off `rec.allowCreate` stays correct — but do not reason from the pre-03 "no anon contact row exists" |
| 9 | `routes/feed/recipient.ts` token / secret / anon-with-row / anon-via-alias arms → same ingests | engine-internal re-emit | `"on-miss"` | `"any"` | all four | `:96`, `:105`, `:150-160` — `allowCreate` omitted; `contactId` pin carries provenance |
| 10 | `lib/feed.ts:190,191` `sendFeedItem`, pure-`anonymousId` recipient | journey/server | `"refuse-on-miss"` | `"any"` | all four | `refusable` at `:179-182`; the `userId` arm's mint is confidentiality-load-bearing (`:160-170`) |
| 11 | `lib/feed.ts:190,191`, any `userId`/`email` recipient | journey/server | `"on-miss"` | `"any"` | all four | same branch, `refusable` false |
| 12 | `routes/lists/index.ts:316` (`applyListSubscription`) | server or token-proven browser | `"on-miss"` | `"any"` | `["external","email"]` | gates at `:532-539` (subscribe) and `:562-569` (unsubscribe); helper's own identity guard at `:311-313`; the subscribe body (`:56-60`) has no `anonymousId`, so the clamp would be inert — declaring `"any"` is behaviour-identical, and the narrow `trustedKinds` is the honest statement |
| 13 | `routes/lists/index.ts:498` (set-preferences) | server or token-proven browser | `"on-miss"` | `"any"` | `["external","email"]` | `:480-495`; 400s when neither key is present |
| 14 | `routes/admin/contacts.ts:522` (admin create) | admin | `"on-miss"` | `"any"` | `["external","email"]` | body carries `externalId`/`email` only. **MOVED from `:486` — PRD 01 grew this file** |
| 15 | `routes/admin/contacts.ts:573` (admin update) | admin | `"on-miss"` | `"any"` | all four | re-supplies the row's own `externalId`/`anonymousId` (`:573-578`). **MOVED from `:537`** |
| 16 | `routes/admin/agent.ts:296` (subscribe/unsubscribe tool) | admin agent | `"on-miss"` | `"any"` | `["external","email"]` | `:291-300` |
| 17 | `routes/admin/agent.ts:324` (`upsert_contact` tool) | admin agent | `"on-miss"` | `"any"` | all four | `:322-329` |
| 18 | `routes/admin/agent.ts:336` (`update_contact` tool) | admin agent | `"on-miss"` | `"any"` | all four | `:333-343` |
| 19 | `lib/identity-service.ts:71` (`linkContact`) | connector (`plugin-discord`, `plugin-telegram`) | `"on-miss"` | `"any"` | all four | `discord` is the whole point of this entry point |
| 20 | `lib/crm-ingest.ts:89` (funnel stage-change) | CRM webhook | `"on-miss"` | `"any"` | `["email"]` | email-only resolve at `:88-94` |
| 21 | `workflows/import-contacts.ts:128` | operator import | `"on-miss"` | `"any"` | `["external","email"]` | key guard at `:122-127` |
| 22 | *(withdrawn — see §Advisory corrections, A2)* | — | — | — | — | `upsertContact` has **zero callers** and is not exported. Dead code; not this PRD's to touch |
| 23 | `lib/ingestion.ts:390-393` (the branch) | pass-through | from `opts` | from `opts` | from `opts` | stays a TWO-entry branch; see §A3 |
| 24 | `lib/ingestion.ts:901` → bucket chain (`buckets/check-membership.ts:75,105,250,270,291,302,358,380,407,419,488,594,604,615`; `lib/bucket-emit.ts:64,94,156,179`; `workflows/bucket-reconcile.ts:220,310`) | engine-internal re-emit | inherited `allowCreate` only | `"any"` | all four | all 20 anchors re-verified exact. Thread the `create` leg only; leave the other two alone |
| 25 | `journeys/journey-context.ts:1313-1318` (`ctx.trigger`) | journey | inherited (`assertsIdentity`) | `"any"` | all four | `:1318` |
| 26 | `journeys/execute-journey-run.ts:422-434` (lifecycle emits) | journey | inherited | `"any"` | all four | `:434` |
| 27 | `routes/webhooks/sources.ts:241,260`; `routes/connectors/index.ts:211,266,280`; `connectors/runtime.ts:100`; `cold-connect/index.ts:203`; `lib/refine.ts:120`; `lib/deal-money-events.ts:51`; `lib/tracking-events.ts:187,255,366`; `lib/crm-ingest.ts:182`; **`routes/admin/agent.ts:180,203`**; `routes/admin/{journeys.ts:858, events.ts:288, bulk.ts:431,526}`; `apps/api/src/workflows/gtm-score.ts:391` | server | `"on-miss"` | `"any"` | all four | none of these passes either flag today — they take the default. They must keep taking the default; the policy object is optional and its absence means exactly this row. **`admin/agent.ts:180` (`fire_event`) and `:203` (`enroll_in_journey`) were missing from the pre-03 table** — pre-existing omissions, not 02/03 additions, and the server default is correct for both |
| 28 | `lib/ingestion.ts:194-201` (`ingestTransformResult` per-element forwarding) | pass-through | forwards `allowCreate` verbatim at `:201` | — | — | **Was uncensused.** T4 must thread the `create` leg through it or a transform-sourced refusal is silently lost |
| — | `routes/groups/index.ts:308-320`, `:363-374`; `lib/groups.ts:192-212` | — | **no policy** | — | — | **Discovery:** the groups router never calls the resolver. It takes a validated `contactId` uuid and guards existence directly (`lib/groups.ts:201-211`). Group identity enters only via `ingestEvent`'s already-resolved `contactId` (`lib/ingestion.ts:609`). Nothing to declare — recorded so a future reader does not go looking |
| — | `workflows/identity-alias-backfill.ts`; `routes/admin/identity.ts`; `resolveViaAlias` (`lib/contacts.ts:2418-2441`) | — | **no policy** | — | — | **Discovery (PRD 02/03 additions):** the backfill writes aliases via raw SQL with an owner-IS-NULL never-steals guard and never calls the resolver; the admin identity router only triggers/reports it; `resolveViaAlias` is a read-only probe consumed by `feed/recipient.ts:149`. None declares trust — recorded so the next census does not re-discover them |

### L6 — what "identical behaviour" means, and how it is proven

Three independent proofs, in increasing strength:

1. **Algebraic.** L2 shows the clamp predicate is the same boolean expression over the same locals.
   The refusal arm's condition moves from `opts.refuseCreateWithKey !== undefined`
   (`contacts.ts:902`) to `policy.create !== "on-miss"` — same discriminant, same derived key.
2. **Differential (T2).** Both option shapes exist simultaneously after T1. A table-driven test runs
   the legacy shape and the equivalent policy shape against a real Postgres for every cell of
   {create × clamp × key-shape × pre-existing-row} and asserts identical
   `{ id===null, resolvedKey, created, linked, merged, mergedKeys, mergedIdentifiedKeys, thrown
   error constructor }` **and** identical `contacts` row deltas. This is the actual evidence, and it
   is cheap precisely because the flip is additive.
3. **Regression (DECISIONS §4, "behaviour tests are the contract").** **144 tests across thirteen
   suites** pin the outcomes this PRD must not move, and they must pass **unmodified**:
   `publishable-key.test.ts` (**36** — a grep for `it(`/`test(` reports 35 and is WRONG; the runner
   is authoritative. Both this census and PRD 05's twelfth identity JOIN were under-reported by
   pattern matching, which is worth remembering the next time a count is derived by grep),
   `observation-paths.test.ts` (17), `contacts-no-create.test.ts`
   (14), `identity-alias-lifecycle.test.ts` (13), `links-arrive.test.ts` (11),
   `contacts-many-keys.test.ts` (10), `observation-derived-reingest.test.ts` (8),
   `identity-alias-backfill.test.ts` (8), `identity-provenance.test.ts` (7),
   `contacts-identity-filter.test.ts` (7), `anonymous-id-threading.test.ts` (5),
   `observation-untouched-paths.test.ts` (4), `contacts-provenance.test.ts` (4). **If a task needs
   an assertion changed, that task is not a refactor — stop and escalate.** (`observation-paths` and
   `publishable-key` are the only test files that name `restrictToAnonymous` textually, **2**
   occurrences total, so almost none of this corpus is mechanism-coupled.) The four suites PRDs
   02/03 added are included deliberately: `contacts-many-keys` and `identity-alias-lifecycle`
   directly pin the claim/adopt arms T1 wraps.

Plus the anti-vacuity gate from house memory: after T1, individually invert each of the three clamp
read sites (`contacts.ts:867`, `:983`, `:1012`) and the refusal arm (`:902`) and record **which
named test goes red**. A predicate no test can kill is an untested predicate and needs one written
before the task closes.

### L7 — the legacy fields are deprecated, not deleted

`ingestEvent` and `ingestTransformResult` are exported (`packages/engine/src/index.ts:579-580`), as
are `resolveOrCreateContact`/`resolveContactNoCreate` (`:408-409`). Their option shapes are public
API. Deleting `restrictToAnonymous`/`allowCreate` is a breaking change; DECISIONS §4 forbids bundling
a behavioural change into a migration step, and §6 requires a changeset for a public API change.
This PRD therefore:

- **adds** `policy?: ResolvePolicy` (additive, minor, changeset required),
- **keeps** both legacy fields accepted and JSDoc-`@deprecated`, normalised into a policy at the top
  of `resolveContactShared`,
- **does not remove them.** Removal belongs with PRD 07's column retirement, where a major/breaking
  sweep is already on the table.

`PublishableAnonymousMergeError` (`contacts.ts:58-65`, message `:60`) is **not** exported from
`index.ts`, so its name and the three routes that translate it to a 403
(`routes/events/index.ts:221-223`, `routes/contacts/index.ts:174-176`,
`routes/tracking/arrive.ts:262-268`) are internal and stay exactly as they are. Do not rename it in
this PRD.

## Advisory corrections (applied 2026-07-28)

| # | Severity | What the pre-03 spec said | Why it was wrong |
| --- | --- | --- | --- |
| A1 | **blocking** | `create: "on-miss" \| { refuseWithKey: string }` as public API | The refusal key is DERIVED (`contacts.ts:1131`), never supplied. Publishing a caller-supplied key would let any caller refuse with an arbitrary string and strand history under a key no contact will ever own — this stack's own bug class, re-introduced as public API. Fixed: two-value enum, key stays derived |
| A2 | major | Row 22 + a T4 forwarding test + a Risks bullet, all about `upsertContact` dropping the policy | `upsertContact` has **zero callers** in `packages` + `apps` including tests, and is not exported from `index.ts`. All three targeted dead code. Deleted; the function is noted for separate cleanup |
| A3 | major | T4 "collapses from two branches to one call, removing the TS2769 workaround" | The comment at `ingestion.ts:384-389` gives TWO load-bearing reasons. The policy fixes only (b), the boolean-literal overload selection. Reason (a) — `resolveOrCreateContact` must keep `id: string` (D3) while refusal returns `null` — is a return-type problem no data-valued discriminant touches. Fixed: keep the two-entry branch, discriminant becomes `policy.create !== "on-miss"` |
| A4 | major | T2 said nothing about fixture namespacing | T2's fixtures deliberately create colliding and identified rows. On a reused database, run 2's "no row" cells resolve run 1's contacts — and because BOTH legs resolve the same stale rows, deep-equality still passes. That is a **fake equivalence proof that is green**, not red, and it is the entire evidentiary basis of this PRD. Fixed: namespacing + run-twice requirement in T2 |
| A5 | minor | Row 8 evidence, rows 14/15 anchors, corpus count, census gaps | PRD 03's `resolveViaAlias` fallback changed when row 8 refuses; PRD 01 moved rows 14/15; corpus is 143 not 105; `admin/agent.ts:180,203` and `ingestion.ts:194-201` were uncensused |

## EARS acceptance criteria

- **WHEN** `resolveContactShared` is called with the legacy `{ restrictToAnonymous, allowCreate }`
  fields and no `policy`, the system **SHALL** produce a result byte-identical to today's for every
  combination of supplied keys, including the thrown error's constructor.
- **WHEN** `resolveContactShared` is called with a `policy` equivalent to a legacy field pair, the
  system **SHALL** produce a result identical to the legacy call in `id`-nullness, `resolvedKey`,
  `created`, `linked`, `merged`, `mergedKeys`, `mergedIdentifiedKeys`, thrown error constructor, and
  net `contacts` row count.
- **WHEN** `policy.allowMerge` is `"anonymous-only"` **AND** the supplied keys are exactly one
  `anonymous` key, the system **SHALL** refuse to fill-in-link a contact carrying `external_id` or
  `email`, refuse any collide-MERGE, and ignore the `contactId` provenance pin — the three
  behaviours at `contacts.ts:867`, `:983-985`, `:1012-1014`.
- **WHEN** `policy.allowMerge` is `"anonymous-only"` **AND** any non-`anonymous` key is supplied, the
  system **SHALL** behave exactly as `allowMerge: "any"` (the clamp is inert), matching today's
  derivation at `contacts.ts:835-840`.
- **WHEN** `policy.create` is `"refuse-on-miss"` and no live contact owns any supplied key, the
  system **SHALL** return `{ id: null, resolvedKey: <derived userId ?? anonymousId> }` and insert no
  `contacts` row.
- **WHEN** a caller passes both a `policy` and a legacy field, the system **SHALL** throw at the call
  site rather than silently preferring one (no precedence rule ever ships).
- **WHEN** `resolveContactNoCreate` is called with a highest-precedence key that is not `userId` or
  `anonymousId`, the system **SHALL** still throw the D8 error with its current message
  (`contacts.ts:1133-1137`).
- **WHEN** a publishable feed mark/clear re-ingest runs for an anonymous visitor, the system
  **SHALL** resolve with `allowMerge: "any"` and full `trustedKinds`, inheriting only the `create`
  refusal — i.e. `POST /v1/feed/mark` for an unseen anon visitor **SHALL** still return 200, store
  the `inapp.*` event, and create zero `contacts` rows (L4).
- **WHEN** (T5 only) a caller supplies a key whose kind is absent from `policy.trustedKinds`, the
  system **SHALL** throw `UntrustedKeyKindError` before any advisory lock is taken.
- **WHEN** (T5 only) any request reaches a browser-facing route through `gatePublishableIdentity`,
  the system **SHALL NOT** be able to trigger `UntrustedKeyKindError` — proven by the 35
  `publishable-key.test.ts` cases staying green with the throw armed.

## Tasks

### T1 — `ResolvePolicy`, normalised inside the resolver
_Boundary:_ `packages/engine` · _Depends:_ PRD 02 (only so the two land in a sane order; T1 does not
read `contact_aliases` and could ship standalone)

Add `IdentityKind` (export the existing `type Kind` from `contacts.ts:415`) and `ResolvePolicy`. Add
`policy?: ResolvePolicy` to `ResolveContactOptions` (`contacts.ts:719-764`). At the top of
`resolveContactShared` (`contacts.ts:822-840`) normalise **either** input shape into one internal
`policy` local, and throw if both shapes are present. Replace the three clamp reads
(`:867`, `:983`, `:1012`) with the derived `clamped` from L2 and the refusal arm's condition (`:902`)
with `policy.create !== "on-miss"`. Mark the legacy fields `@deprecated` in JSDoc.
`resolveOrCreateContact` and `resolveContactNoCreate` keep their exported signatures and return types
**unchanged** — they build the policy internally, so D3 (`id: string` never widens) holds by the same
argument the #621 note made. `resolveContactNoCreate` keeps deriving and D8-validating the refusal
key (`:1129-1138`) — the policy carries the already-validated key internally, never from the caller.

Size: one file, roughly 60 lines changed. Small.

**How it is tested:** `check-types` proves no exported signature moved. The 143-test regression
corpus (L6.3) must pass with **zero** edits. Then run the L6 mutation gate and record the
predicate→test map in Implementation Notes.

### T2 — the differential equivalence harness
_Boundary:_ `apps/api` (test-only; exercises `packages/engine`) · _Depends:_ T1

New `apps/api/src/__tests__/resolve-policy-equivalence.test.ts`. A table over
{`create` ∈ {on-miss, refuse-on-miss}} × {`allowMerge` ∈ {any, anonymous-only}} × {key shape ∈
anon-only, anon+external, email-only, external-only, anon+email, discord-only} × {fixture ∈ no row,
own anon row, identified row owning the anon id, two rows that collide, **anon row holding the id as
an ALIAS only**, **anon row whose column id differs and the supplied id is fresh**}.

The last two fixtures are mandatory post-03 additions: without them the harness never exercises
`claimIdentityKey` under either option shape — the first drives the alias-first `findByKey` →
claim `"held"` path, the second drives claim `"claimed"` → the adoption loop at
`contacts.ts:1354-1361`.

For each cell, run the legacy shape and the policy shape in separate transactions against the same
seeded fixture and assert deep equality of the full result object plus equal `contacts` row deltas
plus the same thrown constructor (`PublishableAnonymousMergeError` / the D8 `Error` / none).

**Namespacing is a hard requirement, not hygiene (A4).** Every identity value the harness creates —
anonymous ids, external ids, emails, discord ids — MUST be run-namespaced (a `crypto.randomUUID()`
suffix per run AND per cell). Each cell MUST assert its `contacts` row delta against a pre-cell count
scoped to its own namespace, never a whole-table count. Rationale: this harness deliberately seeds
colliding and identified rows, so on a reused database run 2's "no row" cells silently resolve run
1's contacts. Both legs then resolve the same stale rows and deep-equality **passes** — a fake
equivalence proof that is green rather than red, in the one test that is the evidentiary basis of the
whole PRD. (`buckets.test.ts` shipped exactly this defect and was a one-shot for months; fixed in
`c3582ce0`.)

This is the evidence for the whole PRD, so it is written before any caller moves.

Size: one test file, ~250 lines. The fixture setup is the bulk of it.

**How it is tested:** it *is* the test. Two mandatory self-checks:
- **Anti-vacuity** — temporarily break one clamp read in `contacts.ts` and confirm at least four
  cells fail. A harness that stays green under a broken resolver is worthless.
- **Anti-reuse** — run the harness twice against the same database with no cleanup between. Both
  runs must pass.

### T3 — browser-facing callers declare their policy
_Boundary:_ `packages/engine` · _Depends:_ T2

Move rows 1-9 and 12-13 of the L5 table onto `policy`. Files: `routes/events/index.ts`,
`routes/contacts/index.ts`, `routes/tracking/arrive.ts`, `routes/feed/recipient.ts`,
`routes/feed/index.ts`, `routes/lists/index.ts`. `trustedKinds` is derived from the same evidence
`gatePublishableIdentity` already computed — a publishable caller with a verified token gets
`["anonymous","external"]`, without one `["anonymous"]`, a secret caller all four. Row 2's note is
mandatory: keep passing `"anonymous-only"` for a token-proven publishable `userId`; "optimising" it
to `"any"` would be a behaviour change hidden behind an equivalence that only holds because the
derivation makes it inert.

Row 8/9 (feed) is the one to get wrong — re-read L4 **and row 8's PRD 03 note** before touching
`routes/feed/recipient.ts`. Key the policy off `rec.allowCreate`, not off a re-derivation of "does an
anon contact row exist": since PRD 03 the refusal also requires the `resolveViaAlias` probe to miss.

Size: six files, mechanical. Medium, and the highest-attention task in the PRD.

**How it is tested:** `publishable-key.test.ts` (35), `observation-paths.test.ts` (17),
`links-arrive.test.ts` (11), `feed-backend.test.ts` (14) and `observation-derived-reingest.test.ts`
(8) green, unmodified. Add one new case: `POST /v1/feed/mark-all` as an unseen publishable anon
visitor returns 200, stores `inapp.feed_cleared` (ingest at `feed/index.ts:456-477`, pin at `:472`),
and leaves `contacts` empty — the L4 trap, asserted on row counts so a "skip the ingest entirely"
implementation cannot pass it.

### T4 — server-side callers declare their policy
_Boundary:_ `packages/engine` · _Depends:_ T2

Move rows 10-11, 14-21, 23-26, **and 28**. Files: `lib/feed.ts`, `lib/ingestion.ts` (rows 23, 24,
28), `lib/crm-ingest.ts`, `lib/identity-service.ts`, `workflows/import-contacts.ts`,
`routes/admin/contacts.ts`, `routes/admin/agent.ts`. Row 27 is deliberately **not** touched — those
sites take the default and the default is the server policy. Row 22 is withdrawn (A2).

`lib/ingestion.ts:390-393` **stays a two-entry branch** (A3). The policy removes only the TS2769
half of the comment at `:384-389`; reason (a) — the published `id: string` return type — is
untouched by a data-valued discriminant. Update the comment to say so rather than deleting it.
Row 28 (`ingestion.ts:194-201`) must thread the `create` leg through `ingestTransformResult`'s
per-element forwarding, or a transform-sourced refusal is silently lost.

Row 24 (the bucket chain, 20 threading sites across three files, all re-verified exact) keeps
threading `allowCreate` only — do not widen it to a whole policy, or an internal re-emit starts
inheriting a browser clamp.

Size: eight files, ~15 call sites. Medium; row 24 is the one that looks big and is not (it is
untouched threading).

**How it is tested:** `contacts-no-create.test.ts` (14), `contacts-many-keys.test.ts` (10),
`identity-provenance.test.ts` (7), `anonymous-id-threading.test.ts` (5),
`contacts-provenance.test.ts` (4), `observation-bucket-expiry.test.ts` (3) and
`observation-untouched-paths.test.ts` (4) green, unmodified. Add a targeted test that a
transform-sourced refusal survives `ingestTransformResult`'s per-element forwarding (row 28).

### T5 — arm `trustedKinds` (optional, droppable)
_Boundary:_ `packages/engine` · _Depends:_ T3, T4

Add `UntrustedKeyKindError` (internal, not exported from `index.ts`) and throw it in
`resolveContactShared` after the keys array is built (`contacts.ts:842-853`) and **before** the
advisory locks at `:874-879`, when a supplied key's kind is not in `policy.trustedKinds`. Default
when no policy is supplied: all four kinds — so row 27 and every untouched caller is unaffected.

This is the only task that is not strictly identical behaviour (it is identical for all *reachable*
inputs — L3, whose proof has three legs, not one). Ship it as its own commit so it can be reverted
alone.

Size: ~20 lines. Small, but the highest-risk-per-line in the PRD.

**How it is tested:** the 35 `publishable-key.test.ts` cases green with the throw armed is the
gate-covered leg of the unreachability proof; `links-arrive.test.ts` and `feed-backend.test.ts`
green cover the other two legs. Then a direct unit test that calls `resolveContactShared`'s entry
points with a deliberately narrow `trustedKinds` and asserts the throw fires *and* that no `contacts`
row and no advisory lock resulted (assert on row count; a throw after the lock would still be correct
but is not what was specified).

### T6 — docs + changeset
_Boundary:_ `packages/engine` · _Depends:_ T5 (or T4 if T5 is dropped)

Changeset for the additive `policy` option on the four exported functions
(`index.ts:408-409`, `:579-580`) plus the newly exported `IdentityKind`/`ResolvePolicy` types.
`pnpm changeset:engine-line`. Update the `docs/` identity section to state the trust rule once: trust
is declared by the caller, an engine-internal re-emit inherits `create` and nothing else, and the
`contactId` pin is a subject declaration rather than a trust grant.

Size: trivial.

**How it is tested:** `pnpm release:check`; the changeset must be a `minor` (additive public API).

## Risks / how this can go wrong

- **The clamp derivation is "simplified" during the refactor.** Someone reads row 2 and decides a
  publishable request with a token-proven `userId` should declare `allowMerge: "any"` because the
  clamp is inert anyway. It is inert *today because of the derivation*; hard-coding the conclusion
  makes the code depend on a fact that the next key-precedence change can silently invalidate. T2
  catches it only if the harness includes the anon+external cell — it does, and that is why.
- **`trustedKinds` gets wired to the HTTP caller instead of the resolver caller.** L4. Symptom: the
  bell breaks for anonymous visitors — 500s on mark/clear — while every unit test passes, because
  the failure needs a publishable request *and* an unseen anon id *and* the feed route.
- **Row 8 is mapped from stale evidence.** Since PRD 03 the feed anon arm refuses only when the
  column probe AND the alias probe both miss. An implementer reasoning from the pre-03 comment will
  refuse for second-device visitors that should now resolve via alias with a pin.
- **A vacuous or state-poisoned equivalence harness.** If T2's fixtures never produce a collide-MERGE
  or an identified row owning the anon id, the clamp cells are all "no candidates" and every
  assertion passes trivially. And if its identities are not namespaced, a second run against the same
  database passes for the wrong reason (A4). Both self-checks in T2 exist for exactly this.
- **`ingestEvent`'s branch removal changes error timing.** Today `resolveContactNoCreate`'s D8
  precondition throws *before* `resolveContactShared` runs (`contacts.ts:1129-1138`); collapsing the
  branch could move that throw after the transaction opens. It must not — and per A3 the branch is
  not collapsing at all.
- **Scope creep into PRD 05.** `keysAnotherContact` (`contacts.ts:133-163`) and the adopt arms
  (create-arm `:949-963`, `fillInLink` claimed-anon loop `:1354-1361`) are *begging* to be deleted
  once trust is explicit. They cannot be: they guard a string-keyed rewrite that only PRD 05 removes.
  Deleting them here re-opens the history-theft hole with none of the uuid-FK protection that makes
  their removal safe later.

## Rollback

No schema change, no migration, no data change — rollback is code-only at every step.

- **T5 alone** — revert the single commit; the throw disappears, `trustedKinds` reverts to a declared
  but unenforced field. Zero behaviour delta by construction (L3).
- **T3 or T4 alone** — each caller's revert is a one-line swap back to the legacy field, which T1
  keeps accepted and working. Revert per-file if the blast radius is localised (e.g. feed only).
- **T1** — reverting it requires reverting T3/T4 first (they depend on the option existing). If the
  whole PR must go, revert the branch merge commit; nothing outside `packages/engine` +
  `apps/api/src/__tests__/` was touched, and no published consumer can have adopted `policy` yet
  because T6's changeset ships in the same release.
- **Production detection signal:** a regression here shows up as a spike in 403s carrying
  `"publishable anonymous write cannot attach to or merge an identified contact"`
  (`contacts.ts:60`) on `/v1/events`, `/v1/contacts` or `/v1/t/arrive`, or as new
  `contacts` rows with `external_id` matching a browser anon id shape. Both are cheap to alert on
  before the deploy.

## Done when

- `ResolvePolicy` is the resolver's internal representation of trust and the three clamp reads plus
  the refusal arm read it, not the legacy booleans.
- The public `create` discriminant is a two-value enum; the refusal key is still derived inside
  `resolveContactNoCreate` and never accepted from a caller (A1).
- Every one of the 15 non-test resolver call sites and every ingest-level trust declarer in the L5
  table either declares a policy or is explicitly recorded as taking the server default.
- `apps/api/src/__tests__/resolve-policy-equivalence.test.ts` passes across the full cell matrix,
  fails when the resolver is deliberately broken, **and passes on a second consecutive run against
  the same database**.
- The 143-test regression corpus (L6.3) passes **with no assertion edited**.
- The mutation map (each of the four predicates → the named test that dies when it is inverted) is
  recorded in Implementation Notes, with any gap filled by a new test.
- **F4 guard-rails (all three, gating):** (1) a test pins today's two-identified-persons merge on
  BOTH hooks the eventual fix will flip — the DB outcome (`pickSurvivor` `:672-693` prefers
  identified-then-oldest) and the `mergedIdentifiedKeys` report; (2) an issue is filed with the
  shared-browser repro and its number recorded in Implementation Notes **before** merge; (3) the
  `never-identified-pair` docblock names the concrete harm (a second person signing in on the same
  browser without `reset()`).
- The four DECISIONS §5 gates are green:
  `pnpm lint`;
  `pnpm exec turbo run check-types --concurrency=2`;
  `cd apps/api && HOGSEND_TEST_DATABASE_URL=postgresql://growthhog:growthhog@localhost:5434/prd06_test pnpm exec vitest run`;
  `cd packages/engine && pnpm test`.
- A minor changeset exists for the additive public API.

## Implementation Notes
