/**
 * Journey Blueprint authoring vocabulary — the shared description text for
 * every agent-facing surface (the in-process tools in `blueprint-tools.ts`
 * and the `@hogsend/mcp` server's authoring-guide resource). One source of
 * truth, so the tool descriptions and the MCP resource can never drift.
 *
 * Two tiers:
 *  - `GRAPH_FORMAT` / `ISSUE_LOOP_HINT` — compact one-liners embedded in tool
 *    descriptions, paid for on every turn (keep terse).
 *  - `BLUEPRINT_AUTHORING_GUIDE` — the full markdown reference, loaded on
 *    demand (an MCP resource fetch), so the complete vocabulary doesn't tax
 *    every conversation turn.
 *
 * Every factual claim below is cross-checked against the execution-tier
 * schema (`blueprintGraphSchema` + the structural checks,
 * `@hogsend/core/src/journey-graph/blueprint.ts`) and the service-layer input
 * schemas (`lib/blueprints.ts`). Update THIS file when the vocabulary grows.
 */

/**
 * The closed executable vocabulary (spec §6/§7), summarized for the model.
 * Kept in the descriptions of every graph-accepting tool so an agent can
 * author without a docs round-trip.
 */
export const GRAPH_FORMAT =
  "Graph format: { journeyId, nodes[], edges[] }. journeyId IS the blueprint id. " +
  'Node: { id, type, title, meta? }. Executable node types (closed vocabulary): "start" (exactly one; the entry point), ' +
  '"sleep" (meta.duration: { hours?, minutes?, seconds? }), ' +
  '"wait" (meta: { event, timeout } — wait for the user\'s event or time out; fork with edge kinds "answered"/"timedOut", or use a single unconditional edge), ' +
  '"send" (meta: { template, idempotencyLabel? } — template MUST be a key from list_email_templates), ' +
  '"connector" (meta: { connectorId, action } — must be a registered connector action), ' +
  '"checkpoint", "trigger" (meta: { event } — fires an event through the ingest pipeline), ' +
  '"decision"/"branch" (meta.conditions: ConditionEval[]; exactly two outgoing edges, kinds "conditional-true" and "conditional-false"), ' +
  'and terminals "end-completed"/"end-exited"/"end-failed". ' +
  'Edge: { id, source, target, kind? }. The graph must be acyclic, have exactly one start, and every node must be reachable from start; non-forking nodes have at most one outgoing edge. "sleepUntil", "capture", "digest", and "unknown" nodes are NOT executable in a blueprint. ' +
  "Trigger/entryLimit/exitOn/suppress live on the blueprint record, not in the graph.";

export const ISSUE_LOOP_HINT =
  "On validation failure you get structured issues [{ nodeId?, edgeId?, path, code, message }] naming exactly what is wrong and where — fix and retry. " +
  "Tip: iterate with validate_journey_blueprint until valid before writing.";

/**
 * The full authoring reference — `GRAPH_FORMAT` expanded into a readable
 * markdown document. Served on demand (e.g. as the
 * `hogsend://blueprint-authoring-guide` MCP resource) instead of inlined
 * into every tool description.
 */
