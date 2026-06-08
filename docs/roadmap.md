# Roadmap — Hogsend

Last updated: 2026-05-25

Phased plan to take Hogsend from a working engine to a production-ready marketing activation platform. Each phase is scoped to be deployable independently — you get value at every checkpoint.

---

## Phase 1: Journey Admin API

**Goal:** Be able to see and control journeys without redeploying.

**Why first:** Without this, you're flying blind. You can't see what's running, who's enrolled, or stop something that's going wrong.

### Endpoints

| # | Endpoint | Purpose |
|---|---|---|
| 1.1 | `GET /v1/admin/journeys` | List all journeys (id, name, trigger, enabled status, active/completed/failed counts) |
| 1.2 | `GET /v1/admin/journeys/:id` | Journey detail — meta, current state counts, recent activity |
| 1.3 | `PATCH /v1/admin/journeys/:id` | Toggle enabled/disabled at runtime (persisted to DB, not just env var) |
| 1.4 | `GET /v1/admin/journeys/:id/states` | List journey instances — filterable by status (active/waiting/completed/failed/exited), paginated |
| 1.5 | `GET /v1/admin/journeys/:id/states/:stateId` | Single instance detail — current node, entry time, context, logs |
| 1.6 | `DELETE /v1/admin/journeys/:id/states/:stateId` | Cancel/force-exit a journey instance |
| 1.7 | `POST /v1/admin/journeys/:id/enroll` | Manually enroll a user (accepts userId or contactId) |

### Schema Changes
- New `journeyConfigs` table: `journeyId (PK)`, `enabled`, `updatedAt`, `updatedBy`
- `JourneyRegistry` reads from DB on startup + API toggles update at runtime
- Worker listens for config change events or polls on interval

### Acceptance Criteria
- [ ] Can list all registered journeys with their enabled state
- [ ] Can enable/disable a journey via API without redeploying
- [ ] Can see all users currently in a specific journey and their status
- [ ] Can cancel a stuck journey instance
- [ ] Can manually enroll a user into a journey

---

## Phase 2: Visibility — Timeline, Events, Email History

**Goal:** Be able to answer "what happened to this user?" and "what emails have we sent?"

**Why second:** Once you can control journeys, you need to debug them. This phase gives you the data access to understand what's happening.

### Endpoints

| # | Endpoint | Purpose |
|---|---|---|
| 2.1 | `GET /v1/admin/contacts/:id/timeline` | Chronological feed: events received, journeys entered/exited, emails sent/delivered/opened — all interleaved by timestamp |
| 2.2 | `GET /v1/admin/events` | Event history — filterable by userId, event name, date range. Paginated |
| 2.3 | `GET /v1/admin/events/:id` | Single event detail with full properties |
| 2.4 | `GET /v1/admin/emails` | Email send history — filterable by contact, template, status, date range. Paginated |
| 2.5 | `GET /v1/admin/emails/:id` | Single email detail — delivery timeline, link clicks, journey context |
| 2.6 | `GET /v1/admin/journey-logs/:stateId` | Full log sequence for one journey instance |

### Acceptance Criteria
- [ ] Can view a contact's full activity timeline
- [ ] Can search events by name and date range
- [ ] Can see all emails sent with delivery status
- [ ] Can drill into a specific email and see its full lifecycle
- [ ] Can trace a journey instance step by step through its logs

---

## Phase 3: Metrics & Analytics

**Goal:** Dashboard-ready aggregate data — how are journeys performing, how are emails landing.

**Why third:** Phases 1-2 give you control and detail. This phase gives you the bird's-eye view for decision-making.

### Endpoints

| # | Endpoint | Purpose |
|---|---|---|
| 3.1 | `GET /v1/admin/metrics/overview` | System summary: total contacts, active journeys, emails sent (24h/7d/30d), bounce rate, unsubscribe rate |
| 3.2 | `GET /v1/admin/metrics/journeys` | Per-journey: enrolled, completed, failed, exited counts + completion rate + avg duration |
| 3.3 | `GET /v1/admin/metrics/journeys/:id` | Single journey funnel: enrolled → email sent → opened → clicked + drop-off at each step |
| 3.4 | `GET /v1/admin/metrics/emails` | Per-template: sent, delivered, opened, clicked, bounced counts + rates |
| 3.5 | `GET /v1/admin/metrics/emails/deliverability` | Deliverability trends: delivery rate, bounce rate, complaint rate over time |
| 3.6 | `GET /v1/admin/metrics/events` | Event volume by name over time (for capacity planning and understanding traffic patterns) |

### Schema Changes
- Consider materialized views or TimescaleDB continuous aggregates for time-series metrics
- Add indexes for common metric queries (status counts by journey, email counts by template)

### Acceptance Criteria
- [ ] Can get system-wide stats in a single call
- [ ] Can see per-journey completion and failure rates
- [ ] Can see email deliverability trends over time
- [ ] Can identify underperforming journeys or templates
- [ ] Metrics queries perform under 500ms on 100k+ records

---

## Phase 4: Bulk Operations & Data Management

**Goal:** Operate at scale — import contacts, replay events, retry failures.

### Features

