---
"@hogsend/core": minor
"@hogsend/engine": minor
"@hogsend/cli": minor
"@hogsend/studio": patch
---

Journey Blueprints hardening across the save path, interpreter, promote-to-code generator, and Studio.

Engine + core:

- Blueprint `triggerEvent` and trigger-node events now reject reserved engine namespaces (`email`/`journey`/`bucket`/`contact`, both `.` and `:` forms) at save time (structured `reserved_event` issue, 422) and at execution time for pre-existing rows. The canonical `RESERVED_EVENT_NAME_RE` / `isReservedEventName` now live in `@hogsend/core` and are reused by semantic-link tracking.
- `entryPeriod` must be a positive duration — `{}` and zero-valued shapes (`{hours: 0}`) are rejected instead of silently degrading `once_per_period` to unlimited.
- Enable/update/promote races closed with guarded conditional writes: a promoted blueprint can no longer be re-enabled or edited by a racing request (`promoted`, 409), concurrent graph edits resolve to exactly one winner (`version_conflict`, 409), and graph edits serialize against new enrollments via a transaction-scoped advisory lock taken on both sides — closing the count-vs-insert window that could desync a suspended run's replay journal.
- A replayed blueprint run whose row was deleted or whose stored graph no longer validates now fails the recovered enrollment (guarded, with `journey:failed` side effects) instead of stranding it in `waiting`/`active` forever.
- New `ctx.exit(reason?)` journey primitive: terminate an enrollment as `exited` (no `journey:completed`/`journey:failed`). The blueprint interpreter's `end-exited` node and promoted code share this one mechanism.
- MCP blueprint tools: `createdBy` is bound at mount time and removed from tool input — agent input can no longer attribute a blueprint to someone else.

CLI (`hogsend blueprints promote`):

- Generated code is now faithful to the interpreter: `end-exited` emits `ctx.exit()`, `end-failed` throws, every send/trigger/connector carries `idempotencyLabel` (author label or node id), sends pass `props: user.properties`, triggers pass `userEmail`, and decision verdicts are frozen via `ctx.once` with the interpreter's key shape.
- Blueprint-controlled strings interpolated into generated comments are sanitized (`*/` and line terminators neutralized) so a hostile node id or condition value cannot escape comment syntax.
- `--journey-id` that renames the journey away from the blueprint id now requires `--allow-reenrollment`, since the rename discards `entryLimit` history and re-enrolls prior completers.

Studio:

- The Journeys list pages through all blueprints instead of silently truncating at 100, with an explicit indicator if the cap is hit.