export const BLUEPRINT_AUTHORING_GUIDE = `# Journey Blueprint authoring guide

A Journey Blueprint is a lifecycle automation authored as a JSON graph,
stored in the database, and executed by the engine's generic interpreter —
no deploy in the loop. The graph is fully validated at save time (schema +
structure + template/connector registries); an invalid graph is never saved.

## Graph shape

\`\`\`
{ "journeyId": "<blueprint id>", "nodes": [...], "edges": [...] }
\`\`\`

- \`journeyId\` IS the blueprint id — one id, one namespace (it must not
  collide with a registered code journey's id, and it is immutable after
  create: an updated graph's \`journeyId\` must equal the blueprint id).
- Every node: \`{ id, type, title, subtitle?, meta? }\` — \`id\` and
  \`title\` are required strings; \`meta\` requirements depend on \`type\`.
- Every edge: \`{ id, source, target, label?, kind? }\` — \`source\`/
  \`target\` are node ids. \`kind\` is one of \`"default"\` (same as
  omitted), \`"answered"\`, \`"timedOut"\`, \`"conditional-true"\`,
  \`"conditional-false"\`.

## Node types (closed executable vocabulary)

| Type | Required meta | Semantics |
|---|---|---|
| \`start\` | — | Exactly one per graph; the entry point. |
| \`sleep\` | \`duration\` | Durable sleep for a fixed duration. |
| \`wait\` | \`event\`, \`timeout\` (a duration) | Wait until THIS user emits \`event\` OR \`timeout\` elapses. Fork with one \`answered\` + one \`timedOut\` edge, or use a single unconditional edge. |
| \`send\` | \`template\`, optional \`idempotencyLabel\` | Send an email. \`template\` MUST be a registered template key (list them first); an unregistered key is rejected at save time. |
| \`connector\` | \`connectorId\`, \`action\` | Fire a registered connector action (e.g. Discord/Telegram). Rejected at save time if the action isn't registered. |
| \`checkpoint\` | — | Observability marker; the node id is the label. |
| \`trigger\` | \`event\` | Push an event through the full ingest pipeline (can enroll other journeys). |
| \`decision\` / \`branch\` | \`conditions\` (non-empty \`ConditionEval[]\`) | Binary fork: exactly one \`conditional-true\` + one \`conditional-false\` outgoing edge. The conditions array is ANDed — use a single \`composite\` condition for OR. |
| \`end-completed\` / \`end-exited\` / \`end-failed\` | — | Terminals; no outgoing edges. |

NOT executable in a blueprint (display-tier only, rejected with a named
issue): \`sleepUntil\`, \`capture\`, \`digest\`, \`unknown\`.

## Durations

Everywhere a duration appears (\`sleep.meta.duration\`, \`wait.meta.timeout\`,
\`entryPeriod\`, \`suppress\`):

\`\`\`
{ "hours"?: number, "minutes"?: number, "seconds"?: number }
\`\`\`

Keys are strict and values non-negative. At least one key is required
(except \`suppress\`, where \`{}\` means "disabled"). There is NO \`days\`
key — \`{ "days": 3 }\` is rejected loudly (write \`{ "hours": 72 }\`).

## Conditions (\`ConditionEval\`)

Used by \`decision\`/\`branch\` nodes. Discriminated on \`type\`:

- **property** — \`{ type: "property", property, operator, value? }\`.
  Operators: \`eq | neq | gt | gte | lt | lte | exists | not_exists |
  contains\`. \`value\` is a string/number/boolean (omit for
  \`exists\`/\`not_exists\`).
- **event** — \`{ type: "event", eventName, check, operator?, value?,
  within? }\`. \`check\`: \`exists | not_exists | count\`; for \`count\`,
  pair \`operator\` (\`gt | gte | lt | lte | eq\`) with a numeric \`value\`.
  \`within\` is an optional duration window.
- **email_engagement** — \`{ type: "email_engagement", templateKey,
  check }\`. \`check\`: \`opened | clicked | not_opened | not_clicked\`.
- **composite** — \`{ type: "composite", operator: "and" | "or",
  conditions: ConditionEval[] }\` (nestable).

\`triggerWhere\` and \`exitOn[].where\` accept ONLY property conditions
(they evaluate against the incoming event's properties).

## Structural rules (all validated at save time)

- Node and edge ids are unique; every edge connects two existing nodes.
- Exactly one \`start\` node; every node is reachable from it.
- The graph is acyclic (no loop constructs in v1).
- Fan-out is unambiguous: only \`decision\`/\`branch\` (one true + one false
  edge) and \`wait\` (one answered + one timedOut, or a single unconditional
  edge) fork; every other node has at most one outgoing edge; \`end-*\`
  nodes have none.

## Record-level fields (on the blueprint, NOT in the graph)

- \`name\` (required), \`description?\`.
- \`status\` — \`draft\` (default) | \`enabled\` | \`disabled\`. Create
  accepts \`draft\`/\`enabled\`; afterwards transitions go through the
  enable/disable operations (enable re-validates the stored graph against
  the CURRENT template/connector registries).
- \`triggerEvent\` (required) — the event name that enrolls users.
- \`triggerWhere?\` — property conditions the trigger event's properties
  must satisfy for enrollment.
- \`entryLimit\` (required) — \`once | once_per_period | unlimited\`; pair
  \`once_per_period\` with \`entryPeriod\` (a duration).
- \`exitOn?\` — \`[{ event, where? }]\`: events that abort in-flight runs.
- \`suppress\` (required) — quiet-period duration after a completed run;
  \`{}\` disables suppression.

Reserved namespaces \`email.*\`, \`journey.*\`, \`bucket.*\`, \`contact.*\`
are engine-emitted — do not use them as blueprint trigger events.

## Workflow: validate, iterate, then write

Validation returns structured issues \`[{ nodeId?, edgeId?, path, code,
message }]\` naming exactly what is wrong and where — fix and retry.
Iterate with the validate (dry-run) surface until the graph is valid, then
create/update; the same checks run on every write, so nothing invalid is
ever saved. A \`valid: false\` report is a successful call, not an error.
Event names are an open vocabulary (prefer an observed/declared name over
inventing a near-duplicate); template keys and connector actions are closed
registries — list them before referencing them.
`;
