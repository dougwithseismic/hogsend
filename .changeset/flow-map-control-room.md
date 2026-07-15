---
"@hogsend/core": minor
"@hogsend/engine": minor
"@hogsend/studio": minor
---

Live growth control room (#485): a Studio flow map of the whole machine.

- `defineSurface({ id, name?, tier, match })` (`@hogsend/core`) declares external touchpoints — docs, marketing site, the server app — as flow nodes. `match` is a serializable spec (`events` / `eventPrefix` / `source` / string-typed `where`), compiled into ONE classifier emitted as both SQL (windowed aggregate) and TS (live path), parity-tested.
- `GET /v1/admin/flow`: journeys + funnel stages auto-register as nodes alongside declared surfaces; per-node conversion + revenue heat (attributed and direct never merged), dwell pile-ups (`stuckContacts`), journey live counts, and first-touch `utm_campaign` acquisition lanes.
- `GET /v1/admin/flow/stream`: every classified ingest publishes a flow transition over Redis pub/sub, fanned out as SSE — Studio renders each real contact as a bright pulse riding its rail within ~1s.
- `GET /v1/admin/flow/nodes/{nodeId}/contacts`: the drill-down — who is at a node, stuck-first, with journey enrollment breakdowns.
- Studio "Control room": graph-first dagre layout over real edges, earn-your-canvas visibility (empty registry nodes behind a toggle), draggable nodes with live-anchored ghost rails, lane chips, and a resizable drill-down panel.
- Reusable `computeNodeDwell` / `computeFlowHeat` / `listStuckContacts` — the substrate #486 (signal feed) composes.
