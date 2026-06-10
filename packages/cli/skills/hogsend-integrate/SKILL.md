---
name: hogsend-integrate
description: Use when wiring an EXISTING product codebase — Next.js (App or Pages Router), Express, Hono, Remix, SvelteKit, or any Node server — to a running Hogsend instance via @hogsend/client. The outside-in playbook — detect the host stack, find the signup/auth/billing seams (better-auth, Clerk, Supabase, Stripe, NextAuth), install @hogsend/client, add contacts.upsert on signup + events.send on key actions + emails.send for transactional, wire HOGSEND_API_URL/HOGSEND_API_KEY env, then verify ingestion with `hogsend events`. NOT for code inside a Hogsend app itself (there, use hogsend-client-sdk for app code or the authoring skills for journeys/emails) and NOT for migrating off Loops/Customer.io/Resend Broadcasts (that is hogsend-migrate).
license: MIT
metadata:
  author: withSeismic
  version: "1.0.0"
---

# Integrate a host app with Hogsend

This skill drives the **outside-in** flow: you are working in someone's PRODUCT
codebase (a SaaS app, a marketing site backend — NOT a Hogsend app), and the
goal is to wire it to a running Hogsend instance so that signups become
contacts, key actions become events (which trigger journeys), and transactional
sends go through Hogsend's tracked pipeline.

The shape of the work: **detect the stack → find the seams → wire the client →
add the calls → verify ingestion.** Confirm the seams with the user before
editing; everything else is mechanical.

## Step 0 — orientation guard (am I in the right codebase?)

Check `package.json` first. If it depends on `@hogsend/engine` — or the project
has `src/journeys/` + `src/emails/` — you are INSIDE a Hogsend app, and this
skill does not apply:

- App code inside a Hogsend app → the **hogsend-client-sdk** skill (the
  scaffold already ships a preconfigured `hs` at `src/lib/hogsend.ts`).
- Journeys / emails / lists / webhook sources → the **hogsend-authoring-\***
  skills.

This skill targets the HOST product. The only Hogsend dependency you will add
here is `@hogsend/client`.

## Step 1 — detect the stack

Probe, don't ask. Each framework decides where server-side code lives and where
the shared client module goes (full wiring per framework →
`references/framework-recipes.md`):

| Probe | Stack | Server-side code lives in |
|---|---|---|
| `next.config.*` + `app/` (or `src/app/`) | Next.js App Router | route handlers `app/**/route.ts`, server actions |
| `next.config.*` + `pages/api/` | Next.js Pages Router | `pages/api/**` |
| `express` dep + `app.post(`/`router.post(` | Express | route handlers, middleware |
| `hono` dep + `new Hono(` | Hono | route handlers |
| `@remix-run/*` (or `react-router` v7 framework mode) | Remix | `action`/`loader` exports |
| `@sveltejs/kit` dep | SvelteKit | `src/routes/**/+server.ts`, `+page.server.ts`, `src/lib/server/` |

**The one rule that never changes: the client is server-only.** `HOGSEND_API_KEY`
must NEVER reach the browser bundle — no `NEXT_PUBLIC_`/`VITE_`/`PUBLIC_`
prefixes, no client-component imports. Fire events from route handlers, server
actions, API routes, and webhooks.

## Step 2 — find the signup/auth/billing seams

Grep for the places identity is created and money changes hands. Report what you
find as a short table and **confirm with the user before editing**. Detection
greps + a wired snippet per provider → `references/auth-billing-seams.md`:

| Seam | Grep for |
|---|---|
| better-auth | `betterAuth(`, `databaseHooks` |
| Clerk | `clerkMiddleware`, a webhook handler verifying `svix-*` headers |
| Supabase Auth | `supabase.auth.signUp`, `auth.admin`, auth webhook handlers |
| NextAuth / Auth.js | `NextAuth(`, `events:` (esp. `createUser`) |
| Stripe | `stripe.webhooks.constructEvent`, `checkout.session.completed`, `customer.subscription.` |
| Hand-rolled | `signup`/`register` route handlers, `INSERT INTO users`, ORM `user.create` |

Also note: if the team prefers zero host-code for a provider, Hogsend itself
ships **inbound webhook presets** for Clerk/Supabase/Stripe/Segment (point the
provider's webhook at the Hogsend instance's `POST /v1/webhooks/{clerk,supabase,stripe,segment}`,
set the secret env on the HOGSEND side). Host-side `@hogsend/client` calls and
Hogsend-side presets are alternatives — don't double-fire the same event.

## Step 3 — wire the client (one shared server module)

```bash
pnpm add @hogsend/client        # or npm i / yarn add — never hand-edit versions
```

Create ONE server-only module exporting a singleton (placement per framework in
`references/framework-recipes.md`; e.g. `lib/hogsend.ts`, or
`hogsend.server.ts` where the framework enforces server-only by suffix):

