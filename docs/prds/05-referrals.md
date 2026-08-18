# PRD 05 - Referrals (`defineReferral`)

> **Status: draft for build (2026-08-18).** Lifts the dogfood referral v1 (consumer-only, `?ref=`
> stamp + bespoke webhook source) into the engine as a first-class primitive built on the link
> tracker and the identity graph. No payouts. Attribution model, tree depth and level weights are
> REPORT-TIME parameters, never program config.

## 1. Problem

Hogsend can already say "this contact converted for £X" (`conversions`, `deals`,
`attribution_credits`) and, in dogfood only, "this contact was referred by Y" (a `referred_by`
property read back from a stored `referral.visited` event). Nothing joins the two. There is no
referrer→referee edge in the schema, no multi-level walk, and no way to ask "what revenue did Y's
tree produce, under first-touch, three levels deep".

Every CEP (Braze, Iterable, Customer.io, Klaviyo, Loops) punts referrals to a bolt-on (Rewardful,
Cello) that stands up a second cookie identity graph. Hogsend owns the contact graph and the click
spine, so a referral is an edge it already has the two ends of. That is the edge over the bolt-ons:
server-side, ad-blocker-proof, self-referral fraud falls out of the identity merge, and the reward
can be a Discord role, an email, an SMS or a webhook because it is just a journey.

## 2. Goals

- Answer, from one report request: who is referring, who they referred (N levels deep), and the
  revenue tied to each, under any attribution model, window, depth and weight vector.
- Zero new identity machinery: touches ride the link tracker, binding rides identity adoption,
  revenue rides `conversions` / `attribution_credits`.
- A lifecycle with veto hooks (`before*`) and facts on the bus (`on*` = `referral.*` events) so
  rewards, notifications and fraud rules are journeys and hooks, not engine features.
- Leave the door open for payouts (Stripe Connect) as an additive worker over the report, without
  building any of it now.

## 3. Non-goals

- Payouts, clawbacks, KYC, tax forms, FX. A payout is "a report at a chosen model and depth,
  snapshotted when you pay". Out of scope; the ledger is shaped so it can be added.
- Coupon/discount codes as a pricing feature. A vanity slug is typeable, and that is enough.
- IP/device fingerprint fraud heuristics. Fraud = identity (self, duplicate) + operator vetoes.
- Group-level referrals (a company refers a company). Person-scoped, like journeys.
- Studio authoring UI. Observe-only view; authoring stays in code.

## 4. Naming

`defineReferral` (house pattern: `defineJourney`, `defineSignal`, `defineConnector`,
`defineAccountLink` define a KIND with a bare noun; instances are rows). Not "program": that is the
bolt-on vocabulary. `id` optional, default `"default"`.

## 5. Model

### 5.1 A referral link IS a managed link

`mintLink` already carries `source`, vanity `slug`, `appendRef` (arrival attribution to
`POST /v1/t/arrive`, anon leg with `allowCreate: false`), `idempotencyKey`, QR export, Studio
listing and `link_clicks` with the bot filter. A referral link is one mint:

```ts
mintLink({ db, baseUrl, url: destination, source: "referral", type: "shared",
  ownerContactId: referrerContactId, slug, appendRef: true,
  idempotencyKey: `referral:${referralId}:${referrerContactId}` })
```

**New link type `shared`.** Today `personal` carries the OWNER's `distinctId` and the click stitches
the clicker TO that identity (may mint `hs_t`); `public` carries no person. A referral link is a
third thing: owned by a person, clicked by someone else. The owner is attributed; the clicker is
NEVER stitched to the owner. `shared` behaves like `public` for stitching (no `distinctId`, no
`hs_t`) and like `personal` for attribution (via `links.owner_contact_id`). Reusing `personal` would
identify every referee as the referrer, which is exactly the share-safe invariant's failure mode.

Consequences that come for free: a typed code is slug resolution; a printed QR is an offline
referral; a Discord "share your link" post is `sendConnectorAction` with the URL; every referrer's
link is listed in Studio Links with clicks already counted; any existing managed link can be made a
referral link retroactively by setting an owner.

