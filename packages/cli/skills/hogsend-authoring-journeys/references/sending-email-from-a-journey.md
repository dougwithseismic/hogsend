# Sending email from a journey

`sendEmail()` is a **standalone import from `@hogsend/engine`** — it is NOT a
method on `ctx`. It renders the template, checks the user's email preferences,
rewrites links + injects the open pixel (tracking), writes the `email_sends` row,
and hands off to the provider. You just call it with a template key and props.

```ts
import { defineJourney, sendEmail } from "@hogsend/engine";
import { Events, Templates } from "./constants/index.js";

export const welcome = defineJourney({
  meta: { /* ... */ },
  run: async (user, ctx) => {
    await sendEmail({
      to: user.email,                         // recipient
      userId: user.id,                        // external id (for prefs + tracking)
      journeyStateId: user.stateId,           // attributes the send to THIS run
      template: Templates.ACTIVATION_WELCOME, // a key from your emails registry
      subject: "Welcome — let's get you set up",
      journeyName: user.journeyName,          // shows on the send record / tags
      props: { firstName: user.properties.firstName }, // template props (optional)
    });
  },
});
```

## The options (`SendEmailOptions`)

```ts
interface SendEmailOptions {
  to: string;                          // required — recipient email
  userId: string;                      // required — external user id
  template: string;                    // required — registry key (use Templates.*)
  subject: string;                     // required
  journeyName?: string;                // attribution label (defaults to template)
  journeyStateId?: string;             // pass user.stateId to tie to this run
  props?: Record<string, unknown>;     // props handed to the template component
}
```

`name` is auto-derived if you don't pass it: `props.firstName` → `props.name` →
the local-part of the email → `"there"`. So a template that renders `{name}`
always has something. Pass `firstName` in `props` for a real name.

## The result (`SendEmailResult`)

```ts
interface SendEmailResult {
  emailSendId: string;   // id of the email_sends row — keep it if you need to correlate
  sentAt: string;        // ISO timestamp
}

const { emailSendId, sentAt } = await sendEmail({ /* ... */ });
```

## Template keys must exist in your registry

`template` is a `Templates.*` constant from your `src/journeys/constants/`. Each
key must resolve to a real template in `src/emails/` — the constant value (e.g.
`"activation/welcome"`) is the registry key. If you send a new email, first add:

1. the template component + registry entry under `src/emails/`,
2. the matching `Templates` key in `src/journeys/constants/`,

then reference it here as `Templates.YOUR_KEY`. A mismatched key fails at render
time, not compile time, so keep them in lockstep.

## Preferences, tracking, and idempotency

- `sendEmail` checks the user's email preferences internally; an unsubscribed
  user is not emailed. You do not need to gate it — though after a long
  `ctx.sleep` it is good practice to branch on `ctx.guard.isSubscribed()` first
  (see `references/branch-on-engagement.md`).
- Link-click + open tracking is applied automatically by the engine mailer —
  you get it regardless of which provider is configured.
- `sendEmail` is **not** itself deduped — calling it twice sends twice. Guard
  repeat sends with `ctx.history.email({ email, template })` when a journey can
  re-run a step.

For SMS / push / Slack, import the relevant standalone sender — those are also
plain function imports, never on `ctx`.
