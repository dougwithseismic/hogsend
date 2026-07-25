# @hogsend/plugin-apollo

## 0.54.0

### Minor Changes

- b62877a: Add refinement: pull person and company intelligence for a known contact from an
  enrichment provider and land it as flat `refined_*` contact properties, so a
  behaviour-derived bucket can be qualified by fit.

  `refineContact()` is a standalone import, never a `ctx` method — the same shape
  as `sendEmail()` and `sendSms()`. It never throws: every failure mode comes back
  as a status, so a vendor outage cannot escape into the journey run that called
  it. It writes through `ingestEvent`, which is the only path that re-runs bucket
  membership, so the loop closes synchronously.

  `EnrichmentProvider` is a new BYO-provider kind in `@hogsend/core`, authored with
  `defineEnrichmentProvider()` and following the email/SMS/analytics pattern:
  vendor-neutral contract, registry plus container resolution in the engine, and a
  thin plugin package. `@hogsend/plugin-apollo` is the reference implementation.

  Every lookup costs money, so the controls ship with the feature rather than
  after it. The `enrichment_lookups` ledger is one row per provider and lookup key,
  and that single unique index serves as the TTL cache, the negative cache, and the
  exactly-once guarantee at once. `ENRICHMENT_MONTHLY_LOOKUPS` is a hard monthly cap
  that fails closed, and it counts vendor CALLS rather than rows, so a `force`
  refresh loop cannot spend past it. Note the default is `0`, meaning uncapped: set
  it deliberately per environment.

  `GET /v1/admin/contacts` gains `orderBy=property` with `orderProperty`, which
  ranks contacts by a numeric property inside the jsonb bag under a
  `jsonb_typeof` guard, so one non-numeric value cannot take the endpoint down.
  This is what turns a bucket into a list you can work through.

  `contact.refined` joins the outbound webhook catalog, emitted only on a genuine
  refinement. A cache hit spends nothing and changes nothing a subscriber has not
  already heard about, so it emits nothing.

  Also extracts `withDurableGate`, which owns the positional-journal ordering in
  one place rather than leaving every durable helper to re-derive it by hand, and
  adds a reusable harness that asserts a durable function's call journal is
  identical across every return path. Four bugs of that class shipped in this
  release before the primitive existed, each one green on every gate.

### Patch Changes

- Updated dependencies [b62877a]
  - @hogsend/core@0.54.0

## 0.53.0

### Minor Changes

- Initial release: `createApolloProvider`, the reference `EnrichmentProvider`.
  Person lookup via Apollo's `people/match` (probed live 2026-07-25),
  company lookup via `organizations/enrich`, normalized to the vendor-neutral
  `EnrichmentResult` with injectable `fetch`/`baseUrl` for offline tests.
