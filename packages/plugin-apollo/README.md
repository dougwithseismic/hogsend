# @hogsend/plugin-apollo

Apollo.io `EnrichmentProvider` for Hogsend — the reference implementation of the
vendor-neutral enrichment contract in `@hogsend/core`.

A dumb wire: it queries Apollo's `POST /api/v1/people/match` (and
`GET /api/v1/organizations/enrich` for company-only lookups) and normalizes the
response into `EnrichmentResult`. All caching, TTL, budget-cap, ledger and
ingest logic lives in the engine's `refineContact()` pipeline.

## Usage

```ts
import { createApolloProvider } from "@hogsend/plugin-apollo";

const provider = createApolloProvider({
  apiKey: process.env.APOLLO_API_KEY!,
  // baseUrl?: string   — override the API origin (tests/proxies)
  // fetch?: typeof fetch — inject fetch (tests run offline against fixtures)
});
```

Or let the engine's env preset do it: set `APOLLO_API_KEY` and the engine
registers the provider automatically (id `apollo`). Select it explicitly with
`ENRICHMENT_PROVIDER=apollo` when more than one enrichment provider is
registered.

## Normalization notes

- Auth is the `x-api-key` header (verified against the live API, 2026-07-25).
- Apollo's `departments` is an array; the neutral `department` trait is the
  FIRST element (Apollo lists the primary function first). The full array is
  preserved in `raw`.
- The company `domain` is Apollo's `primary_domain` (`acme.com`), never
  `website_url` (a full URL) — the engine keys domain lookups on this value.
- Null vendor fields are omitted from the result, never emitted as `null`
  (a written null would delete an existing contact value downstream).
- `employeeCount` / `estimatedRevenue` are coerced to real JSON numbers so
  `gte` bucket conditions match.
- A non-2xx response throws with the HTTP status in the message; the API key
  never appears in error messages.
- `found: false` (no match) is a legitimate, non-throwing result — the engine
  negative-caches it.
