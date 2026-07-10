# Journey Engine — Full Spec

Code-first, agentic-ready lifecycle orchestration engine for teams on PostHog + a bring-your-own email provider (Resend or Postmark today, SES later). Open source. Self-hostable. Journeys are typed TypeScript objects, not YAML, not drag-and-drop canvases.

Fills the gap between "PostHog webhooks firing into a Hono handler" and "paying $500/mo for Customer.io." Built to be read, written, and modified by engineers and AI agents alike.

---

## Who This Is For

The engineer who set up PostHog, wired up Resend, and is now hand-rolling journey logic in application code because PostHog workflows aren't there yet. Small teams (1-10 eng) shipping product-led SaaS who need behavioral email sequences, not a marketing automation platform.

**Not for:** marketing teams who need a visual canvas. Enterprise orgs who need Braze/Iterable. Anyone who needs 50 integrations out of the box.

---

## Architecture

```
┌──────────────────────────────────────────────────────┐
│                    Event Sources                      │
│  PostHog webhooks ─┐                                  │
│  Internal events ──┤──→ Hono Ingestion (/ingest)      │
│  API calls ────────┘         │                        │
└──────────────────────────────┼────────────────────────┘
                               ▼
┌──────────────────────────────────────────────────────┐
│                   Journey Engine                      │
│                                                       │
│  ┌─────────────┐  ┌──────────────┐  ┌─────────────┐  │
│  │  Enrollment  │  │ State Machine │  │  Scheduler  │  │
│  │  (match      │  │ (Postgres     │  │  (BullMQ /  │  │
│  │   trigger,   │  │  journey_     │  │   pg-boss   │  │
│  │   check      │  │  states,      │  │   cron,     │  │
│  │   entry      │  │  advance,     │  │   evaluate  │  │
│  │   limits)    │  │  exit)        │  │   pending)  │  │
│  └──────┬──────┘  └──────┬───────┘  └──────┬──────┘  │
│         └────────────────┼─────────────────┘          │
│                          ▼                            │
│                   Action Router                       │
└──────────────────────┬───────────────────────────────┘
                       │
          ┌────────────┼────────────┬──────────────┐
          ▼            ▼            ▼              ▼
   ┌──────────┐ ┌──────────┐ ┌──────────┐  ┌──────────┐
   │  Resend  │ │ PostHog  │ │ Webhook  │  │  Enroll  │
   │  Email   │ │  Event   │ │  (HTTP)  │  │  Another │
   │  Send    │ │  Push    │ │          │  │  Journey │
   └────┬─────┘ └──────────┘ └──────────┘  └──────────┘
        │
   ┌────┴─────────────────────────────────┐
   │         Email Pipeline               │
   │  React Email render                  │
   │  → Link rewrite (tracking URLs)      │
   │  → Open pixel inject                 │
   │  → Resend API send                   │
   └──────────────────────────────────────┘
        │
   ┌────┴─────────────────────────────────┐
   │       Tracking Endpoints             │
   │  /track/open/:id   → log + 1x1 GIF  │
   │  /track/click/:id  → log + 302       │
   │  /unsubscribe/:token → prefs page    │
   └──────────────────────────────────────┘
```

---

## Stack

| Concern | Tool |
|---|---|
| Runtime | Hono (Node.js — needs BullMQ; Workers is an option later with different queue strategy) |
| State | Postgres |
| Job queue / scheduler | BullMQ + Redis, or pg-boss if skipping Redis |
| Event source | PostHog (webhooks + API) |
| Email delivery | Bring-your-own `EmailProvider` (Resend or Postmark today; SES later) |
| Email templates | React Email |
| Journey definitions | TypeScript (.ts files, typed objects) |
| Link / open tracking | Self-hosted Hono endpoints |
| Deploy | Railway (Postgres + Redis + Hono service) or self-hosted Docker |

---

## Data Model

