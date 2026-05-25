## PostHog Community Insights for Hogsend

Researched the PostHog community (posthog.com/community) for feature requests, pain points, and discussions relevant to Hogsend's email and lifecycle orchestration positioning. Findings organized by category with a prioritized opportunity matrix.

### Email & Messaging Requests

- **Surveys in emails** — 165 votes. Users want to collect survey responses via email interactions (e.g., inline rating buttons, one-click feedback). PostHog surveys exist in-app but not via email channel.
- **Messaging/push notifications** — 29 votes. Extending beyond email to push and in-app messaging. Users want a unified notification layer tied to their analytics data.
- **List-Unsubscribe headers** — compliance requirement, active discussion. RFC 8058 one-click unsubscribe is mandatory for bulk senders (Google/Yahoo enforcement). Multiple threads about proper implementation.
- **Inactivity-based email triggers** — multiple threads. "Send email if user didn't do X in Y days." Classic win-back/re-engagement pattern. No native PostHog solution.
- **Opt-out sync across tools** — keeping unsubscribes in sync when users manage preferences from external email clients or third-party tools. Broken sync = compliance risk.

### Workflow & Automation

- **Custom webhook sources** — 35 votes. Inbound webhooks triggering workflows from external systems (Stripe events, form submissions, CRM updates).
- **Custom transformations** — 19 votes. Data transformation and enrichment before acting on events. Users want to reshape payloads, merge properties, compute values.
- **Event-based feature flag targeting** — 109 votes. Dynamically adjusting feature flags based on user behavior events, not just static properties.
- **Cohort entry/exit as workflow triggers** — repeated community asks. "When a user enters cohort X, do Y." Currently no webhook or automation on cohort membership changes.
- **User property changes triggering actions** — 6+ reply thread. Detecting when a property value changes (e.g., plan upgrade, profile completion) and firing an action in response.

### Growth & Activation

- **Product tours** — 682 votes (highest voted overall). In-app onboarding activation flows. Users want to guide new users through key features with step-by-step walkthroughs.
- **Correlation analysis for cohorts** — 69 votes. Identifying which behaviors correlate with successful outcomes (activation, retention, conversion). "What do power users do differently?"
- **PostHog CRM** — 107 votes. Lightweight relationship management alongside analytics. View user timeline, add notes, track account health.
- **Customer support product** — 114 votes. Support ticketing and communication tied to user analytics context.

### Integration Pain Points (Our Opportunity)

- **PostHog <> Customer.io sync** — 16 replies, biggest email integration thread. Users struggling with event sync reliability, unidentified users leaking through to Customer.io, duplicate profiles, and stale data. Workarounds involve custom middleware. Hogsend replaces this entire integration need natively.
- **HubSpot data source issues** — bidirectional sync problems, missing events, property mapping headaches. Another integration Hogsend can displace for email use cases.
- **Brevo, DittoFeed** — custom email destination builders appearing in the community. Users building their own PostHog-to-email pipelines. Validates strong demand for first-class email integration that doesn't exist yet.

### Prioritized Opportunity Matrix

| Priority | Feature | Community Signal | Hogsend Fit |
|----------|---------|-----------------|-------------|
| Must-have | Inactivity/absence triggers | Multiple threads | OPEN QUESTION — may belong in PostHog workflows, not Hogsend (see architectural notes below) |
| Must-have | List-Unsubscribe headers + opt-out sync | Compliance blocker | Already partially handled by contacts system |
| Must-have | Surveys in emails | 165 votes | Natural journey step — embed survey in email, capture response as event |
| High | Webhook source ingestion (external events into journeys) | 35 votes | Enables PostHog workflows to trigger Hogsend journeys via webhook |
| High | Cohort-based journey triggers | Repeated asks | Depends on PostHog cohort API exposing membership changes |
| High | Property-change triggers | 6+ replies | Needs event stream diffing or periodic polling against PostHog |
| High | Push notification channel | 29 votes | New channel type beyond email in journey context |
| Medium | Product tour orchestration | 682 votes | Different product surface entirely, but Hogsend could orchestrate timing/targeting |
| Medium | CRM-lite features | 107 votes | Contact enrichment, notes, account-level views on top of existing contacts |
| Medium | Event-to-feature-flag bridge | 109 votes | PostHog API integration to toggle flags from journey logic |

### PostHog Workflow Capabilities (Research, 2026-05-25)

Deep-dive into what PostHog workflows can and can't do today, specifically around inactivity detection and external triggering.

**What PostHog workflows CAN do:**

