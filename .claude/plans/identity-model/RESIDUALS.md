# Residual minting paths — found 2026-07-28, post-#621

#621 stopped three observation paths from minting contacts and established THE LAW: *a refusal must
be inherited by every derived re-ingest*, because a pin-less re-resolve mints `external_id = <anonId>`,
a row that is strictly WORSE than the ghost it replaces (it collides with identified contacts and
403s the visitor out of their own feed).

A post-merge verification pass found paths that still mint. Ranked by severity. **None of these are
fixed yet.** They are engine bugs in the same class as #621 and belong in the same release as the
identity-model work, not after it.

---

## R1 — Link-click re-ingest mints `external_id = <anonId>` (VERIFIED, same law as #621)

`lib/tracking-events.ts:255-274` — `pushLinkClickEvent` calls `ingestEvent({ userId: distinctId })`
with **no `allowCreate`**, so it defaults to `true`. Call site `routes/tracking/click-pipeline.ts:397`
gates only on `!isBot && link.distinctId`.

**Reachability confirmed**: `lib/links.ts:318` copies whatever `distinctId` the caller passes for a
`personal` link (`type === "personal" ? (opts.distinctId ?? null) : null`). A journey minting a link
for an anonymous visitor — which the demo journeys do — produces an anon-keyed personal link. The
click then re-ingests that key with creation allowed and the create arm mints
`external_id = <anonId>`.

This is EXACTLY the shape #621 fixed on the feed-mark path and missed here. It is a derived
re-ingest of a key whose original observation was refused, so D11 says it must inherit the refusal.

**Fix:** `allowCreate: false` on the `pushLinkClickEvent` ingest. Safe by construction — a link
carrying a `distinctId` was minted for a person who was already known, so either the key resolves
(fill-in-link, unchanged) or it was refused at observation time and must stay refused. Unlike
`sendFeedItem`'s `userId` arm, there is no confidentiality role for the mint here: this is an event
ingest, not a feed-read authorization, so `collidesWithIdentified` has no stake in it.

**Note:** `tracked_links` has no `contact_id` column (`schema/tracked-links.ts:50` — `distinctId` only),
so inheriting the refusal is the correct fix rather than threading a provenance pin. If PRD 04 ever
adds `contact_id` to tracked links, revisit.

**Test:** mint a personal link for an unseen anon key, click it, assert zero `contacts` rows and that
the `link.clicked` event still stores. Mutation: removing `allowCreate: false` must fail it.

---

## R2 — `PUT /v1/contacts`, publishable key, `anonymousId` alone (KNOWN, deliberately deferred)

Recorded in the ghost-contacts BACKLOG as out of scope: refusing here forces `id: z.string().nullable()`
on a published response schema plus a `@hogsend/client` type widening. The residual was stated
plainly at the time: *a hand-rolled `pk_` fetch sending only `anonymousId` can still mint.* No
first-party SDK emits that shape (`packages/js` `identify()` always sends a `userId`).

**What IS new and worth fixing cheaply:** the schema comment at `routes/contacts/index.ts:47-49`
claims "requireIdentity still requires email or userId below". That is FALSE on the publishable path —
`routes/_shared.ts:53` returns early for a bare `anonymousId`, and the CREATE arm
(`contacts.ts:751-830`) carries no `restrictToAnonymous` guard (that flag bites only fill-in-link
`:840` and merge `:869`). A comment asserting a guarantee the code does not provide is how the next
person builds on a false premise. Correct the comment even while deferring the behaviour.

---

## R3 — Bucket cron/backfill emits (UNVERIFIED — flagged, not asserted)

`workflows/bucket-reconcile.ts:617,762,1150` and `workflows/bucket-backfill.ts:405` emit with
`contactId: map.get(row.userId)` (which can miss) and do not inherit `allowCreate`. Post-#621 an
anon-keyed `bucket_memberships` row owning no contact is now the STEADY STATE rather than an
anomaly, so this path gets MORE likely to fire over time, not less.

Needs a reachability trace before any change. Recorded so it is not lost.

---

## R4 — Two anonymous-id namespaces reach the same contact by different arms

`/api/subscribe` forwards the **PostHog** distinct id as `anonymousId` (`apps/docs/lib/ingest.ts:96`),
while the browser SDK's `identify()` sends its own **`hs_anon_id`** (`packages/js/src/client.ts:438`).
Different id spaces, both adopted, but by different arms: the `hs_anon_id` history — which is the
visitor's actual in-app demo activity — is adopted only by the fill-in-link arm, which requires
`/api/hogsend-token` to have succeeded.

Not a bug today (the demo's `awaitIdentity()` bounds the wait and reports an unlinked fire), but it
means "the anon history is adopted" is true via two independent mechanisms, only one of which is
tested. Worth one test pinning the PostHog-namespace arm.

---

## R5 — Engine paths not used by the dogfood, recorded for completeness

- Segment preset puts an `anonymousId` into `userId` (`webhook-sources/presets/segment.ts:79`) →
  `external_id = <anon id>`, `email NULL`.
- `routes/admin/agent.ts:324` (`upsert_contact`) mints `anonymousId`-only, unguarded.

---

## Consumer-side (different repo — `hogsend-dogfood`)

`referral-visited` still mints one emailless contact per (browser, referrer). Its transform
(`src/webhook-sources/referral-visited.ts:43-54`) returns an `anonymousId` with no `userId`/`userEmail`,
and webhook-source ingest (`routes/webhooks/sources.ts:241,260`) passes no `allowCreate`. Its own test
actively asserts the emailless property. The remedy is a one-line dogfood change (drop
`contactProperties: { referred_by }` — `referral-convert.ts` already reads attribution from event
properties), NOT an engine flag.