```sql
-- ============================================
-- Core tables
-- ============================================

-- Where each user is in each journey
CREATE TABLE journey_states (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id         TEXT NOT NULL,
  user_email      TEXT NOT NULL,
  journey_id      TEXT NOT NULL,
  current_node    TEXT NOT NULL,
  status          TEXT NOT NULL DEFAULT 'active'
                    CHECK (status IN ('active', 'completed', 'exited', 'paused', 'error')),
  entered_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  node_entered_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  next_eval_at    TIMESTAMPTZ,
  context         JSONB DEFAULT '{}',
  error_message   TEXT,
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE(user_id, journey_id, status)  -- one active instance per journey per user
);

CREATE INDEX idx_journey_pending
  ON journey_states (next_eval_at)
  WHERE status = 'active' AND next_eval_at IS NOT NULL;

CREATE INDEX idx_journey_user
  ON journey_states (user_id, status);

-- Every state transition logged immutably
CREATE TABLE journey_logs (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id         TEXT NOT NULL,
  journey_id      TEXT NOT NULL,
  from_node       TEXT,
  to_node         TEXT,
  action_type     TEXT,       -- send_email | evaluate_condition | wait_started | wait_completed | exit | error
  result          JSONB,      -- email_id, condition_result, error details, etc.
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX idx_logs_user_journey
  ON journey_logs (user_id, journey_id, created_at DESC);

-- ============================================
-- Email tracking
-- ============================================

-- Every email sent
CREATE TABLE email_sends (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id         TEXT NOT NULL,
  user_email      TEXT NOT NULL,
  journey_id      TEXT,
  journey_node    TEXT,
  template_key    TEXT NOT NULL,
  subject         TEXT NOT NULL,
  resend_id       TEXT,
  sent_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
  opened_at       TIMESTAMPTZ,
  clicked_at      TIMESTAMPTZ,
  bounced_at      TIMESTAMPTZ,
  complained_at   TIMESTAMPTZ
);

CREATE INDEX idx_sends_user ON email_sends (user_id, sent_at DESC);
CREATE INDEX idx_sends_resend ON email_sends (resend_id);

-- Every link in every email, for click tracking
CREATE TABLE tracked_links (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  send_id         UUID NOT NULL REFERENCES email_sends(id) ON DELETE CASCADE,
  original_url    TEXT NOT NULL,
  click_count     INT DEFAULT 0,
  first_clicked   TIMESTAMPTZ,
  last_clicked    TIMESTAMPTZ
);

CREATE INDEX idx_links_send ON tracked_links (send_id);

-- Individual click events (for analytics, optional but useful)
CREATE TABLE link_clicks (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  link_id         UUID NOT NULL REFERENCES tracked_links(id) ON DELETE CASCADE,
  clicked_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  user_agent      TEXT,
  ip_hash         TEXT  -- hashed, not raw, for GDPR
);

-- ============================================
-- User preferences & suppression
-- ============================================

CREATE TABLE email_preferences (
  user_id         TEXT PRIMARY KEY,
  unsubscribed    BOOLEAN DEFAULT false,
  categories      JSONB DEFAULT '{}',
  -- e.g. { "marketing": true, "product_updates": true, "digest": true }
  -- true = opted in, false = opted out
  bounce_count    INT DEFAULT 0,
  suppressed      BOOLEAN DEFAULT false,  -- hard suppression (bounce/complaint)
  suppressed_at   TIMESTAMPTZ,
  updated_at      TIMESTAMPTZ DEFAULT now()
);

-- ============================================
-- Event store (local, for condition evaluation without hitting PostHog API)
-- ============================================

CREATE TABLE user_events (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id         TEXT NOT NULL,
  event_name      TEXT NOT NULL,
  properties      JSONB DEFAULT '{}',
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX idx_events_user_name
  ON user_events (user_id, event_name, created_at DESC);

-- Keeps condition evaluation fast and local.
-- PostHog is the source of truth; this is a hot cache
-- populated by the same webhook ingestion endpoint.
```

---

## Journey Definition Format

Journeys are TypeScript files exporting a typed `JourneyDefinition` object. They live in a `journeys/` directory. A registry file exports all active journeys as a map.

### Type System

```typescript
// journey-engine/types.ts

export interface JourneyDefinition {
  id: string;
  name: string;
  description?: string;
  enabled: boolean;

  trigger: {
    /** PostHog event name or internal event name */
    event: string;
    /** Only enroll if these property conditions also match */
    where?: PropertyCondition[];
  };

  /** How often a user can enter this journey */
  entryLimit: "once" | "once_per_period" | "unlimited";
  /** If once_per_period, minimum hours between entries */
  entryPeriodHours?: number;

  /** User exits immediately (and stops receiving) if any of these fire */
  exitOn?: Array<{
    event: string;
    where?: PropertyCondition[];
  }>;

  /** Min hours between emails within this journey. Engine checks before every send. */
  suppressHours: number;

  /** ID of the first node to execute */
  entryNode: string;

  /** All nodes, keyed by ID. Flat map — nodes reference each other by ID string. */
  nodes: Record<string, JourneyNode>;
}

// --- Nodes ---

export type JourneyNode = ActionNode | WaitNode | ConditionNode;

export interface ActionNode {
  type: "action";
  id: string;
  action: JourneyAction;
  next: string | null; // null = journey complete
}

export interface WaitNode {
  type: "wait";
  id: string;
  hours: number;
  next: string;
}

export interface ConditionNode {
  type: "condition";
  id: string;
  eval: ConditionEval;
  onTrue: string;
  onFalse: string;
}

// --- Actions ---

export type JourneyAction =
  | SendEmailAction
  | FireEventAction
  | WebhookAction
  | EnrollJourneyAction;

export interface SendEmailAction {
  type: "send_email";
  templateKey: string;
  subject: string;
  /** Category for unsubscribe preferences. Default: "marketing" */
  category?: string;
  /** Override journey-level suppressHours for this send */
  suppressHours?: number;
}

export interface FireEventAction {
  type: "fire_event";
  /** Fires both locally (user_events table) and to PostHog */
  eventName: string;
  properties?: Record<string, unknown>;
}

export interface WebhookAction {
  type: "webhook";
  url: string;
  method?: "POST" | "PUT";
  headers?: Record<string, string>;
  body?: Record<string, unknown>;
}

export interface EnrollJourneyAction {
  type: "enroll_journey";
  journeyId: string;
}

// --- Conditions ---

export type ConditionEval =
  | PropertyCondition
  | EventCondition
  | EmailEngagementCondition
  | CompositeCondition;

export interface PropertyCondition {
  type: "property";
  property: string;
  operator: "eq" | "neq" | "gt" | "gte" | "lt" | "lte" | "exists" | "not_exists" | "contains";
  value?: string | number | boolean;
}

export interface EventCondition {
  type: "event";
  /** Check local user_events table */
  eventName: string;
  /** "exists" = has this event ever been recorded. "count" = check how many times. */
  check: "exists" | "not_exists" | "count";
  operator?: "gt" | "gte" | "lt" | "lte" | "eq";
  value?: number;
  /** Only look at events within this window (hours). Omit = all time. */
  withinHours?: number;
}

export interface EmailEngagementCondition {
  type: "email_engagement";
  /** Which email (by template key) to check */
  templateKey: string;
  check: "opened" | "clicked" | "not_opened" | "not_clicked";
}

export interface CompositeCondition {
  type: "composite";
  operator: "and" | "or";
  conditions: ConditionEval[];
}
```

