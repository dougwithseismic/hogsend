---
"@hogsend/cli": minor
"@hogsend/testing": minor
---

Add `hogsend simulate <journeyId>`: runs one journey from the app through
`@hogsend/testing` on a virtual clock and prints its timeline (enrollment,
waits and how they resumed, checkpoints, sends, triggers, guard skips, final
status). Inputs come from `--user`/`--user-id`/`--email`, repeatable
`--event "<after>:<event>[:<json props>]"`, `--scenario <file.json>` or
`--all-scenarios <dir>`; output is `--format text`, `markdown` or `json`. The
command exits 1 when a simulated journey throws. It needs `@hogsend/testing`
installed in the app.

`@hogsend/testing` adds `simulateJourney(journey, scenario, { force? })`, which
returns that report as JSON, and `createScenarioTest()`. Scenario rows accept
`subscribed`, `guard`, `history`, `entry` and `variants`. Timeline entries now
carry a wait's planned `durationMs`, a `sleepUntil` target, `variant`
assignments, and the explicit `idempotencyLabel` of a send.
