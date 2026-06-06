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
can trigger (or exit) on that event. That's the whole integration. A bucket can
also carry its OWN behavior inline via `.on()` reactions (which themselves
desugar to journeys — see below), and you can QUERY a bucket's members directly.

## Pick a bucket when…

- You're describing a STATE that comes and goes: "power users", "trial ending
  this week", "went dormant", "on the pro plan and active".
- Membership should self-heal as data changes — including time-based exits (a
  rolling `within` window rolling past) with no inbound event. The reconcile
  cron owns those leaves; a journey cannot observe "nothing happened".
- You want to reuse the same audience for MANY downstream flows. One bucket, N
  journeys binding to its transitions.
- You want the audience size visible in Studio, or you want to query membership
  in code (`count` / `has` / `members`).

## Pick a journey when…

- You're describing a SEQUENCE with timing: welcome series, dunning, onboarding
  nudges. Steps, durable sleeps, branches.
- The thing is a one-time reaction to an event, not an ongoing membership.
- You need per-step email sends, history checks, cross-journey triggers, etc.

## How transitions drive journeys

On a real join the engine emits `bucket:entered:<id>`; on a leave,
`bucket:left:<id>`. Both flow through the SAME `ingestEvent` pipeline a normal
event does, so journeys route on them exactly like any other trigger. Bind with
the bucket's typed transition refs `bucket.entered` / `bucket.left` (literal-typed
off the id — see bucket-id-aliases), importing the bucket from its leaf module:

```ts
import { days, hours } from "@hogsend/core";
import { defineJourney, sendEmail } from "@hogsend/engine";
import { powerUsers } from "../buckets/power-users.js"; // leaf module, not the barrel
import { Templates } from "./constants/index.js";

export const powerUserOnboarding = defineJourney({
  meta: {
    id: "power-user-onboarding",
    name: "Power-user onboarding",
    enabled: true,
    trigger: { event: powerUsers.entered },   // join → start the flow
    entryLimit: "once_per_period",
    suppress: hours(24),                        // required re-entry cool-down
    exitOn: [{ event: powerUsers.left }],      // leave → pull them out
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

## Inline reaction vs a separate journey

A bucket can also carry behavior INLINE with `bucket.on("enter" | "leave" |
"dwell", ...)`. A reaction is NOT a lightweight listener — it **desugars to a real
durable journey** tagged `sourceBucketId`, triggered by the bucket's own
transition event, inheriting the full enrollment-guard stack and durable context.
So the choice is about colocation, not capability:

- **One canonical behavior per transition** that belongs WITH the audience →
  colocate it as `bucket.on(...)`. It ships with the bucket and groups under it in
  Studio.
- **A SECOND or DIVERGENT behavior on the same transition** → write a normal
  `defineJourney({ trigger: { event: bucket.entered } })`. There is one canonical
  reaction per transition; everything beyond that is just another journey binding
  to the typed ref. Don't stack multiple `.on("enter")` calls expecting an
  emitter-style fan-out — that's what a separate journey is for.

`dwell` has no journey equivalent: it fires from the reconcile cron over the
EXISTING continuously-resident population, which `on("enter") + ctx.sleep` (a
per-user durable timer that only clocks future entrants) cannot do. See the main
SKILL for dwell semantics.

## Querying a bucket's members

A bucket is also a read surface — you don't need a journey to ask who's in it:

```ts
const { data: total } = await powerUsers.count();          // number | null
const { data: isMember } = await powerUsers.has(userId);   // boolean
const page = await powerUsers.members({ limit: 50 });      // { data, error, count, cursor }
for await (const m of powerUsers.membersIterator()) { /* paged internally */ }
```

All results are `{ data, error }`-shaped, GDPR-joined to live contacts, and
paged (hard cap 100) — never an unbounded array. Reach for these from a workflow,
a custom route, or a script; reach for a journey when you need per-user durable
control flow instead.

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
  top of that. (Generated reactions intentionally use `entryLimit:"unlimited"` +
  `suppress:{seconds:0}` — re-entry is a filter there, not a cool-down.)

Rule of thumb: shape the audience on the bucket (`criteria`, `minDwell`,
`entryLimit`), shape the messaging cadence on the journey (`suppress`,
`exitOn`). For the condition/duration semantics shared by both, see the
hogsend-conditions skill.

## What buckets are NOT

Buckets are observe-only in Studio — there is no visual builder, exactly like
journeys. They live in code. And `kind:"manual"` (membership mutated only by
explicit API/import) is declared on the type for forward-compat but is REJECTED
at registration in v1 — every bucket today is `kind:"dynamic"` with `criteria`.
