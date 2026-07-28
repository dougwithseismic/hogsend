# PRD 05 — `posthog-codegen`

**Depends on:** credentials only (PRD 00's plumbing, not its schema). **Status:** `[ ]` —
startable now, and the only headline PostHog PRD that still is. It never touched the cohort
chain, so PRD 02's parking (`DECISIONS.md` §8) costs it nothing.

Independently shippable at any point. Zero runtime coupling to the cohort chain, delivers
standalone DX value, and exercises the OAuth credential path end-to-end — a useful
integration smoke test for everything after it.

**Caveat on "can jump the queue" (corrected).** The claim is weaker than it reads. AC 7
requires paged reads under PostHog's rate limits, so T05.1 needs the rate-limited PostHog
client, which today lives in `packages/cli/src/lib/import-shared.ts:96-148` — a package
`packages/engine` may not import from (workspace dependency cycle). **Resolution: this PRD
depends on the DECISIONS §2.10 prerequisite that moves `createRateLimitedFetch` into
`@hogsend/core`, NOT on PRD 02 T02.1.** That distinction is what kept 05 alive: the
prerequisite shipped as P0 (`f4419e26`) and is in the tree, while PRD 02's cohort client is
not. T05.1 inherits the limiter and owes nothing.

## Goal

`hogsend posthog generate` pulls the live PostHog catalog and emits a **committed** `.d.ts`
module augmentation covering event names, event properties, cohort ids, and flag keys, so
a typo is a compile error. `--check` fails on drift.

## Locked decisions

- **Generated types are observed, not declared.** PostHog infers property types from
  ingested data (String / Numeric / Boolean / DateTime); per-event property scoping is
  sampled and the catalog drifts whenever someone ships a new `capture()`. Therefore:
  **every generated property is optional by default**, strictness is opt-in, and the
  generated file is committed and reviewed like any other code.
- **It cannot mirror `hogsend flags generate` architecturally** (DECISIONS §2.8). That
  command is fully offline; this one needs a live API call with a credential that never
  leaves the engine. A new admin proxy route resolves the token server-side; the CLI does
  only the offline rendering.
- **Reuse, do not reimplement**, the rendering half of `packages/cli/src/commands/flags.ts`:
  `propertyKey` quoting to match Biome's `quoteProperties: "asNeeded"` (`:185-194`),
  alphabetical key sort for determinism, the `DO NOT EDIT BY HAND` header, and the
  `declare module` augmentation shape (`:196-222`).
- **`--check` is not a blocking PR gate.** A moving upstream catalog would break unrelated
  PRs. Ship it as a scheduled job that opens a PR, and exit 0 with a notice when no
  credential is present.

## Acceptance criteria (EARS)

1. WHEN `hogsend posthog generate` runs with a valid credential, the system SHALL write a
   deterministic, byte-identical-on-rerun `.d.ts` augmentation.
2. WHEN the same catalog is generated twice, output SHALL be byte-identical.
3. WHEN a property's PostHog type is unrecognised or non-scalar, the system SHALL emit
   `unknown` rather than a partial or wrong type.
4. WHEN `--check` runs and the committed file differs from freshly-generated output, the
   system SHALL exit non-zero and report the diff.
5. WHEN `--check` runs with no PostHog credential configured, the system SHALL exit 0 with
   a notice.
6. WHEN no credential is configured, `generate` SHALL fail with a clear `not connected`
   message naming `hogsend connect posthog`.
7. WHEN the catalog is large, the system SHALL page through it under rate limiting without
   exceeding PostHog's limits.

## Tasks

### T05.1 — Definitions proxy route
_Boundary:_ `packages/engine/src/routes/admin/` · _Depends:_ `createRateLimitedFetch` →
`@hogsend/core` (the DECISIONS §2.10 prerequisite; see BACKLOG)

Server-side fetch of `event_definitions`, `property_definitions`, `cohorts`,
`feature_flags`. Template verbatim: `routes/admin/analytics.ts:157-357` — route-local
`createTokenManager({ db, providerId: "posthog", logger })`,
`getAccessToken() ?? env.POSTHOG_PERSONAL_API_KEY ?? null`, `409 no_posthog_credential`,
typed error class → 502. Rate-limited paging via the shared `createRateLimitedFetch` from
`@hogsend/core` — do not reimplement a limiter, and do not import from `@hogsend/cli`
(dependency cycle).

### T05.2 — Augmentable registry maps
_Boundary:_ `packages/core` · _Depends:_ —

Open empty interfaces following the `FlagRegistryMap` / `TemplateRegistryMap` pattern, plus
an `IsEmpty…` helper mirroring `packages/core/src/flags/registry.ts:45` so "codegen never
ran" is detectable at the type level.

### T05.3 — The CLI command
_Boundary:_ `packages/cli/src/commands/` · _Depends:_ T05.1, T05.2

New `Command` object registered in `commands/index.ts`. Usage-string style, `-h/--help`
first, `ctx.json` for output mode, never branching on raw argv. Offline rendering only.

### T05.4 — `--check` drift mode
_Boundary:_ `packages/cli/src/commands/` · _Depends:_ T05.3

No precedent exists anywhere in the CLI (verified) — this is new territory. Render to a
buffer, compare against the committed file, exit non-zero on difference. Satisfies AC 4, 5.

## Seams

A real PostHog project is needed to verify against a genuine catalog. Build against a Fake
definitions response; enumerate the real-project run as a human verification step.

## Done when

All ACs pass, gates green, and a generated `.d.ts` demonstrably turns a misspelled event
name into a compile error in a consumer app.

## Implementation Notes
