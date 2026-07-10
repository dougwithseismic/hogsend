# JourneyContext (`ctx`) — the full primitive API

`ctx` is the SECOND argument to `run(user, ctx)`. It exposes **durable
orchestration primitives only** — the things that need Hatchet's durable
execution or the journey's bound state (sleep, checkpoints, triggering events,
reading history). It is deliberately small.

It is the `JourneyContext` type from `@hogsend/core`. Everything below is a real
method.

## Durable timing

```ts
// Durable Hatchet sleep. Sets state → "waiting" for the duration, then "active".
// The worker can restart mid-sleep and resume — this is the core durability win.
const { sleptAt, resumedAt } = await ctx.sleep({
  duration: days(2),          // DurationObject from days()/hours()/minutes()
  label: "post-welcome",      // optional — also written as currentNodeId
});

// Durable sleep until an absolute instant (Date or ISO string).
await ctx.sleepUntil(someDate, { label: "wait-for-renewal" });

// Timezone-bound fluent scheduler — always resolves to an absolute Date you
// then pass to sleepUntil. Bound to the user's resolved timezone.
const at = ctx.when.tomorrow().at("09:00");        // 9am local, tomorrow
await ctx.sleepUntil(at, { label: "morning-nudge" });
// other ctx.when builders: .next("mon").at("HH:mm"), .nextLocal("HH:mm"),
// .in(days(3)).at("HH:mm"), and chainers .tz(zone) / .window(start,end) / .ifPast("next"|"now")
```

## Durable wait-for-event

```ts
// Park the journey until THIS user emits `event`, OR `timeout` elapses —
// whichever first. The reactive alternative to "sleep a fixed window, then poll
// ctx.history": it resumes the INSTANT the event lands. Forward-looking — only
// events fired AFTER the wait begins count (use ctx.history.hasEvent for the past).
const { timedOut, properties } = await ctx.waitForEvent({
  event: Events.FEATURE_USED,
  timeout: days(7),           // REQUIRED, capped at the 720h task execution limit
  label: "await-activation",  // optional — written as currentNodeId
});
if (timedOut) {
  // they never did it — nudge (re-check ctx.guard.isSubscribed() first after a long wait)
} else {
  // event arrived — they activated on their own. `properties` carries the
  // matched event's payload (best-effort, scalars only) — branch on the
  // answer directly, e.g. a semantic-link NPS score:
  // if (typeof properties?.score === "number" && properties.score <= 6) { … }
}
```

NEVER put the awaited event in `exitOn` too: an `exitOn` match mid-wait aborts
the run (`JourneyExitedError`) BEFORE your post-wait branch executes. React via
`waitForEvent` OR exit via `exitOn` — one event name, one role.

Waiting twice for the same event (e.g. after a reminder send)? Pass
`lookback: hours(1)` on the second wait — the wait is forward-looking, so an
answer landing in the gap between the two waits would otherwise be missed;
`lookback` checks recent `user_events` first and resolves immediately with the
payload.

If the journey `exitOn`-matches (or is cancelled) WHILE waiting, the run aborts
cleanly — state goes `"exited"`, the durable run is cancelled, and no post-wait
step (or email) fires. You don't catch anything; the engine handles it.

## Digest — aggregate a window into ONE execution

```ts
// Collapse many trigger events over a fixed window into a single run. The FIRST
// event enrolls; every same-name event during the window is absorbed by the
// active-enrollment guard (no new run) and returned here at flush. So a user
// firing an event 40x this week gets ONE email, not 40. Replay-safe: the flush
// scan runs once and the result is recorded, so a replay returns it verbatim.
const digest = await ctx.digest({
  window: days(7),            // aggregation window, measured from this call. Max 720h.
  // event: Events.FEATURE_USED,  // optional — defaults to the journey's trigger event
  // where: (b) => b.prop("plan").eq("pro"),  // optional; trigger.where applies by default
  // maxEvents: 100,          // events returned AND recorded. Default 100, ceiling 500.
  label: "weekly-activity",   // node id; default `digest:<event>`. Distinct per run.
});
// digest.events   → chronological [{ properties, occurredAt }], capped at maxEvents
// digest.count    → number of events in the window
// digest.truncated→ true when more than maxEvents matched
// digest.flushedAt→ ISO instant the window closed (recorded — replay-stable)

// A 7-day window is a long wait; unsubscribe does NOT exit the journey.
if (!(await ctx.guard.isSubscribed())) return;

// "Batch" is plain TypeScript over digest.events — there is NO batch primitive.
const byProject = Object.groupBy(digest.events, (e) =>
  String(e.properties?.projectId ?? "other"),
);
```

`entryLimit: "unlimited"` → a ROLLING digest (each window re-enrolls from the
next event). `entryLimit: "once"` → exactly ONE window ever. Pair a rolling
digest with `suppress: days(0)`: the digest already collapses the sends, and a
`suppress` ≥ the window would gap out each new window's email. The window is
NEVER tier-gated. Straggler caveat: an event landing between the flush scan and
the run completing counts toward the NEXT window, not this one.

## Throttle — advisory frequency check

