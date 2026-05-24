# Hogsend

Code-first lifecycle engine for teams on PostHog + Resend. Journeys are typed TypeScript objects, not YAML, not drag-and-drop canvases. Self-hostable. Open source.

Fills the gap between "PostHog webhooks firing into a Hono handler" and "paying $500/mo for Customer.io."

[![Deploy on Railway](https://railway.com/button.svg)](https://railway.com/deploy/LxSCyR)

---

## Why Hogsend

- **Agentic-native.** Journeys are typed `.ts` files. An AI agent can create, modify, and reason about them. No proprietary format, no visual-only builder.
- **PostHog-native.** Bi-directional event sync. Events flow in from PostHog webhooks, engagement data flows back. Build cohorts based on email engagement alongside product metrics.
- **Self-hostable.** Postgres + Redis + one Node process. Deploy to Railway in 5 minutes. Your data stays yours.

---

## Architecture

```
                         Event Sources
  PostHog webhooks ──┐
  Internal events ───┤──> Hono Ingestion (/v1/ingest)
  API calls ─────────┘         |
                               v
                        Journey Engine
           ┌─────────────┐  ┌──────────────┐
           │  Enrollment  │  │   Hatchet    │
           │  (match      │  │  (durable    │
           │   trigger,   │  │   workflow   │
           │   check      │  │   execution, │
           │   limits,    │  │   sleeps,    │
           │   kick off   │  │   retries,   │
           │   workflow)  │  │   dashboard) │
           └──────┬──────┘  └──────┬───────┘
                  └────────────────┤
                                   v
                            Action Router
                               |
          ┌────────────┬───────┴──────┬──────────────┐
          v            v              v              v
     Resend       PostHog        Webhook        Enroll
     Email        Event          (HTTP)         Another
     Send         Push                          Journey
```

| Concern | Tool |
|---------|------|
| Runtime | Hono on Node.js |
| Workflow orchestration | Hatchet (durable execution, sleeps, retries) |
| Database | TimescaleDB (Postgres 18) |
| ORM | Drizzle |
| Job queue / cache | Redis |
| Event source | PostHog (webhooks + API) |
| Email delivery | Resend |
| Email templates | React Email |
| Journey definitions | TypeScript (typed objects) |
| Deploy | Railway or self-hosted Docker |

---

## Quick Start

### Deploy to Railway

1. Click the deploy button above
2. Set your `RESEND_API_KEY` and `RESEND_FROM_EMAIL`
3. Open the Hatchet dashboard (deployed as a service), generate an API token under Settings > API Tokens
4. Set `HATCHET_CLIENT_TOKEN` on the API and Worker services
5. Both services will redeploy and connect

### Self-hosted (Docker Compose)

```bash
git clone https://github.com/hogsend/hogsend.git
cd hogsend
pnpm setup          # checks Docker, starts containers, installs deps, creates .env
pnpm dev            # starts API on port 3002
```

In a separate terminal:

```bash
cd apps/api
hatchet worker dev  # starts Hatchet worker with hot-reload
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

## Writing Journeys

Journeys are TypeScript files in `apps/api/src/journeys/`. Each exports a typed `JourneyDefinition` object.

### Example: Activation Welcome Series

```typescript
import type { JourneyDefinition } from "@hogsend/core/types";

export const activationWelcome: JourneyDefinition = {
  id: "activation-welcome",
  name: "Activation — Welcome Series",
  enabled: true,

  trigger: { event: "user.created" },   // enroll when this event fires
  entryLimit: "once",                    // each user enters once
  suppressHours: 12,                     // min hours between emails
  exitOn: [{ event: "user.deleted" }],   // exit immediately on this event

  entryNode: "send_welcome",

  nodes: {
    send_welcome: {
      type: "action",
      id: "send_welcome",
      action: {
        type: "send_email",
        templateKey: "activation/welcome",
        subject: "Welcome — let's get you set up",
      },
      next: "wait_48h",
    },

    wait_48h: {
      type: "wait",
      id: "wait_48h",
      hours: 48,
      next: "check_engagement",
    },

    check_engagement: {
      type: "condition",
      id: "check_engagement",
      eval: {
        type: "event",
        eventName: "feature.used",
        check: "exists",
      },
      onTrue: "send_advanced",    // they used it -> tips email
      onFalse: "send_nudge",      // they didn't -> nudge email
    },

    send_advanced: {
      type: "action",
      id: "send_advanced",
      action: { type: "send_email", templateKey: "activation/advanced", subject: "Nice work — here's what to try next" },
      next: "wait_48h_2",
    },

    send_nudge: {
      type: "action",
      id: "send_nudge",
      action: { type: "send_email", templateKey: "activation/nudge", subject: "You haven't tried the key feature yet" },
      next: "wait_48h_2",
    },

    wait_48h_2: { type: "wait", id: "wait_48h_2", hours: 48, next: "send_community" },

    send_community: {
      type: "action",
      id: "send_community",
      action: { type: "send_email", templateKey: "activation/community", subject: "Join the community" },
      next: null,  // journey complete
    },
  },
};
```

### Node Types

| Type | Fields | Behavior |
|------|--------|----------|
| `action` | `action`, `next` | Execute an action, advance to `next` (or complete if `null`) |
| `wait` | `hours`, `next` | Sleep durably via Hatchet, then advance |
| `condition` | `eval`, `onTrue`, `onFalse` | Evaluate a condition, branch accordingly |

### Action Types

| Type | What it does |
|------|-------------|
| `send_email` | Render React Email template, send via Resend |
| `fire_event` | Insert into local event store + push to PostHog |
| `webhook` | POST/PUT to an external URL |
| `enroll_journey` | Enroll the user in another journey |

### Condition Types

| Type | What it checks |
|------|---------------|
| `event` | Has a specific event been recorded? How many times? Within a time window? |
| `property` | Check a PostHog person property or journey context value |
| `email_engagement` | Has the user opened/clicked a specific email? |
| `composite` | AND/OR combinations of other conditions |

### Adding a Journey

1. Create `apps/api/src/journeys/your-journey.ts` exporting a `JourneyDefinition`
2. Import and register it in `apps/api/src/journeys/index.ts`
3. Deploy

---

## API Endpoints

| Method | Path | Description |
|--------|------|-------------|
| POST | `/v1/ingest` | Ingest events from PostHog webhooks or direct API calls |
| POST | `/v1/webhooks/posthog` | PostHog webhook receiver (signature verified) |
| GET | `/v1/health` | Health check |
| GET | `/docs` | Scalar API reference (dev only) |
| GET | `/openapi.json` | OpenAPI spec (dev only) |

---

## Environment Variables

| Variable | Required | Default | Description |
|----------|----------|---------|-------------|
| `DATABASE_URL` | Yes | - | PostgreSQL connection string |
| `BETTER_AUTH_SECRET` | Yes | - | Auth secret (min 32 characters) |
| `RESEND_API_KEY` | Yes | - | Resend API key for email delivery |
| `NODE_ENV` | No | `development` | `development`, `production`, or `test` |
| `PORT` | No | `3002` | HTTP server port |
| `LOG_LEVEL` | No | `info` | `error`, `warn`, `info`, `http`, `debug` |
| `REDIS_URL` | No | `redis://localhost:6379` | Redis connection string |
| `BETTER_AUTH_URL` | No | `http://localhost:3002` | Auth base URL |
| `RESEND_FROM_EMAIL` | No | `noreply@hogsend.com` | Sender email address |
| `HATCHET_CLIENT_TOKEN` | No | - | Hatchet API token for workflow execution |
| `POSTHOG_WEBHOOK_SECRET` | No | - | Shared secret for verifying PostHog webhooks |
| `ENABLED_JOURNEYS` | No | `*` | Comma-separated journey IDs to load, or `*` for all |

---

## Monorepo Layout

```
apps/
  api/                  Hono REST API + Hatchet worker
packages/
  core/                 Journey types, schemas, condition engine, registry
  db/                   Drizzle ORM schema and migrations
  email/                Resend client, React Email templates
  typescript-config/    Shared tsconfig bases
```

---

## License

MIT
