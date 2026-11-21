---
"@hogsend/cli": minor
"@hogsend/testing": minor
---

Add `hogsend simulate <journeyId>`: runs one journey from the app through
`@hogsend/testing` on a virtual clock and prints its timeline (enrollment,
waits and how they resumed, checkpoints, sends, triggers, guard skips, final
status). Inputs come from `--user`/`--user-id`/`--email`, repeatable
`--event "<after>:<event>[:<json props>]"`, `--scenario <file.json>` or
`--all-scenarios <dir>`; output is `--format text`, `markdown` or `json`. It
needs `@hogsend/testing` installed in the app.

- A run starts at the current time unless `--now` or the scenario's `now` sets
  it. Dates must be ISO 8601; a value without an offset is read as UTC.
- A run stops after 720h of virtual time (`--until <duration>` or scenario
  `until` changes it). A journey still waiting there is reported as `running`
  and exits 0. A run over 10,000 timeline entries fails, and the command is
  stopped after 60 seconds of wall-clock time (`--timeout <seconds>`).
- The journeys run in a child process with a clean environment: provider
  credentials in the shell (PostHog, Resend, Postmark, Twilio, connector and
  webhook secrets) are not passed, and the database, Redis and Hatchet
  settings are placeholders. Ctrl-C stops the child.
- A scenario that cannot be run is reported (in `errors` for json) without
  hiding the other scenarios. The command exits 1 when a simulated journey
  throws or a scenario cannot be run.

`@hogsend/testing` adds `simulateJourney(journey, scenario, { force?, maxSteps? })`,
which returns that report as JSON, and exports `createScenarioTest()`,
`JourneyHorizonError` and `JourneyStepBudgetError`. Harness options gain
`until` (`run()` rejects with `JourneyHorizonError` at the horizon) and
`maxTimelineEntries`. Scenario rows accept `until`, `subscribed`, `guard`,
`history`, `entry` and `variants`.

The harness timeline is more detailed, so tests that assert the exact
timeline (`toEqual` on `test.timeline` or `effects.waits`, or snapshots) will
need updating: waits now carry their planned `durationMs` (and `sleepUntil`
its `until` target), `ctx.variant` adds one `variant` entry per key per run,
sends carry an explicit `idempotencyLabel` when one was passed, the
`TimelineEntry["type"]` union includes `variant`, and a wait outcome can be
`horizon`.
