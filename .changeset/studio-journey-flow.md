---
"@hogsend/studio": minor
"@hogsend/engine": minor
"@hogsend/core": minor
---

Studio visual journey flow — see a journey's control flow as a graph.

- `@hogsend/core`: journey-graph IR — a typed node/edge schema for a journey's control flow.
- `@hogsend/engine`: AST-based journey-graph extractor, per-stage `journey_logs` transitions for journey metrics, and an "open in editor" source-location affordance.
- `@hogsend/studio`: journey flow view — dagre layout with decision nodes, forks, and inline email preview; a funnel view; quick actions (AI share, open-in-IDE); and Mermaid / image export.
