# PRD 04 — `@hogsend/plugin-apollo`

**Depends on:** PRD 01 · **Status:** `[ ]`

## Goal

The reference `EnrichmentProvider`: a dumb wire that queries Apollo and normalises the response into
`EnrichmentResult`. No caching, no DB, no budget logic — the engine owns all of that (DECISIONS §3.7).

## Locked decisions

- Package shape is a direct mirror of `packages/plugin-postmark`, the smallest complete plugin:
  ships **raw `src`** (`main`/`types` → `./src/index.ts`, `exports: { ".": "./src/index.ts" }`,
  `files: ["src","README.md"]`), `tsup.config.ts` with `dts: false`, a 4-line `tsconfig.json`
  extending `@repo/typescript-config/base.json`, `vitest.config.ts`, `README.md`, `CHANGELOG.md`.
- `createApolloProvider({ apiKey, baseUrl?, fetch? })`. **`fetch` is injectable** — every test drives
  recorded fixtures through it, so the suite needs no network and no API key. This is the
  `plugin-attio` pattern.
- Added to `packages/engine/package.json` `optionalDependencies` (alongside `plugin-twilio` and
  `plugin-postmark`), never to `dependencies`.
- Apollo's response shape must not leak past this package (DECISIONS §3.5).
- **Verify the current Apollo API contract before implementing** — endpoint paths, auth header, and
  response field names may have changed. Use WebFetch against Apollo's developer docs. Record what
  you find in the fixtures and cite it in Implementation Notes. Do not implement from memory.
- No npm publish in this run. A brand-new `@hogsend/*` package's first publish must be manual; that
  is a release-train task, not a build task.

## Acceptance criteria (EARS)

1. WHEN `enrichPerson({ email })` receives an Apollo match the system SHALL return `found: true` with
   `person` and `company` populated from the documented Apollo fields and `raw` set to the verbatim
   response body.
2. WHEN Apollo returns no match the system SHALL return `found: false` with `person` and `company`
   undefined and SHALL NOT throw.
3. WHEN Apollo returns a non-2xx status the system SHALL throw an error whose message includes the
   status code, so `refineContact` can record an `error` ledger row (PRD 03 AC 7).
4. WHEN `enrichPerson` is called the system SHALL send the API key using Apollo's documented auth
   mechanism and SHALL NOT include it in any thrown error message or log line.
5. WHEN `capabilities` is read the system SHALL report `personLookup: true` and `companyLookup: true`.
6. WHEN a numeric Apollo field arrives as a string the system SHALL coerce it to a JSON number before
   returning it in `EnrichedCompany`, so PRD 03's `gte` comparisons work (DECISIONS §3.4).

## Tasks

### T4.1 — Package scaffold
_Boundary:_ `packages/plugin-apollo` · _Depends:_ PRD 01

The seven files above, copying `packages/plugin-postmark` structure exactly. Add
`@hogsend/core` as a workspace dependency. Register in engine `optionalDependencies`.

### T4.2 — Provider implementation + fixtures
_Boundary:_ `packages/plugin-apollo` · _Depends:_ T4.1

`createApolloProvider` implementing `EnrichmentProvider` via `defineEnrichmentProvider`. Recorded
fixtures for: a match, a no-match, a 401, a 429. Tests drive all six acceptance criteria through the
injected `fetch`.

### T4.3 — Wire the env preset
_Boundary:_ `packages/engine` · _Depends:_ T4.2

The guarded dynamic import in `lib/enrichment-providers-from-env.ts` (built in PRD 01 T1.3) now
resolves. Add a test asserting a provider is produced when `APOLLO_API_KEY` is set.

## Seams

**A live Apollo API key** — needed only for the final end-to-end smoke in PRD 07. All six acceptance
criteria are satisfied against fixtures. Enumerate as a human ask; do not block.

## Done when

All six acceptance criteria pass against fixtures, gates green, and `enrichmentProvidersFromEnv`
produces an Apollo provider when the key is set.

## Implementation Notes

_(filled in during build)_
