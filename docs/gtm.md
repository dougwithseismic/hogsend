# Refinement and the GTM loop

**Status:** engine reference (single source of truth)
**Scope:** `refineContact()`, the `EnrichmentProvider` contract, the
`enrichment_lookups` ledger, and the scoring pattern that turns a bucket into a
ranked list.

---

## 1. What this is, and what it is not

Hogsend already knew what a contact **did**. Refinement is how it learns who
they **are** — pulling person and company intelligence for a known contact from
an external provider and landing it as flat contact properties, so a
behaviour-derived bucket can be qualified by fit.

That is one new capability, not six. The GTM vocabulary people ask for mostly
already exists here under different names:

| You want | It already is |
| --- | --- |
| Signals | A bucket. `defineBucket()` + the leaderboard in §6. |
| Traits | `contacts.properties`. A jsonb bag with condition support. |
| GTM buckets | Buckets. |
| Journey actions | Journeys, plus `bucket.on("enter" \| "leave" \| "dwell")`. |
| Impact | Attribution + holdout lift (`docs/attribution-impact-plan.md`). |
| **Refinement** | **New. This document.** |

A "signal" is a bucket you can rank and sort. That is why §6 exists: without
ordering you can enrich and score a contact and still not answer *who do I call
today*.

## 2. The loop

```
behaviour
  → bucket("gtm-high-intent")
      ↓ .on("enter")
    refineContact()                                  ← the new part
      ↓ ingestEvent({ contactProperties })
    contacts.properties.refined_*
      ↓ re-runs checkBucketMembership synchronously
    score = plain TypeScript (fit x behaviour)
      ↓ ingestEvent({ contactProperties: { gtmScore } })
    bucket("gtm-qualified", b => b.prop("gtmScore").gte(20))
      ↓ .on("enter")
    notify sales / push to CRM
```

The score is **plain TypeScript in your app**, not an engine primitive. That is
the wedge: scoring rules are business logic that changes weekly, and a config UI
for them is a worse version of a function.

A complete working copy of this loop lives in `apps/api/src/buckets/gtm-*.ts`
and `apps/api/src/workflows/gtm-score.ts`.

## 3. `refineContact()`

A **standalone import**, never a `ctx` method — the same shape as `sendEmail()`
and `sendSms()`. `JourneyContext` stays orchestration primitives only.

```ts
import { refineContact } from "@hogsend/engine";

const result = await refineContact({ userId: user.id, email: user.email });
```

### Options

| Option | Meaning |
| --- | --- |
| `userId` | The contact's canonical key (`external_id ?? anonymous_id ?? id`). |
| `email` | An email address to resolve and to look up by. |
| `contactId` | The `contacts.id` row id — the unforgeable, engine-internal pin. |
| `provider` | Override the container's active provider by registry id. |
| `force` | Bypass the TTL and negative cache. Does **not** bypass the budget cap. |
| `idempotencyLabel` | Disambiguates the replay key when two refine sites in one journey share a nearest wait label. |

At least one of `userId` / `email` / `contactId` is required; with none you get
`skipped` / `no_lookup_key`.

### Every return status

**It never throws.** A vendor 5xx does not escape into the journey run that
called it. Branch on the status:

| `status` | `reason` | Meaning |
| --- | --- | --- |
| `refined` | — | A vendor lookup was paid for and traits landed. `properties` holds the patch. |
| `cached` | — | This lookup key was already paid for. The stored patch is landed on the contact being asked about. `properties` holds it. |
| `not_found` | — | The vendor has no record. Cached as a paid negative result. |
| `skipped` | `no_lookup_key` | Nothing resolvable was passed. |
| `skipped` | `no_provider` | No enrichment provider is configured, or an explicit `provider` id resolved to nothing. |
| `skipped` | `budget_exceeded` | `ENRICHMENT_MONTHLY_LOOKUPS` is exhausted. Fails closed. |
| `skipped` | `provider_error` | The vendor threw. An `error` ledger row records the spend but does **not** suppress a later retry. |
| `skipped` | `ingest_failed` | The traits could not be written. Nothing landed. |

**`cached` means "this lookup key was already paid for", NOT "this contact
already has the answer."** That distinction is load-bearing. A hit lands the
stored patch on the contact being asked about, which is what makes a shared
company-domain key useful: the first contact at `acme.com` pays, and every
colleague after them gets the same company traits for free. Return the caller's
own traits instead and every contact after the first is silently starved.

### Replay safety

`refineContact` runs inside `withDurableGate`
(`packages/engine/src/journeys/with-durable-gate.ts`), so it is exactly-once
across a Hatchet replay, in two layers:

