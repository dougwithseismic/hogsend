---
"@hogsend/engine": minor
"@hogsend/core": minor
"@hogsend/email": minor
"@hogsend/db": minor
"@hogsend/cli": minor
"@hogsend/client": minor
"@hogsend/js": minor
"@hogsend/react": minor
"@hogsend/plugin-posthog": minor
"@hogsend/plugin-resend": minor
"@hogsend/plugin-postmark": minor
"@hogsend/plugin-discord": minor
"@hogsend/plugin-telegram": minor
"@hogsend/studio": minor
"hogsend": minor
"create-hogsend": minor
---

Journey Blueprints — JSON-authored journeys, DB-stored, worker-executed. Same worker, same durable primitives (`ctx.sleep`/`ctx.waitForEvent`/`sendEmail`/`ctx.trigger`) as a code `defineJourney`, but stored as a row instead of committed code — an agent or admin can create and run a lifecycle automation without a PR.

- **New `journey_blueprints` table** (migration `0044`): `id` (= the graph's `journeyId`), `status` (`draft`/`enabled`/`disabled`), `version`, `triggerEvent`/`triggerWhere`, `entryLimit`/`entryPeriod`, `exitOn`, `suppress`, `graph` (jsonb), `source` (`mcp`/`studio`/`api`), `createdBy`, `promotedAt`/`promotedToJourneyId`.
- **Execution-tier graph validation** (`blueprintGraphSchema`, `@hogsend/core`) — a stricter profile of the existing `JourneyGraph` IR (acyclic, no `unknown`/`digest`/`sleepUntil`/`capture` nodes, resolved conditions), layered with engine-side template/connector registry checks. Every write path runs through one `validateBlueprintGraphForSave` — an invalid graph is never saved.
- **One generic `journeyBlueprintInterpreter` Hatchet task** walks a blueprint's graph using the SAME primitives a code journey calls, so replay-safety and exactly-once sends needed zero new engine work. Dispatch-at-ingest (`checkBlueprintTriggers`) routes matching events to it without a worker redeploy.
- **Admin CRUD + lifecycle API** (`/v1/admin/blueprints/*`): create/list/get/patch, a dry-run `/validate` (and per-blueprint `/:id/validate`), `/enable`/`/disable`. A graph-changing edit is rejected (409) while the blueprint has any active/waiting enrollment — Hatchet's durable sleep/wait primitives are matched positionally on replay, so changing the node sequence out from under a suspended run could desync it.
- **Agent-facing MCP tool set** (`create_journey_blueprint`, `update_journey_blueprint`, `validate_journey_blueprint`, `enable_journey_blueprint`, `disable_journey_blueprint`, `list_email_templates`, `list_events`) over the same service layer the HTTP routes use — no parallel auth or storage path.
- No forced approval gate: a blueprint can be created already `enabled`. Studio gives post-hoc oversight (visible immediately, `createdBy` provenance, instant disable), not a pre-send review step.
