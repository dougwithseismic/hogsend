# Groups

Hogsend's **groups** are first-class account/team/company-level entities — the
sovereign answer to PostHog group analytics. A group is any collective a contact
belongs to: a `company` (`acme.com`), a `team` (`growth`), a `workspace`, an
`account`. Every group is identified by its `(groupType, groupKey)` natural key,
carries its own property bag, and tracks its members.

The whole model is **standalone (DB-first)**: it works with zero analytics
provider — groups, memberships, and the per-event association map all live in
Hogsend's own tables. When PostHog **is** configured the association forwards as
`$groups` on each mirrored capture and property writes call PostHog
`groupIdentify` — an automatic win, not a second integration to wire.

**Group-level journeys are deliberately deferred** (a future phase). Journeys
stay person-scoped today; a person-journey does not yet read group state. See
[Deferrals](#deferrals-v1).

## The data model

Three pieces, all engine-owned:

- **`groups`** (`packages/db/src/schema/groups.ts`) — one row per group:
  `id`, `organizationId` (multi-tenant scope, nullable today), `groupType`,
  `groupKey`, `displayName`, `properties` (jsonb bag), `firstSeenAt`,
  `lastSeenAt`, `deletedAt` (soft-delete), plus `createdAt`/`updatedAt`. The
  natural key is enforced by a **partial-unique** index on `(groupType,
  groupKey) WHERE deleted_at IS NULL` — exactly one LIVE group per type+key, so
  a soft-deleted row can retain its stale key. `organizationId` is deliberately
  OMITTED from the arbiter (nullable + NULLs-distinct would fork the default
  org=NULL case into duplicates) — identical idiom to the `contacts` identity
  indexes.
- **`group_memberships`** (`packages/db/src/schema/group-memberships.ts`) — a
  join table (`groupId` → `contactId`, both real uuid FKs with `onDelete:
  cascade`), an optional `role` label, and `joinedAt`. Unique on `(groupId,
  contactId)` — exactly one membership per pair. Memberships have no
  soft-delete; a remove is a hard delete.
- **`user_events.groups`** — a `jsonb` `Record<string, string>` column
  (`groupType → groupKey`) carrying the group association each event belongs to
  (e.g. `{ company: "acme.com", team: "growth" }`), null when unset.

The portable domain shapes (`Group`, `GroupMembership`, `GroupIdentifyInput`,
`GroupMemberInput`) and the `GroupsAssociation` map type live in `@hogsend/core`
(`packages/core/src/types/group.ts`), decoupled from the drizzle row types so
SDK consumers take no DB dependency. Their Zod validators
(`groupIdentifySchema`, `groupMemberSchema`, `groupsAssociationSchema`) live in
`packages/core/src/schemas/group.schema.ts`.

## Associating groups (the browser path)

The **browser SDK associates only** — it never writes group properties or reads
groups (those are secret-key operations). `hogsend.group(groupType, groupKey)`
merges into the reactive `groups` slice; every subsequent `capture` carries the
full map.

```ts
import { createHogsend } from "@hogsend/js";

const hogsend = createHogsend({ apiUrl, publishableKey: "pk_…" });

hogsend.group("company", "acme.com");
hogsend.group("team", "growth");
hogsend.capture("feature_used"); // sent with groups: { company, team }

hogsend.getGroups();  // { company: "acme.com", team: "growth" }
hogsend.resetGroups(); // clears associations (reset() also clears, PostHog parity)
```

There is **no `properties` argument on `group()` by design** — group PROPERTIES
are a secret-key write. On the React side, `useGroup()` exposes the same
association-only surface bound to the provider client:

```tsx
import { useGroup } from "@hogsend/react";

function OrgSwitcher() {
  const { groups, group, resetGroups } = useGroup();
  // groups is read reactively (useSyncExternalStore); group()/resetGroups() mutate
}
```

### The `/v1/events` `groups` field

Both SDKs attach the association map to the ingest call — `POST /v1/events`
accepts an optional `groups: Record<string, string>` field:

```jsonc
POST /v1/events
{
  "name": "feature_used",
  "userId": "u_1",
  "groups": { "company": "acme.com" }
}
```

On ingest (`packages/engine/src/lib/ingestion.ts`), an event carrying `groups`:

1. persists the map on `user_events.groups`;
2. runs `associateGroups` — ensures each group row exists (a bare
   resolve-or-create upsert, **no property write, no analytics**) and upserts a
   `group_memberships` row for the resolved contact (idempotent
   `onConflictDoNothing`);
3. forwards the map to analytics as `$groups` on the mirrored `capture` (when
   the event mirror is enabled and a provider is configured).

The association path is best-effort (a group-write hiccup never fails an
already-stored event) and runs on the fresh-insert side of the idempotency
guard, so a same-key replay never re-associates. It is **association-only** — a
publishable (`pk_`) key can reference a group key here but can never write group
properties or read groups.

## The group HTTP API (secret-key only)

Group property writes, membership mutations, **and reads** all live on the
secret-key `/v1/groups` router (`packages/engine/src/routes/groups/index.ts`).
The prefix is guarded by `requireApiKey` + `requireScope("ingest")` in
`routes/index.ts` (bare + `/*` subtree) — a browser (`pk_`) key is rejected
before it reaches any handler.

### Identify (upsert) a group

`POST /v1/groups` resolves-or-creates the group by natural key, merges
`properties` onto its bag (new keys win, `displayName` coalesces so an omitted
name never nulls an existing one), best-effort mirrors the write to the active
analytics provider (`groupIdentify`), and emits the outbound `group.identified`
event.

```jsonc
POST /v1/groups
{
  "groupType": "company",
  "groupKey": "acme.com",
  "displayName": "Acme, Inc.",
  "properties": { "plan": "enterprise", "seats": 42 }
}
// → 200 { "group": { id, groupType, groupKey, displayName, properties, firstSeenAt, lastSeenAt, … } }
```

### Members

```jsonc
POST   /v1/groups/{groupType}/{groupKey}/members         { "contactId": "<uuid>", "role": "admin" }
// → 200 { "membership": { … }, "created": true }   // created:false on a re-add
// → 404 when the contactId is well-formed but unknown/soft-deleted (no orphan group is minted)

DELETE /v1/groups/{groupType}/{groupKey}/members/{contactId}
// → 200 { "removed": true }   // removed:false when the group or membership did not exist

GET    /v1/groups/{groupType}/{groupKey}/members?limit=50&offset=0
// → 200 { "members": [ { contactId, email, externalId, role, joinedAt } ] }   // newest-joined first, live contacts only
```

The add-member handler asserts the contact exists **before** resolving the group
(a `GroupContactNotFoundError` → 404), so a bad contact id never creates an
orphan group. `contactId` is validated as a uuid at the route, so a malformed id
is a 400 rather than a 500.

### Read

```jsonc
GET /v1/groups/{groupType}/{groupKey}              // → 200 { group } | 404
GET /v1/groups?groupType=company&limit=50&offset=0 // → 200 { groups: [ … ] } // newest-seen first, default 50 max 200
```

### Server SDK — `@hogsend/client`

The `groups.*` resource (`packages/client/src/resources/groups.ts`) is the typed
binding for the secret-key data plane. Both path segments are URL-encoded, so
keys with reserved characters are safe.

```ts
import { Hogsend } from "@hogsend/client";

const hs = new Hogsend({ baseUrl: "https://api.example.com", apiKey: "hsk_…" });

await hs.groups.identify({
  groupType: "company",
  groupKey: "acme.com",
  displayName: "Acme, Inc.",
  properties: { plan: "enterprise" },
});
await hs.groups.addMember({ groupType: "company", groupKey: "acme.com", contactId, role: "admin" });
await hs.groups.listMembers({ groupType: "company", groupKey: "acme.com" });
const group = await hs.groups.get({ groupType: "company", groupKey: "acme.com" });
const companies = await hs.groups.list({ groupType: "company" });
await hs.groups.removeMember({ groupType: "company", groupKey: "acme.com", contactId });
```

## Analytics forwarding (the PostHog auto-win)

Group support is an **optional wire** on the neutral `AnalyticsProvider`
contract (`packages/core/src/providers/analytics.ts`):

- `CaptureOptions.groups` — a `groups` map on any `capture`, forwarded to the
  provider (PostHog `$groups`) so the event is attributed to those groups;
- `groupIdentify({ groupType, groupKey, properties })` — the group analog of the
  person `setPersonProperties` write;
- `capabilities.groups` — declares the provider supports groups. A provider that
  can't do groups omits `groupIdentify` and leaves the flag false; the engine
  no-ops, so this stays purely additive and the standalone DB path is unaffected.

The PostHog provider (`packages/plugin-posthog/src/provider.ts`) sets
`capabilities.groups: true`, forwards `groups` as `$groups` on capture
(`capture.ts`), and implements `groupIdentify` (fire-and-forget over the same
async posthog-node queue as capture). So with `POSTHOG_API_KEY` set:

- browser/event associations ride the mirrored capture as `$groups`;
- `POST /v1/groups` / `groups.identify` property writes also call
  `posthog.groupIdentify`.

With no provider configured, all of the above is a no-op and the sovereign DB
tables remain the single source of truth.

## Segment `group` integration

The Segment webhook preset (`packages/engine/src/webhook-sources/presets/segment.ts`,
`POST /v1/webhooks/segment`, HMAC-hex signed via `SEGMENT_WEBHOOK_SECRET`) maps
Segment's `group` call. Segment's group model is single-type, so the `groupType`
defaults to `"company"` and `groupId` becomes the `groupKey`:

1. it **writes the group + its traits** via `identifyGroup` — safe because the
   webhook is HMAC-signed (trusted server-to-server), unlike a publishable
   browser key which may only associate;
2. it returns a `segment.group` `IngestEvent` carrying `groups: { company:
   groupId }`, so the ingest pipeline resolves the contact and creates the
   **membership** through the same `associateGroups` path, plus Events-feed
   observability.

Note: the outbound `group.identified` webhook does **not** fire from the Segment
path — a webhook-source `ctx` has no `hatchet`; only the `POST /v1/groups` HTTP
route owns that fan-out.

## Outbound webhook events

Three `group.*` events join the signed outbound event catalog
(`WEBHOOK_EVENT_TYPES` in `packages/engine/src/lib/webhook-signing.ts`, the
single source of truth mirrored into `@hogsend/cli` and `@hogsend/client`):

- **`group.identified`** — a successful `POST /v1/groups` identify;
- **`group.member_added`** — a membership add that THIS call inserted
  (`created:true`; a re-add is a no-op);
- **`group.member_removed`** — a membership row that was actually deleted.

All three fire from the **intent-layer `/v1/groups` routes ONLY** — never from
the ingest / `associateGroups` path, so a pageview-driven association can't flood
the outbound stream (the same intent-layer rule the contacts events follow).

## Studio (observe views)

Studio ships two **observe-only** views (`packages/studio/src/views/`), backed
by the read-only admin endpoints (`packages/engine/src/routes/admin/groups.ts`,
`requireAdmin`-guarded):

- **Groups list** (`groups-view.tsx`, `/groups`) — every live group newest-seen
  first, with member counts.
- **Group detail** (`group-detail-view.tsx`, `/groups/:groupType/:groupKey`) —
  the header + stats (members / first seen / last seen), the property bag, recent
  members, and recent tagged events (selected via the `user_events.groups` jsonb
  containment operator).

There is intentionally **no create/edit-group UI** in Studio — groups are
authored in the data plane; Studio observes.

## Base-currency lens (optional FX)

Group revenue is grouped **per currency and never summed across currencies**
(`lib/revenue.ts`'s law — a GBP deal and a USD deal don't add). The
base-currency lens is an **opt-in converted VIEW** layered on top of that
truth, so yen and dollars can sit in the same funnel: each per-currency total
converts through an operator-sanctioned quote→base rate, and only the
conversions are summed. **Off by default** — with no `BASE_CURRENCY` set,
nothing anywhere converts and nothing changes.

Envs:

- `BASE_CURRENCY` — the reporting currency (e.g. `USD`). Unset = lens off.
- `FX_PROVIDER` — the rate source: `static` (default) or `frankfurter`.
- `FX_RATES` — the static sheet: JSON quote→base rates, e.g.
  `{"JPY":0.0065,"GBP":1.27}` (= 1 JPY is 0.0065 base units). Malformed JSON
  or non-positive rates **fail the boot loudly** — a typo'd sheet must never
  silently convert money wrong.
- `FX_RATES_AS_OF` — optional ISO date labeling the static sheet.

**The base currency is also a Studio setting** (Settings → Currency, backed by
`GET/PUT/DELETE /v1/admin/settings/fx` over the generic `operator_settings`
table). Precedence, resolved **per request** (a Studio change needs no
reboot): a code pin (`createHogsendClient({ fx: { baseCurrency } })`) wins
over everything; then the stored setting — a row with `baseCurrency: null` is
the operator **explicitly turning the lens off and beats env**; with no row,
env `BASE_CURRENCY` decides (DELETE clears the override back to env). **The
static-sheet honesty rule**: an `FX_RATES` sheet is quoted against exactly one
base (the env `BASE_CURRENCY` it was written for), so when the effective base
differs — e.g. Studio picks another currency — the sheet serves **nothing**
(converted figures disappear) rather than mis-multiplying its rates into a
base they were never quoted in. Frankfurter re-bases natively and is
unaffected; the Settings card warns in plain language when the configured
sheet can't serve the chosen base.

**Static is the default because it is sovereign**: the operator supplies the
rates, zero network in the money path, figures change only when the operator
changes them. **Frankfurter** (`FX_PROVIDER=frankfurter`) opts into ECB daily
reference rates: one `latest?from=<base>` call fetches every quote (inverted
to quote→base), upserted into the `fx_rates` table so conversions are pinned
to a recorded sheet and the API sees **at most one call per 24h staleness
window**. **Fail-soft throughout**: a failed fetch serves the last cached
sheet; cold + down resolves to no lens — converted figures degrade to absent,
the per-currency truth always still serves. A BYO source implements the
one-wire `FxRateProvider` contract (`defineFxRateProvider`, `@hogsend/core`)
and is passed as `createHogsendClient({ fx: { provider } })`.

With the lens active, the admin group list/detail gain `revenueBase` (the
converted sum) per group and a top-level `fx: { baseCurrency, asOf }` label.
A group with **any** unconvertible currency reports `revenueBase: null` — a
partial sum is a lie. `sort=revenue` ranks by the base-converted sum in SQL;
if any currency on the filtered groups lacks a rate, the **ranking falls back
wholesale** to the existing cross-currency heuristic for that request (warned
in the log) — excluding the unconvertible rows would zero-out a real account,
and converting only some money would rank a partial sum.

## Security posture

- **Group PROPERTY writes, membership mutations, and reads are secret-key only** —
  the `/v1/groups` router, the `@hogsend/client` `groups.*` resource, and the
  Segment webhook (HMAC-signed). This is operator data; it never leaves the
  server.
- **Publishable / browser keys may ONLY associate** — attach a `groups` map to
  an ingested event via `hogsend.group()` → `POST /v1/events`. They can never
  write group properties or read groups. The ingest association path writes no
  properties and fires no analytics `groupIdentify`.
- **Standalone by default** — everything works with zero analytics provider.
  PostHog forwarding (`$groups` + `groupIdentify`) is an automatic add-on when
  `POSTHOG_API_KEY` is present, never a requirement.

## Deferrals (v1)

- **Group-level journeys** — journeys stay person-scoped; a person-journey does
  not yet read group state, and there is no group-triggered enrollment. A future
  phase.
- Organization-scoped uniqueness (the `organizationId` column exists but is not
  part of any unique key — a system-wide multi-tenancy concern).
- Group merge / alias (no `(groupType, groupKey)` re-key path).
