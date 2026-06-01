# Architecture — Current State

Last updated: 2026-05-25

Visual map of how Hogsend's components connect today, and where the gaps are.

---

## System Architecture

```
                           ┌─────────────────────────────┐
                           │       Event Sources          │
                           │                              │
                           │  PostHog webhooks ──┐        │
                           │  API /v1/ingest ────┤        │
                           │  Webhook sources ───┘        │
                           └──────────┬──────────────────┘
                                      │
                                      ▼
                    ┌─────────────────────────────────────┐
                    │          Ingestion Pipeline          │
                    │       (src/lib/ingestion.ts)         │
                    │                                      │
                    │  1. Store event in userEvents         │
                    │  2. Push to Hatchet (route to tasks)  │
                    │  3. Evaluate exit conditions           │
                    │  4. Upsert contact record              │
                    └──────────┬──────────────────────────┘
                               │
                  ┌────────────┼────────────────┐
                  ▼                             ▼
     ┌────────────────────┐        ┌────────────────────────┐
     │    Hatchet Engine   │        │   Exit Condition Check  │
     │   (task routing)    │        │  (active journeys for   │
     │                     │        │   user with matching     │
     │  Matches event to   │        │   exitOn rules)          │
     │  journey triggers   │        └────────────────────────┘
     └────────┬───────────┘
              │
              ▼
     ┌────────────────────────────────────────────────────┐
     │              Journey Execution                      │
     │          (defineJourney → Hatchet task)              │
     │                                                     │
     │  ┌──────────────────────────────────────────────┐   │
     │  │ Entry Guards (evaluated in order)             │   │
     │  │  1. meta.enabled check                       │   │
     │  │  2. evaluateTriggerConditions()              │   │
     │  │  3. checkEntryLimit()                        │   │
     │  │  4. checkEmailPreferences()                  │   │
     │  └──────────────┬───────────────────────────────┘   │
     │                 │ pass                               │
     │                 ▼                                    │
     │  ┌──────────────────────────────────────────────┐   │
     │  │ Journey run(user, ctx)                        │   │
     │  │                                               │   │
     │  │  ctx.sleep()       → durable wait             │   │
     │  │  ctx.checkpoint()  → update currentNodeId     │   │
     │  │  ctx.trigger()     → push event to ingest     │   │
     │  │  ctx.guard.*       → subscription checks      │   │
     │  │  ctx.history.*     → event/journey/email lookups│  │
     │  │  sendEmail()       → standalone email service  │   │
     │  │  getPostHog()      → standalone PostHog client │   │
     │  └──────────────┬───────────────────────────────┘   │
     │                 │                                    │
     │                 ▼                                    │
     │  State: active → waiting → active → completed       │
     │         (tracked in journeyStates + journeyLogs)    │
     └─────────────────────────────────────────────────────┘
              │
              ▼
     ┌────────────────────────────────────────────┐
     │           Email Pipeline                    │
     │                                             │
     │  React Email render                         │
     │  → Link rewrite (tracking URLs)             │
     │  → Resend API send                          │
     │  → Store in emailSends                      │
     │  → Resend webhooks update delivery status   │
     │                                             │
     │  Bounce suppression after 3 bounces         │
     │  One-click unsubscribe (RFC 8058)           │
     │  Preference center with categories          │
     └────────────────────────────────────────────┘
```

---

## Data Flow

```
Event → userEvents table
     → Hatchet (routes to journey tasks)
     → Exit condition check (may exit active journeys)
     → Contact upsert

Journey task → journeyStates (created on entry)
            → journeyLogs (node transitions)
            → emailSends (when sending email)
            → trackedLinks + linkClicks (email engagement)
            → userEvents (via ctx.trigger for cross-journey)

Resend webhook → emailSends (status updates)
              → emailPreferences (bounce tracking)
              → contacts (suppression)
```

---

## Infrastructure

```
┌──────────────────────────────────────────────────────────┐
│                    Railway (Production)                    │
│                                                           │
│  ┌─────────────┐  ┌─────────────┐  ┌─────────────────┐  │
│  │ hogsend-api │  │hogsend-worker│  │  hatchet-lite   │  │
│  │ (Hono HTTP) │  │(Hatchet tasks│  │ (engine + gRPC) │  │
│  │ port 3002   │  │ no HTTP port)│  │ dashboard :8888 │  │
│  │             │  │              │  │ gRPC :7077      │  │
│  │ pre-deploy: │  │              │  │                 │  │
│  │ db:migrate  │  │              │  │ own Postgres 15 │  │
│  └──────┬──────┘  └──────┬──────┘  └────────┬────────┘  │
│         │                │                   │           │
│         └────────────────┼───────────────────┘           │
│                          │                               │
│  ┌───────────────────────┼───────────────────────────┐   │
│  │           Shared Infrastructure                    │   │
│  │                                                    │   │
│  │  ┌──────────────────┐  ┌────────────────────────┐ │   │
│  │  │ TimescaleDB       │  │ Redis 8               │ │   │
│  │  │ (Postgres 18)     │  │ PostHog property cache │ │   │
│  │  │ port 5434         │  │ port 6380             │ │   │
│  │  └──────────────────┘  └────────────────────────┘ │   │
│  └───────────────────────────────────────────────────┘   │
└──────────────────────────────────────────────────────────┘

Cloudflare DNS: hogsend.com → api.hogsend.com CNAME → Railway
```

---

## What's Connected vs What's Missing

```
  CONNECTED (data flows)              MISSING (no data path)
  ========================            ========================

  PostHog → Ingest → DB    ✓         DB → Admin dashboard     ✗
  Ingest → Hatchet → Task  ✓         Journey states → API     ✗
  Task → Email → Resend    ✓         Email history → API      ✗
  Resend → Webhook → DB    ✓         Event history → API      ✗
  DB → Contact API         ✓         Metrics aggregation      ✗
  Unsubscribe → Prefs      ✓         Journey control API      ✗
                                      Alerting/monitoring      ✗
                                      Management UI            ✗
```

The core pipeline (event in → journey executes → email out → delivery tracked) is complete. The gap is everything that reads data back out for humans to see and control.