### Example Journey

```typescript
// journeys/activation-welcome.ts

import type { JourneyDefinition } from "../journey-engine/types";

export const activationWelcome: JourneyDefinition = {
  id: "activation-welcome",
  name: "Activation — Welcome Series",
  enabled: true,

  trigger: { event: "user.created" },
  entryLimit: "once",
  suppressHours: 12,
  exitOn: [
    { event: "user.deleted" },
  ],

  entryNode: "send_welcome",

  nodes: {
    send_welcome: {
      type: "action",
      id: "send_welcome",
      action: {
        type: "send_email",
        templateKey: "activation/welcome",
        subject: "Welcome to Acme — your first lap in 5 minutes",
      },
      next: "wait_48h",
    },

    wait_48h: {
      type: "wait",
      id: "wait_48h",
      hours: 48,
      next: "check_pitgpt",
    },

    check_pitgpt: {
      type: "condition",
      id: "check_pitgpt",
      eval: {
        type: "event",
        eventName: "pitgpt.message_sent",
        check: "exists",
      },
      onTrue: "send_pitgpt_advanced",
      onFalse: "send_pitgpt_explainer",
    },

    send_pitgpt_advanced: {
      type: "action",
      id: "send_pitgpt_advanced",
      action: {
        type: "send_email",
        templateKey: "activation/pitgpt-advanced",
        subject: "Your first session is in — here's what PitGPT found",
      },
      next: "wait_48h_2",
    },

    send_pitgpt_explainer: {
      type: "action",
      id: "send_pitgpt_explainer",
      action: {
        type: "send_email",
        templateKey: "activation/pitgpt-explainer",
        subject: "You haven't tried PitGPT yet — here's what it does",
      },
      next: "wait_48h_2",
    },

    wait_48h_2: {
      type: "wait",
      id: "wait_48h_2",
      hours: 48,
      next: "send_community",
    },

    send_community: {
      type: "action",
      id: "send_community",
      action: {
        type: "send_email",
        templateKey: "activation/community",
        subject: "5,000 sim racers are waiting for you",
      },
      next: null,
    },
  },
};
```

### Journey Registry

```typescript
// journeys/index.ts

import type { JourneyDefinition } from "../journey-engine/types";
import { activationWelcome } from "./activation-welcome";
import { reactivationDormant } from "./reactivation-dormant";
import { pbCelebration } from "./pb-celebration";
import { freeToProConversion } from "./free-to-pro";

export const journeyRegistry: Record<string, JourneyDefinition> = {
  [activationWelcome.id]: activationWelcome,
  [reactivationDormant.id]: reactivationDormant,
  [pbCelebration.id]: pbCelebration,
  [freeToProConversion.id]: freeToProConversion,
};
```

Adding a journey = write a `.ts` file, add it to the registry, deploy. An AI agent can do this with a single file write.

### Replay-safety (exactly-once side effects)

Journeys run as Hatchet durable tasks that **replay-from-top** on a worker crash, OOM, or redeploy (every push to `main`). Side effects between durable waits — `sendEmail()`, `ctx.trigger()` — must therefore be exactly-once across a replay, or a redeploy mid-journey re-delivers an email.

The engine guarantees this automatically, with **zero authoring change in the common case** (each template sent once per enrollment). Two defense-in-depth layers, both fed by one shared content-derived key:

- **Layer 2 (primary, version-independent)** — each send/trigger is auto-keyed by the enrollment's **replay-stable Hatchet run id** + the nearest authored wait/checkpoint label + the templateKey/event. The run id (not the freshly-minted `journeyStates.id`) is the anchor because a replay-from-top of a journey whose prior enrollment is TERMINAL would otherwise mint a new state row and a non-colliding key; on replay the engine **recovers the existing enrollment by run id** so the same id and the same key are re-derived. That deterministic key is threaded into the existing `email_sends`/`user_events` unique-index dedup, so a replayed effect short-circuits to the prior row instead of re-dispatching. The key is content/label-derived (never positional), so it is robust to the branch and clock divergence a replay can introduce. The auto-keying lives in the tracked mailer, so even a journey that calls the raw `getEmailService().send(...)` (bypassing the `sendEmail()` helper) is covered.
- **Layer 1 (fast path, eviction-gated)** — the same key is also run through Hatchet's durable `memo`, skipping the effect entirely before the DB is touched. Active only on engine >= v0.80.0 (DURABLE_EVICTION); below that it cleanly no-ops and Layer 2 carries the guarantee. Logged once at boot.

