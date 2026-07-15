# Branching on engagement / history after a sleep

The classic lifecycle shape: send something, durably wait, then branch on what
the user did (or didn't do) in the meantime. The branch primitives live on
`ctx.history.*` and `ctx.guard.isSubscribed()`; the wait is `ctx.sleep`.

## The pattern

```ts
import { days, defineJourney, sendEmail } from "@hogsend/engine/journeys";
import { Events, Templates } from "./constants/index.js";

export const activation = defineJourney({
  meta: { /* ... */ },
  run: async (user, ctx) => {
    await sendEmail({
      to: user.email,
      userId: user.id,
      journeyStateId: user.stateId,
      template: Templates.ACTIVATION_WELCOME,
      subject: "Welcome — let's get you set up",
      journeyName: user.journeyName,
    });

    // Durable wait. The worker can restart here and resume.
    await ctx.sleep({ duration: days(2), label: "post-welcome" });

    // Branch on behaviour that happened DURING the sleep.
    const { found: activated } = await ctx.history.hasEvent({
      userId: user.id,
      event: Events.FEATURE_USED,
    });
    if (activated) return; // happy path — nothing more to do

    // Re-check subscription after the long wait before sending again.
    if (!(await ctx.guard.isSubscribed())) return;

    await sendEmail({
      to: user.email,
      userId: user.id,
      journeyStateId: user.stateId,
      template: Templates.ACTIVATION_NUDGE,
      subject: "You haven't tried the key feature yet",
      journeyName: user.journeyName,
    });
  },
});
```

## The branch sources

- **`ctx.history.hasEvent({ userId, event, within? })`** → `{ found, count }`.
  Did the user fire an event? Add `within: days(7)` to scope to a window. This is
  the workhorse for "did they activate / convert / open the app".
- **`ctx.history.email({ email, template })`** → `{ sent, lastSentAt, count }`.
  Did this email already go out? Use it to avoid re-sending the same template on
  a re-run.
- **`ctx.history.journey({ userId, journeyId })`** →
  `{ completed, lastCompletedAt, entryCount }`. Has the user been through another
  journey? Branch on cross-journey state.
- **`ctx.guard.isSubscribed()`** → `boolean`. ALWAYS re-check before sending
  after a long `ctx.sleep` — a user can unsubscribe during the wait. Enrollment
  only checks preferences at entry, not at each send.

## Reactive alternative: `ctx.waitForEvent`

The pattern above sleeps a **fixed window** then polls history — good when you
want to wait a set time regardless. When you're waiting **for a specific event to
happen** (and want to react the moment it does, or give up after a deadline),
`ctx.waitForEvent` is the sharper tool: it resumes the instant the user fires the
event, or returns `timedOut: true` when the timeout wins.

```ts
const { timedOut } = await ctx.waitForEvent({
  event: Events.FEATURE_USED,
  timeout: days(7),                 // required; capped at the 720h task limit
  label: "await-activation",
});
if (!timedOut) return;              // they activated on their own — done
if (!(await ctx.guard.isSubscribed())) return;
await sendEmail({ /* nudge */ });
```

Rule of thumb: **fixed delay → `ctx.sleep` then `ctx.history.hasEvent`**;
**wait until they do X (or time out) → `ctx.waitForEvent`**. The wait is
forward-looking (only events after it begins count), and an `exitOn` match
cancels it mid-wait, so no post-wait send fires after the journey exits.

## Idempotency — journeys can replay

A journey task is durable, and a step before a `ctx.sleep` can be re-executed if
the worker restarts mid-flow. `sendEmail` is NOT deduped, so guard repeatable
sends:

```ts
const { sent } = await ctx.history.email({
  email: user.email,
  template: Templates.ACTIVATION_NUDGE,
});
if (!sent) {
  await sendEmail({ /* ... template: Templates.ACTIVATION_NUDGE ... */ });
}
```

Guidelines:

- Make each send conditional on `ctx.history.email(...)` when a step can run more
  than once.
- Use `ctx.checkpoint("label")` before/after meaningful steps so a restart is
  observable on the `journeyStates` row.
- Keep side effects (the actual `sendEmail`, `ctx.trigger`) AFTER the history
  checks so the check reflects reality at that moment.

For the time-window / `within` duration helpers and richer condition shapes
(`property`, `event`, `email_engagement`, `composite`), see the
**hogsend-conditions** skill.
