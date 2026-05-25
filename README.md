# Hogsend

> **Work in progress.** This is a no-fuss, self-hosted lifecycle marketing platform for scrappy startups that want full lifecycle email on top of PostHog and Resend — yesterday. Use it to move fast and test ideas before going full send into Customer.io, Brevo, etc.

The pipe between PostHog events and the lifecycle emails you were about to hand-roll anyway.

PostHog tells you what users do. Resend delivers your emails. Hogsend is the bit in the middle — it listens for events, decides who gets what, waits, checks conditions, and sends. Journeys are async TypeScript functions, not YAML configs or drag-and-drop canvases. You write them like application code because they are application code.

Open source. Self-hostable. Built for small teams (1–10 eng) shipping product-led SaaS who picked PostHog and Resend and now need behavioral sequences without buying a third platform.

[![Deploy on Railway](https://railway.com/button.svg)](https://railway.com/deploy/LxSCyR)

---

## What You Can Build

Anything where a user does something in your product and you want to respond over time with emails, events, or webhooks. Some examples:

- **Welcome sequences** that branch based on whether the user actually used the product — skip the "here's how to get started" email if they already did
- **Trial-to-paid conversion** that watches for usage milestones, sends different emails depending on engagement, and follows up with a winback offer if they don't convert
- **Payment failure recovery** — escalating reminders that stop the moment the payment goes through (via `exitOn`)
- **Dormancy reactivation** — detect inactive users via events, run a win-back series, track if they come back
- **NPS / feedback collection** timed after key moments (subscription renewal, milestone reached)
- **Referral prompts** sent to highly active users after they hit an achievement
- **Abandoned checkout recovery** — start a sequence when checkout begins, exit when it completes
- **Achievement celebrations** that fire events back to PostHog so you can build cohorts around engagement
- **Webhook-based integrations** — update a CRM, ping Slack, call any external API as part of a journey
- **Cross-journey orchestration** — one journey enrolls a user in another, chaining sequences without duplicating logic

Each of these is a single TypeScript file using `defineJourney()`. The `run` function reads like the logic actually is — if/else, loops, early returns, real code. No visual canvas, no proprietary DSL.

---

## How It Works

Events arrive (from PostHog webhooks, your app, wherever). Hogsend matches them to journeys. Each journey is a durable async function — it can send emails, sleep for days, check if a user did something, branch, fire events back to PostHog, call webhooks, or enroll users in other journeys. Hatchet handles the durable execution so sleeps survive deploys and crashes.

```
PostHog webhooks ──┐
Your app events ───┤──▶ /v1/ingest ──▶ Hatchet routes to matching journeys
API calls ─────────┘                          │
                                              ▼
                                    ┌──────────────────────┐
                                    │  defineJourney()      │
                                    │  async run fn         │
                                    │                       │
                                    │  ctx.sleep()          │
                                    │  ctx.checkpoint()     │
                                    │  ctx.event.check()    │
                                    │  ctx.event.fire()     │
                                    │                       │
                                    │  + direct imports:    │
                                    │  sendEmail()          │
                                    │  posthog plugin       │
                                    └──────────┬───────────┘
                                               │
                    ┌────────────┬──────────────┼────────────┐
                    ▼            ▼              ▼            ▼
                 Resend      PostHog        Webhooks     Sleep &
                 (email)     (person        (fetch)      resume
                             properties)                 later
```

Events pushed back to PostHog mean you can build cohorts like "users who opened the welcome email but haven't used feature X" — email engagement alongside product metrics, no separate tool.

---

## Writing Journeys

Journeys use `defineJourney()` — you declare metadata (trigger, entry limits, exit conditions) and write an async `run` function that receives the user and a context object with typed helpers.

### Example: Welcome Series

```typescript
import { days } from "@hogsend/core";
import { Events, Templates } from "./constants/index.js";
import { defineJourney } from "./define-journey.js";
import { sendEmail } from "../lib/email.js";

export const activationWelcome = defineJourney({
  meta: {
    id: "activation-welcome",
    name: "Activation — Welcome Series",
    enabled: true,
    trigger: { event: Events.USER_CREATED },
    entryLimit: "once",
    suppressHours: 12,
    exitOn: [{ event: Events.USER_DELETED }],
  },

  run: async (user, ctx) => {
    await sendEmail({ to: user.email, userId: user.id, journeyName: user.journeyName,
      template: Templates.ACTIVATION_WELCOME,
      subject: "Welcome — let's get you set up",
    });

    await ctx.sleep({ duration: days(2), label: "post-welcome" });

    const { found: hasUsedFeature } = await ctx.event.check({
      userId: user.id,
      event: Events.FEATURE_USED,
    });

    if (hasUsedFeature) {
      await sendEmail({ to: user.email, userId: user.id, journeyName: user.journeyName,
        template: Templates.ACTIVATION_ADVANCED,
        subject: "Nice work — here's what to try next",
      });
    } else {
      await sendEmail({ to: user.email, userId: user.id, journeyName: user.journeyName,
        template: Templates.ACTIVATION_NUDGE,
        subject: "You haven't tried the key feature yet",
      });
    }

    await ctx.sleep({ duration: days(2), label: "pre-community" });

    await sendEmail({ to: user.email, userId: user.id, journeyName: user.journeyName,
      template: Templates.ACTIVATION_COMMUNITY,
      subject: "Join the community",
    });
  },
});
```

That's a real journey. It sleeps for days, checks behavioral events, branches, and sends different emails based on what the user actually did. The `run` function is a durable execution — Hatchet persists state across sleeps, so it survives deploys and restarts.

Duration helpers (`days()`, `hours()`, `minutes()`) replace magic strings. Constants (`Events`, `Templates`) replace magic event/template names. Every context method uses object params and returns a result object.

### Example: Churn Prevention

```typescript
export const churnPrevention = defineJourney({
  meta: {
    id: "churn-prevention",
    name: "Churn — Payment Recovery & Prevention",
    enabled: true,
    trigger: { event: Events.PAYMENT_FAILED },
    entryLimit: "once_per_period",
    entryPeriodHours: 168,
    suppressHours: 4,
    exitOn: [
      { event: Events.PAYMENT_SUCCEEDED },
      { event: Events.SUBSCRIPTION_CANCELLED },
    ],
  },

  run: async (user, ctx) => {
    await sendEmail({ to: user.email, userId: user.id, journeyName: user.journeyName,
      template: Templates.CHURN_PAYMENT_FAILED,
      subject: "Your payment didn't go through",
    });

    await ctx.sleep({ duration: days(1), label: "first-retry" });

    const { found: hasRetried } = await ctx.event.check({
      userId: user.id,
      event: Events.PAYMENT_SUCCEEDED,
      withinHours: 24,
    });
    if (hasRetried) return;

    await sendEmail({ to: user.email, userId: user.id, journeyName: user.journeyName,
      template: Templates.CHURN_PAYMENT_FAILED,
      subject: "Reminder: please update your payment method",
      props: { gracePeriodDays: 2 },
    });

    await ctx.sleep({ duration: days(2), label: "final-notice" });

    const { found: hasResolved } = await ctx.event.check({
      userId: user.id,
      event: Events.PAYMENT_SUCCEEDED,
      withinHours: 72,
    });
    if (!hasResolved) {
      await sendEmail({ to: user.email, userId: user.id, journeyName: user.journeyName,
        template: Templates.CHURN_PAYMENT_FAILED,
        subject: "Final notice: your account will be downgraded tomorrow",
        props: { gracePeriodDays: 1 },
      });
    }
  },
});
```

Notice `exitOn` — if a `payment.succeeded` event arrives at any point during the journey, Hatchet exits it immediately. No wasted emails.

### Context API

The `ctx` object passed to every journey's `run` function. Every method takes an options object and returns a result object.

| Method | What it does | Returns |
|--------|-------------|---------|
| `ctx.sleep({ duration: days(2), label? })` | Durable sleep — survives deploys, persists state to DB | `{ sleptAt, resumedAt }` |
| `ctx.checkpoint("label")` | Update the journey state label (for observability) | `void` |
| `ctx.event.check({ userId, event, withinHours? })` | Check if a user has a specific event in the local store | `{ found, count }` |
| `ctx.event.fire({ userId, event, properties? })` | Insert event locally + push to Hatchet | `{ eventKey, firedAt }` |

The context only provides durable execution primitives. Everything else is a direct import:

| Import | What it does |
|--------|-------------|
| `sendEmail({ to, userId, template, subject, ... })` | Render + send email via Resend (from `../lib/email.js`) |
| `getPostHog()?.getPersonProperties(userId)` | Fetch PostHog person properties (from `../lib/posthog.js`) |

Event payload properties are available on `user.properties`.

Duration helpers from `@hogsend/core`: `days(n)`, `hours(n)`, `minutes(n)` — type-safe, human-readable, no magic strings.

### Journey Metadata

| Field | Type | What it controls |
|-------|------|-----------------|
| `id` | `string` | Unique identifier, used in Hatchet task name (`journey-<id>`) |
| `trigger.event` | `string` | The event that enrolls users (e.g. `"user.created"`, `"payment.failed"`) |
| `trigger.where` | `PropertyCondition[]` | Optional conditions that must also match on the event properties |
| `entryLimit` | `"once" \| "once_per_period" \| "unlimited"` | How often a user can enter |
| `entryPeriodHours` | `number` | Minimum hours between entries (when `once_per_period`) |
| `suppressHours` | `number` | Minimum hours between emails within this journey |
| `exitOn` | `Array<{ event, where? }>` | Events that immediately exit the user from the journey |
| `enabled` | `boolean` | Toggle without removing code |

### Adding a Journey

1. Add any new event/template names to `apps/api/src/journeys/constants/`
2. Create `apps/api/src/journeys/your-journey.ts` using `defineJourney()` with `days()`/`hours()` helpers and constant imports
3. Import it in `apps/api/src/journeys/index.ts` and add to `allJourneys`
4. Deploy — the worker picks it up automatically

### Included Journeys

The repo ships with 10 production-ready journeys covering common lifecycle stages:

| Journey | Trigger | What it does |
|---------|---------|-------------|
| `activation-welcome` | `user.created` | Welcome series with feature-adoption branching |
| `activation-nudge-series` | `user.created` | Multi-touch onboarding nudges for inactive users |
| `conversion-trial-upgrade` | `trial.started` | Trial-to-paid conversion with usage-based sends |
| `conversion-abandoned-checkout` | `checkout.abandoned` | Cart recovery sequence |
| `retention-milestone` | `milestone.reached` | Achievement celebrations |
| `referral-invite` | `milestone.reached` | Post-achievement referral prompts for active users |
| `feedback-nps` | `user.created` | NPS survey collection (14-day + 60-day) |
| `reactivation-dormancy` | `user.dormancy_detected` | Win-back sequence for inactive users |
| `churn-prevention` | `payment.failed` | Payment failure recovery escalation |
| `test-onboarding` | `test.signup` | Test journey for development |

---

## Quick Start

### Deploy to Railway

1. Click the deploy button above
2. Set `RESEND_API_KEY` and `RESEND_FROM_EMAIL`
3. Open the Hatchet dashboard (deployed as a service), generate an API token under Settings > API Tokens
4. Set `HATCHET_CLIENT_TOKEN` on the API and Worker services
5. Both services redeploy and connect

### Install the CLI

The fastest way to go from zero to a running Hogsend deployment. The CLI handles Railway provisioning, environment variables, service creation, and health checks — so you don't have to wire it up manually. One command to provision, one command to verify.

```bash
# macOS, Linux, WSL
curl -fsSL https://raw.githubusercontent.com/dougwithseismic/hogsend/main/install.sh | bash

# or download a binary directly from GitHub Releases
# https://github.com/dougwithseismic/hogsend/releases
```

Then spin up a full deployment:

```bash
hogsend init      # Interactive Railway provisioning wizard — sets up API, worker, Hatchet, Postgres, Redis
hogsend status    # Verify everything is healthy
```

### Local Development

```bash
git clone https://github.com/dougwithseismic/hogsend.git
cd hogsend
pnpm setup          # Checks Docker, starts containers, installs deps, creates .env
pnpm dev            # Starts API on port 3002
```

In a separate terminal:

```bash
cd apps/api
hatchet worker dev  # Starts worker with hot-reload
```

Hatchet dashboard: `http://localhost:8888` (login: `admin@example.com` / `Admin123!!`)

### Common Commands

```bash
pnpm dev                          # Start API via Turbo
pnpm build                        # Build all packages
pnpm lint                         # Biome check
pnpm check-types                  # TypeScript check across workspaces
pnpm --filter @hogsend/api test   # Run tests

# Database
pnpm --filter @hogsend/db db:generate   # Generate migration from schema
pnpm --filter @hogsend/db db:migrate    # Run migrations
pnpm --filter @hogsend/db db:studio     # Open Drizzle Studio
```

---

## Architecture

### Event Flow

1. **Ingest** — events arrive at `/v1/ingest` (PostHog webhooks, direct API calls) and get stored in the local event table
2. **Route** — the ingest endpoint pushes events to Hatchet, which routes them to every journey whose `trigger.event` matches
3. **Guard** — inside each journey's durable task, enrollment guards check entry limits, trigger conditions, and email preferences before running
4. **Execute** — the journey's `run` function executes with full access to the context API (send, sleep, check, branch, etc.)
5. **Track** — every email send, event fire, and state transition is logged. Email engagement events push back to PostHog.

### Stack

| Concern | Tool |
|---------|------|
| HTTP API | Hono on Node.js |
| Durable execution | Hatchet (sleeps, retries, event routing) |
| Database | TimescaleDB (Postgres 18) via Drizzle ORM |
| Cache / queues | Redis |
| Email delivery | Resend (via `@hogsend/plugin-resend`) |
| Product analytics | PostHog (via `@hogsend/plugin-posthog`) |
| Email templates | React Email |
| Journey definitions | TypeScript (`defineJourney()`) |
| CLI | Go (cobra) |
| Deploy | Railway or Docker Compose |

### Monorepo Layout

```
apps/
  api/                  Hono REST API + Hatchet worker (two entry points)
cli/                    Go CLI (init, deploy, status, journeys, contacts)
packages/
  core/                 Journey types, Zod schemas, condition engine, registry
  db/                   Drizzle ORM schema and migrations
  email/                React Email templates, render helpers
  plugin-posthog/       PostHog person properties, event capture, feature flags
  plugin-resend/        Resend email delivery, tracked sends, webhook handling
  typescript-config/    Shared tsconfig bases
```

### Two Processes, One Codebase

The API and worker are separate processes that share the same code:

- **API** (`src/index.ts`) — serves HTTP, pushes events to Hatchet
- **Worker** (`src/worker.ts`) — long-running process that executes journey tasks and background workflows

In production these scale independently. In development, `pnpm dev` runs the API and `hatchet worker dev` runs the worker with hot-reload.

---

## API

| Method | Path | Description |
|--------|------|-------------|
| POST | `/v1/ingest` | Ingest events (PostHog webhooks or direct) |
| GET | `/v1/health` | Health check |
| GET | `/v1/email/unsubscribe/:token` | Unsubscribe page |
| POST | `/v1/email/unsubscribe/:token` | One-click unsubscribe (RFC 8058) |
| GET | `/v1/email/preferences/:token` | Email preference center |
| POST | `/v1/webhooks/resend` | Resend delivery webhooks (bounce, complaint, etc.) |
| POST | `/v1/webhooks/sources` | Webhook source receiver |
| * | `/v1/admin/*` | Admin routes (contacts, preferences) |
| GET | `/docs` | Scalar API docs (dev only) |
| GET | `/openapi.json` | OpenAPI spec (dev only) |

---

## CLI

```bash
hogsend init        # Provision Railway project, services, and env vars
hogsend setup       # Local dev — Docker, deps, .env
hogsend status      # Health check for the deployment
hogsend deploy      # Trigger Railway deploy for API + Worker
hogsend journeys    # Enable/disable journeys via ENABLED_JOURNEYS
hogsend contacts    # Manage contacts
hogsend destroy     # Tear down Railway project (with confirmation)
```

---

## Environment Variables

| Variable | Required | Default | Description |
|----------|----------|---------|-------------|
| `DATABASE_URL` | Yes | — | PostgreSQL connection string |
| `BETTER_AUTH_SECRET` | Yes | — | Auth secret (min 32 chars) |
| `RESEND_API_KEY` | Yes | — | Resend API key |
| `NODE_ENV` | No | `development` | `development`, `production`, `test` |
| `PORT` | No | `3002` | HTTP server port |
| `LOG_LEVEL` | No | `info` | `error`, `warn`, `info`, `http`, `debug` |
| `REDIS_URL` | No | `redis://localhost:6379` | Redis connection string |
| `RESEND_FROM_EMAIL` | No | `noreply@hogsend.com` | Sender address |
| `HATCHET_CLIENT_TOKEN` | No | — | Hatchet API token |
| `POSTHOG_API_KEY` | No | — | PostHog personal API key (enables person property lookups in journeys) |
| `POSTHOG_HOST` | No | `https://us.i.posthog.com` | PostHog API host (US or EU cloud, or self-hosted) |
| `POSTHOG_WEBHOOK_SECRET` | No | — | Secret for verifying PostHog webhooks |
| `API_PUBLIC_URL` | No | — | Public URL for unsubscribe links |
| `ENABLED_JOURNEYS` | No | `*` | Comma-separated journey IDs, or `*` for all |

---

## Infrastructure

Local development runs via Docker Compose:

- **TimescaleDB** (Postgres 18) on port 5434
- **Redis 8** on port 6380
- **Hatchet-Lite** — dashboard at `localhost:8888`, gRPC at `localhost:7077`

Production runs on Railway with two services (API + Worker), Postgres, Redis, and Hatchet-Lite. Push to `main` auto-deploys.

---

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md) for setup, code style, and how to submit changes.

---

## License

[Elastic License 2.0 (ELv2)](LICENSE) — you can use, modify, and self-host freely. The two things you can't do: offer it as a managed service to third parties, or remove license key functionality. See the [LICENSE](LICENSE) file for the full terms.
