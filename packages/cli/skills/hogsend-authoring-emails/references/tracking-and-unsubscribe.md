# Tracking & unsubscribe — what happens automatically on every send

This is co-located with email authoring on purpose: link-click tracking, open
tracking, preference checks, and unsubscribe are **automatic on every send**.
The engine's `createTrackedMailer` owns the whole pipeline; the email provider
(`createResendProvider`) is just the dumb wire. You author the `.tsx`; the engine
does the rest. You should NOT call any of these helpers yourself — this reference
explains what runs so you author components that leave room for it.

## The send pipeline (engine-owned, runs on `send` / `sendEmail`)

```
emailService.send({ template, props, to, ... })   // or sendEmail({...}) in a journey
        │
        ▼  createTrackedMailer.send → sendTrackedEmail (the DB-backed path)
  1. preference / suppression check, then frequency cap
        (both skipped when skipPreferenceCheck is set)
  2. getTemplate(key, props, registry) → resolve element + subject + category
  3. insert email_sends row  → gives the send a stable emailSendId (status "queued")
  4. renderToHtml(element), then prepareTrackedHtml(html, emailSendId, baseUrl, db):
        • rewriteLinks()    — every <a href="https?://…"> → /v1/t/c/:linkId
        • injectOpenPixel() — <img src="/v1/t/o/:emailSendId"> before </body>
        (only when baseUrl + prepareTrackedHtml are present; else send the raw react element)
  5. provider.send(...)     — Resend gets the already-rewritten HTML
  6. update email_sends → resendId + status "sent" (or "failed" on throw)
```

Tracking comes along regardless of which provider you supply, because steps 2–4
live in the engine, not the provider. The tracking domain is `options.baseUrl`
(threaded from `config.baseUrl`, i.e. `API_PUBLIC_URL`).

## Link-click tracking

`rewriteLinks` (engine `lib/tracking.ts`) scans the rendered HTML for
`href="https://…"`, deduplicates the URLs, bulk-inserts one `tracked_links` row
per unique URL, then single-pass replaces each href with
`{API_PUBLIC_URL}/v1/t/c/{linkId}`. At click time:

- `GET /v1/t/c/:id` records a `link_clicks` row (IP + user-agent), increments
  `tracked_links.click_count`, sets `email_sends.clicked_at` (first click only,
  `WHERE clicked_at IS NULL`), then **302-redirects to the original URL**.
- After responding it fire-and-forgets an `email.link_clicked` event (props:
  `emailSendId`, `templateKey`, `linkUrl`, `linkId`) into PostHog + the ingest
  pipeline, so journeys can branch on it and `exitOn` can fire. It ALSO emits the
  outbound-catalog `email.clicked` event, which fans out durably to every
  subscribed DESTINATION — **per-hit, not first-touch** (every click is delivered,
  unlike the first-only `clicked_at` column).

Authoring implication: use real `<a href>` / react-email `Button`/`Link` with
absolute `https://` URLs and they're tracked automatically. Non-HTTP links
(`mailto:`, `tel:`) are left alone — the regex only matches `https?://`.

## Open tracking

`injectOpenPixel` appends a 1×1 GIF `<img src="{API_PUBLIC_URL}/v1/t/o/{emailSendId}">`
just before `</body>` (so always compose inside `Layout`, which emits a proper
`<body>`). At open time:

- `GET /v1/t/o/:id` sets `email_sends.opened_at` (first open only), returns a
  42-byte transparent GIF with `Cache-Control: no-store`.
- Then fire-and-forgets an `email.opened` event (props: `emailSendId`,
  `templateKey`) into PostHog + the ingest pipeline, and emits the outbound-catalog
  `email.opened` event that fans out durably to every subscribed DESTINATION —
  **per-hit, not first-touch**.

The engine's own constants for these are `EMAIL_OPENED = "email.opened"` and
`EMAIL_LINK_CLICKED = "email.link_clicked"`. In journey code, reference them via
your `Events` constants and check `ctx.history.hasEvent({ event })` to branch on
engagement — see the **hogsend-authoring-journeys** skill.

## Preference / suppression check

Before sending, `sendTrackedEmail` checks `email_preferences` for the recipient.
If the user is unsubscribed/suppressed/category-unsubscribed, the send is skipped
and the result `status` reflects it (`"unsubscribed"` / `"suppressed"` /
`"skipped"`) — no provider call. Genuinely transactional mail that must always go
out can pass `skipPreferenceCheck: true`. Frequency caps also short-circuit here
(`status: "skipped", reason: "frequency_capped"`); `category: "transactional"` is
exempt from caps by default.

## Unsubscribe — token, URL, and the footer slot

The unsubscribe link is a signed, expiring token, not a DB lookup. The engine's
`sendEmail` builds it for journey sends:

```ts
import { generateUnsubscribeUrl } from "@hogsend/email";
// engine builds this for you when API_PUBLIC_URL + BETTER_AUTH_SECRET are set:
const unsubscribeUrl = generateUnsubscribeUrl({
  baseUrl: process.env.API_PUBLIC_URL,
  secret: process.env.BETTER_AUTH_SECRET,
  externalId: userId,
  email: to,
});
// → {baseUrl}/v1/email/unsubscribe?token=<base64url payload>.<hmac-sha256 sig>
```

It is injected into your template as the `unsubscribeUrl` prop AND set as the
`List-Unsubscribe` + `List-Unsubscribe-Post` headers (one-click unsubscribe). All
you do as the author is **accept `unsubscribeUrl?: string` in your props and pass
it to `Layout`** (which forwards it to `Footer`) — that's the slot:

```tsx
export default function MyEmail({ name = "there", unsubscribeUrl }: MyEmailProps) {
  return (
    <Layout preview={`Hi ${name}`} unsubscribeUrl={unsubscribeUrl}>
      {/* … */}
    </Layout>
  );
}
```

There is a matching `generatePreferenceCenterUrl(...)` →
`{baseUrl}/v1/email/preferences?token=…` (action `"manage"`) for a full
preference center link; pass it as `preferencesUrl` to `Layout` the same way.

## Why these links aren't click-tracked

`rewriteLinks` skips any URL containing `/v1/email/unsubscribe` or
`/v1/email/preferences` (the `SKIP_PATTERNS`), so unsubscribe and preference
links go straight through un-rewritten — an unsubscribe must never bounce through
the click endpoint. You don't need to do anything for this; it's handled.

## What you do NOT do

- Don't call `prepareTrackedHtml`, `rewriteLinks`, or `injectOpenPixel` — the
  mailer calls them.
- Don't call `generateUnsubscribeUrl` in a template — the engine injects the URL.
- Don't hand-roll an open pixel or rewrite links in your `.tsx`.

Author the component; the engine guarantees tracking + unsubscribe on send.
Full system docs: `docs/tracking.md`.
