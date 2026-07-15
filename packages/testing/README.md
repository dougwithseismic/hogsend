# @hogsend/testing

Deterministic, zero-infrastructure unit tests for Hogsend journeys. The harness
runs the original journey function with virtual time, scripted events and
in-memory histories, while capturing outbound effects for assertions.

Author journey modules with the environment-free engine entry point so the
original module can be imported without production credentials:

```ts
import { defineJourney, sendEmail } from "@hogsend/engine/journeys";
```

```ts
const test = createJourneyTest(welcome, { user });
test.events.after(days(2), "project.created", { projectId: "p1" });
await test.run();
```

When `run()` starts, the harness records one enrollment event using
`journey.meta.trigger.event` and `user.properties`. Do not script that trigger
yourself; `events.*` is for additional immediate or future events.

Pass registered connector definitions through `connectorActions` when a journey
uses `sendConnectorAction`; unknown actions fail before capture. Scheduled
`guard` changes gate recipient-directed captured effects, and explicit email,
SMS, and feed idempotency keys are deduplicated in memory. Await every journey
effect—ambient timers and third-party async work are intentionally not drained.

SMS capture follows production's explicit opt-in policy. `smsConsent` defaults
to `"missing"`; use `smsConsent: "granted"` for a delivery path, and pass
`smsTemplates` to validate runtime template keys. Use `preferences` to fixture
email transport suppression or category/channel opt-outs. Transactional SMS
bypasses missing consent, but global unsubscribe and phone-level
`smsConsent: "suppressed"` still block it. `meta.suppress` gaps email and SMS
independently, including history fixtures carrying the same `journeyId`.
`preferences.defaultOptIn` models list polarity; a `false` list requires an
explicit `preferences.categories[id] = true` grant.

Import `@hogsend/testing/vitest` once in a Vitest setup or test module to add
`toHaveSent` and `toHaveSentTimes`. Vitest is an optional peer; the core harness
does not import it, so its API is not coupled to a test runner.

Hogsend packages publish raw TypeScript source. Your runner must transform
TypeScript dependencies under `node_modules`; a direct Node import without a
TypeScript loader is not supported. With Vitest, inline the raw-source packages
so Vite transforms their `.ts` files and resolves their internal `.js`
specifiers:

```ts
server: {
  deps: {
    inline: [/@hogsend\/(core|email|engine|sms|testing)/],
  },
},
```

For another runner, configure its equivalent dependency transform or launch it
with a TypeScript loader such as `tsx`.

## License

[Elastic License 2.0](../../LICENSE)
