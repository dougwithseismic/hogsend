# Blueprint graph node/edge vocabulary

A blueprint's `graph` is `{ journeyId, nodes[], edges[] }` — the same
discriminated-union `JourneyNode`/`JourneyEdge` shape Studio's flow view
renders for code journeys, restricted to a validated execution-tier subset.

## Base fields every node has

```ts
{
  id: string;       // stable within this graph — joins to runtime currentNodeId
  type: string;     // discriminant, see below
  title: string;    // human label shown in Studio
  subtitle?: string;
  meta?: { ... };   // per-type, see below
}
```

## Executable node types

| `type` | `meta` | Compiles to |
|---|---|---|
| `start` | `{ conditions? }` | Entry point — one required, exactly once, no incoming edges |
| `sleep` | `{ duration: { hours?, minutes?, seconds? } }` | `ctx.sleep({ duration, label })` |
| `wait` | `{ event, timeout: { hours?, minutes?, seconds? } }` | `ctx.waitForEvent({ event, timeout, label })` — forks the WAIT node itself into `timedOut`/`answered` outgoing edges, no separate decision node |
| `send` | `{ template, idempotencyLabel? }` | `sendEmail({ template, ... })` — `template` MUST be a registered key (`list_email_templates`) |
| `connector` | `{ connectorId, action }` | `sendConnectorAction({ connectorId, action })` |
| `checkpoint` | (none) | `ctx.checkpoint(label)` — observability marker only |
| `trigger` | `{ event }` | `ctx.trigger({ event })` — pushes another event through ingest, can fan out to other journeys/blueprints |
| `decision` / `branch` | `{ conditions: ConditionEval[] }` | A fork — MUST have exactly two outgoing edges, kinds `conditional-true` and `conditional-false` |
| `end-completed` / `end-exited` / `end-failed` | (none) | Terminal — no outgoing edges |

## NOT allowed in a v1 blueprint (execution-tier rejects these outright)

- **`digest`** — no static meta shape resolvable at validation time (the
  digest window can be dynamic); use `sleep` + a `decision` instead, or
  promote to code if you need real digesting.
- **`sleepUntil`** — the target instant is computed at runtime, not
  statically expressible in a stored graph.
- **`capture`** — analytics capture calls aren't idempotent
  (`getPostHog()?.capture()` isn't replay-safe), so they're not exposed here.
- **`unknown`** — the code-journey AST extractor's escape hatch for an
  unresolved call. A blueprint graph is hand/agent-authored, so there's
  nothing to degrade to — an `unknown` node is a validation error, not a
  warning.

If you need one of these, author the journey in code instead (see
**hogsend-authoring-journeys**) — the same worker runs it either way.

## Edges

```ts
{
  id: string;
  source: string;   // node id
  target: string;   // node id
  label?: string;
  kind?: "default" | "timedOut" | "answered" | "conditional-true" | "conditional-false";
}
```

- Every node except a terminal `end-*` needs at least one outgoing edge, or
  validation fails as unreachable/dead-end.
- A `decision`/`branch` node's two edges MUST be kinds `conditional-true` and
  `conditional-false` — anything else fails validation.
- A `wait` node's timeout fork uses `timedOut` / `answered` kinds on its
  outgoing edges (mirroring `ctx.waitForEvent`'s `{ timedOut }` result the
  same code journey would branch on).
- Plain sequential edges (sleep → send, send → end, etc.) omit `kind`
  (defaults to `"default"`).
- No cycles — the graph must be a DAG. A decision's two branches must
  reconverge on a later node, not loop back to an earlier one.

## Conditions

`decision`/`branch` node `meta.conditions` and `start.meta.conditions` use the
same `ConditionEval` vocabulary as a code journey's `trigger.where`/`exitOn[].where`
— see the **hogsend-conditions** skill for the full condition-type reference
(property comparisons, event-existence, email-engagement, AND/OR composition).
The example in the parent SKILL.md shows the simplest form, a single property
equality check.
