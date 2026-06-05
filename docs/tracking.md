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

Tracking endpoints don't just write to the DB — they push events through the full ingest pipeline. This means:

1. **PostHog gets the events** — opens and clicks appear on the person timeline in PostHog, enabling cohort building and analytics
2. **Journeys can react** — journey code can check `ctx.history.hasEvent({ event: "email.opened" })` to branch based on engagement
3. **Exit conditions work** — if a journey has `exitOn: [{ event: "email.link_clicked" }]`, clicking a link can exit the user from a journey

### Events Pushed

| Endpoint | Event | Properties |
|----------|-------|------------|
| Click (`/v1/t/c/:id`) | `email.link_clicked` | `emailSendId`, `templateKey`, `linkUrl`, `linkId` |
| Open (`/v1/t/o/:id`) | `email.opened` | `emailSendId`, `templateKey` |

Events are fire-and-forget — the redirect/GIF returns immediately, event processing happens async. Uses `resolveEmailSendContext()` which does a single `emailSends LEFT JOIN journeyStates` query to get the userId and templateKey.

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
       ↓
posthog.captureEvent()  ← sends to PostHog (buffered, sync)
       ↓
ingestEvent()  ← stores in userEvents, pushes to Hatchet,
                  checks exit conditions, upserts contact
```

## Journey Context — PostHog Integration

Journey code has direct access to PostHog through the context object:

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

## Architecture Notes

- **Deduplication**: If the same URL appears multiple times in an email, only one `tracked_links` row is created. All occurrences share the same tracking ID.
- **Idempotent opens/clicks**: `openedAt` and `clickedAt` on `emailSends` use `WHERE ... IS NULL` guards — they're set once and never overwritten.
- **Non-blocking**: tracking DB writes happen in parallel and don't delay the redirect/pixel response.
- **Engine-owned mailer**: `prepareTrackedHtml` is part of the engine-owned `createTrackedMailer` (in `@hogsend/engine`). The email provider is a dumb `EmailProvider` — the contract lives in `@hogsend/core` (canonical author import `@hogsend/engine`), and `@hogsend/plugin-resend` exports `createResendProvider`, the reference implementation. Link/open tracking, preference checks, and the `email_sends` write all live in the engine and come along regardless of which provider you supply.
- **Analytics in the client**: The PostHog-style analytics service is initialized once at startup by `createHogsendClient` and available as `client.analytics`. Tracking endpoints and journey context both use it from there.
- **Graceful degradation**: All PostHog operations are no-ops when `POSTHOG_API_KEY` is not set. Tracking still works (DB writes + ingest events), just without PostHog sync.

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
