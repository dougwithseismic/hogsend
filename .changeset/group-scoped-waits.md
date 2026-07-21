---
"@hogsend/core": minor
"@hogsend/engine": minor
"@hogsend/testing": minor
"create-hogsend": minor
---

Group-scoped durable waits: `ctx.waitForEvent` and `ctx.history.hasEvent` gain
a `group` option — a person-scoped journey parks until ANY member of the
enrolled user's group fires the event. Key resolution is replay-stable
(explicit `{ type, key }` → the trigger event's `groups` association → the
recorded key → the user's sole live membership, which records under
`journey_states.context.__groupKeys__`; ambiguity throws
`GroupScopeUnresolvableError` instead of guessing). Results gain
`actorUserId` — WHO fired the resolving event — on every non-timeout hit,
including plain user-scoped waits (note: consumer tests doing exact equality
on wait results will see the new field). All group waits ride the durable
re-arm leg, and every filtered wait's outcome is now frozen set-once under a
`__waits__` terminal mark and replayed verbatim — a redeploy after a resolved
wait can no longer flip the run onto the timeout branch (this also hardens
pre-existing `where`-filtered waits; duplicate wait labels in one run now
throw). The ingest push carries the event's `groups` map; the
`@hogsend/testing` harness simulates group scope (`triggerGroups` option,
scripted-event `groups`, loud error when a bare-string type can't resolve);
the scaffold ships a commented `groups.d.ts` `GroupTypeMap` augmentation stub
for typed `group:` options. Journey Blueprints' wait node does NOT gain the
option (code-first journeys only, a documented deferral); group-level
journeys and group-level throttle stay deferred.
