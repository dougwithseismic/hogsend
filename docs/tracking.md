# Email Tracking — Link Clicks & Open Tracking

First-party link click tracking and email open tracking. Every outgoing email gets its links rewritten to redirect through your API, and a 1x1 tracking pixel injected for open detection. All tracking data lives in your database — no third-party dependencies.

## How It Works

```
Template render → HTML string
                    ↓
            rewriteLinks()
              - extract all <a href="..."> tags
              - deduplicate URLs
              - bulk INSERT tracked_links rows
              - single-pass regex replace: hrefs → /v1/t/c/:linkId
            injectOpenPixel()
              - append <img src="/v1/t/o/:emailSendId"> before </body>
                    ↓
            Modified HTML → Resend API
```

When a recipient opens the email or clicks a link:

- **Open**: email client loads the pixel → `GET /v1/t/o/:emailSendId` → sets `emailSends.openedAt` (first-open-wins) → returns 1x1 transparent GIF
- **Click**: email client follows link → `GET /v1/t/c/:linkId` → records `link_clicks` row (IP, user agent, timestamp), increments `tracked_links.clickCount`, sets `emailSends.clickedAt` → 302 redirects to original URL

## First-Party Domain

Tracking URLs use `API_PUBLIC_URL` as the base — e.g., `https://api.hogsend.com/v1/t/c/:id`. Since this is your own subdomain:

- No third-party cookie issues
- Better deliverability (links point to your domain, not a tracking service)
- Full control over the data

If you're using the default `api.hogsend.com` CNAME → Railway setup, tracking works automatically. If self-hosting, set `API_PUBLIC_URL` to your API's public URL.

## Setup

No additional setup required beyond what's already configured. Tracking is enabled automatically when:

1. `API_PUBLIC_URL` is set (defaults to `http://localhost:3002`)
2. `RESEND_WEBHOOK_SECRET` is set (enables the tracked email service)

Emails sent through `emailService.send()` (the tracked path) automatically get link rewriting and pixel injection. The Hatchet task path (`sendEmailTask`) does not — it's the simple/direct path.

## Database Tables

### `tracked_links`

One row per unique URL per email. Created at send time.

| Column | Type | Description |
|--------|------|-------------|
| `id` | UUID | Primary key — used in tracking URL |
| `email_send_id` | UUID | FK → `email_sends` |
| `original_url` | TEXT | The original destination URL |
| `click_count` | INTEGER | Denormalized click counter |
| `created_at` | TIMESTAMP | When the link was created |

### `link_clicks`

One row per click event. Append-only.

| Column | Type | Description |
|--------|------|-------------|
| `id` | UUID | Primary key |
| `tracked_link_id` | UUID | FK → `tracked_links` |
| `ip_address` | TEXT | Client IP (from `x-forwarded-for`) |
| `user_agent` | TEXT | Client user agent string |
| `clicked_at` | TIMESTAMP | When the click happened |

### `email_sends` (existing, tracking fields)

| Column | Description |
|--------|-------------|
| `opened_at` | Set on first open pixel load |
| `clicked_at` | Set on first link click |

## API Endpoints

### `GET /v1/t/c/:id` — Click Tracking

Looks up the tracked link, records a click, and redirects.

- **Response**: `302` redirect to original URL
- **Fallback**: unknown link IDs redirect to `API_PUBLIC_URL`
- **Records**: `link_clicks` row + `tracked_links.clickCount` increment + `emailSends.clickedAt` (first click only)

### `GET /v1/t/o/:id` — Open Tracking

Records an email open and returns a tracking pixel.

- **Response**: `200` with `image/gif` (42 bytes), `Cache-Control: no-store`
- **Records**: `emailSends.openedAt` (first open only — subsequent requests are no-ops)

## What Gets Skipped

These URLs are never rewritten:

- **Unsubscribe links** — URLs containing `/v1/email/unsubscribe`
- **Preference links** — URLs containing `/v1/email/preferences`
- **Non-HTTP** — `mailto:`, `tel:`, etc. (regex only matches `https?://`)

## Event Loop — PostHog + Journey Integration

Tracking endpoints don't just write to the DB — they push events through the full ingest pipeline AND emit them on the durable outbound spine. This means:

1. **PostHog gets the events** — opens and clicks reach PostHog **per-hit** (every open, every click, not first-touch) as a `kind="posthog"` outbound destination subscribed to `email.opened`/`email.clicked`. There is NO separate fire-and-forget `captureEvent` anymore (removed in the Phase 2 cutover): PostHog rides the same durable, retried delivery spine as every other destination, so it gets exactly one copy of each hit.
2. **Journeys can react** — journey code can check `ctx.history.hasEvent({ event: "email.opened" })` to branch based on engagement
3. **Exit conditions work** — if a journey has `exitOn: [{ event: "email.link_clicked" }]`, clicking a link can exit the user from a journey

### Events Pushed

The tracking endpoints emit on TWO paths from one resolved send context:

