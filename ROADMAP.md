# Roadmap

Five long-running tracks, each with a standing pool of issues you can pick up without waiting on a maintainer. This replaces the May 2026 pre-launch checklist that used to live in the issue tracker.

Every roadmap issue carries the contract it implements, pointers to shipped reference implementations, and an acceptance checklist. If an issue is missing one of those, say so on the issue and we'll fix it.

## How to pick up work

1. Browse a track label below, or start from [`good first issue`](https://github.com/dougwithseismic/hogsend/issues?q=is%3Aissue+is%3Aopen+label%3A%22good+first+issue%22).
2. Comment on the issue to claim it before you start.
3. Issues labeled [`maintainer-led`](https://github.com/dougwithseismic/hogsend/issues?q=is%3Aissue+is%3Aopen+label%3Amaintainer-led) touch engine semantics (replay-safety, identity, delivery guarantees) — align on approach in the issue before writing code.
4. [CONTRIBUTING.md](CONTRIBUTING.md) covers setup and PR expectations. Questions: [Discord](https://discord.gg/rv6eZNvYrr).

## Why these tracks

PostHog Workflows, Resend Automations, and Loops all do hosted lifecycle automation. Hogsend's claims are the ones a dashboard product can't copy:

1. **Journeys live in your repo.** Typed TypeScript, code-reviewed, versioned, editable by agents (MCP server, blueprints, promote-to-code).
2. **You run it and you own the wire.** Self-hosted, BYO provider behind neutral contracts, first-party open/click tracking that no provider switch takes away.
3. **Journeys prove revenue.** Attribution, event-native funnels, and incrementality ship in the engine — not in a separate BI tool.

Each track below strengthens one of those claims.

## Track 1 — Providers & integrations ([`track: providers`](https://github.com/dougwithseismic/hogsend/issues?q=is%3Aissue+is%3Aopen+label%3A%22track%3A+providers%22))

The engine is provider-neutral behind contracts that each have shipped reference implementations:

| Contract | Definition | Shipped references |
| --- | --- | --- |
| `EmailProvider` | `packages/core/src/providers/email.ts` | `plugin-resend`, `plugin-postmark` |
| `SmsProvider` | `packages/core/src/providers/sms.ts` | `plugin-twilio` |
| `AnalyticsProvider` | `packages/core/src/providers/analytics.ts` | `plugin-posthog` |
| CRM | `packages/core/src/providers/crm.ts` | `plugin-attio`, `plugin-hubspot`, `plugin-ghl` |
| Conversion destination | `packages/core/src/providers/conversion-destination.ts` | `plugin-meta-capi` |
| Connector | `packages/engine/src/connectors/define-connector.ts` | `plugin-discord`, `plugin-telegram` |
| Webhook source preset | `packages/engine/src/webhook-sources/presets/` | Stripe, Clerk, Supabase, Segment |

A new provider is a bounded clone-and-adapt package: implement the contract, keep the wire dumb (the engine owns rendering, preferences, tracking, and send records), normalize webhooks, fail closed on unverifiable signatures. Wanted next: SendGrid, SES, and Mailgun email; Vonage and Telnyx SMS; Mixpanel and Amplitude analytics; Pipedrive and Close CRM; Google Ads and LinkedIn conversion destinations; a Slack connector; GitHub, Linear, and Cal.com webhook presets; and a conformance test kit so plugin PRs verify themselves.

## Track 2 — Push channel ([`track: push`](https://github.com/dougwithseismic/hogsend/issues?q=is%3Aissue+is%3Aopen+label%3A%22track%3A+push%22))

Email and SMS are first-class channels with the full pipeline: preferences, suppression, tracking, test mode, replay-safe journey helpers. Push is the missing third channel. The SMS architecture (`docs/sms.md`) is the blueprint: a `PushProvider` contract, a tracked send pipeline, `sendPush` + `ctx.history.push`, then Web Push (VAPID) and FCM reference providers.

## Track 3 — Run anywhere ([`track: portability`](https://github.com/dougwithseismic/hogsend/issues?q=is%3Aissue+is%3Aopen+label%3A%22track%3A+portability%22))

Self-hosting is a core claim, so the operational footprint has to shrink. Hatchet is currently the only supported workflow engine and the largest piece of that footprint. Work here: a `WorkflowEngine` adapter boundary that preserves replay semantics, Inngest and DBOS adapter spikes, plain-Postgres support verified in CI, a production single-box docker-compose guide, and more deploy targets (Fly.io, Coolify) alongside Railway.

## Track 4 — Front door ([`track: dx`](https://github.com/dougwithseismic/hogsend/issues?q=is%3Aissue+is%3Aopen+label%3A%22track%3A+dx%22))

The path from "found the repo" to "journeys running against my app" — `create-hogsend`, the `hogsend` CLI, `@hogsend/js` / `@hogsend/react`, docs recipes. Work here: SDK parity with the REST API, a full-stack example app in `examples/`, and a first-class path for adding Hogsend to an existing app rather than scaffolding a new one.

## Track 5 — Studio observability ([`track: studio`](https://github.com/dougwithseismic/hogsend/issues?q=is%3Aissue+is%3Aopen+label%3A%22track%3A+studio%22))

Studio observes; it does not author. Journeys, campaigns, deals, attribution, and funnels have views today. Work here: SMS operations (sends, consent, suppressions), a DLQ and alerts ops surface, and a holdout/lift readout for the incrementality data the engine already exposes.

## Not on the roadmap

- **A multi-tenant hosted cloud.** Hogsend is an engine you run. Managed single-tenant hosting exists as a service, not as a product fork.
- **Visual journey authoring.** Journeys are code. Studio renders and observes them; it will not grow a drag-and-drop editor.
- **Ad campaign management.** Conversion forwarding (Meta CAPI, Google Ads, LinkedIn) is in scope; audience sync and bid management belong to PostHog's CDP and the ad platforms.
