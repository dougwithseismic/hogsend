---
"@hogsend/core": minor
"@hogsend/engine": minor
"@hogsend/studio": minor
"@hogsend/db": minor
---

`defineFunnel` — funnels as a code-first primitive, plural. A funnel is authored like a journey: `defineFunnel({ id, stages, quotedStage?, soldStage?, sources })` where `sources` is per-provider stage maps whose native-pipeline keys double as the funnel's traffic claim; register many via `createHogsendClient({ funnels })`. Ingest routes each CRM stage event to the claiming funnel (exact pipeline beats provider-wide `"*"`; overlapping claims and duplicate ids throw at boot; unclaimed traffic falls back to the `"default"` funnel). Deals gain `funnel_id` (nullable, healed on next stage event); `crm.stage_changed` and the money events carry `funnel_id` as a property so conversion points and journeys scope per funnel via `where` — the money-event NAMES stay stable per funnel-designated stages. The `crm.{stages,quotedStage,soldStage,stageMaps}` shorthand from the configurable-ladder release is now sugar for a single `"default"` funnel (zero breaking). Admin deals list/stats/timeseries take a `funnel` param (the default funnel also matches pre-funnel null rows); stats serve the funnel catalog and per-funnel `stageOrder`/`reached`; Studio's revenue dashboard gets a funnel switcher.
