import type { JourneySpec } from "@hogsend/engine";

/**
 * Dogfood demo of a DECLARATIVE journey — pure data, no `run()` function.
 *
 * This object is what a `*.journey.json` (or YAML) file parses to; it's kept
 * as a TS module here so it type-checks against `JourneySpec` in CI, but the
 * engine treats it exactly like JSON loaded at runtime: it goes into the
 * `journeys` array as-is and `createHogsendClient` / `createWorker` adapt it
 * via `journeyFromSpec` (validation at boot, step interpreter at run time).
 *
 * Triggered only by the manual `demo.spec_journey` event, so it never crosses
 * paths with the real lifecycle journeys.
 */
export const specDemoJourney = {
  specVersion: 1,
  id: "spec-demo",
  meta: {
    name: "Spec Demo — JSON-defined journey",
    description:
      "A journey defined as data (JSON spec) and executed by the engine's step interpreter.",
    enabled: true,
    trigger: { event: "demo.spec_journey" },
    entryLimit: "unlimited",
    suppress: { minutes: 1 },
    exitOn: [{ event: "demo.spec_journey_exit" }],
  },
  steps: [
    {
      id: "hello",
      type: "send_email",
      template: "welcome",
      subject: "Hello from a JSON journey",
    },
    { id: "settle", type: "sleep", duration: { minutes: 5 } },
    {
      id: "responded",
      type: "wait_for_event",
      event: "demo.spec_journey_reply",
      timeout: { hours: 24 },
    },
    {
      id: "did-respond",
      type: "branch",
      if: { type: "wait_result", of: "responded", fired: true },
      yes: [
        {
          id: "converted",
          type: "trigger_event",
          event: "demo.spec_journey_converted",
        },
      ],
      no: [{ id: "mark-quiet", type: "checkpoint" }],
    },
  ],
} as const satisfies JourneySpec;