- **Internal bus** (`ingestEvent` → journey routing + `userEvents`) uses the engine's first-party event names — click is `email.link_clicked`, open is `email.opened`.
- **Outbound spine** (`emitOutbound` → every subscribed destination incl. PostHog) uses the **canonical catalog names** — click is `email.clicked`, open is `email.opened`.

| Endpoint | Internal-bus event | Outbound-spine (canonical) event | Properties |
|----------|--------------------|----------------------------------|------------|
| Click (`/v1/t/c/:id`) | `email.link_clicked` | `email.clicked` | `emailSendId`, `templateKey`, `linkUrl`, `linkId` |
| Open (`/v1/t/o/:id`) | `email.opened` | `email.opened` | `emailSendId`, `templateKey` |

Both paths are fire-and-forget — the redirect/GIF returns immediately, event processing happens async. They share a single `resolveEmailSendContext()` call (one `emailSends LEFT JOIN journeyStates` query) for the userId and templateKey.

#### Canonical name + PostHog event-name remap

`email.clicked` is the **canonical** outbound name (the legacy fire-and-forget PostHog path captured clicks as `email.link_clicked`). To keep PostHog insights that were built on the old name matching, a `kind="posthog"` destination accepts an optional `config.eventNames` remap, applied to the envelope type before the capture body is built. It defaults to identity (no remap):

```jsonc
// kind="posthog" endpoint config — preserve legacy click insights
{
  "apiKey": "phc_…",
  "host": "https://us.i.posthog.com",
  "eventNames": { "email.clicked": "email.link_clicked" }
}
```

### How It Flows

```
Email client clicks link
       ↓
GET /v1/t/c/:id
       ↓
Record click (link_clicks, clickCount, clickedAt)  ← DB writes
       ↓
Return 302 redirect  ← response sent immediately
       ↓  (fire-and-forget)
resolveEmailSendContext()  ← single JOIN query
       ├─ ingestEvent("email.link_clicked")  ← internal bus: userEvents,
       │                                        Hatchet routing, exit conditions
       └─ emitOutbound("email.clicked")  ← durable spine: one delivery row per
                                            subscribed destination (PostHog via
                                            the kind="posthog" capture adapter,
                                            retried/backoff/DLQ like any webhook)
```

## Journey Context — PostHog Integration (DEPRECATED shims)

> **Deprecated.** `ctx.identify` and `ctx.posthog.capture` are PostHog-specific
> shims kept for backwards compatibility. They remain because PostHog
> `$set`/`$unset` identity semantics have no vendor-neutral envelope
> representation yet, but they are single-vendor, fire-and-forget calls. For
> fanning user/event data out to product + data tools, prefer **outbound
> DESTINATIONS** on the durable spine — the email/contact/journey/bucket
> lifecycle is delivered durably (retry/backoff/DLQ) to PostHog, Segment, Slack
> and any subscriber, keyed by `webhook_endpoints.kind`. See "Email lifecycle on
> the outbound spine" below.

Journey code has direct (deprecated) access to PostHog through the context
object:

### `ctx.identify(properties)`

Set person properties on PostHog for the current journey user. PostHog is the source of truth for person properties — this does NOT write to the local DB.

```typescript
run: async (user, ctx) => {
  ctx.identify({ onboarding_step: "completed", plan: "pro" });
}
```

No-op when `POSTHOG_API_KEY` is not configured.

### `ctx.posthog.capture({ event, properties? })`

Fire a custom PostHog event for the current user. Useful for journey-specific analytics that don't need to go through the ingest pipeline.

```typescript
run: async (user, ctx) => {
  ctx.posthog.capture({
    event: "journey.activation_complete",
    properties: { duration_days: 7 },
  });
}
```

No-op when `POSTHOG_API_KEY` is not configured.

### `ctx.trigger()` vs `ctx.posthog.capture()`

| Method | Where it goes | Use case |
|--------|--------------|----------|
| `ctx.trigger()` | Internal ingest pipeline (Hatchet + event store + exit conditions) | Cross-journey triggers, internal events |
| `ctx.posthog.capture()` | PostHog only | Analytics, person timeline events |

Use `ctx.trigger()` when other journeys need to react to the event. Use `ctx.posthog.capture()` for pure analytics.

## Using Tracking Events in Journeys

```typescript
import { Events } from "../constants/events.js";
import { days } from "@hogsend/core";

const journey = defineJourney({
  meta: {
    id: "activation-welcome",
    name: "Activation Welcome",
    trigger: { event: Events.USER_CREATED },
    entryLimit: { type: "once" },
  },
  run: async (user, ctx) => {
    await sendEmail({
      to: user.email,
      userId: user.id,
      template: "welcome",
      subject: "Welcome!",
    });

    await ctx.sleep({ duration: days(2), label: "wait-for-open" });

    // Check if they opened the welcome email
    const { found: opened } = await ctx.history.hasEvent({
      userId: user.id,
      event: Events.EMAIL_OPENED,
      within: days(2),
    });

    if (!opened) {
      await sendEmail({
        to: user.email,
        userId: user.id,
        template: "reminder",
        subject: "Did you see our welcome email?",
      });
    }

    // Check if they clicked any link
    const { found: clicked } = await ctx.history.hasEvent({
      userId: user.id,
      event: Events.EMAIL_LINK_CLICKED,
      within: days(3),
    });

    if (clicked) {
      ctx.identify({ activated: true });
      ctx.posthog.capture({ event: "journey.user_activated" });
    }
  },
});
```

