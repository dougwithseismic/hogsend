/**
 * The JourneySpec authoring reference, served as the MCP resource
 * `hogsend://journey-spec-reference`. This is how the model learns to write
 * valid specs WITHOUT bloating the manage_journey tool description (tool
 * definitions cost context on every conversation; resources load on demand).
 */
export const SPEC_REFERENCE = `# Hogsend JourneySpec authoring reference

A journey is JSON: metadata (when to start/stop) + an ordered list of steps.
Validate template keys first via hogsend_report scope "catalog".

## Envelope

{
  "specVersion": 1,
  "id": "activation-nudge",            // kebab-case, unique, becomes the journey id
  "meta": {
    "name": "Activation nudge",
    "description": "optional",
    "enabled": true,                    // ignored on create via MCP (born disabled)
    "trigger": { "event": "user.signed_up", "where": [ /* optional PropertyCondition[] */ ] },
    "entryLimit": "once" | "once_per_period" | "unlimited",
    "entryPeriod": { "hours": 720 },    // only with once_per_period
    "suppress": { "minutes": 1 },       // min gap between entries (required)
    "exitOn": [{ "event": "user.activated" }]   // optional: cancels in-flight enrollment
  },
  "steps": [ ...steps ]
}

## Steps (each needs a unique kebab-case "id" — it names the step everywhere)

Send an email (template must exist in the catalog):
  { "id": "hello", "type": "send_email", "template": "activation-nudge", "subject": "Quick tip", "props": { } }

Wait a fixed time:
  { "id": "settle", "type": "sleep", "duration": { "hours": 48 } }        // hours/minutes/seconds

Wait until an absolute time:
  { "id": "launch", "type": "sleep_until", "at": "2026-08-01T09:00:00Z" }

Wait for the user to do something (or time out):
  { "id": "responded", "type": "wait_for_event", "event": "user.activated", "timeout": { "hours": 96 } }

Branch (arms are step lists; "no" optional):
  { "id": "did-activate", "type": "branch",
    "if": { "type": "wait_result", "of": "responded", "fired": true },
    "yes": [ { "id": "done", "type": "end" } ],
    "no":  [ { "id": "nudge-again", "type": "send_email", "template": "activation-nudge-2", "subject": "Still stuck?" } ] }

Branch conditions:
  { "type": "property", "property": "plan", "operator": "eq", "value": "pro" }
    operators: eq, neq, gt, gte, lt, lte, contains, exists, not_exists
  { "type": "event", "eventName": "feature.used", "check": "exists" | "not_exists", "within": { "hours": 72 } }
  { "type": "wait_result", "of": "<wait step id>", "fired": true | false }
  { "type": "composite", "operator": "and" | "or", "conditions": [ ... ] }

Other steps:
  { "id": "mark", "type": "checkpoint" }                                   // progress marker
  { "id": "notify", "type": "trigger_event", "event": "nudge.converted" }  // fire an event
  { "id": "stop", "type": "end" }                                          // finish here

## Rules the server enforces (violations return a 400 you can fix)
- Step ids unique across the whole tree; reserved ids: start, end-completed, end-exited, end-failed.
- "wait_result.of" must reference an EARLIER wait_for_event step.
- Every send_email.template must be a registered template key.
- The spec id must not collide with a code journey (409 — pick another id).

## Worked example — nudge users parked at activation

{
  "specVersion": 1,
  "id": "activation-nudge",
  "meta": {
    "name": "Activation nudge",
    "enabled": true,
    "trigger": { "event": "user.signed_up" },
    "entryLimit": "once",
    "suppress": { "minutes": 1 },
    "exitOn": [{ "event": "user.activated" }]
  },
  "steps": [
    { "id": "wait-3d", "type": "sleep", "duration": { "hours": 72 } },
    { "id": "check-active", "type": "branch",
      "if": { "type": "event", "eventName": "user.activated", "check": "exists", "within": { "hours": 72 } },
      "yes": [ { "id": "done", "type": "end" } ] },
    { "id": "nudge", "type": "send_email", "template": "activation-nudge", "subject": "One step left" },
    { "id": "await-activation", "type": "wait_for_event", "event": "user.activated", "timeout": { "hours": 96 } },
    { "id": "outcome", "type": "branch",
      "if": { "type": "wait_result", "of": "await-activation", "fired": true },
      "yes": [ { "id": "celebrate", "type": "trigger_event", "event": "activation_nudge.converted" } ],
      "no":  [ { "id": "final", "type": "send_email", "template": "activation-nudge-2", "subject": "Need a hand?" } ] }
  ]
}
`;