| # | Feature | Purpose |
|---|---|---|
| 4.1 | `POST /v1/admin/contacts/import` | Bulk CSV/JSON import with upsert semantics |
| 4.2 | `GET /v1/admin/contacts/export` | Export contacts as CSV/JSON (streamed, filterable) |
| 4.3 | `POST /v1/admin/events/replay` | Replay events by ID or filter (re-runs through ingest pipeline) |
| 4.4 | `POST /v1/admin/emails/:id/resend` | Retry a failed email send |
| 4.5 | `POST /v1/admin/journeys/:id/enroll/batch` | Batch enroll multiple users |
| 4.6 | Event deduplication | Idempotency key on ingest to prevent duplicate events |

### Schema Changes
- Add `idempotencyKey` column to `userEvents` with unique constraint
- Add `importJobs` table for tracking async import progress

### Acceptance Criteria
- [ ] Can import 10k contacts from CSV without timeout
- [ ] Can export contacts with filters
- [ ] Can replay a specific event or set of events
- [ ] Can retry a bounced/failed email
- [ ] Duplicate events are rejected with idempotency key

---

## Phase 5: Auth, Audit & Security Hardening

**Goal:** Multi-user access with proper authentication, audit trail, and key management.

### Features

| # | Feature | Purpose |
|---|---|---|
| 5.1 | Multi-key API auth | Generate, revoke, and rotate admin API keys |
| 5.2 | Key scoping | Per-key permissions (read-only, journey-admin, full-admin) |
| 5.3 | Audit log | Track all admin actions: who did what, when, from where |
| 5.4 | Soft delete | Contacts and journey states soft-deleted (recoverable) |
| 5.5 | Rate limiting | Per-key rate limits on admin and ingest endpoints |

### Schema Changes
- `apiKeys` table: id, name, keyHash, scopes[], createdBy, createdAt, revokedAt, lastUsedAt
- `auditLogs` table: id, actor, action, resource, resourceId, detail JSONB, timestamp, ipAddress

### Acceptance Criteria
- [ ] Can create and revoke API keys
- [ ] Keys have scoped permissions (read vs write vs admin)
- [ ] All admin actions are logged with actor and detail
- [ ] Deleted contacts can be recovered within 30 days
- [ ] Rate limits enforced per key

---

## Phase 6: Alerting & Monitoring

**Goal:** Know when things go wrong before users tell you.

> **Update (post-outbound-destinations).** The durable outbound webhook spine
> now covers much of 6.1/6.4: any subscriber (including a `kind="slack"`
> destination) can receive `email.bounced` / `email.complained` and the rest of
> the catalog with retry/backoff/DLQ. Remaining alerting work is threshold *rules*
> (e.g. "bounce rate > X%"), not the delivery transport.

### Features

| # | Feature | Purpose |
|---|---|---|
| 6.1 | Webhook alerting | Fire webhooks on: journey failure, high bounce rate, delivery issues |
| 6.2 | Alert rules | Configurable thresholds: bounce rate > X%, failed journeys > N in Y minutes |
| 6.3 | Health check expansion | `/v1/health` includes: DB connectivity, Redis status, Hatchet connectivity, queue depth |
| 6.4 | Slack/email notifications | Built-in notification channels for alerts |
| 6.5 | Dead letter queue | Failed events/tasks captured for inspection and retry |

### Schema Changes
- `alertRules` table: id, type, threshold, channel, enabled
- `alertHistory` table: id, ruleId, triggeredAt, detail, acknowledged

### Acceptance Criteria
- [ ] Alerts fire when bounce rate exceeds threshold
- [ ] Failed journey tasks are captured and retryable
- [ ] Health endpoint reports dependency status
- [ ] Can configure alert channels (webhook URL, Slack, email)

---

## Phase 7: Management Dashboard

**Goal:** A UI for non-engineers to operate the platform.

**Why last:** The API phases (1-6) are independently useful — engineers can use them directly, scripts can consume them, and a dashboard built on top of solid APIs will be maintainable. Building UI before the API is stable means rebuilding it.

### Scope
- New `apps/dashboard` — likely Next.js given the existing monorepo patterns
- Consumes the admin API built in phases 1-6
- Key screens:
  - **Overview** — system health, active journeys, recent activity, key metrics
  - **Journeys** — list, detail, enable/disable toggle, instance browser
  - **Contacts** — list, search, detail with timeline view
  - **Emails** — send history, template performance, deliverability
  - **Events** — stream/search view
  - **Settings** — API keys, alert rules, preferences

### Acceptance Criteria
- [ ] Non-technical user can see active journeys and their status
- [ ] Can enable/disable a journey from the UI
- [ ] Can view a contact's full timeline
- [ ] Can see email deliverability at a glance
- [ ] Dashboard loads within 2s on initial page load

---

## Summary Timeline

```
Phase 1: Journey Admin API          ← Unlocks: control without redeploying
Phase 2: Visibility & History       ← Unlocks: debugging, user-level investigation
Phase 3: Metrics & Analytics        ← Unlocks: performance monitoring, decision-making
Phase 4: Bulk Operations            ← Unlocks: scale operations, data management
Phase 5: Auth & Audit               ← Unlocks: multi-user, compliance, accountability
Phase 6: Alerting & Monitoring      ← Unlocks: proactive incident response
Phase 7: Management Dashboard       ← Unlocks: non-engineer operation
```

Each phase builds on the last. Phase 1 is the highest-leverage work — it turns Hogsend from a deploy-and-pray system into something you can actually operate.
