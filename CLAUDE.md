# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

**Hogsend** — code-first, agentic-ready lifecycle orchestration engine for teams on PostHog + Resend. Turborepo monorepo using pnpm workspaces. Full product spec lives in `docs/product-spec.md`.

## Commands

```bash
pnpm dev              # Start API via Turbo (port 3002)
pnpm build            # Build all packages/apps via Turbo
pnpm lint             # Biome check (linting + formatting)
pnpm lint:fix         # Biome auto-fix
pnpm format           # Biome format --write
pnpm check-types      # TypeScript type-checking across all workspaces

# Run API workspace directly
pnpm --filter @hogsend/api dev

# API only (from apps/api)
cd apps/api && pnpm dev         # tsx watch with .env
cd apps/api && pnpm build       # tsup → dist/

# Worker (from apps/api)
cd apps/api && hatchet worker dev              # Hatchet CLI with hot-reload (recommended for dev)
cd apps/api && pnpm worker:dev                 # tsx watch without Hatchet CLI
cd apps/api && pnpm worker                     # production: node dist/worker.js

# Tests (vitest, API workspace only)
cd apps/api && pnpm test        # vitest run (single pass)
cd apps/api && pnpm test:watch  # vitest watch mode

# Database (from packages/db)
cd packages/db && pnpm db:generate    # generate migration from schema changes
cd packages/db && pnpm db:migrate     # run migrations
cd packages/db && pnpm db:push        # push schema directly (dev shortcut)
cd packages/db && pnpm db:studio      # Drizzle Studio GUI

# First-time setup (Docker, deps, env; auto-remaps busy host ports)
pnpm bootstrap                  # runs scripts/bootstrap.sh

# Infrastructure (TimescaleDB, Redis, Hatchet-Lite)
docker compose up -d            # Start postgres, redis, hatchet-lite
```

## Architecture

### Monorepo layout

Hogsend is a **versioned engine consumed as a dependency**, not a fork. The framework lives in `@hogsend/engine`; `apps/api` is a thin **content-only** consumer that wires its journeys/templates/webhook-sources into the engine's factories. New apps are scaffolded with `pnpm dlx create-hogsend@latest`.

- **packages/engine** — the framework (`@hogsend/engine`): `createHogsendClient`, `createApp`, `createWorker`, `defineJourney`, `defineWebhookSource`, the ingestion + tracking pipeline, the engine-owned `createTrackedMailer`, all built-in routes + middleware, and the registries. This is the public API surface and the committed semver boundary.
- **apps/api** — the dogfood **consumer** app: content only (journeys, webhook-sources, workflows, `src/emails/` templates, constants) plus two thin entry points (`src/index.ts` HTTP, `src/worker.ts` task execution) that call the engine factories
- **packages/core** — Journey types, Zod schemas, condition evaluation engine, duration helpers, journey registry (`@hogsend/core`)
- **packages/db** — Drizzle ORM schema, migrations (two-track: engine + client), and seed (`@hogsend/db`). Exports raw `.ts` — no build step, bundled by consumers via tsup `noExternal`
- **packages/email** — render machinery only (`@hogsend/email`): `renderToHtml`/`renderToPlainText`, `getTemplate`/`createRegistry`, the `TemplateRegistry`/`TemplateDefinition` types + open `TemplateRegistryMap` (module-augmented by consumers), unsubscribe token/URL helpers. Concrete templates are NOT here — they live in the consumer's `src/emails/`
- **packages/plugin-posthog** — PostHog person property fetching (with Redis cache), event capture (`@hogsend/plugin-posthog`)
- **packages/plugin-resend** — a Resend `EmailProvider` (`createResendProvider`, the reference implementation). The provider is a provider-neutral, dumb wire: `send()`/`sendBatch()` take **HTML strings** (never React) and return `{ id }`, and `verifyWebhook()`/`parseWebhook()` normalize Resend's verbatim webhook into a provider-neutral `EmailEvent`. Rendering (React → HTML), tracking, preference checks, and the `email_sends` write all live in the engine's `createTrackedMailer`, not here (`@hogsend/plugin-resend`)
- **packages/plugin-postmark** — a Postmark `EmailProvider` (`createPostmarkProvider`): same provider-neutral contract (HTML-only `send`/`sendBatch`, `EmailEvent`-normalizing webhooks). Opt-in (Resend stays the default); activate with `EMAIL_PROVIDER=postmark` or `email.defaultProvider: "postmark"`. Forces provider-native open/click tracking OFF per send (`capabilities.nativeTracking: false`); HTTP-Basic webhook auth, fail-closed when unconfigured (`@hogsend/plugin-postmark`)
- **packages/create-hogsend** — the `create-hogsend` scaffolder (copies `template/`, substitutes `{{APP_NAME}}`/`{{ENGINE_VERSION}}`)
- **packages/cli** — `@hogsend/cli` (Node): `eject`/`patch` today; the planned home for the consolidated `hogsend` CLI
- **packages/typescript-config** — Shared tsconfig bases (`@repo/typescript-config`)

### Engine factories (packages/engine) + the thin consumer (apps/api)

The engine exposes a dependency-injection client and app/worker factories; the consumer (`apps/api`) wires content into them. All of the following live in `packages/engine/src/`:

