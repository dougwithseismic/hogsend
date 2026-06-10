# Resend Broadcasts/Audiences → Hogsend mapping

Audit greps, the concept table, and rewrites for a codebase using Resend's
Broadcasts + Audiences + Contacts APIs. Resend's API may differ by SDK version —
treat the left-hand column as "look for", and verify against the project's
actual calls.

**The special case first: Resend can stay.** Hogsend's default `EmailProvider`
IS Resend (`@hogsend/plugin-resend`) — the same `RESEND_API_KEY` keeps
delivering the mail. This migration replaces the ORCHESTRATION layer (who
decides what to send to whom, when) — broadcasts, audiences, contact state —
not necessarily the wire. That makes it the lowest-risk migration of the three:
deliverability, domains, and DKIM are already proven.

## Audit greps (code half)

```bash
grep -rn "resend" package.json
# The orchestration surface being migrated:
grep -rn "resend.broadcasts\.\|resend.audiences\.\|resend.contacts\." src/
# Plain transactional — DISTINCT, may stay on resend.emails.send or move:
grep -rn "resend.emails.send" src/
grep -rn "RESEND_API_KEY\|RESEND_AUDIENCE" . --include="*.env*" --include="*.ts"
```

GUI half (from the Resend dashboard): audiences + contact counts, broadcast
history + their content, unsubscribed contacts per audience, and the verified
sending domains (these carry over untouched when Resend stays the provider).

## Concept mapping

| Resend concept | Hogsend equivalent | Notes |
|---|---|---|
| Audience | list — `defineList({ id, name, defaultOptIn })` | Resend audiences are explicit-membership mailing lists → almost always opt-in (`defaultOptIn: false`) |
| Contact (in an audience) | contact + list membership — `hs.contacts.upsert({ email, properties?, lists: { "<list-id>": true } })` | `firstName`/`lastName` → `properties`; `unsubscribed: true` contacts → suppression import (see `cutover-checklist.md`) |
| Broadcast | campaign — `hs.campaigns.send({ list, template, props })` | Or `hogsend campaigns send --list <id> --template <key>`. Content becomes a four-file react-email template |
| `resend.emails.send` (transactional) | EITHER keep as-is (it still works) OR move to `hs.emails.send` | Moving buys first-party open/click tracking, preference/suppression checks, send history, and journey attribution — recommended, not required |
| Scheduled broadcast | campaign triggered when you want it | A campaign sends on enqueue; schedule via your own cron/workflow if needed |
| (No workflow product) | journeys — `defineJourney()` | Net-new capability, not a port. Teams on Resend Broadcasts usually hand-rolled drip logic in app code — grep for `setTimeout`/cron-driven email sends worth replacing with journeys |

## Before / after

Audience + contact management (host product code):

```ts
// BEFORE (Resend — shapes vary by SDK version)
await resend.contacts.create({
  email: "ada@example.com",
  firstName: "Ada",
  audienceId: NEWSLETTER_AUDIENCE_ID,
});

// AFTER (@hogsend/client) — list defined once in the Hogsend app via
// defineList({ id: "newsletter", name: "Newsletter", defaultOptIn: false })
import { hogsend } from "../lib/hogsend.js";

await hogsend.contacts.upsert({
  email: "ada@example.com",
  userId: user.id,
  properties: { firstName: "Ada" },
  lists: { newsletter: true },
});
// (or, membership alone: hogsend.lists.subscribe({ list: "newsletter", email: "ada@example.com" }))
```

Broadcast → campaign:

```ts
// BEFORE: a broadcast created in the Resend dashboard / broadcasts API

// AFTER — template authored in the Hogsend app first
// (four-file contract → hogsend-authoring-emails skill)
const { campaignId } = await hogsend.campaigns.send({
  list: "newsletter",
  template: "june-update",
  props: {},
  name: "June update",
});
// Poll progress: await hogsend.campaigns.get(campaignId)
// CLI: hogsend campaigns send --list newsletter --template june-update
//      hogsend campaigns status <campaignId> --json
```

Transactional, if moving (optional but recommended):

```ts
// BEFORE (Resend direct)
await resend.emails.send({
  from: "Acme <hello@acme.com>",
  to: "ada@example.com",
  subject: "Reset your password",
  html: renderedHtml,
});

// AFTER — Hogsend renders the react-email template, applies tracking +
// preference checks, records the send, THEN delivers via the same Resend key
await hogsend.emails.send({
  to: "ada@example.com",
  template: "password-reset",
  props: { resetUrl },
});
```

## Resend-specific gotchas

- **Don't double-manage contacts.** Once Hogsend owns the audience (as a
  list), stop writing to `resend.audiences`/`resend.contacts` — Hogsend's
  provider integration uses Resend purely as a send wire, not as a contact
  store.
- **Unsubscribes move to Hogsend.** Hogsend injects its own unsubscribe/
  preference links and stores state in its `email_preferences`. Import Resend's
  per-audience unsubscribed contacts BEFORE the first campaign
  (`cutover-checklist.md`), and stop relying on Resend-side unsubscribe state
  afterward.
- **Domains/DKIM carry over** when Resend stays the provider — verify
  `RESEND_API_KEY` (and the from-address envs) are set on the Hogsend
  deployment, then nothing else changes on the deliverability side.
- **Broadcast HTML is re-authored**, not pasted: rebuild as a react-email
  component using the Hogsend app's `src/emails/_components/` chrome so
  tracking + unsubscribe slots work.
