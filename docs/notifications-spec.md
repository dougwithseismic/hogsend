# Real-Time Notifications — Product Spec

In-app notifications for teams already on PostHog. Event fires, journey runs, notification appears in the user's browser — no polling, no third-party service, no vendor lock-in.

PostHog tells you what happened. Hogsend reacts to it in real-time.

---

## Who This Is For

The engineer who has PostHog tracking events and Hogsend orchestrating journeys, and now wants to close the loop with the user — show them something in the UI without waiting for an email to land. Teams shipping product-led SaaS who want in-app notifications without bolting on Novu, Knock, or a $200/mo notification service.

**Not for:** teams who need omnichannel orchestration across SMS/push/Slack from day one. That comes later via plugins. This is the browser-first foundation.

---

## What We're Building

Three things:

### 1. @hogsend/js — Browser SDK

Zero-dependency vanilla JavaScript/TypeScript client. Two distribution modes:

**npm package** — for apps built with Next.js, Vite, Remix, or any bundler:
```typescript
import { HogsendClient } from "@hogsend/js";

const hogsend = new HogsendClient({
  apiKey: "pk_live_abc123",
  userId: currentUser.id,
  baseUrl: "https://api.hogsend.com",
});

hogsend.on("notification", (n) => {
  showToast(n.title, n.body);
});
```

**Script tag** — for Framer, Webflow, static sites, or any page with a `<script>` tag:
```html
<script src="https://api.hogsend.com/v1/sdk.js"></script>
<script>
  const hogsend = new Hogsend.HogsendClient({
    apiKey: "pk_live_abc123",
    userId: "user_123",
    baseUrl: "https://api.hogsend.com",
  });
  hogsend.on("notification", function(n) {
    alert(n.title);
  });
</script>
```

The API serves the script at `/v1/sdk.js` with cache headers. No CDN dependency.

**Client capabilities:**
- SSE connection for real-time delivery (auto-reconnect with backfill on reconnect)
- Local notification state (list, unread count)
- Mark as read / mark all as read
- Event emitter: `notification`, `notification:read`, `connected`, `disconnected`, `error`
- `destroy()` for cleanup

### 2. @hogsend/react — React Hooks + Components

Wraps @hogsend/js with React primitives. No extra dependencies beyond React 18+.

**Provider + hooks:**
```tsx
<HogsendProvider apiKey="pk_live_abc123" userId={user.id} baseUrl="https://api.hogsend.com">
  <NotificationBell />
  <App />
</HogsendProvider>
```

```tsx
function NotificationBell() {
  const count = useUnreadCount();
  return <button>Notifications {count > 0 && <span>{count}</span>}</button>;
}

function NotificationPanel() {
  const { notifications, markAsRead, markAllAsRead } = useNotifications();
  return (
    <div>
      <button onClick={markAllAsRead}>Mark all read</button>
      {notifications.map((n) => (
        <div key={n.id} onClick={() => markAsRead(n.id)}>
          <strong>{n.title}</strong>
          <p>{n.body}</p>
        </div>
      ))}
    </div>
  );
}
```

**Hooks:**
- `useHogsend()` — raw client instance
- `useNotifications()` — reactive list + actions
- `useUnreadCount()` — reactive badge number

**Optional pre-built components** (unstyled, data-attribute-based for easy CSS targeting):
- `NotificationBell` — button with badge count
- `NotificationCenter` — scrollable notification list with render props

### 3. Backend — Notification Service + Real-Time Delivery

Notifications are a **standalone service**, not part of the journey context. The journey context stays lean with orchestration primitives. Notifications are called directly from anywhere — journey code, route handlers, Hatchet tasks, cron jobs.

```typescript
// In a journey
import { notifications } from "../lib/notifications.js";

const journey = defineJourney({
  meta: { id: "activation-welcome", ... },
  async run(user, ctx) {
    await ctx.email.send(user, { template: "welcome", subject: "Welcome!" });
    await ctx.sleep({ duration: days(2) });

    // Standalone call — not on ctx
    await notifications.send({
      userId: user.id,
      title: "Complete your profile",
      body: "Add a photo and bio to get the most out of the platform.",
      actionUrl: "/settings/profile",
      type: "action",
    });
  },
});
```

```typescript
// In a route handler
app.post("/v1/something", async (c) => {
  const { notifications } = c.get("container");
  await notifications.send({
    userId: "user_123",
    title: "Export ready",
    body: "Your CSV export is ready to download.",
    data: { downloadUrl: "/exports/abc.csv" },
  });
});
```

---

## Architecture