## Email lifecycle on the outbound spine

The full email lifecycle fans out to every subscribed DESTINATION (a
`webhook_endpoints` row keyed by `kind` — `posthog`, `segment`, `slack`, or a
plain signed `webhook`) on the durable outbound spine, with the same
retry/backoff/DLQ machinery as every webhook delivery. The catalog of email
events a destination can subscribe to:

| Canonical event | Meaning | Touch semantics |
|-----------------|---------|-----------------|
| `email.sent` | Accepted by the provider for delivery | once per send |
| `email.delivered` | Provider confirmed delivery to the recipient's mailbox | once per send |
| `email.opened` | Open pixel loaded | **per-hit** — EVERY open |
| `email.clicked` | Tracked link followed | **per-hit** — EVERY click |
| `email.bounced` | Hard/soft bounce reported by the provider | once per send |

Two product decisions are baked into this:

- **`email.delivered` is the canonical "email was received" signal.** When you
  need "did this user actually receive the message" (vs merely "we sent it"),
  subscribe a destination to `email.delivered`, not `email.sent`.
- **Every destination receives EVERY open and click — per-hit, not
  first-touch.** The first-party `emailSends.openedAt` / `clickedAt` columns are
  still first-touch (set once via the `WHERE ... IS NULL` guard, for open/click
  *rate* reporting), but the OUTBOUND `email.opened` / `email.clicked` deliveries
  fire on every hit so downstream tools see the full engagement stream. This is
  intentional and differs from the first-touch DB columns.

This is why fan-out belongs on destinations rather than the deprecated
`ctx.posthog.capture` / `ctx.identify` shims: a destination gets the whole
lifecycle durably, for any number of subscribers, without journey code mirroring
state into one vendor by hand.

## Architecture Notes

- **Deduplication**: If the same URL appears multiple times in an email, only one `tracked_links` row is created. All occurrences share the same tracking ID.
- **Idempotent opens/clicks**: `openedAt` and `clickedAt` on `emailSends` use `WHERE ... IS NULL` guards — they're set once and never overwritten.
- **Non-blocking**: tracking DB writes happen in parallel and don't delay the redirect/pixel response.
- **Engine-owned mailer**: `prepareTrackedHtml` is part of the engine-owned `createTrackedMailer` (in `@hogsend/engine`). The email provider is a dumb `EmailProvider` — the contract lives in `@hogsend/core` (canonical author import `@hogsend/engine`), and `@hogsend/plugin-resend` exports `createResendProvider`, the reference implementation. Link/open tracking, preference checks, and the `email_sends` write all live in the engine and come along regardless of which provider you supply.
- **Analytics in the client**: The PostHog-style analytics service is initialized once at startup by `createHogsendClient` and available as `client.analytics`. Journey context (`ctx.identify`/`ctx.posthog.capture`) uses it directly. As of the Phase 2 cutover the tracking endpoints (open/click) NO LONGER call `client.analytics` for opens/clicks — those reach PostHog per-hit via a `kind="posthog"` outbound destination on the durable spine, not a direct `captureEvent`.
- **Graceful degradation**: The direct `client.analytics` operations (journey context) are no-ops when `POSTHOG_API_KEY` is not set. Tracking still works (DB writes + ingest events + outbound spine), and PostHog open/click sync only happens if a `kind="posthog"` destination is configured for those events.

## Querying Tracking Data

```sql
-- Links and clicks for an email
SELECT tl.original_url, tl.click_count, lc.ip_address, lc.clicked_at
FROM tracked_links tl
LEFT JOIN link_clicks lc ON lc.tracked_link_id = tl.id
WHERE tl.email_send_id = '<email-send-id>'
ORDER BY lc.clicked_at DESC;

-- Open rate for a template
SELECT
  COUNT(*) AS total,
  COUNT(opened_at) AS opened,
  ROUND(COUNT(opened_at)::numeric / COUNT(*) * 100, 1) AS open_rate
FROM email_sends
WHERE template_key = 'activation-welcome';

-- Click-through rate
SELECT
  COUNT(*) AS total,
  COUNT(clicked_at) AS clicked,
  ROUND(COUNT(clicked_at)::numeric / COUNT(*) * 100, 1) AS ctr
FROM email_sends
WHERE template_key = 'activation-welcome';

-- Top clicked links across all emails
SELECT tl.original_url, SUM(tl.click_count) AS total_clicks
FROM tracked_links tl
GROUP BY tl.original_url
ORDER BY total_clicks DESC
LIMIT 20;
```
