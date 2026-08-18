# Referrals

A referral is an edge between two contacts Hogsend already owns: the referrer
who shared a link and the referee who clicked it. `defineReferral` records that
edge, binds it when the referee identifies, and puts every stage on the event
bus so the reward is a journey rather than an engine feature.

Nothing here stands up a second identity graph. A touch rides the link tracker,
the bind rides identity adoption, and revenue rides `conversions`. Payouts are
out of scope (see [Not built](#not-built)).

Public guide: `apps/docs/content/docs/guides/referrals.mdx`. Design record:
`docs/prds/05-referrals.md`.

## Definition

```ts
import { defineReferral, days } from "@hogsend/engine";

export const invite = defineReferral({
  id: "invite",                                  // optional, default "default"
  link: {
    destination: "https://app.example.com/join", // string | (referrer) => string
    slugFrom: (referrer) => referrer.properties.handle,
    campaign: "invite",
  },
  qualify: { event: "subscription.started" },    // optional
  bindWindow: days(30),                          // optional, default 30d
  beforeTouch,
  beforeBind,
  beforeQualify,
});
```

Pass it to `createHogsendClient({ referrals: [invite] })` in BOTH `index.ts`
and `worker.ts`. There is no env preset and no active referral: a program
exists because it was authored in code, and a product may run several at once.
An empty registry leaves every wired site inert.

`getReferralLink({ referral?, contactId })` returns `{ url, slug, linkId }` for
one referrer. It issues no durable Hatchet call, so it is invisible to the
replay journal and needs no `ctx.once` wrap, and it is idempotent at the
database: a replay recovers the existing row instead of minting a second link.

## A referral link is a managed link

A referral link is one `mintLink` call with the link type `shared`.

- `personal` carries the owner's `distinctId` and stitches the clicker to that
  identity. `public` carries no person.
- `shared` is owned by a person and clicked by someone else: it attributes to
  `links.owner_contact_id` and stitches nobody. Reusing `personal` would
  identify every referee as the referrer.

`mintLink` enforces the invariant: `type: "shared"` requires `ownerContactId`,
and `ownerContactId` on a `personal` or `public` link throws. `links.referral_id`
records which program the link belongs to.

Everything the link tracker already does comes with it: a typed code is slug
resolution (`/l/:slug`), a printed QR is an offline referral, clicks are counted
with the bot filter, and the link is listed in Studio Links.

## Schema

`referral_touches` (migration 0073) is the edge log. One row per touch, never
updated except the bind, qualify and reject stamps.

| column | notes |
|---|---|
| `referral_id` | the `defineReferral` id |
| `referrer_contact_id` | `links.owner_contact_id` at touch time, denormalized so a later owner change does not rewrite history |
| `referee_key` | canonical key at touch: an anonymous id on a cold touch |
| `referee_contact_id` | stamped at bind, or immediately when the toucher was already identified |
| `link_id` | null for `manual` and `import` touches |
| `click_id` | `link_clicks.id`, no FK (different retention) |
| `source` | `link`, `slug_entry`, `invite`, `manual`, `import` |
| `status` | `touched`, `bound`, `qualified`, `rejected` |
| `rejected_reason` | `self`, `window`, `veto`, `bot`, `duplicate` |
| `qualified_conversion_id` | the conversion that earned the qualification |
| `properties` | scalar bag from `beforeTouch` or the invite |

A partial-unique index on `(referral_id, referee_contact_id,
referrer_contact_id) WHERE status <> 'rejected'` makes the same pair one edge; a
different referrer is a new row, so last-touch models can still see it.

`links.owner_contact_id` and `links.referral_id` carry the ownership.
`attribution_credits.referral_touch_id` puts referral credit in the same ledger
as marketing attribution, under `channel = "referral"`.

Nothing weighted is persisted. There is no `referral_credits` table, no stored
depth and no stored model.

## Lifecycle

The store (`lib/referrals.ts`) never emits. The intent layer
(`lib/referral-intent.ts`) is the one place that mutates a touch AND emits. The
"after" of every stage is a journey on the matching event.

| stage | trigger | `before*` may veto on | writes | event |
|---|---|---|---|---|
| touch | click on a `shared` link, `/v1/t/arrive`, or `POST /v1/referrals/touch` | bot, archived link, toucher is the owner, `beforeTouch` | a `touched` row (or `bound` when the toucher is identified) | `referral.touched` |
| bind | the referee identifies (`adoptOrphanHistory`), or the toucher was identified | referee equals owner after merge (`self`), touch older than `bindWindow` (`window`), `beforeBind` | `bound_at`, `status = bound` | `referral.bound` |
| qualify | `qualify.event` fires for a bound referee, evaluated in `ingestEvent`, once per touch | `qualify.where`, `beforeQualify` | `qualified_at`, `qualified_conversion_id` | `referral.qualified` |
| convert | any conversion for a referee with a bound touch | none, it is a fact | `attribution_credits.referral_touch_id` | `referral.converted` to the direct referrer, `referral.tree_converted` to each ancestor to depth 5 |
| reject | any veto | | `status = rejected`, `rejected_reason` | `referral.rejected` |

Without a `qualify` block, a bind is the qualification.

`referral.tree_converted` carries `{ level, viaContactId, conversionValue,
currency, refereeContactId }`. A reward journey filters on the level:

```ts
defineJourney({
  meta: {
    trigger: {
      event: "referral.tree_converted",
      where: (b) => b.prop("level").eq(1),
    },
  },
  run: async (user, ctx) => { /* … */ },
});
```

The bus copy of `tree_converted` never carries `value`, so the wildcard revenue
conversion cannot fire for an ancestor.

All six events are in `WEBHOOK_EVENT_TYPES` and both vendored copies
(`packages/cli/src/commands/webhooks.ts`, `packages/client/src/types.ts`).

## Identity and replay laws

**Identity.** A journey re-ingest carries the engine-internal `contactId` PIN,
never the bare canonical key. A cold touch's `referee_key` is an anonymous id,
and passing it alone would mint a contact with `external_id = <anonId>` (the
ghost-contact case). `referral.touched` carries `allowCreate: false`.

**Replay.** The touch write is keyed by `click_id` or the POST idempotency key.
The qualify write is guarded by the partial-unique index plus `qualified_at IS
NULL`. A convert is per `conversions.id`, itself unique per definition and
event. Journeys downstream get exactly-once from the existing engine dedup.

## The report

Model, window, depth and level weights are REQUEST parameters. Nothing is
persisted per model and nothing is backfilled when the reader changes their
mind. If a report is ever slow, a materialised ancestor table is an index, not a
semantic change.

`GET /v1/referrals/report?referral=invite&model=first_touch&window=30d&depth=3&weights=1,0.5,0.25&from=&to=`

- `model` is one of `first_touch`, `last_touch`, `linear`, `time_decay`,
  `position`. These ids are the engine's own (`REFERRAL_MODELS` in
  `lib/referral-report.ts`), not `@hogsend/attribution`'s `ATTRIBUTION_MODELS`:
  that list is a marketing-touchpoint vocabulary whose ids do not name what a
  referral edge is.
- `window` is the touch-to-bind gap ceiling (`<number><unit>`, units `ms s m h d
  w`). An edge whose referee identified later than this is not eligible,
  whatever the program's `bindWindow` was when the row was written.
- `depth` walks the referrer chain, hard cap 5.
- `weights` is one number per level, index 0 = level 1. Level 1 defaults to 1
  and every deeper level to 0, so raising `depth` alone widens the tree counts
  but changes no revenue number.
- `from` / `to` filter CONVERSIONS, not the tree. A beneficiary with referees
  but no in-window revenue comes back with empty value lists.

Credit for one conversion is `levelWeight[L] * Π(edgeWeight over the L hops) *
value`. Under `first_touch` and `last_touch` every surviving edge weight is 1,
so it reduces to `levelWeight * value`. A zero-weight edge is dropped rather
than kept at zero: under `first_touch` a later referrer is not a beneficiary,
not a beneficiary worth nothing.

**Currencies are never converted.** Every monetary field is a list of
`{ currency, value }`, and a conversion with no currency reports as ISO 4217
`XXX`. The only flattening is the leaderboard's sort key, which is never
returned as a number.

`direct` counts (`touched` / `bound` / `qualified`) are deliberately NOT
model-filtered: how many people a referrer touched is a fact about the referrer.

`GET /v1/referrals/tree/:contactId` is the drill-in: every non-rejected edge
below one referrer to `depth` (default 3, cap 5). It is a ledger view, not a
model, so no window is applied, nothing is weighted, and per-node conversion
totals count every conversion. An unknown contact returns `200` with an empty
node list, because "referred nobody" is the same answer.

The whole walk is one recursive CTE with an array cycle guard, so a referee who
later refers an ancestor terminates.

## Routes

| route | auth |
|---|---|
| `POST /v1/referrals/touch` | secret key, `referrals` scope |
| `POST /v1/referrals/import` | secret key, `referrals` scope; insert-only, calls the store directly so it emits nothing |
| `GET /v1/referrals/report` | secret key, `referrals` scope |
| `GET /v1/referrals/tree/:contactId` | secret key, `referrals` scope |
| `GET /v1/referrals/me` | publishable or secret key, plus a server-minted `userToken` |
| `GET /v1/admin/referrals` | admin; the leaderboard plus contact identity |
| `GET /v1/admin/referrals/:contactId` | admin; the tree plus the touch log |

`referrals` is a new orthogonal scope, like `accounts`.

The guards in `routes/index.ts` BRANCH rather than stack: `/referrals/me` is
enumerated as its own `use` before the secret list, and there is no
`/referrals/*` catch-all, because Hono runs every matching `use` and
`route("/v1", v1)` flattens middleware, so a blanket guard would 401 the
browser route.

`/v1/referrals/me` NEVER confirms existence. Absent, forged, expired and
unknown-user tokens all return `200 {"link": null, "stats": null}`, byte-
identical to a deploy with no referral registered.

On `POST /v1/referrals/touch` a `slug` wins over an explicit `referral` in the
body: the link's own `referral_id` is authoritative, and the body value is only
a default when the link carries none.

## SDKs

- `@hogsend/client` (secret): `referrals.touch()`, `referrals.report()`,
  `referrals.tree()`, `referrals.import()`. There is no `link()`: minting the
  caller's own link is browser-side and the engine exposes no secret-key mint
  route.
- `@hogsend/js` (publishable, anonymous-only): `hogsend.captureRef()` posts the
  `hs_ref` arrival param to `/v1/t/arrive` (automatic on init unless
  `captureRef: false`); `hogsend.referral.link()` reads
  `/v1/referrals/me` and writes the reactive `referral` slice.
- `@hogsend/react`: `useReferralLink()` returns `{ link, stats, loading,
  refresh }` and re-fetches when the bound identity flips.
- `@hogsend/mcp` (read-only): `get_referral_report`, `get_referral_tree`.

## Studio

Observe-only. `Referrals` is the leaderboard with a model / window / depth
picker that does nothing but re-query, and `Referrals → <contact>` is the tree
drill-in plus the touch log, rejected rows and reasons included. No create or
edit UI: authoring stays in code.

## Not built

- **Payouts**, clawbacks, KYC, tax forms, FX. A payout is a report at a chosen
  model and depth, snapshotted when you pay. The ledger is shaped so it can be
  added; none of it exists.
- **A per-referrer rate cap** on touches. The PRD lists it as a `beforeTouch`
  veto reason; the engine ships no built-in cap, so write your own
  `beforeTouch` if you need one.
- **Coupon and discount codes** as a pricing feature. A vanity slug is typeable,
  and that is the whole code mechanism.
- **IP and device fingerprint fraud heuristics.** Fraud is identity (self,
  duplicate) plus operator vetoes.
- **Group-level referrals** (a company refers a company). Referrals are
  person-scoped, like journeys.
- **A Studio authoring UI.**