### 5.2 Schema

**`links`** (existing): add `owner_contact_id uuid NULL` (FK `contacts`, `ON DELETE SET NULL`),
`type` gains `"shared"`. Invariant enforced in `mintLink`: `type: "shared"` requires
`ownerContactId`; `ownerContactId` on `personal`/`public` throws.

**`referral_touches`** (new): the edge log. One row per touch, never updated except the bind stamp.

| column | type | notes |
|---|---|---|
| `id` | uuid pk | |
| `referral_id` | text not null | the `defineReferral` id |
| `referrer_contact_id` | uuid not null → contacts | `links.owner_contact_id` at touch time (denormalized: an owner change later must not rewrite history) |
| `referee_key` | text not null | canonical key at touch (anon id, or contact key if already identified) |
| `referee_contact_id` | uuid null → contacts | stamped at bind (adopt) or immediately if the toucher was identified |
| `link_id` | uuid null → links | null for `source: manual/import` |
| `click_id` | uuid null | `link_clicks.id`, no FK (different retention) |
| `source` | text not null | `link` \| `slug_entry` \| `invite` \| `manual` \| `import` |
| `touched_at` | timestamptz not null | |
| `bound_at` | timestamptz null | |
| `status` | text not null | `touched` \| `bound` \| `qualified` \| `rejected` |
| `rejected_reason` | text null | `self` \| `window` \| `veto` \| `bot` \| `duplicate` |
| `qualified_at` | timestamptz null | |
| `qualified_conversion_id` | uuid null → conversions | |
| `properties` | jsonb | scalar bag from `beforeTouch` / invite (`refereeEmailHint`, campaign) |

Indexes: `(referee_contact_id, referral_id, touched_at)`, `(referrer_contact_id, referral_id)`,
`(referee_key) WHERE referee_contact_id IS NULL` (adopt scan), partial-unique
`(referral_id, referee_contact_id, referrer_contact_id) WHERE status <> 'rejected'` (the SAME pair
is one edge; a different referrer is a new touch, so last-touch models can see it).

**`attribution_credits`** (existing): add `referral_touch_id uuid NULL`; touch events from a shared
link land in the ledger with `channel = "referral"` under every existing model. Marketing
attribution and referral attribution are then the same ledger.

Nothing else. No `referral_credits`, no weights, no depth persisted. Revenue is `conversions` and
`deals`; the tree is `referral_touches`; every report is a query.

### 5.3 The report is a query

`GET /v1/referrals/report?referral=invite&model=first_touch&window=30d&depth=3&weights=1,0.5,0.25&from&to`
(secret key), and `getReferralReport()` in `@hogsend/client`.

- Pick the effective edge per referee under `model` + `window` (first_touch, last_touch, or all
  edges with linear/time_decay/position weights). This is the SAME model vocabulary as
  `@hogsend/attribution` `ATTRIBUTION_MODELS`; reuse the ids.
- Recursive CTE up from each converting referee to `depth` (hard cap 5).
- Join `conversions` (value, currency, `occurredAt`), optionally `deals` for LTV.
- Output per beneficiary: `{ contactId, direct: {touched, bound, qualified}, tree: [{level, referees,
  conversions, value}], value }`, plus a per-referee drill-in `GET /v1/referrals/tree/:contactId`.

Depth, weights and model are request parameters. Changing your mind costs nothing; nothing is
backfilled. If a report is ever slow, a materialised ancestor table is an index, not a semantic
change.

## 6. Lifecycle

Mirrors `defineAccountLink`: veto hooks return `{ ok: false, reason }`; the store NEVER emits;
the intent layer emits outbound + re-ingests for journeys. `after*` is not a hook, it is the bus:
the after of every stage is a journey on the matching `referral.*` event.