```
                    Server Side
 ┌──────────────────────────────────────────────────────┐
 │                                                      │
 │  Journey / Route Handler / Hatchet Task              │
 │    │                                                 │
 │    ▼                                                 │
 │  notifications.send({ userId, title, ... })          │
 │    │                                                 │
 │    ├──→ INSERT into notifications table (Postgres)   │
 │    │                                                 │
 │    └──→ PUBLISH to Redis channel                     │
 │           notifications:{userId}                     │
 │                                                      │
 └──────────────────────────────────────────────────────┘
                        │
                Redis Pub/Sub
                        │
 ┌──────────────────────────────────────────────────────┐
 │  API Process                                         │
 │                                                      │
 │  GET /v1/notifications/stream (SSE)                  │
 │    │                                                 │
 │    ├──→ Validate publishable key + userId            │
 │    ├──→ Subscribe to Redis notifications:{userId}    │
 │    ├──→ Stream events to client via SSE              │
 │    └──→ Heartbeat every 30s                          │
 │                                                      │
 │  GET  /v1/notifications         (list, paginated)    │
 │  POST /v1/notifications/:id/read (mark read)        │
 │  POST /v1/notifications/read-all (mark all read)    │
 │  GET  /v1/sdk.js                (serve JS bundle)   │
 │                                                      │
 └──────────────────────────────────────────────────────┘
                        │
                   SSE / REST
                        │
 ┌──────────────────────────────────────────────────────┐
 │  Browser                                             │
 │                                                      │
 │  @hogsend/js (or @hogsend/react)                     │
 │    │                                                 │
 │    ├──→ EventSource to /v1/notifications/stream      │
 │    ├──→ On message: update local store, fire events  │
 │    ├──→ On reconnect: GET /v1/notifications?since=X  │
 │    └──→ markAsRead / markAllAsRead via REST           │
 │                                                      │
 └──────────────────────────────────────────────────────┘
```

**Why Redis pub/sub between worker and API:** The Hatchet worker (where journeys run) and the API (where SSE connections live) are separate processes. Redis pub/sub bridges them. Worker publishes, API subscribes and fans out to connected clients. No new infrastructure — Redis is already in the stack.

**Why SSE, not WebSockets:** SSE is simpler, works through CDN/proxies natively, auto-reconnects in browsers, and is sufficient for server→client notifications. We don't need bidirectional communication.

---

## Auth Model

