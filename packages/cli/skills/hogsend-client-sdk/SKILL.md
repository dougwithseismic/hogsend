---
name: hogsend-client-sdk
description: Use when calling Hogsend from your own product/app code (a signup handler, a billing webhook, a cron) via the @hogsend/client SDK + public data-plane API — new Hogsend({ baseUrl, apiKey }), then contacts.upsert/find/delete, events.send (alias .track), emails.send, lists.list/subscribe/unsubscribe. Teaches the contactProperties-vs-eventProperties split on POST /v1/events, the ingest-scoped HOGSEND_API_KEY, the 202 + listsError warning, and HogsendAPIError/RateLimitError. NOT for use inside a journey (there, use sendEmail()/ctx.trigger()). The scaffold ships a preconfigured `hs` at src/lib/hogsend.ts.
license: MIT
metadata:
  author: withSeismic
  version: "1.0.0"
---

# Hogsend client SDK (`@hogsend/client`)

`@hogsend/client` is the typed HTTP client for Hogsend's **public data plane** —
contacts, events, transactional emails, and lists. It is a thin wrapper over
native `fetch` (no heavy deps, ships ESM + CJS + `.d.ts`). This is how you talk
to Hogsend from your OWN product code: a signup handler, a Stripe webhook, a
nightly cron — anything OUTSIDE the engine that needs to upsert a contact, fire
an event, or send a one-off email.

## Where this belongs (read first)

This SDK is for **app code, not journey code.**

- **Outside the engine** (your API routes, webhooks, jobs) → use this client.
  You're crossing the network into Hogsend's HTTP data plane.
- **Inside a journey's `run(user, ctx)`** → do NOT use this client. Use the
  engine's in-process primitives instead: `sendEmail()` (from `@hogsend/engine`)
  to send, and `ctx.trigger({ event, userId, properties })` to fire an event
  back through the ingestion spine. Those run in-process with full attribution
  and durability; reaching back out over HTTP from inside a journey is wrong.

The scaffold already ships a **preconfigured client** at `src/lib/hogsend.ts`
exporting `hs`. Import that — do not re-instantiate `new Hogsend(...)` per call:

```ts
import { hs } from "./lib/hogsend.js";

await hs.events.send({ userId: "u_1", name: "signup" });
```

`src/lib/hogsend.ts` wires `baseUrl` from `API_PUBLIC_URL` and `apiKey` from
`HOGSEND_API_KEY` for you. `pnpm bootstrap` mints a local ingest key and writes
it; in production you create a key with the `ingest` scope and set
`HOGSEND_API_KEY`.

## Construction + auth

```ts
import { Hogsend } from "@hogsend/client";

const hs = new Hogsend({
  baseUrl: "https://api.example.com",      // your deployed API
  apiKey: process.env.HOGSEND_API_KEY!,    // hsk_… key with the `ingest` scope
  // fetch?: typeof fetch    — override for tests / custom agents (default: global)
  // timeoutMs?: number      — per-request timeout, aborts the request (default 30000)
  // headers?: {…}           — extra headers on every request (e.g. tracing)
});
```

**Auth: the data plane requires an `ingest`-scoped key.** `ingest` is an
*orthogonal* scope (not part of the `read < journey-admin < full-admin`
hierarchy): a key must either be granted `ingest` explicitly OR hold `full-admin`
(which implies every data-plane scope). A bare `read` admin key will NOT work
against the data plane. This is distinct from the admin key the `hogsend` CLI's
read commands use.

**Identity on every write.** Every write takes at least one of `email` or
`userId` (your external/distinct id). Both may be supplied. A union type + a
runtime `assertIdentity` guard enforce that at least one is present — calling
with neither throws before the request goes out.

## The resources at a glance