- **Layer 1** — Hatchet's durable `memo`, keyed by the replay-stable run anchor
  plus the caller's own arguments. Requires an engine with memo eviction
  (>= v0.80.0).
- **Layer 2** — the `enrichment_lookups` unique index, which carries
  exactly-once on its own, version-independently, and outside a journey
  entirely.

The one authoring rule: if you refine the **same subject twice in one journey**
on divergent branches that share a nearest wait label, pass a distinct
`idempotencyLabel` to each. The engine throws a loud collision error if you
forget, so it surfaces in development rather than silently over-deduplicating.

## 4. Traits

Every trait key is **flat and top-level**, prefixed `refined_`:

```
refined_title              refined_company_name
refined_seniority          refined_company_domain
refined_department         refined_company_industry
refined_linkedin_url       refined_company_employees   (number)
refined_country            refined_company_revenue     (number)
                           refined_company_country
refined_at (ISO string)    refined_provider
```

Three rules govern them, and each one has a silent failure mode:

1. **Flat, never dotted.** `evaluatePropertyConditions` reads
   `journeyContext[key]`. Author `b.prop("refined_seniority")`. A dotted
   `b.prop("properties.refined_seniority")` resolves to nothing and the
   condition is simply never true.
2. **Real JSON numbers.** `conditions/property.ts` does no coercion, so the
   string `"250"` never matches `gte(100)`. The two numeric traits are written
   as numbers; if you add your own, keep them numeric.
3. **Absent fields are omitted, never written as null.** `mergePropertiesSql`
   wraps the patch in `jsonb_strip_nulls`, so writing `null` **deletes** an
   existing good value. A provider that returns a null LinkedIn URL must not
   erase one you already had.

## 5. Cost control

Every lookup costs money, so the ledger, TTL, negative cache and budget cap ship
together rather than as a follow-up.

`enrichment_lookups` holds one row per `(provider, lookup_kind, lookup_key)`.
That single unique index does three jobs at once: TTL cache, negative cache, and
exactly-once.

| Env var | Default | Meaning |
| --- | --- | --- |
| `ENRICHMENT_PROVIDER` | `apollo` when one is registered | Active provider id. |
| `APOLLO_API_KEY` | unset | Builds the Apollo preset. Absent, refinement is inert. |
| `ENRICHMENT_TTL_DAYS` | `90` | How long a row (hit **or** miss) satisfies a lookup. |
| `ENRICHMENT_MONTHLY_LOOKUPS` | `0` | Hard monthly cap. **`0` means UNCAPPED.** |

Three things worth knowing:

- **`expiresAt` is materialised on write**, not computed at read time, so
  changing `ENRICHMENT_TTL_DAYS` later does not retroactively expire or extend
  existing rows.
- **The cap counts vendor CALLS, not rows.** A `force` refresh updates the row
  in place, so counting rows would count distinct subjects and a `force` loop on
  one key would spend without limit. `spend_count` and `spend_window` make it
  exact, and the window reset means last month's attempts cannot bleed into this
  month's budget.
- **An `error` row records the spend but does not suppress a retry.** An outage
  across an already-refined base is precisely when the cap has to hold, so a
  failed call still counts — but it must not poison the key.

**Set `ENRICHMENT_MONTHLY_LOOKUPS` deliberately in every environment.** The
default is uncapped, and the failure mode of an exhausted cap is silent
under-enrichment, which looks like "the feature does nothing" rather than an
error. If you run it capped, alert on `budget_exceeded`.

## 6. Ranking — turning a bucket into a list

`GET /v1/admin/contacts` accepts `orderBy=property` plus `orderProperty=<key>`,
which sorts by a numeric property inside the jsonb bag:

```
GET /v1/admin/contacts?orderBy=property&orderProperty=gtmScore&orderDir=desc
```

The value is extracted under a `jsonb_typeof(...) = 'number'` guard. Without it
a single non-numeric value in one contact's bag 500s the whole endpoint, and
non-numeric values in a free-form jsonb bag are a matter of time, not
possibility. Non-numeric and absent values sort last.

For a large contacts table, add the expression index:

```sql
CREATE INDEX CONCURRENTLY contacts_gtm_score_idx
  ON contacts (((properties ->> 'gtmScore')::numeric))
  WHERE jsonb_typeof(properties -> 'gtmScore') = 'number';
```

The `WHERE` clause is required. Without it the index expression is evaluated for
every row, and the first contact whose `gtmScore` is not numeric fails the cast
and **breaks every ingest write to that table**.

## 7. The scoring pattern

Two rules, and the first one is not a style preference.

### Recompute, never increment

