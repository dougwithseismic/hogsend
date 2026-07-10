---
name: hogsend-authoring-journey-blueprints
description: Use when creating, validating, or enabling a Journey Blueprint — the JSON-authored alternative to defineJourney() for automations that shouldn't need a PR. Covers the create_journey_blueprint/validate_journey_blueprint/enable_journey_blueprint MCP tools, the blueprint graph's node/edge vocabulary, and the validate-in-a-loop workflow.
license: MIT
metadata:
  author: withSeismic
  version: "1.0.0"
---

# Authoring Journey Blueprints

A Journey Blueprint is a lifecycle journey stored as a **data row**
(`journey_blueprints`) instead of committed code — it runs through the exact
same worker, the exact same durable primitives (`ctx.sleep` /
`ctx.waitForEvent` / `sendEmail` / `ctx.trigger`), and the exact same
`JourneyGraph` node/edge vocabulary a `defineJourney()` code journey compiles
to. The difference is entirely in how it's authored: a blueprint is created
and edited through MCP tools or the admin API, live, without a PR or a
redeploy.

Reach for a blueprint when an agent (or you, live, mid-conversation) needs to
stand up a lifecycle automation right now. Reach for `defineJourney()` (see
the **hogsend-authoring-journeys** skill) when the logic is complex,
long-lived, or you want it reviewed and version-controlled like the rest of
the app.

## The authoring loop

1. **Draft a graph.** A `nodes[]` + `edges[]` JSON structure — see
   `references/blueprint-graph-nodes.md` for the node type vocabulary.
2. **Validate before you save anything.** Call `validate_journey_blueprint`
   with the draft graph. It runs the SAME checks `create`/`update`/`enable`
   run (field shapes, structural checks — acyclic, every node reachable,
   every non-terminal node has an outgoing edge — plus template/connector
   registry checks) and returns a structured issue list. `valid: false` is a
   normal, expected response while iterating — not an error. Loop until
   `valid: true`.
3. **Create it.** `create_journey_blueprint` with the validated graph plus
   `name`, `triggerEvent`, `entryLimit`, `suppress`. Defaults to
   `status: "draft"` — pass `status: "enabled"` to go live immediately (there
   is no forced human-approval gate; Studio gives post-hoc visibility, not a
   pre-send review step).
4. **Enable it** (if you created it as a draft) with
   `enable_journey_blueprint` — this re-validates the STORED graph against
   the CURRENT template/connector registries first, so it can't go live with
   a since-unregistered template.
5. **Edit it later** with `update_journey_blueprint`. A metadata-only patch
   (name, description, `triggerEvent`, `exitOn`, `entryLimit`, `suppress`)
   always succeeds. A **graph-changing** patch is rejected while the
   blueprint has any active/waiting enrollment (409) — Hatchet's durable
   sleep/wait primitives are matched positionally on replay, so changing the
   node sequence out from under a suspended run could desync it. Wait for
   enrollments to drain, or disable the blueprint first.

## Example: sleep → decision → send

```json
{
  "name": "Activation nudge",
  "triggerEvent": "user.created",
  "entryLimit": "once",
  "suppress": {},
  "status": "enabled",
  "graph": {
    "journeyId": "activation-nudge",
    "nodes": [
      { "id": "start", "type": "start", "title": "user.created" },
      { "id": "sleep-3d", "type": "sleep", "title": "Wait 3 days",
        "meta": { "duration": { "hours": 72 } } },
      { "id": "check-activated", "type": "decision", "title": "Activated?",
        "meta": { "conditions": [
          { "type": "property", "property": "activated", "operator": "eq", "value": true }
        ] } },
      { "id": "send-nudge", "type": "send", "title": "Send activation nudge",
        "meta": { "template": "welcome" } },
      { "id": "end-ok", "type": "end-completed", "title": "Done" }
    ],
    "edges": [
      { "id": "e1", "source": "start", "target": "sleep-3d" },
      { "id": "e2", "source": "sleep-3d", "target": "check-activated" },
      { "id": "e3", "source": "check-activated", "target": "end-ok", "kind": "conditional-true" },
      { "id": "e4", "source": "check-activated", "target": "send-nudge", "kind": "conditional-false" },
      { "id": "e5", "source": "send-nudge", "target": "end-ok" }
    ]
  }
}
```

`send.meta.template` must be a key already registered in this app's
`src/emails/registry.ts` — `list_email_templates` returns the current set.
`triggerEvent` (and any `trigger`-adjacent event name) doesn't need to
pre-exist anywhere; `list_events` returns event names observed so far, purely
as a naming reference.

## Key concepts

- **The graph id IS the blueprint id.** `graph.journeyId` and the blueprint's
  own id are the same value, one namespace shared with code journeys —
  `create_journey_blueprint` rejects an id already used by a registered
  `defineJourney`.
- **A blueprint's node vocabulary is a restricted, execution-safe subset** of
  the full `JourneyGraph` IR (the same IR Studio's code-journey flow view
  renders). `digest`, `sleepUntil`, `capture`, and `unknown` nodes are NOT
  allowed in v1 — see `references/blueprint-graph-nodes.md` for exactly which
  types are, and why.
- **No loops, binary decisions only.** A blueprint graph must be acyclic;
  every `decision`/`branch` node forks into exactly two paths
  (`conditional-true` / `conditional-false`) that converge later.
- **Three-state lifecycle:** `draft` (not live) → `enabled` (new events
  enroll users) → `disabled` (new enrollments stop; in-flight runs keep
  going). There's no "promoted" state change you make directly — that's set
  when a blueprint is promoted to code (a separate, human-reviewed step).
- **Studio shows it, doesn't gate it.** Every blueprint — draft or enabled —
  is visible in Studio's `/journeys` list immediately, with `createdBy`
  provenance and an instant disable action. That's the oversight mechanism,
  not a required approval step.

## Reference

- **The full node/edge vocabulary, meta shapes per node type, and what's
  excluded from v1** → `references/blueprint-graph-nodes.md`

For the underlying primitives (`ctx.sleep`, `ctx.waitForEvent`, duration
helpers, condition shapes) see the **hogsend-authoring-journeys** and
**hogsend-conditions** skills — a blueprint graph's node `meta` fields mirror
those primitives' arguments directly.
