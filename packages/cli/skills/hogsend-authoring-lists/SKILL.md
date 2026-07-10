---
name: hogsend-authoring-lists
description: Use when adding or editing a code-defined email list in src/lists/ — defineList({ id, name, description?, defaultOptIn, enabled? }) from @hogsend/engine. A list is just a named email_preferences.categories key (NO new table); defaultOptIn:false = opt-in, defaultOptIn:true = opt-out. Covers the reserved ids, the id pattern, and the register ritual (src/lists/index.ts + thread the lists array into createHogsendClient in BOTH src/index.ts and src/worker.ts — lists are NOT passed to createWorker). Surfaced at GET /v1/lists + POST /v1/lists/:id/(un)subscribe.
license: MIT
metadata:
  author: withSeismic
  version: "1.0.0"
---

# Authoring Hogsend lists

A **list** is a code-defined email subscription category — a newsletter, a
product-updates digest, a beta-announcements channel. You declare it with
`defineList()` in `src/lists/`, mirroring `defineJourney()` / `defineBucket()`:
a synchronous, definition-time call that validates the id and returns a
`DefinedList`.

The headline fact: **a list is NOT a new table.** It is a named key inside the
existing `email_preferences.categories` JSONB. `defineList` just declares that
key, gives it a human name, and sets its **default polarity** (`defaultOptIn`).
The engine's mailer suppression check and the preference center read that key;
the data plane exposes it at `GET /v1/lists` + `POST /v1/lists/:id/(un)subscribe`.

You are editing a **scaffolded consumer app** (content only). You import
`defineList` from `@hogsend/engine`; you never touch engine internals (the
registry, the suppression check, the preference-center wiring are all engine-owned).

## The shape

```ts
import { defineList } from "@hogsend/engine";

export const productUpdates = defineList({
  id: "product-updates",                 // category key — see id rules below
  name: "Product updates",               // human label (shown in GET /v1/lists)
  description: "New features and product news.", // optional
  defaultOptIn: false,                   // opt-in (blocked until subscribed)
  // enabled: true,                      // optional, defaults to true
});
```

`defineList({ id, name, description?, defaultOptIn, enabled? })`:

