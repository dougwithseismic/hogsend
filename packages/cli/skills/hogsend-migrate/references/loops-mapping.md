# Loops → Hogsend mapping

Audit greps, the concept table, and before/after rewrites for a codebase using
Loops (loops.so). Loops' own API may differ by SDK version — treat the
left-hand column as "look for", and verify against the project's actual calls.

## Audit greps (code half)

```bash
grep -rn "loops" package.json                 # the SDK dep (commonly `loops`)
grep -rn "sendEvent\|updateContact\|sendTransactionalEmail\|createContact" src/
grep -rn "transactionalId" src/               # transactional template ids
grep -rn "LOOPS_API_KEY\|loops.so" . --include="*.env*" --include="*.ts"
```

GUI half (ask the user to export/screenshot from the Loops dashboard): Loops
(the workflows), audiences/segments, mailing lists + their opt-in state,
email templates, and the unsubscribed-contacts export.

## Concept mapping

| Loops concept | Hogsend equivalent | Notes |
|---|---|---|
| Contact (+ contact properties) | contact — `hs.contacts.upsert({ email, userId?, properties })` | Loops keys contacts on email; carry the app's user id as `userId` too — Hogsend identity is `email` and/or `userId` |
| `sendEvent` (event + event/contact properties) | `hs.events.send({ …, eventProperties, contactProperties })` | Keep the bag split deliberate: per-occurrence facts → `eventProperties` (drive journey `trigger.where`/`exitOn`); durable facts → `contactProperties` |
| Loop (the visual workflow) | journey — `defineJourney()` in `src/journeys/` | Entry trigger → `trigger.event`; "enter once" → `entryLimit: "once"`; goal/exit → `exitOn`; timers → `ctx.sleep({ duration: days(n) })`; audience filters → `trigger.where` conditions |
| Transactional email (`sendTransactionalEmail` + `transactionalId`) | `hs.emails.send({ to | userId, template, props })` + a four-file template | Each `transactionalId` becomes a template key in the Hogsend app's `src/emails/` registry; `dataVariables` become typed `props` |
| Mailing list (opt-in/opt-out toggle) | list — `defineList({ id, name, defaultOptIn })` | Loops' "public" opt-in lists → `defaultOptIn: false`; default-subscribed lists → `defaultOptIn: true` |
| Audience / segment filter | bucket (`defineBucket`) when behavioral; `trigger.where` when it's just an entry filter | Don't over-build: a one-condition audience is usually just a `where` clause |
| Campaign (one-off blast) | campaign — `hs.campaigns.send({ list | bucket, template, props })` | Or `hogsend campaigns send --list … --template …` |
| Unsubscribed contacts | suppression import — see `cutover-checklist.md` | Import BEFORE any send |

## Before / after

Contact + event (host product code):

```ts
// BEFORE (Loops — shape varies by SDK version)
await loops.updateContact("ada@example.com", { plan: "pro" });
await loops.sendEvent({
  email: "ada@example.com",
  eventName: "subscription_started",
  eventProperties: { plan: "pro" },
});

// AFTER (@hogsend/client)
import { hogsend } from "../lib/hogsend.js";

await hogsend.contacts.upsert({
  email: "ada@example.com",
  userId: user.id,
  properties: { plan: "pro" },
});
await hogsend.events.send({
  email: "ada@example.com",
  userId: user.id,
  name: "subscription_started",
  eventProperties: { plan: "pro" },
});
```

Transactional:

```ts
// BEFORE (Loops)
await loops.sendTransactionalEmail({
  transactionalId: "clxyz...",
  email: "ada@example.com",
  dataVariables: { resetUrl },
});

// AFTER — template authored in the Hogsend app first
// (four-file contract → hogsend-authoring-emails skill)
await hogsend.emails.send({
  to: "ada@example.com",
  template: "password-reset",
  props: { resetUrl },
});
```

A Loop becomes a journey (authored in the HOGSEND app, not the host —
mechanics → hogsend-authoring-journeys):

```ts
// "When signup occurs → wait 2 days → if no project created, send nudge"
import { days } from "@hogsend/core";
import { defineJourney, sendEmail } from "@hogsend/engine";
import { Events, Templates } from "./constants/index.js";

export const onboardingNudge = defineJourney({
  meta: {
    id: "onboarding-nudge",
    name: "Onboarding nudge",
    enabled: false, // stays off until the cutover switch stage
    trigger: { event: Events.SIGNUP },
    entryLimit: "once",
    suppress: days(7),
    exitOn: [{ event: Events.PROJECT_CREATED }],
  },
  run: async (user, ctx) => {
    await ctx.sleep({ duration: days(2), label: "post-signup" });
    const { found } = await ctx.history.hasEvent({
      userId: user.id,
      event: Events.PROJECT_CREATED,
    });
    if (!found) {
      await sendEmail({
        to: user.email,
        userId: user.id,
        journeyStateId: user.stateId,
        template: Templates.ONBOARDING_NUDGE,
        journeyName: user.journeyName,
      });
    }
  },
});
```

## Loops-specific gotchas

- **Email-keyed identity.** Loops contacts are keyed on email. If the app has
  stable user ids, send BOTH on every Hogsend write so identities link
  (`linked: true` in the upsert result confirms a merge).
- **Event property names become your journey vocabulary.** Journeys'
  `trigger.where` matches `eventProperties` keys — keep names stable across the
  rewrite, or update both sides together.
- **Template content is GUI-side.** Export each template's content from the
  Loops editor; you are re-authoring it as react-email, not copying HTML
  verbatim (use the Hogsend app's `src/emails/_components/` chrome).
- **Loops' unsubscribe is per-mailing-list + global.** Map list-level
  unsubscribes to `hs.lists.unsubscribe({ list, email })` and global ones to
  the admin preferences route (`unsubscribedAll`) — see `cutover-checklist.md`.
