# Customer.io → Hogsend mapping

Audit greps, the concept table, and before/after rewrites for a codebase using
Customer.io. Customer.io's API surface varies by SDK (`customerio-node` Track
vs App API clients) and product tier — treat the left-hand column as "look
for", and verify against the project's actual calls.

## Audit greps (code half)

```bash
grep -rn "customerio" package.json            # commonly `customerio-node`
grep -rn "TrackClient\|APIClient\|cio\." src/
grep -rn "identify\|\.track(\|trackAnonymous\|triggerBroadcast" src/
grep -rn "_cio" src/ public/                  # in-app/browser snippet
grep -rn "CUSTOMERIO\|CIO_" . --include="*.env*"
```

GUI half (export/screenshot from the Customer.io dashboard): campaigns (entry
trigger, filters, delays, branches, goal/exit settings), segments (definitions
+ whether data-driven or manual), broadcasts/newsletters, transactional
messages, subscription preferences/topics, and the suppression list.

## Concept mapping

| Customer.io concept | Hogsend equivalent | Notes |
|---|---|---|
| Person + attributes (`identify`) | contact — `hs.contacts.upsert({ userId, email?, properties })` | CIO is id-keyed; Hogsend takes `userId` and/or `email`. Attributes → `properties` |
| `track(id, event, data)` | `hs.events.send({ userId, name, eventProperties, contactProperties? })` | CIO has ONE data bag; Hogsend has two. Sort each field: per-occurrence → `eventProperties`, durable → `contactProperties` |
| Anonymous events (`trackAnonymous`) | no direct equivalent | Hogsend writes need an identity (`email`/`userId`). Defer anonymous tracking to your product-analytics tool; ingest on identification |
| Campaign (triggered workflow) | journey — `defineJourney()` | Trigger → `trigger.event` (+ `where` for filters); frequency settings → `entryLimit`; goal/exit → `exitOn`; delays → `ctx.sleep`; time-windows → `ctx.when`; "wait until event" → `ctx.waitForEvent` |
| Segment (data-driven) | bucket — `defineBucket()` criteria tree | Real-time membership; journeys can trigger on `bucket.entered`/`bucket.left` transitions → hogsend-authoring-buckets |
| Segment (manual) | list — `defineList()` + explicit membership writes | Manual segments are membership-by-assignment, which is what lists are |
| Broadcast / newsletter | campaign — `hs.campaigns.send({ list \| bucket, template })` | API-triggered broadcasts (`triggerBroadcast`) also map here |
| Transactional message | `hs.emails.send({ to \| userId, template, props })` | Each transactional message id becomes a template key in `src/emails/` |
| Subscription preferences / topics | lists (`defineList`) + the built-in preference center | Topic opt-ins → `defaultOptIn: false`; suppression import → `cutover-checklist.md` |
| Reporting webhooks (CIO → your systems) | webhook endpoints / keyed destinations — `hs.webhooks.create({ url, eventTypes, kind?, config? })` | Hogsend emits `email.*`, `contact.*`, `journey.completed`, `bucket.*` on a durable signed spine |

## Before / after

Identify + track (host product code):

```ts
// BEFORE (customerio-node Track API — shape varies by version)
cio.identify("u_1", { email: "ada@example.com", plan: "pro" });
cio.track("u_1", { name: "subscription_started", data: { plan: "pro", amount: 49 } });

// AFTER (@hogsend/client)
import { hogsend } from "../lib/hogsend.js";

await hogsend.contacts.upsert({
  userId: "u_1",
  email: "ada@example.com",
  properties: { plan: "pro" },
});
await hogsend.events.send({
  userId: "u_1",
  name: "subscription_started",
  eventProperties: { plan: "pro", amount: 49 }, // facts about THIS event
  contactProperties: { plan: "pro" },           // durable fact on the person
});
```

Campaign → journey translation guide (authored in the Hogsend app —
mechanics → hogsend-authoring-journeys, conditions → hogsend-conditions):

| Campaign builder block | Journey code |
|---|---|
| "Person enters when event X" | `trigger: { event: "X" }` |
| "…and attribute filter" | `trigger: { where: { type: "property", … } }` |
| "Can enter once / every N days" | `entryLimit: "once"` / `"once_per_period"` |
| "Exit when goal event Y" | `exitOn: [{ event: "Y" }]` |
| "Wait 3 days" | `await ctx.sleep({ duration: days(3) })` |
| "Wait until Tuesday 9am (their tz)" | `ctx.when` scheduler + `ctx.sleepUntil` |
| "Wait up to 7 days for event Z" | `await ctx.waitForEvent({ event: "Z", timeout: days(7) })` |
| "True/false branch on behavior" | `if` on `ctx.history.hasEvent(...)` / `ctx.history.email(...)` |
| "Send email" | `await sendEmail({ …, journeyStateId: user.stateId })` |

## Customer.io-specific gotchas

- **One data bag → two.** The single `data` object on `cio.track` must be
  consciously split into `eventProperties` vs `contactProperties`. Default
  per-field to `eventProperties`; promote to `contactProperties` only what a
  later check on the person should read.
- **Anonymous → identified flows have no Hogsend equivalent** — plan to start
  lifecycle tracking at identification (signup), which is where journeys
  almost always start anyway.
- **In-app `_cio` snippet** (browser tracking) is product analytics, not
  lifecycle orchestration. Don't port it to Hogsend; if the team uses PostHog,
  that's its home, and Hogsend can consume those signals later.
- **Liquid templates** don't transplant. Re-author as react-email with typed
  props; conditional content blocks become plain JSX conditionals.
- **Campaign analytics history stays behind.** Export CSVs for the record;
  Hogsend metrics start at cutover.
