---
name: hogsend-extending
description: Use when extending a Hogsend app beyond journeys/emails/buckets — swapping the email or analytics provider behind its engine-owned contract (EmailProvider / PostHogService), wiring an outbound integration (Slack, a CRM, Stripe) as plain code called from a journey, or deciding when to publish a reusable @hogsend/plugin-* package. Covers the two categories of extension and where each is wired.
license: MIT
metadata:
  author: withSeismic
  version: "1.0.0"
---

# Extending Hogsend

There are **two** ways to extend a Hogsend app, and they are different
mechanisms — don't reach for the wrong one.

1. **Capability providers** (email, analytics). The engine itself drives these,
   so each has an **engine-owned contract** you implement and swap behind.
   `EmailProvider` and `PostHogService` are defined in `@hogsend/core` and
   re-exported from `@hogsend/engine` (the canonical import). You supply an
   implementation via `createHogsendClient({ email: { provider }, analytics })`
   and the engine routes to it — including inbound provider webhooks.
   `@hogsend/plugin-resend` and `@hogsend/plugin-posthog` are the **bundled
   defaults and reference implementations**; you only swap when you want a
   different vendor. → `references/swap-a-provider.md`.

2. **Integrations** (everything you call *out* to — Slack, a CRM, Stripe, an
   internal HTTP API). **No contract, no framework.** Install the SDK, write a
   thin wrapper in your own `src/lib/`, import it into a journey, and call it like
   a function. The engine never sees it. → `references/build-an-integration.md`.

**The deciding question: does the engine call it, or do you?** If the engine
drives the capability (sending mail, capturing analytics) it's a provider behind
a contract. If your journey reaches outward, it's a plain integration.

## Swapping a capability provider — the short version

- **Implement the contract.** `import type { EmailProvider } from "@hogsend/engine"`
  — four methods: `send`, `sendBatch`, `verifyWebhook`, `parseWebhook`. The
  reference implementation to copy is `packages/plugin-resend/src/provider.ts`
  (`createResendProvider`).
- **Wire it.** `createHogsendClient({ email: { templates, provider: createMyProvider(...) } })`.
  Analytics is a **top-level** option (the engine itself fires captures):
  `createHogsendClient({ analytics: createMyAnalytics(...) })`.
- **You get everything else for free.** Template rendering, link-click + open
  tracking, preference/suppression checks, the frequency cap, and the
  `email_sends` row all live in the engine's `createTrackedMailer` — never in the
  provider. They come along regardless of which provider you supply.
- **Defaults.** Pass nothing and you get Resend (built from `RESEND_API_KEY`) +
  PostHog (from `POSTHOG_API_KEY`). Inbound delivery webhooks land at the
  engine-owned route `POST /v1/webhooks/resend`.
- ⚠️ The contract's `SendEmailOptions` imports from `@hogsend/core` (or
  `@hogsend/plugin-resend`), **not** `@hogsend/engine` — the engine's own
  `SendEmailOptions` is a different, higher-level send type.

## Wiring an integration — the short version

- Install the SDK; write `src/lib/<service>.ts` exporting a
  `create<Service>(config)` factory that **validates config at construction, not
  at import** (so tests don't blow up on a missing env var).
- Import it into a journey and call it: `await slack.sendMessage({ ... })`. It's a
  function call, **not** `ctx.sendMessage` — `ctx` is orchestration-only.
- Heavy or background work (a nightly CRM sync, a fan-out import) → author a
  Hatchet task in `src/workflows/` and register it via
  `createWorker({ extraWorkflows })`.

## When to publish a `@hogsend/plugin-*` package

Almost never from a scaffolded app. A standalone module in your `src/` is the
right default. Author and publish a real `@hogsend/plugin-*` package only when an
integration is **reusable across multiple apps** or you intend to **contribute it
back to the engine** — that is engine-development work done in a clone of the
Hogsend monorepo, not in your client app.

## What NOT to do

- **Don't put a service on `ctx`.** `ctx` is durable-orchestration primitives only
  (`sleep`, `checkpoint`, `trigger`, `guard`, `history`, `posthog`, `identify`).
- **Don't reach for a provider contract for a one-directional call** — that's an
  integration (just code).
- **Don't import the `EmailProvider`/`PostHogService` contract from a
  `@hogsend/plugin-*` package** in new code — use `@hogsend/engine` (canonical).
  The plugins still re-export the contracts for back-compat, but new code should
  import from the engine.