| field | required | notes |
|-------|----------|-------|
| `id` | yes | The `email_preferences.categories` key. Must match `/^[a-z0-9_-]+$/i` (letters, digits, `-`, `_`). `transactional` and `journey` are **RESERVED** and rejected (they are the engine's built-in non-list categories — colliding would corrupt suppression logic). `in_app` is **RESERVED** too (the engine's in-app feed channel — see [Channels](#channels-auto-registered)). |
| `name` | yes | Human label surfaced on the list API + preference center. |
| `description` | no | Optional one-liner; omitted from `meta` entirely when absent. |
| `defaultOptIn` | yes | The default polarity. See below — this is the one decision that matters. |
| `enabled` | no | Defaults to `true`. A disabled list is dropped from the registry. |

A malformed or reserved `id` makes `defineList` **throw at definition time** — so
a bad list id fails fast at boot, not silently at send time.

## Channels (auto-registered)

Every list has a `kind`. The lists you author are `kind: "topic"`. The engine
**auto-registers** the other kind — `kind: "channel"` — for the delivery
transports a contact can opt out of. You do NOT `defineList` a channel; the
engine synthesizes them and mounts them at the SAME endpoints (`GET /v1/lists`,
`POST /v1/lists/:id/(un)subscribe`). All channels are **opt-out**
(`defaultOptIn: true`).

- **`in_app`** — always registered. Gates the in-app notification feed.
- **one per member-directed connector** — a connector whose action set declares a
  member-directed action (Telegram `dm`/`sendMessage`, Discord `dmMember`) gets a
  channel keyed by its connector id (`telegram`, `discord`). Those sends are then
  preference-gated automatically (a contact opted out of the `telegram` channel
  stops getting Telegram DMs). Registered only when that connector is wired in.

Two consequences for your `defineList` ids:

- **`in_app` is reserved** — `defineList({ id: "in_app" })` throws at definition
  time.
- **No collision with a channel id** — a `defineList` id that equals an
  auto-registered channel id (e.g. `telegram` or `discord` while that connector is
  configured) **throws at boot** (`List id "telegram" collides with the
  auto-registered channel list…`). Rename your list. Channels are registered
  unconditionally — `ENABLED_LISTS` filters your topic lists but never drops a
  channel.

`GET /v1/lists` items now carry `kind`, so `<PreferenceCenter>` sections Channels
above Topics automatically. A channel list is NEVER a valid email `category` (on a
journey/template) or a campaign audience — the engine rejects it fail-closed
(a channel gates a transport, not an email topic).

## `defaultOptIn` — opt-in vs opt-out (the only real decision)

A list's default polarity decides whether a contact is subscribed BEFORE they
ever touch the preference center. The mailer's suppression check reads
`email_preferences.categories[id]` against this default:

- **`defaultOptIn: false` (opt-in).** The contact is NOT subscribed until they
  explicitly subscribe. A send gated on this list is **blocked unless
  `categories[id] === true`** (an exact `true`). This is the right default for a
  marketing newsletter, a beta list, anything that needs affirmative consent.
- **`defaultOptIn: true` (opt-out).** The contact IS subscribed by default. A
  send is blocked **only on an explicit `false`** (`categories[id] === false`) —
  absence or any other value means subscribed. This is the "default newsletter
  everyone gets until they unsubscribe" pattern.

The asymmetry is deliberate: opt-in requires an exact `true`, opt-out requires an
exact `false`. Everything in between resolves to "subscribed" for opt-out and
"not subscribed" for opt-in.

To gate a send on a list, pass the list id as the `category` on the send (the
engine's `sendEmail()` / the data-plane `POST /v1/emails`). The suppression check
then applies the polarity above. A send with no `category` is not gated on any
list.

## Subscribe / unsubscribe paths

Membership is just a write to `categories[id]`. Three surfaces flip it:

- **Data plane:** `POST /v1/lists/:id/subscribe` (sets `true`) /
  `POST /v1/lists/:id/unsubscribe` (sets `false`), by identity (`email` or
  `userId`). `GET /v1/lists` returns every defined list AND every auto-registered
  channel as `{ id, name, description?, defaultOptIn, kind, subscribed }`.
  `POST /v1/lists/preferences` writes the account-wide `unsubscribedAll` master.
- **`@hogsend/client`:** `hs.lists.list()` / `hs.lists.subscribe(...)` /
  `hs.lists.unsubscribe(...)` (see the hogsend-client-sdk skill).
- **As a side effect of a write:** `contacts.upsert` and `events.send` accept a
  `lists: { [id]: boolean }` map that subscribes/unsubscribes inline.

You author the list; you do NOT write any of these endpoints — the engine mounts
them off the `ListRegistry` built from your `lists` array.

## Registering a list (the wiring ritual)

A defined list does nothing until it is (1) exported from the barrel and (2)
threaded into the client in BOTH entry points. **Lists are NOT passed to
`createWorker`** — unlike buckets, there is no worker-side list wiring. Lists
resolve entirely through the client's `ListRegistry`, so the worker process picks
them up via its OWN `createHogsendClient({ lists })` call, not via `createWorker`.

### 1. Export from `src/lists/index.ts`

```ts
// src/lists/index.ts
import { defineList } from "@hogsend/engine";

export const productUpdates = defineList({
  id: "product-updates",
  name: "Product updates",
  description: "Occasional emails about new features and product news.",
  defaultOptIn: false,
});

// All defined lists for this app. Passed to createHogsendClient({ lists }) in
// BOTH src/index.ts and src/worker.ts. Edit freely — this is your content.
export const lists = [productUpdates];
```

(Let the array infer — no `DefinedList[]` annotation is required, mirroring the
buckets barrel; the base type re-widens each id literal back to `string`, but a
`DefinedList<Id>` is still assignable to the base `DefinedList[]` the client
accepts.)

### 2. Thread into `createHogsendClient` in `src/index.ts`

```ts
// src/index.ts
import { createApp, createHogsendClient } from "@hogsend/engine";
import { lists } from "./lists/index.js";
// ...templates, journeys, webhookSources...

const client = createHogsendClient({
  journeys,
  lists,                 // ← builds the ListRegistry; powers GET /v1/lists + suppression
  email: { templates },
});

const app = createApp(client, { webhookSources });
```

### 3. Thread into `createHogsendClient` in `src/worker.ts`

```ts
// src/worker.ts
import { createHogsendClient, createWorker } from "@hogsend/engine";
import { lists } from "./lists/index.js";

const client = createHogsendClient({
  journeys,
  lists,                 // ← same lists array; the worker's mailer needs the registry too
  email: { templates },
});

const worker = createWorker({ container: client, journeys /* …, NO lists here */ });
```

Note the asymmetry vs buckets: `lists` goes into `createHogsendClient` in BOTH
files, but it is **never** passed to `createWorker`. Passing it to `createWorker`
is not an option the factory takes. The worker's send path gets lists through the
client's `ListRegistry`.

Reference implementation: `apps/api/src/lists/index.ts` in the engine monorepo.

## Golden rules

1. A list is a `categories` key, NOT a table. There is no migration, no
   `db:generate` — `defineList` + the wiring is the whole change.
2. `defaultOptIn` is the one decision. `false` = opt-in (needs an exact `true` to
   send); `true` = opt-out (blocked only on an exact `false`). Pick consciously.
3. `id` must match `/^[a-z0-9_-]+$/i`. `transactional`, `journey`, and `in_app`
   are reserved and throw, and your id must not collide with an auto-registered
   channel (`in_app`, `telegram`, `discord`) — a collision throws at boot.
4. Wire `lists` into `createHogsendClient` in BOTH `src/index.ts` AND
   `src/worker.ts`. Do NOT pass `lists` to `createWorker` — it is not an accepted
   option; lists resolve via the client's `ListRegistry`.
5. Gate a send on a list by passing the list id as the send's `category`. No
   `category` = not gated.
