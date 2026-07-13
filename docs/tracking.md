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
            Modified HTML → provider send wire (HTML only)
```

First-party tracking is **provider-agnostic and sovereign**: it runs identically no matter which `EmailProvider` you send through (Resend, Postmark, …). The engine rewrites links and injects the pixel itself, so it never delegates open/click tracking to the provider. Provider-native open/click tracking is forced OFF where the provider allows per-send control (e.g. Postmark `TrackOpens: false`, `TrackLinks: "None"` — `capabilities.nativeTracking: false`), and where it can't (Resend's account-level toggle — `capabilities.nativeTracking: true`) the engine logs a boot WARN telling you to disable it in the dashboard. A stray provider open/click webhook only touches DB status (first-write-wins) and is never re-emitted on the outbound spine.

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
2. An email provider is configured (e.g. `RESEND_API_KEY`, or `POSTMARK_SERVER_TOKEN` with `EMAIL_PROVIDER=postmark`). Each provider owns its own webhook secret at construction — there is no single mailer-level webhook gate

Emails sent through `emailService.send()` (the tracked path) automatically get link rewriting and pixel injection. The Hatchet task path (`sendEmailTask`) does not — it's the simple/direct path.

## Database Tables

### `tracked_links`

One row per unique (URL, semantic event, semantic properties) tuple per email.
Created at send time. Plain links dedupe by URL; two semantic links sharing an
`href` but carrying different answers get SEPARATE rows.

| Column | Type | Description |
|--------|------|-------------|
| `id` | UUID | Primary key — used in tracking URL |
| `email_send_id` | UUID | FK → `email_sends` (NULL for non-email links) |
| `sms_send_id` | UUID | FK → `sms_sends` (SMS short links; NULL otherwise) |
| `short_code` | TEXT | The `/s/:code` handle (SMS-minted rows only; partial unique) |
| `original_url` | TEXT | The original destination URL |
| `click_count` | INTEGER | Denormalized click counter |
| `event` | TEXT | Semantic event name (NULL for plain links) |
| `event_properties` | JSONB | Semantic event payload (scalars only) |
| `semantic_emitted_at` | TIMESTAMPTZ | Set once when this link's click was recorded as THE answer |
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
- **Semantic links**: when the row carries an `event`, additionally ingests the
  consumer event (first answer per send wins) and emits `email.action` on the
  outbound spine — see "Semantic links" below

### `GET /v1/t/o/:id` — Open Tracking

Records an email open and returns a tracking pixel.

- **Response**: `200` with `image/gif` (42 bytes), `Cache-Control: no-store`
- **Records**: `emailSends.openedAt` (first open only — subsequent requests are no-ops)

## What Gets Skipped

These URLs are never rewritten:

- **Unsubscribe links** — URLs containing `/v1/email/unsubscribe`
- **Preference links** — URLs containing `/v1/email/preferences`
- **Non-HTTP** — `mailto:`, `tel:`, etc. (regex only matches `https?://`)

## Touch hygiene — what can and cannot earn attribution credit

Attribution credit (the `attribution_credits` ledger) and journey triggers
ride the internal event bus; raw click **stats** (`link_clicks`, `clickCount`,
`clickedAt`, per-hit outbound webhooks) record every hit. The bus is gated,
the stats are not:

- **Opens never earn credit.** `email.opened` is not a touchpoint class —
  Apple MPP and proxy prefetch make opens too weak to carry credit.
- **Bot/prefetch clicks never reach the bus.** Every redirect route runs
  `isBotOrPrefetch` (UA + purpose headers) and the `email.link_clicked`,
  `sms.link_clicked`, and `link.clicked` bus re-ingests are all gated on it —
  an inbox security scanner (Outlook SafeLinks et al.) or a chat-app unfurl
  bot registers a click row but mints no touch and triggers no journey.
- **Semantic answers are burst-confirmed.** `email.action` is provisional for
  30s and confirmed only after the whole scanner burst is visible.
- **Arrivals require a running page.** `campaign.arrived` / `link.arrived`
  are posted by `@hogsend/js` from the landing page (bots don't execute page
  JS), and `link.arrived` is capped at one event per click ref, ever.