Scope: exactly-once is scoped to **replays of the same durable run**. A genuinely new trigger delivery that spawns a separate run is a new enrollment and (for `unlimited` / elapsed `once_per_period` journeys) legitimately sends again — that is re-enrollment, not a duplicate.

**The only authoring rule:** if you send the SAME template (or trigger the SAME event) more than once in one journey on divergent branches that share a nearest wait label, pass a distinct `idempotencyLabel` per call. The engine throws a loud intra-run key-collision error if two sites derive the same key, so the footgun is caught in dev — never a silently dropped message.

`getPostHog()?.identify()` is replay-safe (a `$set` upsert); prefer a recorded timestamp (e.g. the matched event's `occurredAt` from `ctx.waitForEvent`) over `new Date()` for any value it writes.

**Non-deterministic decisions** — if a journey makes a non-deterministic choice (LLM, RNG, time-bucketing) whose output selects the send template or trigger event (i.e. becomes the dedup key's discriminant), wrap it in `ctx.once(key, compute)`. `ctx.once` records the computed value in the enrollment's state row the first time and replays it verbatim thereafter — durable on ANY engine — so a replay re-derives the SAME choice (and the SAME send key) instead of delivering a duplicate-but-different message.

**Windowed primitives** — `ctx.digest({ window, event?, where?, maxEvents? })` aggregates a fixed window of trigger events into ONE execution: the first event enrolls, same-name events during the window are absorbed by the active-enrollment guard (spawning no new run) and collected at flush, and the flushed set is recorded set-once so a replay returns it verbatim instead of rescanning — the "batch" grouping is plain TypeScript (`Object.groupBy`) over the result. The window (≤ 720h) is never tier-gated. `ctx.throttle({ limit, window, category? })` is an ADVISORY windowed send-count check (by recipient email) the journey branches on; its verdict is recorded set-once and replayed verbatim, so a replay branches identically even though the run's own sends have since landed in the window. Advisory only — the client-level `frequencyCap` remains the hard send-time backstop.

**Connector actions** — `sendConnectorAction()` (Telegram/Discord) has NO Layer-2 DB backstop (no deliveries table yet), so it is exactly-once only via Layer-1 memo when the engine supports eviction; on a pre-eviction engine a replay can still double-send a connector message. A Layer-2 backstop is a documented follow-up. Do not rely on connector exactly-once in degraded mode.

---

## Engine Core

### Event Ingestion

```
POST /ingest
Body: { event: string, userId: string, properties: Record<string, unknown> }
Source: PostHog webhook action, or direct API call from your app
```

On every inbound event, the engine does three things:

1. **Store locally.** Insert into `user_events` table. This is the hot cache for condition evaluation so we don't hammer PostHog's API on every cron tick.

2. **Check enrollment.** Scan `journeyRegistry` for any journey whose `trigger.event` matches. For each match:
   - Check `trigger.where` conditions if present
   - Check `entryLimit` against `journey_states` (has this user already done this journey?)
   - Check `email_preferences` (is user suppressed/unsubscribed?)
   - If all pass → insert into `journey_states` at `entryNode`, queue immediate evaluation

3. **Check active journeys.** Query `journey_states` for this user where `status = 'active'`. For each:
   - Does this event match any `exitOn` condition? → Exit the journey, set status = 'exited'
   - Is the user on a `condition` node that this event might satisfy? → Re-evaluate immediately instead of waiting for cron

This gives real-time advancement on behavioral events. The cron handles time-based waits; webhooks handle everything else.

### Node Evaluation

The engine evaluates one node at a time per user per journey. A single evaluation pass:

```
1. Load journey definition from registry
2. Load current node from journey_states
3. Evaluate based on node type:

   WAIT node:
     - Has (node_entered_at + hours) elapsed?
     - Yes → advance to node.next
     - No → set next_eval_at = node_entered_at + hours, return

   CONDITION node:
     - Evaluate node.eval (see Condition Evaluation below)
     - Result true → advance to node.onTrue
     - Result false → advance to node.onFalse

   ACTION node:
     - Execute the action (see Action Execution below)
     - If action succeeds → advance to node.next (or complete if null)
     - If action fails → set status = 'error', log, alert

4. After advancing, immediately evaluate the new node too
   (chain through instant nodes without waiting for next cron tick)
   Guard: max 10 advances per evaluation to prevent infinite loops.

5. Log every transition to journey_logs
```

### Condition Evaluation

```
PropertyCondition:
  → Check event properties / journey context against operator/value
  → e.g. plan = "pro", login_count >= 10

EventCondition:
  → Query local user_events table
  → "exists": SELECT 1 FROM user_events WHERE user_id = $1 AND event_name = $2
  → "count": SELECT COUNT(*) ... with optional withinHours filter
  → Fast, no external API call

EmailEngagementCondition:
  → Query email_sends table
  → "opened": WHERE template_key = $1 AND user_id = $2 AND opened_at IS NOT NULL
  → "not_opened": WHERE ... AND opened_at IS NULL

CompositeCondition:
  → Evaluate each sub-condition
  → Combine with AND/OR operator
```

### Action Execution

```
send_email:
  1. Check suppression:
     - Is user in email_preferences with unsubscribed = true? → Skip
     - Is user suppressed (bounce/complaint)? → Skip
     - Has user received an email in the last N hours? → Reschedule
  2. Render React Email template with context data
  3. Rewrite links (see Link Tracking below)
  4. Inject open tracking pixel
  5. Call Resend API
  6. Insert into email_sends with resend_id
  7. Log to journey_logs

fire_event:
  1. Insert into local user_events table
  2. Emit on the durable outbound spine (emitOutbound) — fanned out to every
     subscribed destination, PostHog included via a kind="posthog" destination
     (NOT a fire-and-forget POST to /capture anymore; see "Outbound" above)
  3. This closes the loop — email engagement data flows back into PostHog
     for cohorts, dashboards, and (eventually) ad audience sync

webhook:
  1. POST/PUT to configured URL with configured headers/body
  2. Template body with journey context (e.g. {{userId}}, {{context.lapTime}})
  3. Log response status

enroll_journey:
  1. Trigger enrollment into another journey for this user
  2. Same enrollment checks apply (entry limits, suppression)
  3. Enables journey chaining without duplicating logic
```

### Scheduler

A repeatable job (BullMQ or pg-boss) that runs every 60 seconds:

```sql
SELECT * FROM journey_states
WHERE status = 'active'
AND next_eval_at <= now()
ORDER BY next_eval_at ASC
LIMIT 100;
```

For each row, run the node evaluation pass. Process in batches to avoid long-running transactions. If a batch takes longer than the interval, the next tick skips (BullMQ handles this with `removeOnComplete`).

Additional scheduled jobs:

```
Every 24h: "dormancy detector"
  → Query PostHog or local user_events for users with no activity in 14 days
  → Fire internal event "user.dormant_14d" for each
  → This triggers the reactivation journey via normal enrollment

Every 1h: "stuck journey detector"
  → SELECT * FROM journey_states
     WHERE status = 'active'
     AND updated_at < now() - interval '7 days'
  → Alert (log, webhook, Slack) — something is probably wrong

Every 24h: "suppression cleanup"
  → Check Resend for bounce/complaint webhooks that might have been missed
  → Update email_preferences accordingly
```

---

## Email Pipeline

### Template Rendering

Templates are React Email components. Each template receives a typed props object that includes user data and journey context.

```typescript
// templates/activation/welcome.tsx

import { Html, Head, Body, Container, Text, Button, Img } from "@react-email/components";

interface WelcomeEmailProps {
  userName: string;
  trackingPixelUrl: string;
  unsubscribeUrl: string;
}

export const WelcomeEmail = ({ userName, trackingPixelUrl, unsubscribeUrl }: WelcomeEmailProps) => (
  <Html>
    <Head />
    <Body>
      <Container>
        <Text>Hey {userName},</Text>
        <Text>Welcome to Acme. Let's get your first lap recorded.</Text>
        <Button href="https://example.com/setup">Get Started</Button>
        <Text style={{ fontSize: "12px", color: "#666" }}>
          <a href={unsubscribeUrl}>Unsubscribe</a>
        </Text>
        <Img src={trackingPixelUrl} width="1" height="1" alt="" />
      </Container>
    </Body>
  </Html>
);
```

Template registry maps `templateKey` → component. The engine renders to HTML string via `@react-email/render`, then runs the link rewriter.

### Link Rewriting

After rendering HTML, before sending:

```typescript
function rewriteLinks(html: string, sendId: string): { html: string; links: TrackedLink[] } {
  const links: TrackedLink[] = [];

  const rewritten = html.replace(
    /href="(https?:\/\/[^"]+)"/g,
    (match, url) => {
      // Don't rewrite unsubscribe links or tracking pixel
      if (url.includes("/unsubscribe/") || url.includes("/track/")) {
        return match;
      }

      const linkId = generateUUID();
      links.push({ id: linkId, sendId, originalUrl: url });
      return `href="${TRACKING_BASE_URL}/track/click/${linkId}"`;
    }
  );

  return { html: rewritten, links };
}
```

After rewriting, batch insert all `links` into `tracked_links` table, then send via Resend.

### Open Tracking Pixel

Injected before `</body>`:

```typescript
function injectOpenPixel(html: string, sendId: string): string {
  const pixel = `<img src="${TRACKING_BASE_URL}/track/open/${sendId}" width="1" height="1" style="display:block" alt="" />`;
  return html.replace("</body>", `${pixel}</body>`);
}
```

**Known limitation:** Apple Mail Privacy Protection pre-fetches images, inflating open rates on iOS/macOS. Open tracking is directional, not precise. Never branch a journey solely on email opens — use clicks or product events instead.

---

## Tracking Endpoints

### Open Tracking

```
GET /track/open/:sendId

1. Look up email_sends by id = sendId
2. UPDATE email_sends SET opened_at = now() WHERE id = sendId AND opened_at IS NULL
   (first-touch, for open-rate reporting)
3. Emit "email.opened" on the outbound spine PER-HIT (every open) — fanned out
   to every subscribed destination, PostHog included via kind="posthog"
4. Return 1x1 transparent GIF
   Content-Type: image/gif
   Cache-Control: no-store, no-cache, must-revalidate
   Body: [47 bytes, smallest valid GIF]
```

### Click Tracking

```
GET /track/click/:linkId

1. Look up tracked_links by id = linkId
2. If found:
   - UPDATE tracked_links SET click_count = click_count + 1, last_clicked = now(),
     first_clicked = COALESCE(first_clicked, now())
   - INSERT INTO link_clicks (link_id, user_agent, ip_hash)
   - UPDATE email_sends SET clicked_at = COALESCE(clicked_at, now()) WHERE id = send_id (first-touch)
   - Emit "email.clicked" on the outbound spine PER-HIT (every click) — fanned out
     to every subscribed destination, PostHog included via kind="posthog"
3. 302 redirect to tracked_links.original_url
4. If not found: 302 redirect to app homepage (graceful fallback)
```

### Unsubscribe

```
GET /unsubscribe/:token

Token is a signed JWT containing: { userId, category? }

1. Decode and verify JWT
2. If category specified:
   - Update email_preferences.categories[category] = false
3. If no category (global unsub):
   - Update email_preferences.unsubscribed = true
4. Show simple confirmation page ("You've been unsubscribed")
5. Optional: show preference center (checkboxes for each category)

Also support:
POST /unsubscribe/:token  — for one-click unsubscribe (List-Unsubscribe-Post header)
```

Every email must include:
- Visible unsubscribe link in footer
- `List-Unsubscribe` header (Resend supports this)
- `List-Unsubscribe-Post` header for one-click (RFC 8058)

---

## PostHog Integration

### Inbound: PostHog → Engine

Set up PostHog webhook actions for the events you care about:

```
PostHog Action: "User Created"
  → Webhook: POST https://your-engine.com/ingest
  → Body: { event: "user.created", userId: "{{person.distinct_id}}", properties: { ... } }

PostHog Action: "PitGPT Message Sent"
  → Webhook: POST https://your-engine.com/ingest
  → Body: { event: "pitgpt.message_sent", userId: "{{person.distinct_id}}", properties: { ... } }

PostHog Action: "Lap Recorded"
  → Webhook: POST https://your-engine.com/ingest
  → ...
```

Alternatively: use PostHog's webhook destination to forward ALL events to your ingestion endpoint, and let the engine filter by what it needs. Noisier but simpler to configure.

### Outbound: Engine → PostHog (and any subscriber) via destinations

> **Updated since the original spec.** The engine no longer pushes events back to
> PostHog with a fire-and-forget `pushToPostHog`/`captureEvent` call. Outbound
> events flow on a **durable webhook spine** (retry / backoff / DLQ / reaper), and
> PostHog is now just one **destination** on it — a peer, not a privileged center.

The contact/email/journey/bucket lifecycle is emitted on the outbound spine as a
fixed catalog (`contact.*`, `email.*`, `journey.completed`, `bucket.*`). Each
subscriber is a `webhook_endpoints` row whose `kind` selects a delivery-time
transform:

- `kind="webhook"` (default) — a signed Standard-Webhooks POST to a subscriber URL.
- `kind="posthog"` — fan out to a PostHog project's capture endpoint. Credentials
  (`{ apiKey, host?, eventNames? }`) live per-endpoint in `webhook_endpoints.config`,
  never env vars. `ENABLE_POSTHOG_DESTINATION=true` auto-seeds one subscribed to
  the email funnel (with an `email.clicked → email.link_clicked` remap to keep
  legacy PostHog insights working).
- `kind="segment"` / `kind="slack"` — shipped presets gated by
  `ENABLED_DESTINATION_PRESETS`.
- A custom transport — author it in code with `defineDestination()` and register it
  via `createHogsendClient({ destinations })`.

The shipped email catalog: `email.sent`, `email.delivered` (the canonical
"received" signal), `email.opened` / `email.clicked` (fanned out **per-hit**, every
open/click), `email.bounced`, and `email.complained`.

This means:
- PostHog (or Segment, Slack, a CRM, a warehouse) gets the full email funnel
  durably — dashboards can show email funnel metrics alongside product metrics.
- You can build PostHog cohorts like "users who opened the welcome email but
  haven't recorded a lap".
- Those cohorts can feed PostHog's Meta Conversions API integration for ad
  targeting (ad-platform CAPI stays deferred to PostHog's CDP — destinations are
  for event fan-out, not CAPI).
- Journey conditions can reference previous journey engagement ("did they open the
  last email?").

The journey-context `ctx.posthog.capture` / `ctx.identify` shims have been
**removed** — `JourneyContext` exposes orchestration primitives only. The PostHog
provider's remaining roles are the identity *pull* (`getPersonProperties` for
per-user timezone resolution) and the opt-in `bucket.syncToPostHog` mirror; event
fan-out to PostHog is now a `kind="posthog"` destination on the outbound spine.

---

## Email Provider Webhook Handling

Email is delivered through a provider-neutral `EmailProvider` (Resend and Postmark today; SES later), so delivery webhooks are provider-agnostic. Each provider's webhook arrives at the id-dispatched route `POST /v1/webhooks/email/:providerId`, where the provider's `verifyWebhook` (owning its own secret — svix for Resend, HTTP-Basic for Postmark) normalizes the verbatim payload into a provider-neutral `EmailEvent` before the engine handles it. Only `delivered`/`bounced`/`complained` come from the provider — opens/clicks are first-party and sovereign (see `docs/tracking.md`). Full design: `docs/byo-email-provider.md`. `POST /v1/webhooks/resend` is kept as a deprecated thin alias.

```
POST /v1/webhooks/email/:providerId   (e.g. /v1/webhooks/email/resend)

Events to handle:
- email.delivered → update email_sends (optional, for deliverability metrics)
- email.bounced → update email_sends.bounced_at
  - If hard bounce: set email_preferences.suppressed = true
  - Increment bounce_count; suppress at 3+ bounces
- email.complained → update email_sends.complained_at
  - Immediately: set email_preferences.suppressed = true
  - This user reported spam. Never email them again unless they explicitly re-opt-in.

The provider verifies its own webhook (signature or basic-auth) and normalizes the
payload; the engine then dispatches the resulting `EmailEvent`.
```

---

## Global Suppression Logic

Before every email send, the engine runs this check:

```typescript
async function canSendEmail(userId: string, journeySuppressHours: number, actionSuppressHours?: number): Promise<{
  allowed: boolean;
  reason?: string;
}> {
  // 1. Global unsubscribe
  const prefs = await getEmailPreferences(userId);
  if (prefs?.unsubscribed) return { allowed: false, reason: "unsubscribed" };
  if (prefs?.suppressed) return { allowed: false, reason: "suppressed_bounce_complaint" };

  // 2. Category check (if the email action specifies a category)
  // if (category && prefs?.categories[category] === false)
  //   return { allowed: false, reason: "category_opted_out" };

  // 3. Frequency cap: any email in the last N hours?
  const suppressHours = actionSuppressHours ?? journeySuppressHours;
  const recentSend = await getRecentSend(userId, suppressHours);
  if (recentSend) return { allowed: false, reason: "frequency_cap" };

  // 4. Global daily cap (safety net): max 3 emails per user per 24h
  const dailyCount = await getDailySendCount(userId);
  if (dailyCount >= 3) return { allowed: false, reason: "daily_cap" };

  return { allowed: true };
}
```

If suppressed due to frequency cap, the engine reschedules `next_eval_at` to when the cap expires, rather than skipping the send entirely.

### Channel preferences & connector gating

`email_preferences.categories` is a shared preference namespace across delivery channels, not just email topics. Lists have a `kind`: author-defined `defineList` topics, plus engine **auto-registered channels** (`kind: "channel"`, opt-out) — `in_app` always, and one per member-directed connector (`telegram`, `discord`). Channels are managed through the same `POST /v1/lists/:id/(un)subscribe` endpoints; `in_app` is reserved and a `defineList` id may not collide with a channel id (both throw at boot). The account-wide `unsubscribedAll` master is writable at `POST /v1/lists/preferences` (same identity gate as list writes).

Enforcement follows the channel:
- **Email** — the send gate above (`unsubscribed` / category opt-out) reads an aggregated multi-row preference record, so a suppression imported under `(email, email)` counts.
- **In-app feed** — gated on the `in_app` channel via the same aggregated read.
- **Member-directed connector actions** (`sendConnectorAction` → Discord `dmMember`, Telegram `dm`/`sendMessage`) — auto-skip with a typed `ConnectorActionSkipped` when the resolved contact has `unsubscribedAll` or opted out of that connector's channel. Ops actions (roles, broadcasts, channel messages) and sends with no resolvable contact are never gated. The verdict is replay-stable.

A **journey** stamps its sends with `meta.category` (default `journey`), boot-validated fail-closed against the list namespace; a channel list is never a valid email category or a campaign audience.

---

## Hono Route Map

```typescript
// routes/index.ts

app.post("/ingest", ingestHandler);              // PostHog webhook + direct events
app.get("/track/open/:sendId", openTrackHandler); // Open pixel
app.get("/track/click/:linkId", clickTrackHandler); // Click redirect
app.get("/unsubscribe/:token", unsubPageHandler);  // Unsub preference page
app.post("/unsubscribe/:token", unsubActionHandler); // One-click unsub
app.post("/webhooks/resend", resendWebhookHandler); // Resend delivery events

// Admin / debug API (protect with auth)
app.get("/api/journeys", listJourneysHandler);           // List all journey definitions
app.get("/api/journeys/:id", getJourneyHandler);          // Get one journey + stats
app.get("/api/users/:userId/journeys", userJourneysHandler); // Where is this user in all journeys?
app.post("/api/users/:userId/enroll", manualEnrollHandler);  // Manually enroll a user
app.post("/api/users/:userId/exit", manualExitHandler);      // Manually exit a user
app.get("/api/stats", globalStatsHandler);                   // Sends today, open rate, etc.
```

---

## Observability

### Logging

Every transition is in `journey_logs`. For operational monitoring:

```
- Engine evaluation errors → structured log + alert
- Resend API failures → structured log + retry via BullMQ
- PostHog API failures → structured log + fallback to local data
- Suppression events → structured log (useful for debugging "why didn't they get the email?")
```

### Debug API

The admin endpoints let you answer:
- "Why didn't user X get email Y?" → Check journey_logs for suppression reasons
- "Where is user X in the welcome journey?" → journey_states query
- "How many users are in the activation journey right now?" → aggregate query

### Metrics (push to PostHog)

```
journey_engine.evaluation.count — how many nodes evaluated per tick
journey_engine.evaluation.duration_ms — how long each tick takes
journey_engine.sends.count — emails sent per hour
journey_engine.sends.suppressed — emails suppressed per hour (by reason)
journey_engine.errors.count — action failures per hour
```

---

## What's NOT in V1

- **Visual journey builder** — journeys are `.ts` files. Read-only graph visualization is a nice-to-have; render with mermaid from the typed object if you want it.
- **Ad platform audience sync** — use PostHog's existing Meta Conversions API integration. Build custom audience push when you need it.
- **A/B testing** — defer. When you need it: randomly assign variant in action node, store in context, track by variant in logs.
- **In-app notifications** — future channel adapter. Add a `push_in_app` action type when ready.
- **Multi-tenant** — single-tenant for now. Multi-tenant (managed hosting) is a monetization unlock, not a V1 feature.
- **Template editor UI** — templates are React Email components in the repo. No WYSIWYG.
- **Rate limiting on ingestion** — add if you open the API publicly. Not needed for PostHog webhook source.

---

## Implementation Order

| Day | Deliverable |
|---|---|
| 1 | Postgres migrations, table creation, basic Hono scaffold |
| 2 | Journey type definitions, journey parser, registry loader |
| 3 | Event ingestion endpoint, local event store, enrollment logic |
| 4 | State machine: node evaluation loop (wait, condition, action) |
| 5 | BullMQ scheduler: cron evaluation of pending journey_states |
| 6 | Resend adapter: render React Email → HTML → send |
| 7 | Link rewriting + click tracking endpoint |
| 8 | Open tracking pixel endpoint |
| 9 | Suppression: email_preferences, frequency cap, daily cap |
| 10 | Unsubscribe endpoint + Resend webhook handler (bounce/complaint) |
| 11 | PostHog event push-back (close the loop) |
| 12 | Admin/debug API endpoints |
| 13 | First 3 React Email templates (welcome, pitgpt explainer, community) |
| 14 | Activation welcome journey live on Acme |

Post-launch:
- Week 3: PB celebration + reactivation journeys
- Week 3: Extract engine into standalone npm package
- Week 4: Open source, README, "deploy to Railway" button
- Week 4: Show HN + YouTube video

---

## Go-to-Market

### Positioning

"Code-first lifecycle engine for teams on PostHog + Resend."

Not competing with Customer.io, Braze, or Iterable. Competing with the hand-rolled webhook handlers that every PostHog user eventually writes. The target user has already chosen PostHog (product analytics), already chosen Resend (transactional email), and needs behavioral journeys without buying a third SaaS.

### Differentiation

1. **Agentic-native.** Journeys are typed TypeScript objects in `.ts` files. An AI agent (Claude Code, Cursor, Copilot) can create, modify, and reason about journeys. No proprietary format, no visual-only builder. This is real, not marketing.

2. **PostHog-native.** Bi-directional sync. Events flow in from PostHog, engagement data flows back. Cohorts based on email engagement. Journey conditions that reference PostHog person properties. No one else does this because PostHog workflows is supposed to do it but doesn't yet.

3. **Self-hostable, single-binary.** Postgres + Redis + one Node process. Deploy to Railway in 5 minutes. No vendor lock-in. Your data stays yours.

### Launch Channels

1. **GitHub** — clean repo, strong README with architecture diagram, quickstart, example journey, deploy button
2. **Hacker News** — "Show HN: Open-source lifecycle engine for PostHog users (because Workflows isn't there yet)"
3. **PostHog community** — Slack, GitHub discussions, community integrations page
4. **YouTube** — "I built my own Customer.io in 2 weeks" walkthrough
5. **Reddit** — r/selfhosted, r/SaaS, r/devops
6. **Twitter/X** — build-in-public thread, tag PostHog team

### Monetization (Later)

Managed hosting. Same open-source engine, deployed and maintained for you. $49-99/mo includes Postgres, Redis, monitoring, auto-scaling. Don't build this until you have 500+ GitHub stars and inbound demand. The architecture already supports it — just needs tenant isolation and a billing layer.

---

## Naming

**Hogsend** — Post**Hog** + Re**send**. Code-first lifecycle engine that connects the two.

- npm: `hogsend`
- Domain: hogsend.dev (or hogsend.com)
- GitHub: github.com/hogsend