- `env.ts` — `@t3-oss/env-core` validates env vars at startup (DATABASE_URL, BETTER_AUTH_SECRET required). `RESEND_API_KEY` is optional (a Postmark-only deploy needs no Resend key). `EMAIL_PROVIDER` selects the active provider id (defaults to `resend`); `EMAIL_FROM` is the neutral default-from (falls back to `RESEND_FROM_EMAIL`)
- `container.ts` — `createHogsendClient(opts?)` builds the DI client: `{ env, logger, db, dbClient, auth, emailService, emailProviders, emailProvider, templates, analyticsProviders, analytics, registry, hatchet, clientJournal }`. Options: `{ journeys?, email?: { provider?, providers?, defaultProvider?, templates? }, analytics?, enabledJourneys?, clientJournal?, overrides? }` — email config is grouped under `email`: register one (`provider`) or many (`providers`) `EmailProvider`s and pick the active one with `defaultProvider` (env-presets, `providers`, then `provider` merge consumer-last). The engine owns the cohesive templates→render→preferences→tracking→`email_sends` pipeline; the `EmailProvider` is only the swappable wire. `client.emailProviders` is the container-held `EmailProviderRegistry` (keyed by `meta.id`); `client.emailProvider` is the resolved active one injected into the mailer. An unresolvable `defaultProvider` throws at boot. `analytics` is top-level because the engine itself uses it — provider-neutral since the `AnalyticsProvider` contract (`@hogsend/core`, authored via `defineAnalyticsProvider`): accepts a group `{ provider?, providers?, defaultProvider? }` mirroring `email` (env preset = PostHog when `POSTHOG_API_KEY` is set; `ANALYTICS_PROVIDER` picks the active id), a bare `AnalyticsProvider`, or (deprecated) a legacy `PostHogService` which gets adapter-wrapped. `client.analyticsProviders` is the registry; `client.analytics` the resolved active provider (identity PULL + `setPersonProperties` writes + capture). PostHog person READS need `POSTHOG_PERSONAL_API_KEY` (the phc_ project key is write-only by PostHog's design; reads soft-fail to contact-property fallbacks without it — surfaced once at boot). Other channels (SMS/push/Slack) are plain functions, not options. `overrides` is a small advanced/test-only hatch (`{ mailer?, auth?, hatchet?, db? }`). Returns the `HogsendClient`; set on every request via Hono middleware, read with `c.get("container")` in handlers
- `app.ts` — `createApp(client, { routes?, middleware?, webhookSources?, onError? })` creates the OpenAPIHono app with the middleware stack (secureHeaders, CORS, compress, requestId, request logging, error handler). Auth mounts at `/api/auth/*`; OpenAPI docs/Scalar UI at `/openapi.json` + `/docs` in non-production. Built-in v1 routers (health, ingest, email unsubscribe/preferences, admin, tracking click/open, webhooks) are registered by the engine; the consumer injects only `webhookSources`
- Routes use `createRoute()` + `OpenAPIHono.openapi()` with Zod schemas for request/response validation

`AppEnv` type defines Hono context variables: `{ container, requestId, user, session }` (`container` holds the `HogsendClient`).

The consumer's `apps/api/src/index.ts` is essentially `createApp(createHogsendClient({ journeys, email: { templates } }), { webhookSources })` behind a schema boot-guard; `worker.ts` is `createWorker({ container, journeys })`.

When adding a new built-in route (engine work): define Zod schemas, create the route with `createRoute()`, implement the handler with `.openapi()`, register it in the engine's `routes/index.ts`.

### Hatchet (workflow/task orchestration)

Hatchet handles durable task execution — email sends, journey orchestration, background jobs. The API and worker are separate processes sharing the same codebase:

- **API process** (`src/index.ts`) — serves HTTP, pushes events to Hatchet via `hatchet.events.push()`
- **Worker process** (`src/worker.ts`) — long-running process that executes Hatchet tasks. `createWorker({ container, journeys, enabledJourneys?, extraWorkflows? })` registers the engine's built-in tasks (`sendEmailTask`, `importContactsTask`, `checkAlertsTask`) + all enabled journey tasks + any `extraWorkflows` you pass. Graceful shutdown (SIGTERM/SIGINT) via `worker.stop()`
- **Event-driven routing** — journey tasks declare `onEvents: [trigger.event]` on their Hatchet durable task; the API pushes events and Hatchet routes them to matching tasks automatically
- **Built-in workflows** live in `packages/engine/src/workflows/` (`send-email.ts`, `import-contacts.ts`, `check-alerts.ts`). Consumers add their own custom tasks in their `src/workflows/` and pass them via `extraWorkflows`
- **`hatchet.yaml`** — CLI config for `hatchet worker dev` (run command, watch patterns)

When adding a custom workflow task (consumer): define it in your `src/workflows/`, export from `src/workflows/index.ts`, and pass it to `createWorker({ ..., extraWorkflows: [...] })` in `src/worker.ts`. (The option is `extraWorkflows`, not `workflows`.)

Task input types must be JSON-serializable (extend Hatchet's `JsonObject`). Don't use `[key: string]: unknown` index signatures — use specific keys or `JsonValue`-compatible types.

### Journey system

Journeys use a code-first `defineJourney()` pattern — each journey is its own Hatchet durable task with TypeScript control flow:

- **`defineJourney({ meta, run })`** (engine: `packages/engine/src/journeys/define-journey.ts`, imported as `import { defineJourney } from "@hogsend/engine"`) — accepts `JourneyMeta` (trigger, entryLimit, exitOn, suppress) and a `run` function `(user: JourneyUser, ctx: JourneyContext) => Promise<void>`. Returns `{ meta, task }` where task is the Hatchet durable task. Includes an active-state guard that prevents concurrent enrollment in the same journey
- **Event-driven triggers** — each journey declares `onEvents: [trigger.event]`; when the ingest endpoint pushes an event, Hatchet routes it to matching journeys
- **Enrollment guards** — checked inside the task before `run()` executes, in order: (1) `meta.enabled` flag, (2) `evaluateTriggerConditions()` against event properties if `trigger.where` is set (authored as `PropertyCondition[]` OR a builder fn `(b) => b.prop("score").lte(6)` resolved once at `defineJourney` time), (3) `checkEntryLimit()` enforcing once/once_per_period/unlimited, (4) `checkEmailPreferences()` for unsubscribed users. Ineligible events return `{ status: "skipped", reason }` without creating state
- **State tracking** — on entry, a `journeyStates` row is created with status "active". On completion → "completed" + `journey:completed` event. On error → "failed" + `journey:failed` event
- **`JourneyContext`** (engine: `packages/engine/src/journeys/journey-context.ts`) provides only durable execution primitives:
  - `ctx.sleep({ duration, label? })` — Hatchet durable sleep; sets state to "waiting", resumes to "active"; returns `{ sleptAt, resumedAt }`
  - `ctx.sleepUntil(at, { label? })` — durable sleep until an absolute instant (`Date`/ISO string); same waiting→active lifecycle
  - `ctx.when` — timezone-bound fluent scheduler; builds an absolute `Date` (for `sleepUntil`) via `.next(weekday).at()`, `.nextLocal()`, `.tomorrow().at()`, `.in(duration).at()`, with `.tz()`, `.window(start,end)`, `.ifPast()` refinements. Auto-resolves the user's tz (PostHog → contact → client default → UTC; the PostHog leg needs `POSTHOG_PERSONAL_API_KEY` — the phc_ key is write-only by PostHog's design) and applies the client send window
  - `ctx.waitForEvent({ event, timeout, label? })` — Hatchet durable wait until THIS user emits `event` OR `timeout` elapses (whichever first); returns `{ timedOut, properties? }` (`properties` = the matched event's payload, best-effort scalars — branch on the answer directly). Optional `lookback` checks recent `user_events` first (covers the gap between a send/previous wait and this wait being established). Forward-looking (only events after the wait is established count — use `ctx.history.hasEvent` for "already happened"). Scopes to the user via an escaped CEL filter (`input.userId == '…'`) on the pushed payload; the timeout is the `Or` sleep branch. If the journey hits `exitOn` (or is cancelled) mid-wait, the run aborts cleanly via `JourneyExitedError` (engine sets state "exited" AND cancels the Hatchet run in `ingestEvent`/`checkExits`) — no post-wait side effects fire. Still re-check `ctx.guard.isSubscribed()` after long waits, since unsubscribe does not exit the journey
  - `ctx.checkpoint(label)` — updates `currentNodeId` in journeyStates for observability
  - `ctx.trigger({ event, userId, properties? })` — pushes event through the full ingest pipeline (stores, routes to Hatchet, processes exitOn). Enables cross-journey triggers
  - `ctx.guard.isSubscribed()` — checks if user is still subscribed (useful after long sleeps)
  - `ctx.history.hasEvent({ userId, event, within? })` — check if event occurred, returns `{ found, count }`
  - `ctx.history.journey({ userId, journeyId })` — check journey completion history, returns `{ completed, lastCompletedAt, entryCount }`
  - `ctx.history.email({ email, template })` — check email send history, returns `{ sent, lastSentAt, count }`
- **Service integrations are standalone imports**, not on the context. Email: `sendEmail()` from `@hogsend/engine` (engine `lib/email.ts`). PostHog: `getPostHog()` from `@hogsend/engine` (capture/identify/feature-flags; returns undefined without `POSTHOG_API_KEY` — there are NO ctx.identify/ctx.posthog shims on the context). All functions follow single-object-in, result-object-out pattern
- **Duration helpers** — `days()`, `hours()`, `minutes()` from `@hogsend/core` (re-exported by `@hogsend/engine`) replace magic duration strings
- **Constants** — `Events` and `Templates` live in the **consumer's** `src/journeys/constants/` — `as const` typed values replacing magic strings. `Templates` keys must match the consumer's `src/emails/registry.ts` + `templates.d.ts` augmentation
- **Journey registry** — `JourneyRegistry` class (from `@hogsend/core`) indexes journeys by ID and by trigger event. `ENABLED_JOURNEYS` env var (comma-separated IDs or `*` for all) controls which journeys are loaded
- **Replay-safety (exactly-once side effects)** — journeys are Hatchet durable tasks that replay-from-top on a worker crash / OOM / redeploy. The engine makes `sendEmail()` and `ctx.trigger()` EXACTLY-ONCE across a replay AUTOMATICALLY, with no authoring change in the common case: each is auto-keyed by the **replay-stable Hatchet run id** (NOT the freshly-minted `journeyStates.id` — on replay the engine recovers the existing enrollment by run id, so a terminal-then-replayed `unlimited`/`once_per_period` journey doesn't mint a new state row and re-send) + the nearest authored wait/checkpoint label + the templateKey/event, and that deterministic key is threaded into the existing `email_sends`/`user_events` unique-index dedup (Layer 2, version-independent) plus Hatchet's durable `memo` when the engine supports eviction (Layer 1, fast path; engine >= v0.80.0). The key is content/label-derived (never positional) so it is robust to branch + clock divergence on replay. The auto-keying lives in the tracked mailer, so even a journey calling the raw `getEmailService().send(...)` (bypassing `sendEmail()`) is covered. Exactly-once is scoped to replays of the SAME run; a distinct new run is a legitimate re-enrollment. **The ONLY authoring rule:** if you send the SAME template (or trigger the SAME event) more than once in one journey on divergent branches AND those sites share the same nearest wait label, pass a distinct `idempotencyLabel` to each (e.g. `idempotencyLabel: "nps-reminder"`). The engine THROWS a loud intra-run key-collision error if you forget, so this is caught in dev rather than silently dropping a message. If a NON-deterministic decision (LLM/RNG/time-bucket) selects the template/event (the key's discriminant), wrap it in `ctx.once(key, compute)` — it records the value in the state row once and replays it verbatim (durable on ANY engine) so a replay doesn't deliver a duplicate-but-different message. `getPostHog()?.identify()` is replay-safe ($set upsert) but prefer a recorded timestamp (the matched event's `occurredAt` from `ctx.waitForEvent`) over `new Date()`. `getPostHog()?.capture()` is NOT idempotent — avoid it in journeys. `sendConnectorAction()` (Telegram/Discord) has no Layer-2 backstop yet and can still double-send in degraded (pre-eviction) mode — a known follow-up.

When adding a new journey (consumer): add event/template constants to `src/journeys/constants/`, create a file in `src/journeys/` using `defineJourney()` (imported from `@hogsend/engine`) with duration helpers and constant imports, import it in `src/journeys/index.ts` and add to the `journeys` array. If it sends a new email, add the template to `src/emails/` (component + `registry.ts` entry + `templates.d.ts` augmentation).

### Webhook source system

Generic webhook ingestion via `defineWebhookSource()` (engine: `packages/engine/src/webhook-sources/define-webhook-source.ts`, imported from `@hogsend/engine`). Each source declares metadata, auth (header + env key), optional Zod schema for validation, and a `transform(payload, ctx) → IngestEvent | null` function. Consumers register their sources in their own `src/webhook-sources/index.ts` and pass them to `createApp(client, { webhookSources })`; they're served at `POST /v1/webhooks/:sourceId`. The transform result feeds directly into `ingestEvent()`, so any webhook source can trigger journeys.

When adding a new webhook source (consumer): create a file in your `src/webhook-sources/` using `defineWebhookSource()`, add it to `src/webhook-sources/index.ts`. Note: `email` is a reserved source id (it would shadow the email-provider webhook route, §below) — registering a source with `meta.id === "email"` throws.

### Email provider system (BYO provider)

The email layer is provider-agnostic. The `EmailProvider` contract is provider-neutral and lives in `@hogsend/core` (`packages/core/src/providers/email.ts`, re-exported by `@hogsend/engine`); author providers via `defineEmailProvider()`. A provider owns exactly two wires plus identity, and is a **dumb** wire — the engine owns render → preferences → tracking → `email_sends`:

- **`meta`** — `{ id, name, description? }`; the id keys the registry. **`capabilities`** — `{ nativeTracking?, scheduledSend?, signedWebhooks? }`
- **A send wire** — `send(SendEmailOptions)` / `sendBatch(BatchEmailItem[])` that take **HTML strings only** (never React) and return a neutral `{ id }` (`SendResult`). React Email stays first-class for template authoring AND Studio preview — the engine renders React → HTML itself (`@hogsend/email` `renderToHtml`) before calling `provider.send`. `SendEmailOptions` carries neutral `tag?`/`metadata?` (the mailer translates the engine-level `tags` array); `scheduledAt` is honored only when `capabilities.scheduledSend` (else logged + dropped — use `ctx.sleepUntil`)
- **A normalized webhook source** — `verifyWebhook({ payload, headers })` (owns its own secrets, may be async, throws on bad signature, throws `WebhookHandshakeSignal` for non-status handshakes the route 200s) / `parseWebhook(payload)` — both translate the provider's verbatim webhook into a provider-neutral **`EmailEvent`** (`{ type: EmailEventType, messageId, recipients[], occurredAt, bounce?, click?, raw }`; `EmailEventType` keeps the `email.` prefix). Provider webhooks are consumed ONLY for `delivered`/`bounced`/`complained` — opens/clicks are first-party (see Email tracking)

Providers are held in the container's `EmailProviderRegistry` (`client.emailProviders`, keyed by `meta.id`); the resolved active one is `client.emailProvider`. They're built from env presets (`emailProvidersFromEnv` — Resend when `RESEND_API_KEY` set, Postmark when `POSTMARK_SERVER_TOKEN` set) plus `opts.email.providers`/`opts.email.provider`, with `EMAIL_PROVIDER` / `email.defaultProvider` selecting the active id (default `resend`).

Provider webhooks are received at the id-dispatched route **`POST /v1/webhooks/email/:providerId`** (`packages/engine/src/routes/webhooks/email-provider.ts`), registered before the `:sourceId` catch-all. The route resolves the provider from the registry, calls `verifyWebhook`, and hands the normalized `EmailEvent` to `emailService.handleWebhook(event, providerId)`. `/v1/webhooks/resend` is kept as a deprecated thin alias.

When adding a new provider: scaffold a `packages/plugin-<name>` mirroring `plugin-resend`/`plugin-postmark`, implement `createXProvider` via `defineEmailProvider()` (HTML-only send, force native tracking off where possible, normalize webhooks to `EmailEvent`), and add an optional env preset to `emailProvidersFromEnv`. A brand-new `@hogsend/*` package's first npm publish must be manual (CI can't create it).

### SMS channel (BYO provider)

SMS is a first-class channel mirroring the email architecture. Full docs: `docs/sms.md`. **Operator opt-in**: with no provider configured the SMS service is an inert stub and `sendSms` throws — existing deploys without Twilio creds are unaffected. **Recipient opt-in (TCPA)**: the `sms` channel registers `defaultOptIn: false` — a marketing send needs an explicit `categories.sms === true` grant (lists API / SDK / preference center) OR phone-track consent (inbound START), else it fails closed with `no_consent`. Transactional sends bypass only the consent+topic gates — never the phone STOP list or `unsubscribed_all`.

- **Contract** — `SmsProvider` in `@hogsend/core` (`packages/core/src/providers/sms.ts`, `defineSmsProvider()`). A dumb wire: plain-text `send(SendSmsOptions) → { id }`, `verifyWebhook({ payload, headers, url }) → SmsEvent` (the `url` is passed because Twilio signs the public URL + form params; the route strips trailing slashes off `API_PUBLIC_URL` before building it), `parseWebhook`. `SmsEvent` types: `sms.sent | sms.delivered | sms.failed | sms.inbound`. `meta` is REQUIRED (no pre-registry back-compat).
- **Plugin** — `packages/plugin-twilio` (`createTwilioProvider`), the reference. HTML never crosses the wire. Permanent-failure classification is conservative: 21610/21614/30005/30006 auto-suppress; the transient-leaning 30003 (handset off) and 30004 (carrier content filter) deliberately do NOT. NOTE: `twilio` v6 is CommonJS — use the default import (`import twilio from "twilio"`), not named `{ Twilio }`/`{ validateRequest }` (named imports type-check but throw at runtime).
- **Templates** — `@hogsend/sms` package: empty augmentable `SmsTemplateRegistryMap`, `renderSmsToText` (React → plain text via react-email), `countSmsSegments`. Consumer authors `src/sms/` (components + `registry.ts` + `templates.d.ts`) and passes `sms: { templates }` to `createHogsendClient` in BOTH `index.ts` and `worker.ts`.
- **Engine** — `container.ts` builds `SmsProviderRegistry` + resolves the active provider (`sms.defaultProvider ?? SMS_PROVIDER ?? "twilio"`, or the sole provider when only one is registered; unresolvable explicit id throws). `createTrackedSmsSender` (`lib/sms-mailer.ts` + `lib/sms-tracked.ts`) mirrors the email pipeline: idempotency short-circuit (a re-drive wires the STORED body) → suppression/consent gate (phone STOP list + `unsubscribed_all` unconditional; consent + topic gates skipped for transactional) → SMS frequency cap → journey `meta.suppress` min-gap (SMS leg of `checkJourneySuppress`) → **link rewrite** (bare URLs → `/s/:code` short links; `SMS_LINK_TRACKING` default on, `SMS_LINK_HOST` optional branded domain) → STOP footer (skipped only when the body carries an opt-out INSTRUCTION) → test-mode redirect (container-wired: `HOGSEND_TEST_MODE=true` or `auto`+email-test-mode-armed; `HOGSEND_TEST_PHONE`) → `sms_sends` + `tracked_links` written in ONE transaction → `provider.send` → `sms.sent` outbound. `sendSms()` (`lib/sms.ts`) is the journey helper, replay-safe via the `smsSend` key kind (disjoint from email's `send`); it auto-fills `journeyStateId` from the boundary and passes the pipeline verdict through (`status`/`reason`). `ctx.history.sms({ phone, template })` mirrors `ctx.history.email`.
- **Webhook** — `POST /v1/webhooks/sms/:providerId` (`routes/webhooks/sms-provider.ts`), registered before the `:sourceId` catch-all; `"sms"` is a reserved connector/source id. Status callbacks are guarded monotonic (a late `sent` never regresses `delivered`; duplicates emit nothing) and `sms.delivered`/`sms.failed` carry dedupe keys. Inbound STOP/START/HELP handled by `lib/sms-inbound.ts` (whole-message AND leading-keyword match; STOP → dual-track suppression + `contact.unsubscribed`; START → `grantPhoneConsent` upsert + `contact.subscribed`; confirmation replies default OFF).
- **Click tracking** — `GET /s/:code` (root-mounted next to `/l/:slug`) feeds the shared click pipeline: per-hit `link_clicks` + `clickCount`, first-touch `sms_sends.clicked_at`, per-hit `sms.clicked` outbound, `sms.link_clicked` bus re-ingest for journeys (gated on `!isBot` + a resolved contact key). Both vendored catalog copies (`packages/cli/src/commands/webhooks.ts`, `packages/client/src/types.ts`) must stay hand-synced with `WEBHOOK_EVENT_TYPES`.
- **DB** — `sms_sends` (+ `clicked_at`), `sms_suppressions` (tri-state: active STOP / express phone consent via `resubscribed_at` / no row), `contacts.phone` (partial-unique live index, like `discordId`), `tracked_links.sms_send_id` + `short_code`. Phone is NOT yet a merge-participating identity `Kind` — STOP resolves a contact by a direct `contacts.phone` lookup.

### Voice channel (BYO provider)

Voice is a first-class channel for AI phone agents (outbound + inbound calls: marketing, data collection, selling, appointments), mirroring the SMS architecture. Full docs: `docs/voice.md`; design/roadmap: `docs/voice-agent-plan.md`. **Operator opt-in**: with no provider configured the voice service is an inert stub and `startCall` throws. **Recipient opt-in (TCPA — strictest)**: the `voice` channel registers `defaultOptIn: false` — a marketing call needs an explicit `categories.voice === true` grant, else it fails closed with `no_consent`. Transactional calls bypass only the consent+topic gates — never the internal DNC (`voice_suppressions`) or `unsubscribed_all`.

Voice is **not** "SMS with audio": media/turn-taking/STT-LLM-TTS run in the provider cloud. Hogsend is the control plane — author the agent, start the call, **serve mid-call tool calls synchronously** (where booking/selling/data-collection execute), and ingest the outcome onto the journey bus.

- **Contract** — `VoiceProvider` in `@hogsend/core` (`packages/core/src/providers/voice.ts`, `defineVoiceProvider()`). A dumb wire: `startCall(StartCallOptions) → { id }` (takes a provider-neutral `VoiceAgentConfig`, never a vendor shape), `verifyWebhook/parseWebhook → VoiceWebhookParsed` (discriminated `{ kind: "event", event: VoiceEvent }` | `{ kind: "tool_call", calls: VoiceToolCall[] }`), `encodeToolResults` (the vendor's synchronous reply shape). `VoiceEvent` types: `voice.call_started | call_ended | no_answer | voicemail | failed`; the terminal `call_ended` carries the outcome (transcript, recording, summary, extracted structured data).
- **Agents package** — `@hogsend/voice`: `defineVoiceAgent` (`build(props) → VoiceAgentConfig`; agents are prompt+config **.ts**, NOT React), `defineVoiceTool` (wire `spec` + executable `handler`; method-syntax handler is bivariant so typed tools erase into the registry), augmentable `VoiceAgentRegistryMap`, `renderVoiceAgent` + `{{variable}}` `interpolate`, `createVoiceToolRegistry`, `VoiceCallError`. Consumer authors `src/voice/` (agents + `tools.ts` + `registry.ts` + `templates.d.ts`) and passes `voice: { agents, tools }` to `createHogsendClient` in BOTH `index.ts` and `worker.ts`.
- **Plugin** — `packages/plugin-vapi` (`createVapiProvider`), the reference. `startCall` POSTs `/call` with a transient assistant synthesized from `VoiceAgentConfig` (`agent-mapping.ts`: systemPrompt→model.messages, tools→function tools with `t.parameters` args, `dataSchema`→`analysisPlan.structuredDataPlan`, `record`→`artifactPlan.recordingEnabled` (OFF by default), model defaults to `anthropic/claude-sonnet-4-6` — latest fast NON-reasoning Claude, since a reasoning model's TTFT pauses audibly on voice) + `phoneNumberId` + `customer.number` + `assistantOverrides.variableValues`. `POST /call` is NON-idempotent → retries ONLY a 429 (never ambiguous 5xx/network — a double-dial). Webhooks: verify is OPTIONAL — `X-Vapi-Secret` OR `Authorization: Bearer` when `VAPI_WEBHOOK_SECRET` is set, ACCEPTED unverified when unset (a basic key-only deploy would otherwise 401 every webhook); tool args read from `message.toolCallList[].parameters`; normalizes `status-update`/`end-of-call-report`/`tool-calls`/`assistant-request` into `VoiceWebhookParsed` (3 kinds: `event` | `tool_call` | `assistant_request`); `encodeAssistantResponse` shapes the inbound reply. Vapi composes Deepgram STT + ElevenLabs TTS internally, so it's the turnkey default. (ElevenLabs Agents + Deepgram are additive providers later.)
- **Engine** — `container.ts` builds `VoiceProviderRegistry` + resolves the active provider (`voice.defaultProvider ?? VOICE_PROVIDER ?? "vapi"`, or the sole one; unresolvable explicit id throws) + mints the opt-in `voice` channel list. `createTrackedVoiceCaller` (`lib/voice-caller.ts` + `lib/voice-tracked.ts`) mirrors the SMS pipeline: E.164-normalize `to` → idempotency short-circuit → consent/DNC gate (`voice_suppressions` + `unsubscribed_all` unconditional; consent+topic skipped for transactional) → voice frequency cap → journey `meta.suppress` → **calling-hours guard** (TCPA 8am–9pm from the contact `timezone` property; skipped when unresolvable) → test-mode redirect → `voice_calls` insert (persists `allowedTools`+`variables` in metadata) → `provider.startCall` → status `ringing`. The idempotency-key conflict-LOSER returns the winner's row (never re-places — no double-dial). `startCall()` (`lib/voice.ts`) is the journey helper, replay-safe via the `voiceCall` key kind. `lib/voice-tools.ts` is the hardened mid-call dispatcher: resolves the `voice_calls` row scoped by `providerId` (no row ⇒ refuse), authorizes the tool against the row's `allowedTools`, claims the `toolCallId` in `voice_tool_calls` for idempotency (a retried webhook replays the stored result — no double-booking; a FAILED tool releases the claim), validates required params, times out (15s), and passes a normalized-phone + `userId` + `variables` context. The service also exposes `recordOptOut(phone)` (DNC write from an opt-out tool) + `handleAssistantRequest` (inbound). `ctx.history.voice({ phone, agent })` mirrors `ctx.history.sms`.
- **Webhook** — `POST /v1/webhooks/voice/:providerId` (`routes/webhooks/voice-provider.ts`), before the `:sourceId` catch-all; `"voice"` reserved. Three kinds: a `tool_call` runs the dispatcher + replies SYNCHRONOUSLY with `encodeToolResults`; an `assistant_request` (INBOUND) selects the configured `voice.inboundAgent`, creates the inbound `voice_calls` row, and replies with `encodeAssistantResponse`; an `event` advances status (guarded monotonic) + persists the outcome, then **awaits** `ingestEvent` for each terminal descriptor (idempotency-keyed `voice:<event>:<callId>`, so a retry after a crash still wakes the journey — a failure returns 500 so Vapi retries). Terminal events also `emitOutbound` (external webhook subscribers) and `voice.call_ended` derives `voice.data_collected` (structured data namespaced under `data`, written to `contactProperties`). Permanent failure → internal DNC.
- **Outbound catalog** — `voice.call_started`/`call_ended`/`no_answer`/`voicemail`/`failed`/`data_collected` are in `WEBHOOK_EVENT_TYPES` (`lib/webhook-signing.ts`) + `OutboundPayloads` (`lib/outbound.ts`); the two vendored copies (`packages/cli/src/commands/webhooks.ts`, `packages/client/src/types.ts`) are hand-synced.
- **DB** — `voice_calls` (status/outcome/transcript/structuredData/cost/idempotencyKey) + `voice_suppressions` (internal DNC, phone-keyed) + `voice_tool_calls` (per-invocation idempotency ledger, unique `tool_call_id`) + `voice_call_status` enum (migrations `0047`+`0048`). Reuses `contacts.phone`; no `tracked_links`.
- **Studio preview** — `GET /v1/admin/voice-agents` (catalog) + `/{key}/preview` (`routes/admin/voice-agents.ts`) render the SYNTHESIZED `VoiceAgentConfig` (no audio; media is provider-side), mirroring the email template preview. Studio view: `packages/studio/src/views/voice-agents-view.tsx`. First-party (NOT a plugin) — channels are engine/studio-owned, only providers are plugins.
- **Deferrals** — per-number inbound routing (a single `inboundAgent` answers all inbound today), ElevenLabs/Deepgram providers, blueprint `place_call` node, live audio streaming.

### Ingestion pipeline

`ingestEvent()` (engine: `packages/engine/src/lib/ingestion.ts`) is the central event processing function used by both the ingest endpoint and webhook sources. It: (1) stores the event in `userEvents`, (2) pushes to Hatchet (which routes to matching journey tasks), (3) checks exit conditions on active journeys for the user, (4) upserts the contact record. Exit conditions are evaluated by matching event name against `exitOn` rules in journey metadata and applying property conditions.

### Email tracking (link clicks + opens)

First-party link click and email open tracking. All tracking code is engine-owned (`packages/engine/src/...`); outgoing email HTML is rewritten before reaching the provider:

- `lib/tracking.ts` — `prepareTrackedHtml()` calls `rewriteLinks()` (tag-level anchor pass: extracts URLs + semantic `data-hs-*` metadata, bulk-inserts `tracked_links`, rewrites hrefs to redirect URLs and strips the semantic attributes) then `injectOpenPixel()` (appends 1x1 GIF `<img>` before `</body>`). Skips unsubscribe/preference links
- **Semantic links** — `EmailAction` (from `@hogsend/email`) renders an anchor carrying `event` + scalar `properties`; a click is a PROVISIONAL answer confirmed by the deferred `confirm-semantic-click` Hatchet task after the 30s burst window (whole burst visible, so even a scanner's first click is suppressed; first answer per (send, event) wins via `sem:` idempotency key, rolled back on a failed publish) and emits `email.action` on the outbound spine (PostHog preset captures it under the consumer event name). Reserved namespaces (`email.`/`journey.`/`bucket.`/`contact.`) are rejected at send time. Journeys read the answer from `ctx.waitForEvent → properties`; never put the awaited event in `exitOn`. `href={HOSTED_ANSWER_HREF}` resolves to the engine-hosted answer page (`/v1/t/a/:id`, optional free-text → `<event>.comment`); `TRACKING_IDENTITY_TOKEN=true` appends an encrypted `hs_t` token to redirects, exchanged at `POST /v1/t/identify` for cross-device `posthog.identify`
- `routes/tracking/click.ts` — `GET /v1/t/c/:id` records `link_clicks` row, increments `clickCount`, sets `emailSends.clickedAt` (first click only via `WHERE clickedAt IS NULL`), 302 redirects to original URL, then fire-and-forget pushes `email.link_clicked` event through ingest + PostHog
- `routes/tracking/open.ts` — `GET /v1/t/o/:id` sets `emailSends.openedAt` (first open only), returns 1x1 transparent GIF with `no-store` cache headers, then fire-and-forget pushes `email.opened` event through ingest + PostHog
- `lib/tracking-events.ts` — `resolveEmailSendContext()` (single LEFT JOIN to get userId/templateKey from emailSends + journeyStates) and `pushTrackingEvent()` (fires PostHog capture + ingestEvent for a tracking event)
- Tracking is part of the engine-owned `createTrackedMailer` (`lib/mailer.ts`): it renders the template (React → HTML via `@hogsend/email`), checks preferences, calls `prepareTrackedHtml` (tracking domain = `API_PUBLIC_URL`), writes the `email_sends` row, then calls `provider.send(...)` with HTML only. Any `EmailProvider` (Resend, Postmark, …) is a dumb wire, so tracking comes along regardless of which provider you supply — first-party open/click tracking is provider-agnostic and sovereign (provider-native tracking is forced off where possible, warned at boot where it can't be). Analytics is initialized once by `createHogsendClient` and passed to tracking endpoints
- DB tables: `tracked_links` (one row per unique URL per email), `link_clicks` (one row per click, with IP + user agent)

Full documentation: `docs/tracking.md`

### Condition evaluation engine

`@hogsend/core` provides a composable condition system (`evaluateCondition()`) supporting four types: `property` (property operator checks), `event` (event existence with optional time window), `email_engagement` (open/click tracking via emailSends/linkClicks), and `composite` (AND/OR composition). Used by enrollment guards, journey context event checks, and exit conditions.

### Testing

Tests use vitest and live in `apps/api/src/__tests__/`. The vitest config injects test env vars (DATABASE_URL, PORT, etc.) so tests don't need `.env`. Tests call `app.request()` directly against the Hono app — no HTTP server needed.

### Code style

- **Biome** for linting and formatting (not ESLint/Prettier)
- 2-space indent, double quotes, semicolons always, 80-char line width
- **Conventional Commits** enforced via `commitlint` + Lefthook `commit-msg` hook. Format: `type(scope): description` — types: `feat`, `fix`, `docs`, `style`, `refactor`, `perf`, `test`, `build`, `ci`, `chore`, `revert`. Scope is optional, kebab-case. Header max 100 chars
- **Lefthook** git hooks: `commit-msg` runs commitlint; pre-commit runs `biome check` on staged files; pre-push runs `check-types`
- API builds target Node 22, ESM-only (`"type": "module"`)
- Use `.js` extensions in relative imports within the API (ESM resolution)

### Infrastructure

- **TimescaleDB** (Postgres 18) via docker-compose on port 5434 (user/pass/db: `growthhog`)
- **Redis** 8 (Alpine) via docker-compose on port 6380, for PostHog property caching
- **Hatchet-Lite** via docker-compose — dashboard at `localhost:8888`, gRPC at `localhost:7077`. Default login: `admin@example.com` / `Admin123!!`. Has its own Postgres 15 instance
- API default port is 3002 (configured via PORT env var)
- Node 22 required (pinned via `.node-version`)

### Deployment

- **Railway** (withSeismic team) — two services from same repo, plus Postgres, Redis, Hatchet-Lite
  - `hogsend-api` (`railway.toml`) — HTTP API, health check at `/v1/health`, pre-deploy runs `db:migrate`
  - `hogsend-worker` (`railway.worker.toml`) — Hatchet worker, no HTTP port, scales independently
  - `hatchet-lite` — self-hosted Hatchet engine (Docker image)
- **Cloudflare** — `hogsend.com` DNS on Cloudflare, `api.hogsend.com` CNAME → Railway
- **GitHub auto-deploy** — push to `main` triggers Railway build for both API and worker
- tsup bundles all `@hogsend/*` packages via `noExternal`; npm deps resolve from `node_modules` at runtime
- `/docs` and `/openapi.json` are disabled in production (`NODE_ENV=production`)
