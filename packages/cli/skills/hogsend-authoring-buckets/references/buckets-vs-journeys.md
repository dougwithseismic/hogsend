# Bucket vs journey — when to use which

Buckets and journeys are peers built on the same ingestion spine, but they
answer different questions:

- A **bucket** answers **"who is in this audience right NOW?"** It is continuous
  membership. A user is in or out at every instant based on whether their data
  satisfies `criteria`. There is no flow, no steps, no sleeps — just a
  `bucket_memberships` row that flips active/left as the data changes.
- A **journey** answers **"run this one-shot durable flow for a user."** It is a
  TypeScript control-flow process: send, `ctx.sleep`, branch, send again. It has
  a beginning and an end, durable state, and enrollment guards.

Buckets DRIVE journeys: a join/leave transition emits an event, and a journey
can trigger (or exit) on that event. That's the whole integration.

## Pick a bucket when…

- You're describing a STATE that comes and goes: "power users", "trial ending
  this week", "went dormant", "on the pro plan and active".
- Membership should self-heal as data changes — including time-based exits (a
  rolling `within` window rolling past) with no inbound event. The reconcile
  cron owns those leaves; a journey cannot observe "nothing happened".
- You want to reuse the same audience for MANY downstream flows. One bucket, N
  journeys binding to its transitions.
- You want the audience size visible in Studio.

## Pick a journey when…

- You're describing a SEQUENCE with timing: welcome series, dunning, onboarding
  nudges. Steps, durable sleeps, branches.
- The thing is a one-time reaction to an event, not an ongoing membership.
- You need per-step email sends, history checks, cross-journey triggers, etc.

## How transitions drive journeys

On a real join the engine emits `bucket:entered:<id>`; on a leave,
`bucket:left:<id>`. Both flow through the SAME `ingestEvent` pipeline a normal
event does, so journeys route on them exactly like any other trigger. Bind with
the typed `bucketEntered`/`bucketLeft` helpers (see bucket-id-aliases):

```ts
import { days, hours } from "@hogsend/core";
import { defineJourney, sendEmail } from "@hogsend/engine";
import { bucketEntered, bucketLeft, Templates } from "./constants/index.js";

export const powerUserOnboarding = defineJourney({
  meta: {
    id: "power-user-onboarding",
    name: "Power-user onboarding",
    enabled: true,
    trigger: { event: bucketEntered("power-users") },   // join → start the flow
    entryLimit: "once_per_period",
    suppress: hours(24),                                 // required re-entry cool-down
    exitOn: [{ event: bucketLeft("power-users") }],      // leave → pull them out
  },
  run: async (user, ctx) => {
    await sendEmail({
      to: user.email,
      userId: user.id,
      journeyStateId: user.stateId,
      template: Templates.ACTIVATION_WELCOME,
      subject: "You're a power user now — here's the deep dive",
      journeyName: user.journeyName,
    });
    await ctx.sleep({ duration: days(3), label: "follow-up" });
    // ...continue the flow
  },
});
```

## The re-emit / debounce knobs work TOGETHER

A bucket and the journeys it drives both have entry policies; tune them so
oscillation doesn't spam:

- **Bucket `minDwell`** debounces flapping membership — it defers `bucket:left`
  until membership has existed at least that long, so a user bouncing in and out
  doesn't fire a leave-then-enter storm.
- **Bucket `entryLimit` / `entryPeriod`** gate when a RE-join re-emits
  `bucket:entered` (e.g. `"once_per_period"` with a 7-day `entryPeriod` won't
  re-emit a join within a week of the prior leave).
- **Journey `entryLimit` / `suppress`** are the journey's own re-entry guard on
  top of that.

Rule of thumb: shape the audience on the bucket (`criteria`, `minDwell`,
`entryLimit`), shape the messaging cadence on the journey (`suppress`,
`exitOn`). For the condition/duration semantics shared by both, see the
hogsend-conditions skill.

## What buckets are NOT

Buckets are observe-only in Studio — there is no visual builder, exactly like
journeys. They live in code. And `kind:"manual"` (membership mutated only by
explicit API/import) is declared on the type for forward-compat but is REJECTED
at registration in v1 — every bucket today is `kind:"dynamic"` with `criteria`.
