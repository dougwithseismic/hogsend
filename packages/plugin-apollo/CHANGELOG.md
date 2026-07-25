# @hogsend/plugin-apollo

## 0.53.0

### Minor Changes

- Initial release: `createApolloProvider`, the reference `EnrichmentProvider`.
  Person lookup via Apollo's `people/match` (probed live 2026-07-25),
  company lookup via `organizations/enrich`, normalized to the vendor-neutral
  `EnrichmentResult` with injectable `fetch`/`baseUrl` for offline tests.