**Publishable key** — a non-secret identifier for the Hogsend deployment (like Stripe's `pk_live_*`). Set via `HOGSEND_PUBLISHABLE_KEY` env var. Embedded in frontend code. Does not grant write access to anything — only allows reading notifications scoped to a userId and subscribing to SSE.

**userId** — identifies which user's notifications to serve. Passed by the frontend alongside the publishable key. Maps to `contacts.externalId` in the database.

Both are passed as query params on SSE (EventSource can't set headers) and as headers (`X-Hogsend-Key`, `X-Hogsend-User`) or query params on REST endpoints.

**v1 threat model:** The publishable key prevents random external connections. A user can only read notifications addressed to their own userId. Notifications are read-only from the client — the client cannot create, modify, or delete notifications, only mark them as read. For single-tenant deployments this is sufficient.

**Future (v2):** HMAC-signed user tokens for multi-tenant deployments where userId guessing is a concern. The server signs `userId + timestamp` with a secret, the frontend passes the signed token instead of a raw userId.

---

## Data Model

```sql
CREATE TYPE notification_type AS ENUM ('info', 'success', 'warning', 'error', 'action');

CREATE TABLE notifications (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id     TEXT NOT NULL,
  type        notification_type NOT NULL DEFAULT 'info',
  title       TEXT NOT NULL,
  body        TEXT,
  data        JSONB DEFAULT '{}',
  action_url  TEXT,
  journey_id  TEXT,
  read        BOOLEAN NOT NULL DEFAULT false,
  read_at     TIMESTAMPTZ,
  expires_at  TIMESTAMPTZ,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Primary query: unread notifications for a user, newest first
CREATE INDEX notifications_user_read_created_idx
  ON notifications (user_id, read, created_at DESC);

-- General user lookup
CREATE INDEX notifications_user_id_idx
  ON notifications (user_id);

-- TTL cleanup of expired notifications
CREATE INDEX notifications_expires_at_idx
  ON notifications (expires_at)
  WHERE expires_at IS NOT NULL;
```

**Fields:**
- `type` — controls how the client renders the notification. `info` is default, `action` implies a clickable CTA.
- `data` — arbitrary JSON payload the client can use for rendering (icons, metadata, deep link params).
- `action_url` — optional URL the notification links to. Client decides how to handle (navigate, open modal, etc.).
- `journey_id` — traces the notification back to the journey that created it. Nullable for non-journey notifications.
- `expires_at` — optional TTL. Expired notifications are excluded from queries and cleaned up periodically.

---

## Notification Service API

The service is a standalone module, added to the DI container, usable from anywhere server-side.

```typescript
interface NotificationService {
  send(opts: {
    userId: string;
    title: string;
    body?: string;
    type?: "info" | "success" | "warning" | "error" | "action";
    data?: Record<string, unknown>;
    actionUrl?: string;
    journeyId?: string;
    expiresAt?: Date;
  }): Promise<{ id: string; createdAt: string }>;

  list(opts: {
    userId: string;
    limit?: number;   // default 50
    offset?: number;
    read?: boolean;    // filter by read status
    since?: string;    // ISO timestamp, for backfill on reconnect
  }): Promise<Notification[]>;

  markRead(opts: { id: string; userId: string }): Promise<void>;
  markAllRead(opts: { userId: string }): Promise<void>;
  getUnreadCount(opts: { userId: string }): Promise<number>;
}
```

`send()` does two things: inserts into the database, then publishes to Redis `notifications:{userId}` for real-time delivery. Every other method is a direct database query.

---

## REST API

All endpoints require a valid publishable key and userId.

```
GET  /v1/notifications
  Query: limit (default 50), offset, read (boolean), since (ISO timestamp)
  Response: { notifications: Notification[], total: number }

POST /v1/notifications/:id/read
  Response: { ok: true }

POST /v1/notifications/read-all
  Response: { ok: true, count: number }

GET  /v1/notifications/stream
  Query: apiKey, userId
  Response: SSE stream
  Events: connected, notification, heartbeat

GET  /v1/sdk.js
  Response: JavaScript (IIFE bundle)
  Cache-Control: public, max-age=3600, s-maxage=86400
```

---

## SDK Packages

### @hogsend/js

| Property | Value |
|---|---|
| Dependencies | None (zero-dep) |
| Browser target | ES2020 |
| Bundle formats | ESM (.mjs) + CJS (.cjs) + IIFE (.global.js) |
| IIFE global | `window.Hogsend` |
| Estimated size | ~8-12KB minified |
| Transport | EventSource (SSE) + fetch (REST) |

### @hogsend/react

| Property | Value |
|---|---|
| Dependencies | @hogsend/js (peer) |
| Peer deps | react >=18, react-dom >=18 |
| Bundle format | ESM only |
| Components | Unstyled, data-attribute-based |
| State management | useSyncExternalStore (no external state lib) |

---

## Connection Lifecycle

**Connect:**
1. SDK creates `EventSource` to `/v1/notifications/stream?apiKey={key}&userId={id}`
2. API validates key + userId, subscribes to Redis channel
3. API sends `event: connected`
4. SDK fires `connected` callback
5. SDK calls `GET /v1/notifications?limit=50` to populate initial state

**Receive:**
1. Server-side code calls `notifications.send()`
2. Notification inserted into DB + published to Redis
3. API's Redis subscriber receives message, forwards via SSE
4. SDK receives `event: notification`, adds to local store, fires callbacks

**Reconnect:**
1. Connection drops (network, server restart)
2. SDK fires `disconnected` callback
3. EventSource auto-reconnects (browser built-in, ~3s default)
4. On reconnect, SDK receives `event: connected`
5. SDK calls `GET /v1/notifications?since={lastTimestamp}` to backfill
6. Deduplicates by notification ID, fires callbacks only for new items

**Heartbeat:**
- Server sends `event: heartbeat` every 30s
- Prevents proxies (Cloudflare, nginx, Railway) from killing idle connections
- SDK ignores heartbeat events silently

---

## What This Enables

**Journey-driven notifications:**
```typescript
// User hasn't completed onboarding after 2 days
await notifications.send({
  userId: user.id,
  type: "action",
  title: "Finish setting up your workspace",
  body: "You're 2 steps away from getting started.",
  actionUrl: "/onboarding",
});
```

**Operational notifications from route handlers:**
```typescript
// Long-running export finishes
await notifications.send({
  userId: requestingUser.id,
  type: "success",
  title: "Export complete",
  body: "Your data export is ready to download.",
  data: { exportId: "abc-123" },
});
```

**Real-time feedback during feature rollout:**
```typescript
// Feature flag enabled for user, show them what's new
await notifications.send({
  userId: user.id,
  type: "info",
  title: "New: Dashboard analytics",
  body: "We just enabled advanced analytics for your account.",
  actionUrl: "/dashboard",
});
```

---

## What We're NOT Building (Yet)

- **Push notifications** (mobile/desktop) — future plugin, same pattern as plugin-resend
- **Email notifications** — already handled by the journey email system
- **Notification preferences per user** — v2, needs a preferences UI
- **Multi-tenant routing** — v2, needs HMAC-signed tokens
- **Visual notification builder** — this is code-first, like everything else in Hogsend
- **Delivery guarantees beyond at-least-once** — SSE + REST backfill is sufficient. If a notification is missed in real-time, it's caught on the next fetch.
