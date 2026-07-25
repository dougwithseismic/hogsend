# PRD 01 — Enrichment provider contract + container wiring

**Depends on:** none · **Status:** `[ ]`

## Goal

Add `EnrichmentProvider` as a new BYO-provider kind: a vendor-neutral contract in `@hogsend/core`,
a registry + singleton + env preset in `@hogsend/engine`, and container resolution with the same
merge/resolve/boot-error semantics the email and SMS kinds already have.

After this PRD the engine can hold enrichment providers and resolve an active one. Nothing calls
them yet — `refineContact()` is PRD 03.

## Locked decisions

- Mirror `packages/core/src/providers/sms.ts` — the most recent full-kind addition — for file shape,
  doc-comment density, and naming.
- `meta` is **required** (no pre-registry back-compat to protect, same as SMS).
- Merge order is env presets → `opts.enrichment.providers` → `opts.enrichment.provider`
  (consumer last, last-writer-wins on `meta.id`).
- Active resolution: `opts.enrichment.defaultProvider ?? env.ENRICHMENT_PROVIDER ?? "apollo"`, plus
  the SMS DX rule — when nothing is explicitly requested and exactly one provider is registered, use it.
- An **explicitly requested but unregistered** id throws at boot. Zero providers registered and none
  requested boots inert (no throw) — a deploy with no enrichment is a valid deploy.
- The env preset uses the **guarded, runtime-assembled dynamic import** idiom from
  `lib/email-providers-from-env.ts` (`const POSTMARK_PACKAGE = ["@hogsend","plugin-postmark"].join("/")`)
  so `@hogsend/plugin-apollo` stays an `optionalDependency` and `tsc` never resolves it. The plugin
  does not exist until PRD 04 — the try/catch must handle its absence gracefully, and a test asserts that.

## Acceptance criteria (EARS)

1. WHEN a consumer calls `defineEnrichmentProvider(p)` the system SHALL return `p` unchanged with its
   literal type pinned.
2. WHEN `createHogsendClient()` is called with `enrichment.providers` and `enrichment.provider` that
   share a `meta.id` the system SHALL keep the one from `enrichment.provider`.
3. WHEN `enrichment.defaultProvider` names an id that is not registered the system SHALL throw at
   client construction with a message naming the requested id and the registered ids.
4. WHEN no enrichment provider is registered and none is requested the system SHALL construct the
   client successfully with `client.enrichmentProvider` undefined.
5. WHEN exactly one provider is registered and no id is explicitly requested the system SHALL resolve
   that provider as active.
6. WHEN `APOLLO_API_KEY` is unset the env preset SHALL return an empty provider list without
   attempting the dynamic import.
7. WHEN `APOLLO_API_KEY` is set but the plugin package cannot be resolved the env preset SHALL
   return an empty provider list and log once, not throw.

   **Test this against an unresolvable specifier you control, not against `@hogsend/plugin-apollo`
   being genuinely absent.** PRD 04 adds that package to the engine's `optionalDependencies`, at
   which point an absence-based test silently starts asserting the opposite of what it means. Make
   the import specifier injectable (or test the guard helper directly) so the assertion stays honest
   after PRD 04 lands.
8. WHEN a journey-side effect key is derived with `kind: "refine"` the system SHALL produce a key
   prefixed `journeyRefine:` and distinct from `journeySend:`/`journeySmsSend:`/`journeyConnector:`
   for identical anchor/site/discriminant.

## Tasks

### T1.1 — Core contract
_Boundary:_ `packages/core` · _Depends:_ —

Create `packages/core/src/providers/enrichment.ts` exporting: `EnrichmentQuery`, `EnrichedPerson`,
`EnrichedCompany`, `EnrichmentResult`, `EnrichmentProviderMeta`, `EnrichmentProviderCapabilities`,
`EnrichmentProvider`, `defineEnrichmentProvider`. Add the barrel line to
`packages/core/src/providers/index.ts` (and `packages/core/src/index.ts` if providers are re-exported there).

Field sets are fixed by the plan — the common denominator across Apollo/Clay/Clearbit, nothing vendor-specific:

- `EnrichmentQuery` — `{ email?, domain?, firstName?, lastName?, company? }`
- `EnrichedPerson` — `{ firstName?, lastName?, title?, seniority?, department?, linkedinUrl?, city?, country? }`
- `EnrichedCompany` — `{ name?, domain?, industry?, employeeCount?, estimatedRevenue?, city?, country?, linkedinUrl? }`
- `EnrichmentResult` — `{ found: boolean; person?: EnrichedPerson; company?: EnrichedCompany; raw: unknown }`
- `EnrichmentProviderCapabilities` — `{ personLookup: boolean; companyLookup: boolean; bulk?: boolean }`
- `EnrichmentProvider` — `{ meta; capabilities; enrichPerson(q): Promise<EnrichmentResult>; enrichCompany?(domain): Promise<EnrichmentResult> }`

_Test:_ `packages/core/src/__tests__/` (or the package's existing test location) — `defineEnrichmentProvider`
returns identity; a minimal conforming object type-checks.

### T1.2 — Registry + singleton
_Boundary:_ `packages/engine` · _Depends:_ T1.1

`packages/engine/src/lib/enrichment-provider-registry.ts` — `EnrichmentProviderRegistry`, a direct
copy of `sms-provider-registry.ts` (`register`/`get`/`getAll`/`count`, keyed by `meta.id`,
last-writer-wins). `packages/engine/src/lib/enrichment-registry-singleton.ts` — via
`createOptionalSingleton` from `lib/singleton.ts`, following `connectors/registry-singleton.ts`.
The singleton is required because `refineContact()` (PRD 03) is a standalone import called from
journeys and crons that hold no container reference.

_Test:_ registry keyed by id, last-writer-wins on duplicate id, `count()` correct.

### T1.3 — Env preset + env vars
_Boundary:_ `packages/engine` · _Depends:_ T1.2

`packages/engine/src/lib/enrichment-providers-from-env.ts` — `enrichmentProvidersFromEnv(env)`.
Add to `packages/engine/src/env.ts`: `ENRICHMENT_PROVIDER` (optional string), `APOLLO_API_KEY`
(optional), `ENRICHMENT_TTL_DAYS` (number, default 90), `ENRICHMENT_MONTHLY_LOOKUPS` (number,
default 0 = uncapped). Follow the existing `POSTMARK_*` declarations for style.

_Test:_ AC 6 and AC 7 above.

### T1.4 — Container wiring + key kind + exports
_Boundary:_ `packages/engine` · _Depends:_ T1.3

- `container.ts` — build `EnrichmentProviderRegistry` with the 3-way merge; resolve the active
  provider per the locked rules; expose `enrichmentProviders` + `enrichmentProvider` on the container
  interface and `enrichment?: { provider?, providers?, defaultProvider? }` on
  `CreateHogsendClientOptions`; set the singleton.
- `journeys/journey-boundary.ts` — add `"refine"` to `JourneyKeyKind` and `refine: "journeyRefine"`
  to `KEY_PREFIX`.
- `packages/engine/src/index.ts` — re-export the contract types and `EnrichmentProviderRegistry`.

_Test:_ AC 2, 3, 4, 5, 8.

## Seams

None. Fully buildable and testable offline.

## Done when

All eight acceptance criteria have passing tests; the four gates in DECISIONS §4 are green; a
container constructed with a hand-rolled fake provider resolves it as active.

## Implementation Notes

_(filled in during build)_
