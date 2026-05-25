# Platform Audit — Hogsend

Last updated: 2026-05-25

A complete assessment of what Hogsend has implemented, what's partially done, and what's missing for production marketing activation use.

---

## 1. What's Working (Production-Ready Core)

### Event Ingestion & Routing
- `POST /v1/ingest` accepts events, stores in `userEvents`, routes to Hatchet
- Hatchet matches events to journey trigger declarations automatically
- Exit conditions evaluated on every ingest (checks `exitOn` rules on active journeys)
- Contact auto-upsert on ingest (creates or updates `lastSeenAt`, merges properties)
- Property condition evaluation: eq, neq, gt, gte, lt, lte, exists, not_exists, contains

### Journey Execution
- `defineJourney()` pattern with full TypeScript control flow
- Entry guards: trigger conditions, entry limits (once/once_per_period/unlimited), email preference checks
- State machine in DB: active → waiting → active → completed/exited/failed
- Journey logs track node transitions and actions (`journeyLogs` table)
- Context primitives: `ctx.sleep()`, `ctx.checkpoint()`, `ctx.trigger()`, `ctx.guard.isSubscribed()`
- History queries: `ctx.history.hasEvent()`, `ctx.history.journey()`, `ctx.history.email()`
- Cross-journey triggers via `ctx.trigger()`
- Active-state guard prevents concurrent enrollment in same journey

### Email Delivery & Tracking
- Full lifecycle: queued → rendered → sent → delivered → opened → clicked → bounced → complained
- Click tracking via `trackedLinks` + `linkClicks` tables (original URL, count, IP, user agent)
- Resend webhook receiver at `/v1/webhooks/resend` handles all delivery events
- Bounce suppression: contacts suppressed after 3 bounces
- One-click unsubscribe (RFC 8058) with signed token validation
- Preference center with category-level control

### Contact Management
- Full CRUD: `GET/POST/PATCH/DELETE /v1/admin/contacts`
- Search by email or externalId with pagination
- Property merging (JSONB merge on update)
- Email preferences tied to contact (unsubscribed_all, suppressed, bounce count, categories)
- `firstSeenAt` / `lastSeenAt` tracking

### Webhook Sources
- `defineWebhookSource()` extensible pattern
- PostHog webhook source implemented
- Auth via header + env key, optional Zod validation
- Transform function maps webhook payload to ingest event

### Database Schema
| Table | Purpose |
|---|---|
| `contacts` | User profiles (externalId, email, properties JSONB) |
| `journeyStates` | Journey instance tracking (status, currentNodeId, hatchetRunId, error) |
| `journeyLogs` | Node transition audit trail |
| `userEvents` | All ingested events (userId, event name, properties, timestamp) |
| `emailSends` | Email delivery lifecycle (all status timestamps) |
| `emailPreferences` | Per-user subscription and suppression state |
| `trackedLinks` | Link tracking metadata per email |
| `linkClicks` | Individual click events |
| `auth` tables | BetterAuth session management |

---

## 2. What's Partially Done (Needs Extension)

### Admin API
Currently contacts-only:
- `GET /v1/admin/contacts/` — list with pagination + search
- `GET /v1/admin/contacts/{id}` — single contact + preferences
- `POST /v1/admin/contacts/` — create
- `PATCH /v1/admin/contacts/{id}` — update
- `DELETE /v1/admin/contacts/{id}` — delete
- `GET/PUT /v1/admin/contacts/{contactId}/preferences` — read/write prefs

All require `ADMIN_API_KEY` header. No journey, event, email, or system admin endpoints.

### Observability
- `GET /v1/health` returns status, uptime, timestamp, version
- Journey state changes persisted in `journeyStates`
- Email events tracked in `emailSends`
- Hatchet dashboard available separately (localhost:8888)
- Winston logger for server-side logs

No metrics aggregation, no analytics queries, no alerting.

### Auth & Security
- Email preference tokens are signed (good)
- Resend webhook signature verification (good)
- PostHog webhook secret matching (good)
- Single `ADMIN_API_KEY` env var for all admin access (no rotation, no multi-key, no RBAC)

---

## 3. What's Missing (Not Implemented)