- **Attribution windows apply forward.** The ledger is written at conversion
  time; changing `attributionWindowDays`/`windows` affects new conversions
  only. The backfill command is the deliberate recompute path.

## Managed links (mintLink)

Email's per-send rewritten links (above) are one consumer of the click spine.
The other is **managed links** — operator-owned short links minted outside
email via `mintLink()` (engine) or `POST /v1/admin/links` (the surface behind
the Studio "Links" view). A managed link is a durable `links` row plus a
`tracked_links` click-counter row back-referencing it via `link_id`; email
links keep `link_id` NULL, so the two stay independent.

- **`mintLink({ db, url, baseUrl, source, type?, slug?, label?, campaign?, distinctId?, createdBy? })`**
  inserts both rows and returns `{ linkId, trackedLinkId, url, slug, vanityUrl }`
- **Share-safe invariant**: `distinctId` (the contact a click should stitch) is
  honored ONLY for `type: "personal"`; a `"public"` link never carries a person
- **Admin CRUD**: `GET/POST /v1/admin/links`, `GET/PATCH/DELETE /v1/admin/links/:id`.
  `PATCH originalUrl` re-targets the already-distributed short URL — it updates
  `links.originalUrl` AND every `tracked_links` row scoped by `link_id` in one
  transaction (the click route reads `tracked_links.originalUrl` fresh per hit)
- **Archive is soft**: the short URL keeps redirecting; history survives
- **Clicks emit `link.clicked`** on the outbound spine (never `email.clicked`),
  and — for personal links, human clicks only — re-ingest a first-party
  `link.clicked` bus event journeys can trigger on (filter by `linkId`/`campaign`)

### Vanity slugs — `/l/:slug`

A managed link can carry an operator-chosen slug layered over the UUID short
URL: `https://<host>/l/black-friday`.

- **Shape**: 1–64 chars of `[a-z0-9-]`, no leading/trailing hyphen. Input is
  lowercased before validation, so `/l/Black-Friday` resolves `black-friday`
- **Unique per instance** (`links.slug`, unique index). A taken slug is a `409`
  from `POST`/`PATCH`; invalid shape is a `400`
- **Lifecycle**: set at mint (`slug`), replace or clear via `PATCH`
  (`slug: null` frees it for reuse). Archived links keep their slug reserved
  and keep resolving — clearing the slug is the explicit kill switch
- **`GET /l/:slug`** (root-mounted, unauthenticated) resolves the link's
  canonical tracked row and runs the SAME click pipeline as `/v1/t/c/:id` —
  same `link_clicks` row, same counter, same events — so counts never split by
  entry path. Unknown/malformed slugs redirect to `API_PUBLIC_URL`
- Responses carry `slug` + `vanityUrl` (`${API_PUBLIC_URL}/l/:slug`)

### SMS short links — `/s/:code`

The SMS channel mints per-send short links (8-char crypto-random codes on
`tracked_links.short_code`, `sms_send_id` FK) when the tracked SMS sender
rewrites bare URLs in a rendered body. `GET /s/:code` (root-mounted,
unauthenticated) runs the SAME click pipeline: per-hit `link_clicks` +
`clickCount`, first-touch `sms_sends.clicked_at`, the per-hit `sms.clicked`
outbound event, and the `sms.link_clicked` bus re-ingest for journeys
(bot-gated). Full documentation: `docs/sms.md` § Link tracking.

### QR codes — `GET /v1/admin/links/:id/qr`

Every managed link can render a QR code (admin-authed endpoint; the Studio QR
dialog previews and downloads through it).

- **Params**: `format=svg|png` (default `svg`), `size=64..2048` (default 512),
  `transparent=true` (transparent background, both formats — for print/overlay)
- **Durable by construction**: the code encodes the link's scan URL —
  `/v1/t/c/<qr row id>` — NEVER the vanity slug. The scan row is a second
  `tracked_links` row (`source: "qr"`), lazily minted on first render and
  race-safe via a partial unique index (`tracked_links(link_id) WHERE
  source = 'qr'`). A printed code therefore survives slug changes AND
  destination re-targets (`PATCH` updates the scan row too)
