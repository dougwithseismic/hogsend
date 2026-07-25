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
- **The Apollo contract has been probed live (2026-07-25) — build against THIS, not from memory.**
  One real call was made with the supplied key; do not re-probe casually, every call spends credit.

  ```
  POST https://api.apollo.io/api/v1/people/match
  Headers: x-api-key: <key>          ← this auth mechanism is confirmed working (HTTP 200)
           Content-Type: application/json
  Body:    { "email": "..." }
  Returns: { person, request_id }
  ```

  `person` fields: `first_name`, `last_name`, `title`, `seniority`, `departments`, `linkedin_url`,
  `city`, `state`, `country`, `email`, `organization_id`.
  Company data is **nested at `person.organization`**, not top-level: `name`, `website_url`,
  `primary_domain`, `industry`, `estimated_num_employees`, `annual_revenue`, `city`, `country`,
  `linkedin_url`.

  **Three traps confirmed by the probe:**
  1. **`departments` is an ARRAY**, not a string. `EnrichedPerson.department` is a single string —
     map deliberately (first element) and document the choice. A naive assignment ships an array into
     a jsonb string field and every `eq` condition against it silently fails.
  2. **Company domain is `primary_domain`**, NOT `website_url`. `website_url` is a full URL and would
     poison any domain-keyed lookup or future group association.
  3. `person.linkedin_url` came back **null** while `organization.linkedin_url` was populated — the
     two are independent, and null must be OMITTED from the patch, never written (DECISIONS §3 /
     PRD 03: `jsonb_strip_nulls` turns a written null into a DELETE of an existing good value).

  `estimated_num_employees` and `annual_revenue` both arrived as real JSON **numbers**, so AC 6's
  coercion is a defensive guard rather than the common path — keep it, but do not assume strings.

- **Do not commit the raw probe response as a fixture** — it contains a real person's contact data.
  Hand-author fixtures with the same SHAPE and synthetic values.
- No npm publish in this run. CI publishes brand-new packages fine (the manual-first-publish rule is
  dead); it just needs a changeset covering the whole engine line. Release-train task, not a build task.

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