### Journey Management
- **No runtime enable/disable** — `ENABLED_JOURNEYS` env var requires redeploy
- **No pause/resume** for individual journey instances
- **No manual enrollment** — can't put a user into a journey via API
- **No cancel/force-exit** — can't pull someone out of a running journey
- **No journey list endpoint** — can't query which journeys exist or are enabled
- **No journey state browsing** — can't query who's in what journey at what step
- **No journey versioning** — no way to update a journey definition without affecting in-flight instances
- **No A/B testing** on journey paths

### Analytics & Metrics
- **No journey metrics** — completion rate, average duration, drop-off points
- **No email metrics** — open rate by template, click-through rate, bounce rate trends
- **No funnel view** — enrolled → email sent → opened → clicked → converted
- **No contact timeline** — all events + emails + journey history for one user in chronological order
- **No export** — can't export journey analytics or contact data

### Management UI / Dashboard
- **No dashboard app** — `apps/docs` is documentation only
- **No visual overview** of system state
- Non-technical users cannot operate the platform at all

### Bulk Operations
- **No bulk import/export** for contacts
- **No batch enrollment** into journeys
- **No event replay** — can't reprocess historical events
- **No email resend** — can't retry a failed email delivery

### API Key Management
- **No multi-key support** — single env var
- **No key rotation** mechanism
- **No per-key permissions or scoping**
- **No audit log** of API access

### Alerting & Monitoring
- **No alerts** for failed journeys, high bounce rates, delivery issues
- **No monitoring integration** (PagerDuty, Slack, etc.)
- **No performance metrics** (task execution time, queue depth)

### Data Safety
- **No audit log table** — no record of admin actions
- **No soft delete** — contact deletion is permanent
- **No event deduplication** — same event ingested twice creates two records
- **No webhook delivery logs** or retry history

---

## 4. API Endpoint Inventory

### Implemented
| Method | Path | Auth | Purpose |
|---|---|---|---|
| GET | `/v1/health` | None | Health check |
| POST | `/v1/ingest` | API Key | Event ingestion |
| POST | `/v1/webhooks/resend` | Signature | Resend delivery events |
| POST | `/v1/webhooks/:sourceId` | Per-source | Generic webhook ingestion |
| GET | `/v1/email/unsubscribe/:token` | Token | One-click unsubscribe |
| GET | `/v1/email/preferences/:token` | Token | Preference center page |
| PUT | `/v1/email/preferences/:token` | Token | Update preferences |
| GET | `/v1/admin/contacts` | Admin Key | List contacts |
| GET | `/v1/admin/contacts/:id` | Admin Key | Get contact |
| POST | `/v1/admin/contacts` | Admin Key | Create contact |
| PATCH | `/v1/admin/contacts/:id` | Admin Key | Update contact |
| DELETE | `/v1/admin/contacts/:id` | Admin Key | Delete contact |
| GET | `/v1/admin/contacts/:id/preferences` | Admin Key | Get preferences |
| PUT | `/v1/admin/contacts/:id/preferences` | Admin Key | Update preferences |

### Not Implemented (Needed)
| Method | Path | Purpose |
|---|---|---|
| GET | `/v1/admin/journeys` | List all journeys with enabled status |
| GET | `/v1/admin/journeys/:id` | Journey detail + metrics |
| PATCH | `/v1/admin/journeys/:id` | Enable/disable/pause journey |
| GET | `/v1/admin/journeys/:id/states` | List instances (active, completed, failed) |
| POST | `/v1/admin/journeys/:id/enroll` | Manually enroll a user |
| DELETE | `/v1/admin/journeys/:id/states/:stateId` | Cancel a journey instance |
| GET | `/v1/admin/contacts/:id/timeline` | Contact timeline (events + emails + journeys) |
| GET | `/v1/admin/emails` | Email send history with filters |
| GET | `/v1/admin/emails/:id` | Single email detail |
| GET | `/v1/admin/events` | Event history with filters |
| GET | `/v1/admin/metrics/journeys` | Journey completion/failure rates |
| GET | `/v1/admin/metrics/emails` | Email delivery/open/click rates |
| GET | `/v1/admin/metrics/overview` | System-wide dashboard stats |
