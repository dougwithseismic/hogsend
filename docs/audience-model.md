# The audience model — contacts, lists, buckets, audiences

Who Hogsend can reach, who it may reach, and how groups of people are named.
Read this before `docs/campaign-steps-spec.md` — campaigns build directly on
these nouns.

## The mental model in one screen

There are four nouns. Two are real systems, one is the substrate, one is just
a pointer:

| Noun | One-liner | Backed by |
|---|---|---|
| **Contact** | A person we know — the substrate everything else groups | `contacts` + `contact_aliases` + `email_preferences` tables |
| **List** | A *consent* container: "who may I email about this?" | No table — a key in `email_preferences.categories` JSONB |
| **Bucket** | A *behavior* segment: "who currently matches this?" | `bucket_memberships` table, auto-computed from criteria |
| **Audience** | A campaign's pointer at ONE list or ONE bucket | Nothing — `{ list: id } \| { bucket: id }` on the campaign |

The connecting sentence: **contacts are the people; a list says which of them
consented to a topic; a bucket says which of them currently behave some way;
an audience is a campaign choosing one of those two groups to address.**

Journeys do not use any of this — a journey is entered per-person by an
*event*, never by group membership. (A bucket can *generate* journeys via its
`.on()` reactions; see below.)

## Contacts — the people

The substrate. Not defined in code — rows accumulate from ingestion
(`ingestEvent` upserts a contact per event), imports, and the admin API.

- **`contacts`** — one row per person: `externalId` (the caller's user id),
  `email` (normalized at write), `timezone` (opportunistic IANA cache from
  PostHog), `deletedAt`.
- **`contact_aliases`** — extra identities per contact, typed by Kind
  (`discord_id`, `telegram_id`, …). Written by cold-connect / connector link
  flows. This is how a channel step knows a contact's Discord.
- **`email_preferences`** — the consent record, keyed by normalized email:
  `unsubscribedAll` (global opt-out), `suppressed` (bounce/complaint — set by
  provider webhooks), and `categories` (JSONB map of category-key →
  subscribed boolean). Every email send path checks this; a contact with no
  row at all is in the default state.

Two identity keyspaces exist and this is deliberate: email things
(preferences, sends) key on **email**; behavior things (events, bucket
membership) key on **userId** (`externalId`). They meet through the
`contacts` row. See "Known warts" for where that seam chafes.

## Lists — consent

**What:** a named subscription category with a declared default polarity.
There is no membership table — a list is a *key* in
`email_preferences.categories`, plus registry metadata.

**Defined:** in the consumer, one `defineList()` per list in
`apps/api/src/lists/index.ts`:

```ts
export const productUpdates = defineList({
  id: "product-updates",
  name: "Product updates",
  defaultOptIn: false, // opt-IN: not subscribed until they explicitly join
});
export const lists = [productUpdates];
```

**Wired:** the `lists` array is passed to `createHogsendClient({ lists })` in
BOTH `src/index.ts` (API) and `src/worker.ts`. The engine builds a
`ListRegistry` (`client.listRegistry`) from it.

**Polarity is the whole semantics** (`ListRegistry.isSubscribed` is the single
source of truth, used identically by the mailer's suppression check and the
campaign audience resolvers):

- `defaultOptIn: true` (opt-out — a default newsletter): subscribed UNLESS
  `categories[id] === false`. A contact with no preferences row is subscribed.
- `defaultOptIn: false` (opt-in — must explicitly join): subscribed ONLY when
  `categories[id] === true`.

**Membership moves via consent actions only:** the data plane
(`GET /v1/lists`, `POST /v1/lists/:id/subscribe|unsubscribe`), the preference
center, and unsubscribe links. Code never computes list membership.

**Lists and template categories are the same namespace.** Every email template
declares a `category` in the consumer's `src/emails/registry.ts`, and the boot
guard in `container.ts` validates that each category is either a defined list
id or one of the two reserved built-ins (`transactional`, `journey` — rejected
as list ids by `defineList`). So "what category is this template" and "what
list governs its suppression + unsubscribe link" are one question.

## Buckets — behavior

**What:** a dynamic segment whose membership is *computed*, not consented. A
`criteria` condition tree (the core 4-type condition engine) is evaluated
against events/properties; matching users get a `bucket_memberships` row
(`status: "active"`, keyed by userId). Realtime joins happen on ingest
(`checkBucketMembership`); time-windowed criteria decay via the engine's
reconcile cron; transitions emit `bucket:entered:<id>` / `bucket:left:<id>`
events (a reserved namespace — criteria may not reference `bucket:*` events).

**Defined:** in the consumer, one file per bucket in `apps/api/src/buckets/`,
exported through `apps/api/src/buckets/index.ts`:

```ts
export const powerUsers = defineBucket({
  meta: {
    id: "power-users",
    name: "Power users",
    enabled: true,
    timeBased: true,                    // rolling window → swept by the cron
    entryLimit: "once_per_period",      // re-entry policy for entered events
    entryPeriod: days(7),
    criteria: (b) => b.event(Events.KEY_ACTION).within(days(30)).atLeast(10),
  },
});
```

**Wired:** the `buckets` array goes to `createHogsendClient({ buckets })`
(API + worker) AND `createWorker({ ..., buckets })` — the worker runs the
membership sweeps and any bucket-generated tasks. The engine builds a
`BucketRegistry` (`client.bucketRegistry`).

**What a bucket gives you:**

- **Accessors** — `bucket.count()`, `.has(userId)`, `.members()`,
  `.membersIterator()` for use anywhere in code.
- **Reactions** — `.on("enter" | "leave" | "dwell", handler)` generates real
  journeys triggered by the transition events. This is the bucket→journey
  bridge: "when someone enters `went-dormant`, run this."
- **An audience** — campaigns can address active members (next section).

**What a bucket does NOT give you:** consent. Being in a bucket says nothing
about what the person agreed to receive — see the campaign rule below.

**Future, declared but rejected today:** `kind: "manual"` (membership mutated
only by explicit API, no criteria). Registration rejects it until something
can populate one. Decision rule when it ships: if being in the set implies
*consent to hear about it*, it's an opt-in list, not a manual bucket. A
waitlist is an opt-in list — signing up IS the consent.

## Audiences — the campaign selector

"Audience" exists only on campaigns, and it is nothing but a pointer:
`audience: { list: "newsletter" }` or `audience: { bucket: "power-users" }`
(exactly one, validated). Resolution to actual recipients happens at send
time, in the engine's campaign wave runtime (`send-campaign.ts`), and follows
each system's own semantics exactly:

- **List audience** — resolved by polarity: opt-out lists scan `contacts`
  minus explicit opt-outs (a contact with no prefs row IS included); opt-in
  lists scan `email_preferences` for explicit `true`. Globally-unsubscribed
  and suppressed contacts are excluded up front. The list id is passed as the
  send's `category`, so suppression and the unsubscribe link point at the
  list itself.
- **Bucket audience** — active, non-deleted memberships joined to live
  contacts, suppression pre-filtered. **Consent is borrowed from the email
  template's own declared category** (which is itself a defined list — see
  above): that category drives suppression and the List-Unsubscribe target.
  A bucket campaign's compliance story is exactly as good as its template's
  category, no better.