| stage | trigger | `before*` may veto on | writes | `on*` event (bus + outbound) |
|---|---|---|---|---|
| **touch** | click on a `shared` link (`/v1/t/c/:id`, `/l/:slug`) or `/v1/t/arrive`; `POST /v1/referrals/touch` (slug entry, invite, manual) | bot (`isBot`), archived link, toucher already identified AS the owner, per-referrer rate cap, custom `beforeTouch` | `referral_touches` row `touched` (or `bound` if toucher identified) | `referral.touched` → referrer (referee = anon key; `allowCreate: false`) |
| **bind** | referee identifies: `adoptOrphanHistory` stamps `referee_contact_id`; or an identified toucher | `referee === owner` after merge → `self`; `touched_at` older than the referral's `bindWindow` → `window`; custom `beforeBind` | `bound_at`, `status = bound` | `referral.bound` → referrer AND referee |
| **qualify** | the referral's `qualify.event` fires for a bound referee (evaluated in `ingestEvent`, once per touch) | min value, disposable email, custom `beforeQualify` | `qualified_at`, `qualified_conversion_id` | `referral.qualified` → referrer AND referee |
| **convert** | any `conversions` row for a referee with a bound touch (hooked next to `recordAttributionCredits`) | none (a fact) | `attribution_credits.referral_touch_id` | `referral.converted` → direct referrer; `referral.tree_converted` → each ancestor to depth 5 with `{ level, conversionValue, currency, refereeContactId }` |
| **reject** | any veto | | `status = rejected`, `rejected_reason` | `referral.rejected` → referrer (reason) |

`level` on `tree_converted` is a FACT on the event; a reward journey filters with
`trigger.where: (b) => b.prop("level").eq(1)`. That is the only place levels appear in code.

Identity law: journey re-ingests carry the engine-internal `contactId` PIN, never the bare
canonical key (a cold touch's `referee_key` is an anon id; passing it alone mints a ghost with
`external_id = <anonId>`). `referral.touched` carries `allowCreate: false`.

Replay law: the touch write is keyed by `click_id` (or the `POST` idempotency key); the qualify
write is guarded by the partial-unique index and `qualified_at IS NULL`; convert is per
`conversions.id`, itself unique per (definition, event). Journeys downstream get exactly-once from
the existing engine dedup.

## 7. Public API

### 7.1 Definition

```ts
import { defineReferral, days } from "@hogsend/engine";

export const invite = defineReferral({
  id: "invite",                                    // optional, default "default"
  link: {
    destination: "https://app.example.com/join",   // string | (referrer) => string
    slugFrom: (c) => c.properties.handle,          // optional; default = short random slug
    campaign: "invite",                            // optional, forwarded to mintLink
  },
  qualify: { event: "subscription.started" },      // optional; without it bind = qualified
  bindWindow: days(30),                            // optional; default 30d
  beforeTouch, beforeBind, beforeQualify,          // optional vetoes
});
```

Passed to `createHogsendClient({ referrals: [invite] })` in BOTH `index.ts` and `worker.ts`.

### 7.2 Runtime

- `getReferralLink({ referral?, contactId })` (engine, journey-safe, idempotent mint) → `{ url, slug, linkId }`.
- `ctx` gains nothing (ctx = orchestration primitives only). Journeys call `getReferralLink` and
  `sendEmail`/`sendConnectorAction` as today.
- `@hogsend/client` (secret): `referrals.link({contactId})`, `referrals.touch(...)`, `referrals.report(...)`,
  `referrals.tree(contactId)`, `referrals.import([...])`.
- `@hogsend/js` (publishable, anon-only): `hogsend.referral.capture()` (reads `?ref` / `hs_ref`
  and calls `/v1/t/arrive`; no-op if the SDK already did arrival attribution),
  `hogsend.referral.link()` (userToken-gated: `GET /v1/referrals/me` → the caller's link; NEVER
  confirms existence, absent/forged token returns `200 { link: null }`).
- `@hogsend/react`: `useReferralLink()`.
- Routes: `POST /v1/referrals/touch` (secret), `GET /v1/referrals/report`, `GET /v1/referrals/tree/:contactId`,
  `POST /v1/referrals/import` (secret, insert-only), `GET /v1/referrals/me` (userToken).
  New orthogonal `referrals` scope; guards BRANCH on method + path (accounts-router law).
