---
name: hogsend-authoring-journeys
description: Use when adding or editing a lifecycle journey in src/journeys/ — wiring a defineJourney() trigger/entryLimit/exitOn/suppress, writing the run(user, ctx) control flow, durable sleeps, branching on history/engagement, sending email from a journey, and the register-in-index + thread-into-client/worker ritual.
license: MIT
metadata:
  author: withSeismic
  version: "1.0.0"
---

# Authoring Hogsend journeys

A journey is a code-first lifecycle flow. You declare a `defineJourney({ meta,
run })` in `src/journeys/`: `meta` says who enters and when they exit, and
`run(user, ctx)` is plain TypeScript control flow — send email, durably sleep,
branch on history. Each journey compiles to its own Hatchet durable task, so the
worker can restart mid-flow and resume exactly where it left off.

You are editing a **scaffolded consumer app** (content only). You import from
`@hogsend/engine` and `@hogsend/core`; you never touch engine internals.

## Anatomy of a journey

```ts
import { days, hours } from "@hogsend/core";
import { defineJourney, sendEmail } from "@hogsend/engine";
import { Events, Templates } from "./constants/index.js";

export const welcome = defineJourney({
  meta: {
    id: "welcome",                               // stable, unique id
    name: "Welcome Series",
    enabled: true,
    trigger: { event: Events.USER_CREATED },     // event that enrolls a user
    entryLimit: "once",                          // re-entry policy (+ entryPeriod)
    suppress: hours(12),                         // required declared cool-down field
    exitOn: [{ event: Events.USER_DELETED }],    // events that pull users out
  },
  run: async (user, ctx) => {
    await sendEmail({                            // STANDALONE import, not ctx.*
      to: user.email,
      userId: user.id,
      journeyStateId: user.stateId,
      template: Templates.ACTIVATION_WELCOME,
      subject: "Welcome — let's get you set up",
      journeyName: user.journeyName,
    });
    await ctx.sleep({ duration: days(2), label: "post-welcome" });
    const { found } = await ctx.history.hasEvent({
      userId: user.id,
      event: Events.FEATURE_USED,
    });
    if (!found) {
      await sendEmail({ /* nudge */ });
    }
  },
});
```

## Key concepts

- **`ctx` is orchestration primitives ONLY** — `sleep`, `sleepUntil`, `when`,
  `waitForEvent`, `checkpoint`, `trigger`, `identify`, `guard.isSubscribed`,
  `history.hasEvent/journey/email`, `posthog.capture`. Features are standalone
  imports: `sendEmail()` and `getPostHog()` come from `@hogsend/engine`, NOT off
  `ctx`.
- **Duration helpers** `days()` / `hours()` / `minutes()` from `@hogsend/core`
  (also re-exported by `@hogsend/engine`) — never magic strings.
- **`user`** carries `id`, `email`, `properties`, `stateId`, `journeyId`,
  `journeyName` — pass `user.stateId` to `sendEmail` so the send is attributed.
- **Constants** `Events` / `Templates` live in your `src/journeys/constants/`.
  `Templates` keys must match a key in `src/emails/` registry.

## Task playbooks — load the matching reference

- **Shape `meta` (trigger, entryLimit, exitOn, suppress) + understand the
  enrollment gates and state transitions** → `references/journey-meta.md`
- **The full `ctx` primitive API and what is deliberately NOT on it** →
  `references/journey-context.md`
- **Send an email from inside `run`** → `references/sending-email-from-a-journey.md`
- **Branch after a sleep on engagement / history, idempotently** →
  `references/branch-on-engagement.md`
- **Register a new journey: export + thread into client/worker + ENABLED_JOURNEYS**
  → `references/register-a-journey.md`

For `trigger.where` / `exitOn[].where` property conditions and the duration
helpers in depth, see the **hogsend-conditions** skill. To verify a journey runs
against a live instance (enroll a test user, watch it complete), see the
**hogsend-cli** skill.