```ts
// Contacts ----------------------------------------------------------------
await hs.contacts.upsert({                      // PUT /v1/contacts
  email: "ada@example.com",
  userId: "u_1",
  properties: { plan: "pro" },                  // merged onto the contact
  lists: { newsletter: true },                  // inline list membership
});                                             // -> { id, created, linked }

await hs.contacts.find({ email: "ada@example.com" }); // GET /v1/contacts/find -> Contact[]
await hs.contacts.delete({ userId: "u_1" });          // DELETE /v1/contacts -> { deleted }

// Events ------------------------------------------------------------------
await hs.events.send({                          // POST /v1/events
  userId: "u_1",
  name: "signup",
  eventProperties: { source: "landing" },       // stored ON the event
  contactProperties: { country: "GB" },         // merged onto the CONTACT
  idempotencyKey: "evt_abc",
});                                              // -> { stored, exits, listsError? }
hs.events.track(/* … */);                       // alias of events.send

// Emails ------------------------------------------------------------------
await hs.emails.send({                          // POST /v1/emails
  to: "ada@example.com",
  template: "welcome",
  props: { name: "Ada" },
});                                              // -> { emailSendId, status, reason? }

// Lists -------------------------------------------------------------------
await hs.lists.list();                          // GET  /v1/lists -> ListSummary[]
await hs.lists.subscribe({ list: "newsletter", email: "ada@example.com" });
await hs.lists.unsubscribe({ list: "newsletter", userId: "u_1" });
```

## `eventProperties` vs `contactProperties` (the split that trips people up)

`POST /v1/events` (`hs.events.send`) takes **two distinct property bags** — they
land in different places and serve different jobs:

- **`eventProperties`** — stored ON the event row. These are what a journey's
  `trigger.where` and `exitOn` rules evaluate against. Use them for the
  per-occurrence facts of THIS event: `{ source: "landing", amount: 49,
  plan: "pro" }`. They do not change the contact.
- **`contactProperties`** — merged onto the CONTACT record (the same upsert
  `contacts.upsert` does). Use them for durable facts about the person:
  `{ country: "GB", lifecycleStage: "trial" }`. They persist across events and
  are what later condition checks on the contact read.

Mnemonic: **eventProperties describe the event; contactProperties describe the
person.** A `purchase` event might carry `eventProperties: { amount: 49 }` (this
purchase) AND `contactProperties: { hasPurchased: true }` (a lasting fact). The
same split is exposed by the CLI as `--prop` (event) vs `--contact-prop`
(contact) on `hogsend events send` — see the hogsend-cli skill.

## The 202 + `listsError` warning

`POST /v1/events` returns **202 Accepted** (the event is durably stored and
queued for routing), NOT 200. The result is `{ stored, exits }` plus an optional
`listsError`:

- `stored` — `true` once the event row is written (`false` only on a dedup via
  `idempotencyKey`).
- `exits` — the `{ journeyId, stateId, exited }[]` from evaluating active
  journeys' `exitOn` rules for this user.
- **`listsError?`** — present ONLY when the event was ingested fine but the
  (non-atomic, post-ingest) `lists` membership write failed. **The event itself
  is durably stored** — this is a soft warning surfaced on the 202, not a 400.
  If you passed `lists` and care that membership applied, check for `listsError`
  in the result rather than assuming success.

## Errors

All non-2xx responses (and transport failures) throw typed errors:

```ts
import { HogsendAPIError, RateLimitError } from "@hogsend/client";

try {
  await hs.emails.send({ to: "x@y.com", template: "welcome", props: {} });
} catch (err) {
  if (err instanceof RateLimitError) {
    // 429 — back off for err.retryAfter seconds (from the Retry-After header)
  } else if (err instanceof HogsendAPIError) {
    // err.status (0 = transport failure: DNS/connect/timeout), err.body (parsed JSON or raw text)
  }
}
```

- `HogsendAPIError` — `{ status, body }`. `status === 0` means the request never
  reached the server.
- `RateLimitError extends HogsendAPIError` — `status === 429`, with `retryAfter`
  (seconds) when the `Retry-After` header is present.

## Task playbooks — load the matching reference

- **Full per-resource API: every method's input/result shape, identity rules,
  the typed `emails.send` registry, idempotency** → `references/api-surface.md`

## Golden rules

1. Use this client from APP code only. Inside a journey, use `sendEmail()` /
   `ctx.trigger()` — never reach back out over HTTP.
2. Import the preconfigured `hs` from `src/lib/hogsend.ts`; don't re-instantiate
   `new Hogsend(...)` per call.
3. The key needs the `ingest` scope (or `full-admin`). A read admin key is
   rejected by the data plane.
4. On `events.send`: `eventProperties` describe the event (drive
   `trigger.where`/`exitOn`); `contactProperties` merge onto the contact. Don't
   conflate them.
5. `events.send` returns 202; check `listsError` if you passed `lists` and care
   that membership applied.
6. Every write needs an identity (`email` and/or `userId`).