- **Scans are counted separately**: link responses carry `scanCount` (QR-only
  subtotal) alongside `clickCount` (all-paths total). A scan is a normal click
  on the scan row — `source: "qr"` rides the `link.clicked` payload
- **Personal links**: the scan row copies the link's `distinctId`, so scans
  stitch the same subject as clicks (including `hs_t` when enabled)

### Per-destination stats + the QR-first lens

Print marketing needs stats to survive re-targeting: the code on the door
stays, where it leads changes, and each destination keeps its own numbers.

- **Per-hit provenance**: every `link_clicks` row stamps `destination_url` —
  the redirect target that was live when THAT hit landed (never the
  `hs_t`-tokenized variant). No retarget-history table; the stamp answers
  "stats per destination epoch" directly. Rows from before the column exist as
  a `url: null` bucket
- **`GET /v1/admin/links/:id`** returns `destinations: [{ url, clicks, scans,
  firstAt, lastAt }]`, newest activity first (the current destination leads)
- **`links.description`** (nullable) — what/where the link or its printed code
  physically is, for telling codes apart in bulk. Settable at mint + PATCH
- **`GET /v1/admin/links?hasQr=true`** — the "QR codes" lens: only links whose
  QR scan row exists. There is deliberately NO separate QR table/kind — a "QR
  code" IS a managed link whose scan row has been minted; the Studio "QR
  codes" view lists this lens and its "New QR code" flow mints a link then
  touches the QR endpoint so the row exists immediately

### Arrival attribution — `hs_ref` + `POST /v1/t/arrive`

A redirect can't recognize the visitor (their cookies live on the landing
site's domain). Opt-in per link (`links.append_ref`, default false — appended
params break strict OAuth redirect_uris): the redirect appends
`hs_ref=<link_clicks.id>` (raw per-hit UUID, provenance not identity; built in
the SAME URL pass as `hs_t` so the two never clobber each other). The landing
page reports back to `POST /v1/t/arrive` — automatic with `@hogsend/js`
(`captureRef`, default on) or server-side with a `generateUserToken`-minted
token.

- **Trust tiers** (mirrors the events route + feed recipient): `userToken` →
  verified userId, `visitor_kind='token'` (a KNOWN contact); raw anon id →
  `visitor_kind='anon'`, provenance-only — collision-checked against
  identified contacts BEFORE stamping and ingested under
  `restrictToAnonymous`. Invariant (tested): nothing the ref resolves to
  (esp. `links.distinct_id`) ever enters the contact resolver as a subject
- **First-write-wins stamp** on `link_clicks`
  (`visitor_distinct_id`/`visitor_kind`/`arrived_at`): replays re-run the
  ingest from the STAMPED identity (`idempotencyKey link:arrived:<ref>`) —
  self-healing retry, never re-attribution. Outbound fires only on the fresh
  store
- **`link.arrived`** (bus + outbound, 16th catalog event): the
  landing-confirmed SUBSET of `link.clicked` — carries the VISITOR's identity
  (`linkId` = managed `links.id`; `trackedLinkId` separate). Journeys trigger
  on it (filter `linkId`/`campaign`/`source: "qr"`)
- **Uniform response**: `200 {"ok":true}` for every outcome — no
  contact-existence oracle from an unauthenticated endpoint
- Admin detail carries `arrivalCount` + `identifiedArrivalCount`; `clicks[]`
  rows expose the stamp fields

## Semantic links — in-email answers

A plain tracked link records THAT it was clicked; a **semantic link** records
what the click MEANT. Template authors use `EmailAction` (from
`@hogsend/email`) instead of a plain anchor:

```tsx
import { EmailAction } from "@hogsend/email";

<EmailAction
  event="nps.submitted"           // consumer event name
  properties={{ score: 9 }}        // scalars only, < 2 KB JSON
  href={`${surveyUrl}?score=9`}    // where the human lands
>
  9
</EmailAction>
```

At send time `rewriteLinks` lifts the metadata into the `tracked_links` row and
**strips the attributes** — the in-HTML encoding is internal wire format; the DB
row is the contract. At click time the route emits the event through the FULL
ingest pipeline (`user_events`, Hatchet journey routing, exit checks) plus an
`email.action` envelope on the outbound spine (the PostHog preset captures it
under the CONSUMER event name with the properties flattened).