- **Event-driven triggers** — workflows fire when a specific event occurs. This is the core mechanism — waiting for something to happen.
- **Batch triggers** — run workflows on a recurring schedule against a cohort. Evaluates audience filters at each scheduled time and executes once per matching person. This is the key mechanism for inactivity.
- **Cohort-based inactivity detection** — cohorts support "did NOT complete event X in Y days", "stopped doing an event" (lifecycle), and "did not complete a sequence". Cohorts refresh every ~24 hours.
- **Webhook dispatch** — workflow steps can fire webhooks to external APIs with custom headers and payloads.
- **Delay + condition blocks** — pause a workflow for N days, then check if a condition was met. Used in their onboarding drip campaign template.
- **Audience splits** — conditional or random branching within a workflow.

**What PostHog workflows CANNOT do:**

- **Real-time inactivity detection** — cohorts refresh every ~24 hours. No sub-hour "user hasn't done X in the last 30 minutes" capability.
- **Lifecycle as an automation trigger** — the Lifecycle feature (new, returning, resurrecting, dormant) is reporting/visualization only, not an automation trigger.
- **Complex multi-step orchestration** — workflows handle simple linear or branched flows, not durable long-running state machines with arbitrary TypeScript logic.
- **Sophisticated email management** — PostHog has basic email sending but limited templating, no engagement tracking, no preference management.

**Inactivity pattern that works TODAY:**

1. Create cohort: "users who did `signup` but NOT `onboarding_complete` in 7 days"
2. Create batch trigger: runs daily, targets that cohort
3. Dispatch: webhook to `POST /v1/ingest` with `{ event: "inactive.onboarding", userId, userEmail }`
4. Hogsend receives event → Hatchet routes to matching journey → journey executes

### Architectural Boundary (Resolved)

**PostHog detects. Hogsend acts.**

- **PostHog owns:** event collection, user identification, cohort computation, inactivity/absence detection, feature flags, session recording, A/B testing.
- **Hogsend owns:** journey state machines, email rendering + sending (Resend), multi-step orchestration (Hatchet), contact preferences, delivery tracking, engagement analytics (opens, clicks, bounces), compliance (unsubscribes, suppression).
- **The bridge:** PostHog workflow webhooks → Hogsend's `/v1/ingest` endpoint. PostHog decides WHO needs action. Hogsend decides WHAT to do about it.

Hogsend should NOT replicate PostHog's event stream, poll for inactivity, or compute cohorts. That's PostHog's job.

### Feature Decisions

#### 1. PostHog Webhook Adapter (Build This)

Our existing `/v1/ingest` endpoint already accepts `{ event, userId, userEmail, properties }`, stores the event, and pushes to Hatchet for journey routing. A PostHog workflow webhook sends a different payload shape, but it's the same concept.

**What's needed:** A thin adapter — either a separate route (`/v1/ingest/posthog-webhook`) or a header/query param on the existing endpoint — that normalizes PostHog's webhook payload format into our standard ingest shape. Estimated ~50 lines of code.

This unlocks inactivity triggers, cohort-change triggers, and any other PostHog workflow → Hogsend flow without Hogsend needing to own any detection logic.

#### 2. Plugin/Extension Pattern for Integrations (Document, Don't Build)

Community members want Brevo, HubSpot, Slack, and other integrations. Hogsend should NOT build these as first-class features — that turns us into a generic CDP competing with Customer.io and Segment.

**Approach:**
- `ctx.webhook(url, payload)` already exists in journey context — this is the v0 escape hatch for any destination.
- Document a **plugin pattern**: here's the interface, here's how you register a custom destination step, here's how you type it.
- Community maintains specific adapters (Brevo, HubSpot, Slack, etc.) as plugins.
- Hogsend stays focused on PostHog + Resend. Extensible, not bloated.

#### 3. Event-Based Opt-In for Journeys (Build This)

Currently Hogsend has opt-out (contacts/unsubscribe system). The inverse — opt-in by event — is a natural complement:

- `user_identified` → auto-subscribe to product updates
- `plan_upgraded` → subscribe to premium tips journey
- `trial_started` → subscribe to onboarding drip

**How it works:** Journey metadata declares subscription requirements. When an event fires, it can opt a user into a category. Journeys check both: "was opted in" AND "hasn't opted out." This plays well with the existing contacts system and adds a layer of intentionality — users receive emails based on their behavior, not just because they exist.

### Key Takeaway

Customer.io is the integration people fight with most in PostHog's community. The sync is unreliable, the data model mismatch causes unidentified users to leak through, and teams end up building custom middleware to bridge the gap. Hogsend replacing that entire integration layer with a native PostHog-first approach is strongly validated by community demand. The path is clear: be the email/lifecycle tool that PostHog users actually want, not another generic platform they have to sync with.

---

Source: PostHog Community (posthog.com/community) + PostHog Documentation, researched 2026-05-25