```ts
// ADVISORY branch: "has this user already had `limit` emails this window? then
// skip the nudge." Counts THIS user's non-failed email_sends by recipient email
// (the same count the client-level frequencyCap enforces on). The verdict is
// RECORDED once per site and replayed verbatim, so a replay branches identically.
const { allowed, count, remaining } = await ctx.throttle({
  limit: 3,
  window: days(7),
  // category: "marketing",   // optional — count only this category. No exemptions.
  // label: "nudge-throttle", // optional — distinct per site; reusing one throws.
});
if (!allowed) return; // already got `limit` this window
```

ADVISORY, not enforcement: the client-level `frequencyCap` config stays the HARD
send-time backstop, and the two can disagree across a long wait (this verdict is
frozen at first check; the cap re-counts at send). There is NO reservation, so
concurrent journeys can overshoot an advisory limit. To count things that are
NOT sends (pushes, Slack messages, a specific action), use the named-counter
recipe: `ctx.trigger({ event: "nudge.sent", userId })` to record + a windowed
`ctx.history.hasEvent({ event: "nudge.sent", within: days(7) })` to count.

`ctx.digest`, `ctx.throttle`, and `ctx.once` persist recorded state under the
reserved context keys `__digest__` / `__throttle__` / `__once__` (don't write
them yourself) and reserve the `digest:` / `throttle:` label prefixes — give each
call a distinct `label` when a run has more than one.

## Observability

```ts
// Update currentNodeId on the journeyStates row — a breadcrumb for dashboards.
await ctx.checkpoint("awaiting-activation");
```

## Firing events (cross-journey orchestration)

```ts
// Push an event through the FULL ingest pipeline (stores it, routes to matching
// journey tasks via Hatchet, processes exitOn). Lets one journey trigger another.
await ctx.trigger({
  event: Events.JOURNEY_PRO_PATH,
  userId: user.id,            // defaults userEmail to the current user's email
  userEmail: user.email,      // optional override
  properties: { step: "pro_branch" },
});
```

## Fanning data out — use DESTINATIONS, not `ctx`

There is **no `ctx.identify` and no `ctx.posthog.capture`** — those single-vendor
PostHog shims were removed. `ctx` does not fan data out to product/data tools.

To mirror user/event data into PostHog, Segment, Slack, a CRM or a warehouse, set
up an outbound **DESTINATION**: the email/contact/journey/bucket lifecycle is
delivered there DURABLY (retry / backoff / DLQ), keyed by `webhook_endpoints.kind`.
You don't fire it from `run` — it receives the lifecycle automatically:

- `email.sent` / `email.delivered` / `email.opened` / `email.clicked` /
  `email.bounced` / `email.complained`, `contact.*`, `journey.completed`,
  `bucket.entered` / `bucket.left`.
- `email.delivered` is the canonical **"email was received"** signal.
- EVERY destination receives EVERY open and click — **per-hit, not first-touch** —
  so downstream tools see the full engagement stream.

See the **hogsend-authoring-destinations** skill. (PostHog is now JUST a
destination, `kind="posthog"`.) If you need a fire-and-forget raw write inside a
journey, `getPostHog()` is still importable from `@hogsend/engine` — but for
fan-out, reach for a destination, not an in-journey vendor call.

## Guards

```ts
// Re-check subscription AFTER a long sleep, before sending again.
if (await ctx.guard.isSubscribed()) {
  await sendEmail({ /* ... */ });
}
```

## History reads (branch on what already happened)

```ts
// Did this user fire an event (optionally within a window)?
const { found, count } = await ctx.history.hasEvent({
  userId: user.id,
  event: Events.FEATURE_USED,
  within: days(7),            // optional DurationObject
});

// Has this user completed another journey before? How many times entered?
const { completed, lastCompletedAt, entryCount } = await ctx.history.journey({
  userId: user.id,
  journeyId: "onboarding",
});

// Has this email already received a given template?
const { sent, lastSentAt, count } = await ctx.history.email({
  email: user.email,
  template: Templates.ACTIVATION_WELCOME,
});
```

## What is NOT on `ctx`

These are **standalone imports**, not methods — keeping `ctx` to pure
orchestration:

- **`sendEmail()`** — `import { sendEmail } from "@hogsend/engine"`. See
  `references/sending-email-from-a-journey.md`.
- **`getPostHog()`** — `import { getPostHog } from "@hogsend/engine"` for the raw
  PostHog service (a fire-and-forget escape hatch). For fanning lifecycle data out
  to product/data tools, prefer an outbound DESTINATION (see above) — it delivers
  durably and is vendor-neutral. Note: capture and `$set` person WRITES use the
  `phc_` project key; person READS (`getPersonProperties`) additionally need
  `POSTHOG_PERSONAL_API_KEY` (the project key is write-only by PostHog's design)
  and soft-fail to `{}` without it.
- **SMS / push / Slack** — plain functions you import, never on `ctx`.
- There is **no `ctx.db`, no `ctx.sendEmail`, no `ctx.hatchet`** surfaced to
  consumer journeys. If you reach for one of those, you are modelling it wrong —
  use a primitive above or a standalone import.

The `user` argument (first param) carries identity + attribution: `user.id`,
`user.email`, `user.properties`, `user.stateId` (pass to `sendEmail`),
`user.journeyId`, `user.journeyName`.