## Where everything lives

| Noun | Authored | Registered via | Storage | Data plane |
|---|---|---|---|---|
| Contact | not authored — ingested | — | `contacts`, `contact_aliases`, `email_preferences` | `/v1/contacts`, admin routes |
| List | `apps/api/src/lists/index.ts` (`defineList`) | `createHogsendClient({ lists })` | key in `email_preferences.categories` | `/v1/lists`, `/v1/lists/:id/(un)subscribe`, preference center |
| Bucket | `apps/api/src/buckets/*.ts` (`defineBucket`) | `createHogsendClient({ buckets })` + `createWorker({ buckets })` | `bucket_memberships` | admin bucket routes, Studio |
| Audience | inline on `defineCampaign` / `POST /v1/campaigns` | — | two columns on `campaigns` (`audienceKind`, `audienceId`) | — |

(Engine machinery: `packages/engine/src/lists/`, `packages/engine/src/buckets/`,
resolvers in `packages/engine/src/workflows/send-campaign.ts`.)

## Known warts

1. **`bucket_memberships.userEmail` normalization** — fixed at the root:
   every write site (realtime join, reconcile cron, backfill task) now runs
   `normalizeEmail()`, and migration 0043 backfilled existing rows. The read
   sites' defensive `lower(trim(…))` joins are retained as belt-and-braces —
   TODO(cleanup): safe to strip once `@hogsend/engine` has shipped past
   0.40.0 (see the `TODO(cleanup)` in `send-campaign.ts`'s
   `resolveBucketRecipients`).
2. **The email/userId keyspace seam** — consent keys on email, behavior keys
   on userId. Correct, but every crossing (bucket audience → email send) is a
   join that must handle a missing/mixed-case email. Wart 1 is the sharp
   corner of this seam.
3. **Manual-bucket vs opt-in-list convergence** — not a problem today
   (manual is rejected), but the decision rule above should hold when it
   ships, or we get two spellings of "people I put here."