Validation at send time (violations fail the send loudly):

- Reserved namespaces are barred for `event`: `email.`, `journey.`, `bucket.`,
  `contact.` (dot or colon form).
- `properties` must be a flat object of scalars (string/number/boolean/null);
  non-scalars don't survive the Hatchet wire.
- The `href` must be absolute http(s) and not an unsubscribe/preference URL.

Answer semantics at click time:

- **First answer wins, per (send, event name)** — idempotency key
  `sem:<emailSendId>:<event>` dedupes inside `ingestEvent` BEFORE the Hatchet
  push, so journeys and destinations see at most one answer per send. An NPS
  row of 11 buttons = one answer slot. The winning link's
  `semantic_emitted_at` is stamped.
- **Deferred confirmation + scanner-burst suppression** — security scanners
  (Outlook SafeLinks, Proofpoint) follow every link within seconds. A click on
  a semantic link is therefore only a PROVISIONAL answer: a Hatchet task
  (`confirm-semantic-click`) judges it after the 30-second burst window has
  fully elapsed, counting distinct links of the send clicked in the window
  around the candidate — before AND after it. At ≥ 3 distinct links the whole
  burst (including the scanner's first click) is suppressed; the generic
  `email.link_clicked` still fires per hit. The cost is ~30s of answer
  latency, invisible to journeys waiting on day-scale timeouts. A failed
  Hatchet publish rolls back the idempotency claim, and the `email.action`
  outbound emit carries the same `sem:` key as `dedupeKey`, so task retries
  are exactly-once per endpoint. Still: don't make destructive actions
  one-click EmailActions (a scanner spreading clicks beyond the window could
  in principle slip one through).
- **The generic event is never suppressed** — a semantic click fires BOTH
  `email.link_clicked` (per hit) and the semantic event (once). They are
  different event names; don't sum them as "clicks".

Journeys react via `ctx.waitForEvent`, which returns the matched payload:

```ts
const answer = await ctx.waitForEvent({
  event: "nps.submitted",
  timeout: days(3),
});
if (!answer.timedOut && typeof answer.properties?.score === "number") {
  // branch on the score, enrich the person, trigger a follow-up journey…
}
```

Do NOT put the awaited event in `exitOn` — an exit match mid-wait aborts the
run before the post-wait branch executes.

`waitForEvent` also takes an optional `lookback` duration: the durable wait
only matches events pushed AFTER it is established, so an answer landing
between two waits (or between a send and its wait) would otherwise be missed —
and the `sem:` key means it can never re-push. With `lookback`, recent
`user_events` are checked first and a hit resolves the wait immediately,
payload included. Keep the window tight (just the gap it covers).

### The hosted answer page

A semantic link with no landing page can point at the engine:
`href={HOSTED_ANSWER_HREF}` (`hogsend://answer`, exported by
`@hogsend/email`) resolves at send time to `GET /v1/t/a/:linkId` — a minimal
engine-served page (possession of the unguessable link id is the auth, like
unsubscribe) that confirms the recorded answer and offers a free-text box.
`POST /v1/t/a/:id` (form field `comment`, ≤ 2000 chars) ingests
**`<event>.comment`** with the answer's properties attached — idempotency key
`semc:<emailSendId>:<event>`, so one comment per (send, event).

### Cross-device identity (`hs_t`)

Opt-in via `TRACKING_IDENTITY_TOKEN=true`: tracked-link redirects append a
one-hour identity token to the destination URL. The landing site exchanges it
at `POST /v1/t/identify` (`{ token } → { distinctId, emailSendId }`) and calls
`posthog.identify`, merging the email click with the web session. Tokens are
AES-256-GCM **encrypted** with `BETTER_AUTH_SECRET` — a distinct id can be an
email address, so nothing readable may travel in a URL, history entry, or
referrer. Invalid/expired tokens return `400`. Strip `hs_t` from the address
bar after the exchange and gate the identify call behind whatever analytics
consent the site operates under.

Note for existing deployments: the seeded PostHog destination subscribes to
`email.action` only when seeded fresh — add `email.action` to an existing
endpoint's `event_types` to receive semantic answers.

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

## Journey Context — no PostHog shims

The PostHog-specific journey-context shims `ctx.identify` and `ctx.posthog.capture`
were **removed** — they are no longer members of `JourneyContext`. The context
surface is now `sleep`, `sleepUntil`, `when`, `waitForEvent`, `checkpoint`,
`trigger`, `guard`, and `history` (orchestration primitives only).

To get the email/contact/journey/bucket lifecycle into PostHog (or Segment, Slack,
a CRM, a warehouse), configure an **outbound DESTINATION** on the durable spine —
the catalog is delivered durably (retry/backoff/DLQ) keyed by
`webhook_endpoints.kind`. See "Email lifecycle on the outbound spine" below. For a
custom signal you want elsewhere, fire it from a journey with `ctx.trigger()` (it
joins the internal ingest pipeline) and capture it where you detect it via your
app's own PostHog SDK. The only PostHog reads the engine still does at the hot path
are the identity *pull* (`getPersonProperties` for per-user timezone resolution)
and the opt-in `bucket.syncToPostHog` mirror.

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
      // Fan "activation" out via a destination, or fire an internal event other
      // journeys can react to:
      await ctx.trigger({ event: Events.USER_ACTIVATED, userId: user.id });
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
| `email.complained` | Spam complaint reported by the provider | once per send |

`email.delivered`, `email.bounced`, and `email.complained` have no first-party signal — the provider webhook is their single source, and the mailer emits each on the outbound spine when the active provider reports it (see `emitProviderEmailEvent` in `lib/mailer.ts`). Provider webhooks arrive at `POST /v1/webhooks/email/:providerId`, where the provider's `verifyWebhook` normalizes them into a provider-neutral `EmailEvent` before the mailer dispatches.

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

This is why fan-out belongs on destinations: a destination gets the whole
lifecycle durably, for any number of subscribers, without journey code mirroring
state into one vendor by hand (the old per-vendor `ctx.posthog.capture` /
`ctx.identify` journey shims have been removed).

## Architecture Notes

- **Deduplication**: If the same URL appears multiple times in an email, only one `tracked_links` row is created. All occurrences share the same tracking ID.
- **Idempotent opens/clicks**: `openedAt` and `clickedAt` on `emailSends` use `WHERE ... IS NULL` guards — they're set once and never overwritten.
- **Non-blocking**: tracking DB writes happen in parallel and don't delay the redirect/pixel response.
- **Engine-owned mailer**: `prepareTrackedHtml` is part of the engine-owned `createTrackedMailer` (in `@hogsend/engine`). The email provider is a dumb, provider-neutral `EmailProvider` — the contract lives in `@hogsend/core` (canonical author import `@hogsend/engine`); `@hogsend/plugin-resend` (`createResendProvider`) is the reference implementation and `@hogsend/plugin-postmark` (`createPostmarkProvider`) is a second one. The provider `send` wire is HTML-only — the engine renders React → HTML itself (`@hogsend/email` `renderToHtml`, which also powers Studio preview) before the wire. Link/open tracking, preference checks, and the `email_sends` write all live in the engine and come along regardless of which provider you supply.
- **Analytics in the client**: The PostHog-style analytics service is initialized once at startup by `createHogsendClient` and available as `client.analytics`. Its role is now narrow — the identity *pull* (`getPersonProperties` for per-user timezone resolution) and the opt-in `bucket.syncToPostHog` mirror. It is NOT the outbound firing path: the tracking endpoints (open/click) do NOT call `client.analytics` for opens/clicks, and the journey context no longer exposes a PostHog-capture call. Opens/clicks reach PostHog per-hit via a `kind="posthog"` outbound destination on the durable spine, not a direct `captureEvent`.
- **Graceful degradation**: The `client.analytics` reads (timezone pull, bucket sync) are no-ops when `POSTHOG_API_KEY` is not set. Tracking still works (DB writes + ingest events + outbound spine), and PostHog open/click sync only happens if a `kind="posthog"` destination is configured for those events.

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