`mergePropertiesSql` only overwrites with a literal — there is no SQL-side `+`.
A read-modify-write increment therefore silently loses every concurrent update.
Make the score a pure function of current state:

```ts
export function computeGtmScore(input: GtmScoreInput): number { … }
```

Same input, same number, forever. That dissolves the concurrency problem, makes
decay trivial, and is replay-safe by construction. Pass recency **in** as an
argument rather than reading the clock inside, or the function is untestable.

### Write through `ingestEvent`

`ingestEvent` is the only write path that re-runs `checkBucketMembership`.
`resolveOrCreateContact` writes the jsonb but does not. So does a direct
`UPDATE`. Write the score any other way and `gtm-qualified` freezes with no
error to notice.

This applies with particular force to a **pure property bucket**: the reconcile
cron deliberately skips non-time-based buckets, so a `b.prop("gtmScore").gte(20)`
bucket is evaluated at ingest and **nowhere else**. There is no backstop.

**State the cost honestly: one `user_events` row per contact whose score
changed, per run.** In the example the nightly job skips contacts whose
recomputed score equals the stored one, so on a stable base the cost is near
zero rather than one row per contact per night. The rows you do pay for are
unavoidable, because ingest is the only thing that moves membership.

### Two traps in a batched recompute

- **Termination.** A recompute does not shrink its own work set — a scored
  contact still matches "every contact" — so a naive `LIMIT n` predicate
  re-selects the same first page forever. Use a keyset cursor on `contacts.id`.
- **The self-feeding metric.** If the job writes an event and its recency input
  is an unfiltered `MAX(occurred_at)`, that write resets the contact's own
  recency and inflates the next run's decay. Filter the recency aggregate to the
  events the score actually reads. A metric that feeds a computation whose
  output resets that metric never settles.

## 8. Writing an enrichment provider

Providers are **dumb wires**. All DB, caching, budget, preference and ingest
logic lives in the engine. A provider does one thing: query the vendor and
normalise the response.

```ts
import { defineEnrichmentProvider } from "@hogsend/core";

export const createAcmeProvider = (opts: { apiKey: string; fetch?: typeof fetch }) =>
  defineEnrichmentProvider({
    meta: { id: "acme", name: "Acme Data" },
    capabilities: { personLookup: true, companyLookup: true },
    async enrichPerson(query) { … },
  });
```

Rules:

- **The vendor's response shape must not leak past the package** — the same
  discipline `EmailProvider` holds against Resend.
- **Take `fetch` as an injectable option.** Every test then drives recorded
  fixtures through it, and the suite needs no network and no API key.
- **Register in the engine's `optionalDependencies`**, never `dependencies`.
- **Ship a built `dist/` and point the RUNTIME entry at it** — `main` and the
  `default` export condition go to `dist/index.js`, `files` includes `dist`,
  and the tsup config inlines every raw-source `@hogsend/*` dependency
  (`noExternal`). `types` stays on `src/`, as everywhere else here.

  This is the one class of `@hogsend` package that cannot ship raw `.ts`. Every
  other package is inlined by the consumer's bundler; an opt-in plugin is
  reached only through a guarded dynamic import whose specifier is assembled at
  runtime, so no bundler can see it and Node loads it from `node_modules` —
  where it refuses to strip types
  (`ERR_UNSUPPORTED_NODE_MODULES_TYPE_STRIPPING`). The engine catches that and
  the preset goes inert, so the symptom is a feature that silently does nothing
  rather than an error. Postmark, Twilio and Apollo all shipped this way and
  were unreachable in every bundled consumer (#611). `release-doctor` now
  enforces it.
- **The consumer must install the plugin directly.** The engine's
  `optionalDependencies` entry gets it onto disk but does not link it at the
  consumer's top level, and the consumer's bundle is where the import actually
  resolves. Say so in your README and next to the credential in `env.example`.
- Omit absent fields from the normalised result. Never map a vendor null into a
  written null (§4 rule 3).

`packages/plugin-apollo` is the reference implementation. Its README documents
the three traps the live Apollo contract has: `departments` is an array while
`EnrichedPerson.department` is a single string; the company domain is
`primary_domain`, not the full-URL `website_url`; and person and organization
LinkedIn URLs are independent, either of which can be null.

## 9. Deliberately out of scope

- **`defineSignal`** — a bucket already is one.
- **A `traits` primitive** — `contacts.properties` is it.
- **Email-domain derivation and account rollup.** Groups exist, but journeys
  still cannot be triggered by or read group state.
- **Group-level journeys.** Journeys stay person-scoped.
- **An outbound-sender destination**, a meeting-booked conversion definition,
  and a Prospects-vs-Contacts view.

Each is a clean follow-up. None blocks the loop in §2.