- Outbound catalog: `referral.touched|bound|qualified|converted|tree_converted|rejected` in
  `WEBHOOK_EVENT_TYPES` + BOTH vendored copies (`packages/cli` webhooks, `packages/client` types).
- MCP: `get_referral_report`, `get_referral_tree` (read-only).

### 7.3 Studio (observe-only)

`referrals-view.tsx`: leaderboard (referrers by bound / qualified / tree value under a model +
depth picker that just re-queries), `referral-detail-view.tsx`: a referrer's tree drill-in and
touch log. No create/edit.

## 8. Reports Hogsend can then answer

- Who is inviting: touches, bound, qualified, conversion rate per referrer.
- Who they invited, N deep: `/v1/referrals/tree/:contactId`.
- Revenue per referrer per level, under any model: `/v1/referrals/report`.
- Reconciled with marketing attribution: `attribution_credits WHERE channel = 'referral'`.
- Two-sided funnels with the existing event-native funnels: referrer
  (`link.clicked` → `referral.bound` → `referral.qualified` → `referral.tree_converted`) and referee
  (`referral.touched` → identify → qualify event → conversion).

## 9. Decisions (locked)

1. Links, not codes. No `referral_codes` table; a slug is the code.
2. `shared` link type with `owner_contact_id`. Never reuse `personal`.
3. Every touch is written; the model picks. `referral.bound` MAY fire more than once per referee
   (a later click on a different referrer's link). Same-pair re-touch is a no-op on the edge.
4. Model, window, depth, weights are report-time only. Nothing weighted is persisted.
5. Store never emits; intent layer emits; journeys are the "after".
6. Fraud = identity + vetoes. No fingerprinting.
7. Payouts out of scope; report shape is the payout input.

## 10. Migration from dogfood v1

`referral.visited` → `referral.touched`, `referral.converted` → `referral.qualified`,
`referral.credited` → journey on `referral.qualified`. Delete the `referral-visited` webhook source
and the `/hey` `?ref=` handler; `/hey` mints via `getReferralLink` and captures via
`hogsend.referral.capture()`. The Ambassador role journey keeps its marker dedup and count bucket,
re-triggered on `referral.qualified` with `where level == 1` semantics not needed (direct only).

## 11. Build order

1. Schema: `links.owner_contact_id` + `type: shared`, `referral_touches`,
   `attribution_credits.referral_touch_id`. `mintLink` invariant. Migration + tests.
2. Store `lib/referrals.ts`: touch / bind / qualify / reject, hooks, no emits. Tests pin the
   no-emit law (symbol scan + import list, as `account-links.ts` does).
3. Wire: click + arrive + slug paths call touch for `shared` links; `adoptOrphanHistory` calls
   bind; `ingestEvent` evaluates qualify; `recordAttributionCredits` stamps `referral_touch_id`
   and emits convert/tree_converted. Intent-layer emits + journey re-ingests + outbound catalog.
4. `defineReferral` + container wiring + `getReferralLink`.
5. Routes + report CTE + client SDK + `me` endpoint + `@hogsend/js` capture/link + react hook.
6. Studio views, MCP tools, docs (`docs/referrals.md`, `apps/docs/content/docs/guides/referrals.mdx`).
7. Dogfood migration (sibling repo) and delete v1.

Each stage: simplify, review, real smoke, then commit. Worktree `.claude/worktrees/referrals`.

## 12. Open questions

- Should `qualify` accept a builder condition (`where`) like journey triggers, so "first paid
  invoice over £10" is expressible without a custom veto? Leaning yes, reuse `evaluateTriggerConditions`.
- `bindWindow` default: 30d (Rewardful/Cello default 60d; product referrals convert faster).
- Whether `referral.tree_converted` should carry the full ancestor path or just `level`. Leaning
  `level` + `viaContactId` (the next hop) so a journey can name "your friend's friend".