```ts
// lib/hogsend.ts — server-only. Do not import from client components.
import { Hogsend } from "@hogsend/client";

export const hogsend = new Hogsend({
  baseUrl: process.env.HOGSEND_API_URL!,
  apiKey: process.env.HOGSEND_API_KEY!,
});
```

**Host-app env convention** (add to `.env` + the project's env example file):

```bash
HOGSEND_API_URL=https://hogsend.your-company.com   # the Hogsend API base URL
HOGSEND_API_KEY=hsk_...                            # ingest-scoped data-plane key
```

The key needs the `ingest` scope (or `full-admin`, which implies it) — minted in
the Hogsend app. These names match what the `hogsend` CLI reads, so verification
(Step 5) works with the same env. Do NOT conflate with the Hogsend app's own
internal `API_PUBLIC_URL` — that var belongs inside the scaffolded Hogsend app,
not the host.

## Step 4 — add the calls at the seams

Three call patterns cover almost every integration (full SDK surface, identity
rules, and error types → the **hogsend-client-sdk** skill):

```ts
import { hogsend } from "../lib/hogsend.js";

// 1. Signup → upsert the contact
await hogsend.contacts.upsert({
  email: user.email,
  userId: user.id,                          // your stable external id
  properties: { name: user.name, plan: "free" },
});

// 2. Key actions → send events (these trigger journeys on the Hogsend side)
await hogsend.events.send({
  userId: user.id,
  name: "subscription_started",
  eventProperties: { plan: "pro", amount: 49 },   // facts about THIS event
  contactProperties: { plan: "pro" },             // durable facts, merged onto the contact
  idempotencyKey: stripeEvent.id,                 // dedupes webhook retries
});

// 3. Transactional → send through Hogsend's tracked pipeline
await hogsend.emails.send({
  to: user.email,                                 // or userId: user.id
  template: "password-reset",                     // a key from the HOGSEND app's registry
  props: { resetUrl },
});
```

Rules that matter:

- **Every write needs an identity** — at least one of `email` / `userId`.
- **The property-bag split:** `eventProperties` describe the event and are what
  journey `trigger.where`/`exitOn` rules evaluate; `contactProperties` merge
  onto the contact. Don't conflate them.
- **Idempotency on webhook-driven sends:** pass the provider's event id (e.g.
  the Stripe event id) as `idempotencyKey` so retries don't double-ingest.
- **`template` keys live in the Hogsend app**, not the host — list what exists
  before wiring a send (ask the user, or check the Hogsend app's
  `src/emails/registry.ts`). A new template is authored on the Hogsend side
  (the **hogsend-authoring-emails** skill).
- **Hot paths:** `events.send` returns 202 once stored. Don't let analytics
  block a signup response — catch and log, or fire-and-forget with an error
  handler. Catch `RateLimitError` (has `retryAfter` seconds) and
  `HogsendAPIError` (`status === 0` = transport failure) from
  `@hogsend/client`. If you pass `lists`, check the result's `listsError`.

Pick 3-5 high-signal events (signup, activation moment, subscription started/
cancelled) over instrumenting everything — journeys trigger on these names, so
agree the event names with the user and keep them stable.

## Step 5 — verify the loop end-to-end

Use the `hogsend` CLI against the same instance (`HOGSEND_API_URL` is read from
env; full transcript → `references/verification.md`):

```bash
# 1. Fire a test event through the data plane (or trigger the real code path)
hogsend events send signup --user-id test_agent_$(date +%s) --prop source=integration-test --json

# 2. Confirm it was stored (admin key required for the read path)
hogsend events <that-user-id> --json
```

`stored: true` on the send + the event appearing in the read = the pipe works.
Then exercise the REAL seam (sign a test user up, replay a Stripe test webhook)
and confirm the same way. Fallbacks: `hogsend doctor --json` (instance health),
`hogsend contacts get <userId> --json` (contact landed), and Studio's contacts
view on the Hogsend instance.

## What happens on the Hogsend side

Wiring the host is half the story — events only DO something when a journey
triggers on them. Defining journeys/templates/lists happens in the Hogsend app:
**hogsend-authoring-journeys**, **hogsend-authoring-emails**,
**hogsend-authoring-lists**. For the complete `@hogsend/client` API surface, the
**hogsend-client-sdk** skill.

## Task playbooks — load the matching reference

- **Per-framework wiring (module placement, route-handler examples, env
  loading)** → `references/framework-recipes.md`
- **Per-provider seam detection + wired snippets (better-auth, Clerk, Supabase,
  Stripe, NextAuth)** → `references/auth-billing-seams.md`
- **The verification transcript (CLI flags, expected output, failure
  triage)** → `references/verification.md`
