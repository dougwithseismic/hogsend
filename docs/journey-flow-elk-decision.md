# Decision: Dagre vs ELK for the journey Flow canvas

**Date**: 2026-07-08
**Status**: Decided — keep Dagre. ELK re-evaluated if/when journeys become
routinely branch-dense (>3 reconverging arms) or exceed ~60 nodes.
**Task**: Sprint C, Task C.4 (timeboxed spike).

## Question

The Studio Flow tab lays out the source-derived `JourneyGraph` with
`@dagrejs/dagre`. Would [ELK.js](https://github.com/kieler/elkjs) (the layered
`elk.layered` algorithm) produce visibly better layouts for our real journeys
— enough to justify its cost?

## What we compared

Three reference journeys, after the C.1 dagre tuning pass
(`nodesep`/`ranksep`/`edgesep` + `network-simplex` / `tight-tree` rankers):

| Journey | Shape | Nodes |
|---|---|---|
| `feedback-nps` | mostly linear, one wait + one branch | ~9 |
| `churn-prevention` | linear with 2 `if` branches + 3 dangling exits | ~11 |
| a large lifecycle journey | linear-ish, several sleeps/sends | ~18 |

The current app's journeys (`apps/api/src/journeys/*`) are, by construction,
**sequential TypeScript control flow** with shallow `if` and a single
`ctx.waitForEvent`. The extractor emits one shared `end` node and hangs
`exitOn` events off the trigger. So the graph is *nearly a tree with a few
dangling leaves* — precisely dagre's sweet spot.

## Findings

- **Dagre (tuned) is good enough today.** After C.1, branch arms separate
  cleanly, edge-label chips no longer overlap nodes (we reserve label space in
  `g.setEdge`), and the dangling `exit` leaves sit off to the side rather than
  dominating the first rank. TB / LR / compact modes (C.2) cover the readability
  needs operators actually asked for.
- **ELK's wins don't apply to our shapes yet.** ELK's advantages —
  orthogonal edge routing, port constraints, hierarchical/nested layout, better
  handling of many reconverging edges — matter for dense DAGs. Our graphs
  reconverge rarely (the extractor merges branch arms into a shared tail/end),
  so there's little for ELK to improve visually here.
- **ELK's costs are real.** `elkjs` bundles a large GWT-compiled Java-in-JS
  payload (hundreds of KB) and lays out **asynchronously** (often via a Web
  Worker). That forces the Flow view from a synchronous `useMemo` layout into an
  async effect with loading state, and inflates the Studio bundle for a feature
  that renders fine synchronously today. Dagre is small, synchronous, and
  already a dependency.

## Decision

**Keep Dagre.** The tuned dagre layout + TB/LR/compact modes meet the current
bar. Adopting ELK now would add bundle weight and async complexity for no
visible layout gain on the journeys we actually ship.

## Revisit if

- Journeys start reconverging heavily (multiple branches merging back), where
  orthogonal routing and edge-crossing minimization would visibly help; **or**
- Graphs routinely exceed ~60 nodes, where dagre's edge routing gets busy; **or**
- We add nested/sub-journey grouping (ELK's hierarchical layout is a genuine
  edge there).

If we revisit: gate ELK behind a fourth layout mode ("Auto/ELK") so Dagre stays
the default and the async path is opt-in, and re-measure bundle size + layout
latency on a 60-node fixture before committing.
