# Hogsend Identity Stitching — Engine Spec

## Status & summary

**Status: SHIPPED in `@hogsend/*@0.23.0`** (2026-06-15) — proven end-to-end on the dogfood (`t.hogsend.com`): an anonymous id and a logged-in id merged into one PostHog person via exactly one `$create_alias`. This document is the design reference; the implementation spans `@hogsend/core`, `@hogsend/engine`, `@hogsend/plugin-posthog`, `@hogsend/plugin-discord`, and `@hogsend/client`. Shipped as **one additive minor** on the engine version line — every new path **off by default**, zero forced migration.

**The problem in one line:** today one human becomes many PostHog persons, because the server never merges identities, the server and web distinct-id keyspaces are unrelated by construction, the browser's `persistence:"memory"` makes the one in-session web merge session-scoped, and the single server↔web bridge (`TRACKING_IDENTITY_TOKEN`) is off by default and forward-only.

**The fix in one line:** establish exactly one canonical, ever-identified distinct_id per human (the Hogsend contact key) and absorb every other id INTO it while still anonymous — via (1) end-to-end `anonymousId` threading so the contact key *equals* the browser id (zero-merge), (2) a provider-neutral `mergeIdentities` primitive the engine fires at the two resolver outcomes where two keys become one, (3) a server-side `alias` at `/v1/t/identify` (immune to browser persistence resets) plus identity-bearing tracked links, and (4) Discord `/link` reusing the same merge hook.

**What this release does NOT do (stated up front, because the review caught overclaiming):** it stops new forks and stitches forward; it does NOT retroactively heal historical fragmentation, and it leaves a **known steady-state residual** wherever a merge would require folding two *already-identified* PostHog persons (PostHog refuses that on the safe path — only `$merge_dangerously` repairs it, which is deferred). "One email → one person" holds **except across two prior identified persons.**

**Provider-neutrality:** the entire design speaks the `@hogsend/core` `AnalyticsProvider` contract. PostHog is the reference implementation; nothing hard-couples to it.

---

## 1. Problem & current state (audit evidence)

Verified against the live tree (all paths under `/Users/godzillaaa/Documents/WEB_PROJECTS/clients/growthhog`):

- **The server never identifies or merges.** Email-lifecycle events (`email.sent/opened/clicked/bounced`) are only *captured*: the PostHog capture body is exactly `{api_key,event,distinct_id,timestamp,properties}` — no `$anon_distinct_id`, no `$identify`, no `$set` (`packages/engine/src/destinations/presets/posthog.ts:62-73,166`). Server-side `identify()`/`alias()` is never called (0 grep matches across `packages/`+`apps/`). The paths that look like "identify" (`packages/engine/src/lib/analytics-adapter.ts:32-44`, `packages/plugin-posthog/src/provider.ts:74-85`, `service.ts:49-55`, `apps/api/src/journeys/feedback-nps.ts:79-82`) are `$set`-only property writes via `capture({event:"$set"})`.
- **Server distinct_id = the Hogsend contact key.** `contactKey() = external_id ?? anonymous_id ?? id` (`packages/engine/src/lib/contacts.ts:304-306`). For an email-only docs subscriber that is the raw contact-row UUID. Used by ingest (`ingestion.ts:71-78,136-145`), the destination (`posthog.ts:166`), and the `syncPersons` rail (`posthog.ts:115-141`).
- **Web keyspace is unrelated and ephemeral.** `posthog-js` boots with `persistence:"memory"` (`apps/docs/components/analytics/posthog-boot.tsx:35-36`), so its random anon distinct_id **regenerates on every full page load**. The browser anon id *is* captured at subscribe (`apps/docs/components/landing/email-capture.tsx:169,178`) but is shipped to the server only as an inert contact PROPERTY `posthogDistinctId` (`apps/docs/app/api/subscribe/route.ts:83`). The `/v1/events` schema has **no** `anonymousId` field (`packages/engine/src/routes/events/index.ts:8-17`), even though `resolveOrCreateContact` already accepts `anonymousId` as the 2nd-precedence key — it is simply never passed.
- **Web merges only in-session, opt-in.** posthog-js auto-folds `$anon_distinct_id` on two paths only: subscribe `identify(contactKey,{email,name})` (`email-capture.tsx:199-204`) and the `hs_t` click `identify(distinctId)` (`posthog-boot.tsx:55-72`). Both are lost on the next full reload under `"memory"`.
- **The one server↔web bridge is off and forward-only.** `TRACKING_IDENTITY_TOKEN` defaults `false` (`packages/engine/src/env.ts:165`); it gates `hs_t` mint (`routes/tracking/click.ts:122-135`). `/v1/t/identify` merely decrypts and returns `{distinctId}` — it never calls PostHog (`routes/tracking/identify.ts:49-71`). The token's `distinctId` is the email-person id (`lib/tracking-events.ts:25,37`) — the same server key, not the web anon uuid.
- **The contract has no merge method.** `AnalyticsProvider` (`packages/core/src/providers/analytics.ts`) has no `alias`/merge today.

**Verdict:** the server never merges; web and server keys are unrelated by construction; `persistence:"memory"` makes web merges session-scoped; the one bridge is off + forward-only. Net: one email → many PostHog persons.

---

## 2. Goals & non-goals

**Goals**
1. Exactly one ever-identified distinct_id per human (the canonical contact key); every other id absorbed into it while still anonymous.
2. Stitch forward across sessions, devices, and channels (web, email, Discord, referral) — server-side, immune to browser persistence resets.
3. Provider-neutral: one optional primitive on `AnalyticsProvider`; the engine no-ops cleanly on providers that can't merge.
4. Additive minor, off by default, zero forced migration, clean rolling-deploy story.

**Non-goals (this release)**
1. Retroactive healing of historical one-email-many-persons data (deferred — OQ-2).
2. Repairing collisions of two *already-identified* persons via `$merge_dangerously` (deferred — OQ-1; this is the known residual, §10).
3. Native ad-platform conversion forwarding (out of scope per project CAPI decision).
4. Making the consumer's browser `persistence` choice an engine concern (it is a documented consumer recommendation, §8).

---

## 3. Identity model

### 3.1 Governing invariant

> **There is exactly ONE distinct_id per human that ever becomes `is_identified` in the analytics person store: the canonical Hogsend contact key.** Every other id a human generates — browser anon session, click-landing anon session, Discord snowflake, a pre-link contact UUID — is **absorbed INTO that canonical key while still anonymous, never identified independently.**

This is not a stylistic choice; it is the only model that survives PostHog's merge physics (§3.3). It is also provider-neutral: "one identified key, absorb the rest" is the lowest common denominator across PostHog `alias`, Segment/Rudderstack `alias`, and Amplitude merge.

### 3.2 The canonical key

`contactKey(row) = external_id ?? anonymous_id ?? id` (`contacts.ts:304-306`; SQL twin `contactKeySql()` at `:315-317`). This is already the join key for all contact-referencing tables (re-pointed on merge at `contacts.ts:566-579`), the `userId` destinations emit, what `hs_t` carries, and what `/v1/events` returns as `contactKey`. **Nothing about the key changes.** The work is making every other id converge on it.

### 3.3 PostHog merge physics → legal/illegal call table

Verified against PostHog docs and posthog-node 5.35.1 (native `identify` at `client.d.ts:297`, native `alias({distinctId, alias})` at `:335`, native `aliasImmediate` at `:357`; **no `$merge_dangerously` method** — 0 hits):

- **R1** `$identify`/`alias` merge **anonymous → identified**, directionally; the non-anonymous side wins property conflicts.
- **R2** Cannot re-identify an already-identified anon; cannot merge two already-identified persons on the normal path ("Refused to merge an already identified user").
- **R3** `is_identified` is sticky and one-way. The first `$identify` of a key "burns" it into absorb-only.
- **R4** `alias`'s `alias` argument (PostHog's `alias_id`, the absorbed side) must never have been an `$identify`/`alias` `distinct_id`. `client.alias()` emits a `$create_alias` *event* (there is no `$create_alias` method — don't go looking for one).
- **R6** posthog-node (server) has **no anonymous session**: server `identify` only stamps `is_identified` + props on the key you pass — it stitches *nothing*. **Therefore all server-side stitching uses `alias` (anon-absorb), never server `identify`.**

| Call | Legality | Allowed where |
|---|---|---|
| `posthog.identify(contactKey, {email,name})` with a browser anon session present | LEGAL — folds `$anon_distinct_id` into `contactKey` (R1) | Browser only, at subscribe |
| `client.alias({distinctId: canonical, alias: <anon id>})` | LEGAL iff `alias` was never identified (R4) | Server: `/v1/t/identify`, contact-merge, key-flip |
| server `identify(anonId, …)` to stitch | USELESS — no server anon session (R6) | never |
| `alias({distinctId: anon, alias: canonical})` (direction flipped) | ILLEGAL — tries to absorb an identified key (R2/R4); refused | never |
| pass a web-anon/click/discord id as `distinct_id` of an *identified* capture | ILLEGAL by construction — creates an unmergeable twin (R2/R3) | never |
| `$merge_dangerously` raw capture | last-resort; no native method; deferred (OQ-1) | not in v1 |

**⚠️ MF-1 — the direction footgun, stated as code-review law.** The posthog-node package JSDoc (`client.d.ts:320-339`) shows a **misleading example**: `client.alias({ distinctId: 'anonymous_123', alias: 'user_456' })` — anon as `distinctId`, identified as `alias`. **Do not use the `.d.ts` as the direction reference.** The binding rule comes from the PostHog *docs*, not the package: in `mergeIdentities({distinctId, alias}) → client.alias({distinctId, alias})`, the **first arg `distinctId` is the SURVIVING/canonical (identified) id; the second arg `alias` is the ABSORBED (anonymous) id and MUST never have been an identify/alias `distinct_id`.** The canonical contact key is the *only* value that may appear as `distinctId` (survivor) or as the target of a browser `identify`; anon ids appear *only* as `alias`. An implementer who copies the `.d.ts` example writes the merge backwards, makes the canonical key the absorbed side, and burns it (PostHog refuses the merge). The `provider.test.ts` direction assertion (§9) guards this against the rule, never against the `.d.ts` example.

### 3.4 Convergence summary

| Source | Operation | identified (survivor) / anon | Where |
|---|---|---|---|
| Web anon session | best: thread `anonymousId` so `contactKey == browser id` (no merge). Fallback: posthog-js auto-`$anon_distinct_id` at subscribe | identified = `contactKey`, anon = session id | browser + server (§4) |
| Server lifecycle/email events | `capture` + `setPersonProperties` under `contactKey` (unchanged) | `contactKey` | server destination |
| Email link click | `hs_t` → server `alias({distinctId: contactKey, alias: landing session})` | identified = `contactKey`, anon = landing session | `/v1/t/identify` (§6) |
| Contact merge / Discord `/link` | resolver folds loser → `alias({distinctId: survivorKey, alias: loser ANON key})` | identified = survivorKey, anon = loser anon/uuid key | `ingestEvent` post-resolve (§5) |

---

## 4. Part 1 — `anonymousId` threading (never fork in the first place)

The cheapest stitch is to never fork: make `contactKey` equal the browser distinct id at the first identifying event, so the browser's own anon events and the server's captures land on one person with **zero merge calls**. The resolver already supports this end-to-end: precedence `external → email → anonymous → discord` (`contacts.ts:363-367`), `contactKey = external_id ?? anonymous_id ?? id` (`:304-306`), `ingestEvent` already forwards `anonymousId` to the resolver (`ingestion.ts:15-16,76`), and a later `external_id` attach re-points history via `fillInLink → repointOwnHistory` (`:515-524`) so nothing orphans.

Gaps (all additive → minor):

1. **`/v1/events` schema** (`routes/events/index.ts:8-17`): add `anonymousId: z.string().min(1).max(200).optional()`, and thread `body.anonymousId` into the `ingestEvent` call (`:86-96`). `requireIdentity` (`:74`) still requires email or userId — **`anonymousId` is an extra, never a third identity arm** (anon-only public ingest is an abuse vector).
2. **`@hogsend/client` SDK**: add optional `anonymousId?: string` to `SendEventInput` (`packages/client/src/types.ts:160-166`) and `UpsertContactInput` (`:151-154`) as an **intersection extra**, never a third arm of the `Identity` union (`types.ts:24-26`); `assertIdentity` (`internal/identity.ts:7-18`) is unchanged. Forward it in `EventsResource.send` (`resources/events.ts:18-35`) and the contacts resource.
3. **Consumer (dogfood)**: `apps/docs/app/api/subscribe/route.ts:83` sends the captured browser id as top-level **`anonymousId`**, not the inert `posthogDistinctId` property. The returned `contactKey` then equals the web anon id, and the existing browser `identify(contactKey,…)` is a self-alias no-op.

The `persistence:"memory"` reload-loss problem is a **consumer config decision, not an engine fix** (§8): under `"memory"` this threading stitch is session-scoped (Parts 2/3 carry cross-pageload load); under `"localStorage+cookie"` (recommended behind consent for the dogfood) it becomes permanent and zero-merge.

---

## 5. Part 2 — the provider-neutral `mergeIdentities` primitive

### 5.1 Contract (`@hogsend/core`, `analytics.ts:52-93`)

One optional capability flag (beside `personReads`/`personWrites`, `:52-64`) and one optional method (beside `setPersonProperties`, `:84-86`):

```ts
// AnalyticsCapabilities
/** True when the provider can durably fold two distinct ids into ONE person
 * (PostHog `alias`, Segment/Rudderstack `alias`, Amplitude merge). When false
 * or absent, the engine's identity helper no-ops — stitching is best-effort. */
identityMerge?: boolean;

// AnalyticsProvider
/** Declare `alias` and `distinctId` are the SAME person, folding `alias`'s
 * history into the canonical id. Direction is load-bearing: `distinctId` is the
 * SURVIVING/canonical id, `alias` the absorbed (anonymous) one — mapping straight
 * from the engine's SURVIVOR RULE. Best-effort, idempotent, fire-and-forget.
 * MUST be called only at the moment two keys first become one (a merge event),
 * never per-event: PostHog `alias` is one-directional and once-only per pair.
 * A provider that cannot merge omits this (and sets identityMerge=false); the
 * engine no-ops. */
mergeIdentities?(opts: { distinctId: string; alias: string }): void;
```

`{distinctId, alias}` (not `identify(anon, real)`) is the LCD across providers; `identify(distinctId, props)` is already taken semantically by `setPersonProperties`; the explicit survivor direction maps from the SURVIVOR RULE (`contacts.ts:279-300`). **No `force`/`$merge_dangerously` flag in v1** (no native posthog-node method, irreversible, can't cheaply read `is_identified` — deferred to OQ-1). Both members optional → `defineAnalyticsProvider` pass-through compiles unchanged; the deprecated `PostHogService` shape is untouched. Semver: MINOR (no required interface member — that would be MAJOR).

### 5.2 PostHog implementation (`plugin-posthog/src/provider.ts:45-94`, `client.ts`)

```ts
capabilities: { …, identityMerge: true },
mergeIdentities({ distinctId, alias }) {
  if (!distinctId || !alias || distinctId === alias) return;
  client.alias({ distinctId, alias }); // distinctId=survivor, alias=absorbed — per PostHog DOCS, NOT the .d.ts example (§3.3 MF-1)
},
```

`createPostHogClient` returns a raw `PostHog`, which already exposes `alias` natively; if `client.ts` grows a `capture` facade, add an `alias` pass-through symmetrically. The guard makes the Part-1 self-alias free. `alias` rides the same async posthog-node queue as `capture` (fire-and-forget, won't block the response; `aliasImmediate` exists but we deliberately do NOT await on the hot path).

Legacy adapter (`analytics-adapter.ts:18-54`): no alias wire → leave `identityMerge` absent (`:26`), omit `mergeIdentities`. The engine helper no-ops, so legacy services neither break nor silently mis-stitch.

### 5.3 Engine emission — new helper + exactly two emission points

New `packages/engine/src/lib/analytics-identity.ts`:

```ts
mergeAnalyticsIdentities({ analytics, survivorKey, loserKeys }): void
```
no-ops when `!analytics?.capabilities.identityMerge`; fans out one `mergeIdentities({distinctId: survivorKey, alias: loserKey})` per loser key, skipping `loserKey === survivorKey`; never throws (wraps each call try/catch — fire-and-forget). Fired from `ingestEvent` (which gains an optional `analytics?: AnalyticsProvider` param, threaded from `c.get("container").analytics`); the resolver stays analytics-free (takes only `db`).

**⚠️ MF-2 — the loser-key fan-out MUST filter identified keys (corrects the "rare by construction" overclaim).** Verified: `mergeContacts` builds `loserStrKeys = [loser.externalId, loser.anonymousId, loser.id]` and rewrites all of them (`contacts.ts:559-561`); `recordMergeAliases` records a `reason:"merge"` row for `loser.externalId` whenever present (`contacts.ts:1026-1033`). **A loser carrying an `external_id` is, by the engine's own model, an already-identified PostHog person** (its lifecycle events were captured under that `external_id` as `distinct_id`). Therefore:

- The helper must **NOT** blindly `alias` over all of `loserStrKeys`. It must emit `alias` only for the loser's **anonymous/uuid key** (`loser.anonymousId ?? loser.id`) — **never `loser.externalId`**. Aliasing an `external_id` as the absorbed arg is exactly the identified→identified merge PostHog refuses (R2/R4): it silently no-ops *and* spams PostHog "Refused to merge" warnings on the *normal* merge path.
- `resolveOrCreateContact`'s return gains `mergedKeys?: string[]` carrying **only the safe-to-absorb loser keys** (anon/uuid, with any `external_id` excluded) and a separate `mergedIdentifiedKeys?: string[]` for observability/OQ-1 (the keys we could NOT safely absorb).

**Emission point 1 — collide-MERGE.** `mergeContacts` computes `survivorKey` (`:556`). Post-commit, `mergeAnalyticsIdentities({analytics, survivorKey: resolvedKey, loserKeys: <safe keys only>})`. Where a loser also has an `external_id`, that key is **not** emitted — it is the known residual (§10, OQ-1).

**Emission point 2 — canonical-key flip on fill-in-link.** `fillInLink` re-points own history when `newKey !== oldKey` (`:515-524`). Return `oldKey`; **MF-3 gate:** emit `mergeIdentities({distinctId: newKey, alias: oldKey})` **only when `oldKey` was an anonymous/uuid key (never an `external_id` being superseded)**. The common, safe trigger is "anon/email subscriber later logs in with a real `external_id`" — there `oldKey` is the anon/uuid the contact's events were captured under, and the alias is legal. If the old canonical key was itself an `external_id`, that is the twin case (OQ-1), not a safe alias, and must be skipped + recorded.

**Idempotency placement (MF-missing #2):** `ingestEvent` can be re-driven (Hatchet retries; client retries with the same `idempotencyKey` — the event insert is idempotency-keyed at `ingestion.ts:87`). `mergeAnalyticsIdentities` MUST fire **inside** the idempotency-guarded block (only when the resolver actually performed a merge/flip *this* call), not on every ingest. PostHog `alias` is once-only per pair (harmless on replay), but firing it per-retry violates the "only at the moment two keys first become one" contract and adds queue noise.

---

## 6. Part 3 — identity-bearing tracked links

### 6.1 Goal & threat frame

Generalize `hs_t` beyond email so any Hogsend-tracked link can optionally stitch the clicker. Generalizing widens the token's blast radius, so the whole design is governed by one adversary:

> **IDENTITY-HIJACK:** a tracked link is a bearer credential in a URL. URLs get forwarded, screenshotted, posted publicly, indexed in referrers and history. If clicking a forwarded link lets the *forwardee's* session be identified as the *subject*, two humans collapse into one person.

### 6.2 Which links opt in, and the tier each gets (corrects MF-4)

Defense is **subject-binding scoped to shareability:**

| Link type | Audience | Carries `hs_t`? | Subject binding |
|---|---|---|---|
| **Email link** (existing) | 1:1, addressed inbox | Yes, gated by `TRACKING_IDENTITY_TOKEN` | subject = recipient's canonical key from the `email_sends` row |
| **Referral `/hey/[name]`** | sender → one prospect, but **multicastable in practice** | **No per-prospect `distinctId` token by default** | NONE by default — see MF-4 resolution |
| **Public Discord post** | broadcast, N readers | **No `hs_t`** | none |

**⚠️ MF-4 — referral links must NOT carry a per-prospect token by default.** A `/hey/[name]` page is *designed to be shared* (person-to-person, often pasted into group chats). A token carrying `distinctId = prospect` posted to a group folds *every clicker's* anon session into the one prospect — N strangers → one prospect person. The prior draft called `/hey` "1:1" but nothing enforces 1:1. Resolution: **referral links are treated as broadcast (no identity token) by default.** Stitching a prospect happens only via an explicit on-page action the prospect themselves takes (a normal `/v1/events` with `anonymousId`, Part 1), not via the link credential. If a deployment genuinely needs per-prospect referral stitching, it must opt into **single-use tokens** (burned after first exchange, §6.5), so only the first clicker can fold in. The default ships safe.

So only **email** links (addressed, 1:1-by-delivery) mint `hs_t` by default. Public/broadcast links are tracked (clicks counted) but carry no identity.

### 6.3 Token payload (`lib/identity-token.ts:21-26`)

```ts
interface IdentityTokenPayload {
  distinctId: string;        // canonical contact key — the ONLY ever-identified id; NEVER a per-link/anon id
  src: string;               // "email:<sendId>" | "link:<linkId>" (referral excluded by default, §6.2)
  scope?: "anon-absorb";     // the only merge mode a token may authorize; see MF-7 below
  exp: number;
  emailSendId?: string;      // deprecated alias of src for ONE minor (mirrors resendId→messageId, tracking-events.ts:53-58)
}
```

Single-subject by construction (one canonical key, no "current user" arm). AES-256-GCM, 1h TTL unchanged (`:35,56-65`). Minted at **click time** inside the click route (`:122-136`), **never stored** in `tracked_links` — the shareable artifact `/v1/t/c/:id` carries no identity, only the ephemeral redirect does.

**⚠️ MF-7 — `scope` must default-allow during rolling deploys.** API and worker deploy independently from the same image (separate processes per CLAUDE.md). A new `/v1/t/identify` that **400s** any token missing `scope` would reject every token minted by the still-old click route mid-deploy. Therefore: treat **missing `scope` as `"anon-absorb"`** for the deprecation window; reject only a *present-and-wrong* scope. `validateIdentityToken` today checks only `distinctId`+`exp` (`identity-token.ts:102-107`), so old tokens validate — preserve that.

### 6.4 `tracked_links` schema (`packages/db/src/schema/tracked-links.ts:13-36`) — confirmed-required, MF-6

`emailSendId` is currently `.notNull()` with a self-cascade FK (`:17-19`). Migration (additive → minor, generate via `db:generate`, **not** `db:push`; runs at Railway pre-deploy `db:migrate`):
- drop `.notNull()` on `emailSendId` (keep the nullable FK + the index at `:35`);
- add nullable `distinctId text("distinct_id")` (subject for a stitch-bearing non-email link; **left NULL for broadcast** — Discord/referral default);
- add nullable `source text("source")` (`"email" | "discord" | "link"`).

Loosening a NOT NULL + adding nullable columns never breaks existing rows or inserts. Email-link inserts keep populating `emailSendId`.

### 6.5 `/v1/t/c/:id` click route (`routes/tracking/click.ts`)

1. Select the new columns (`:36-46`): add `distinctId`, `source`.
2. **Gate the `emailSends` first-touch update on `emailSendId != null`** (`:76-88`). Note (MF-6): this is currently *safe-by-accident* (`WHERE id = NULL` matches nothing, no NULL-deref) — make the gate explicit for clarity, not because there's a live bug. **Verify `resolveEmailSendContext` (`:123`) tolerates a NULL `emailSendId` before relying on the fallback** — don't assume.
3. **Gate the semantic-click task** on `emailSendId != null` too (`:97-110`).
4. The `linkClicks` insert + `clickCount` increment (`:64-75`) stay unconditional — every tracked link counts clicks.
5. **Token mint by link type** (`:122-142`): if `link.distinctId` set → mint from it (`src: "${source}:${id}"`); else if `emailSendId` set → existing `resolveEmailSendContext` path; else (broadcast) → mint nothing.
6. **MF-missing #3 — the per-hit outbound emit (`:150-195`) is email-semantic and must NOT fire `email.clicked` for a non-email link.** `emitOutbound("email.clicked", …)` is the wrong event name for a Discord/referral click. For non-email links, emit a distinct, catalogued event name (**`link.clicked`**) — confirm/add it to the outbound catalog — with `{emailSendId: null, messageId: null, userId: link.distinctId ?? null}`. Do not emit a malformed `email.clicked`.

### 6.6 `/v1/t/identify` — server-side `alias` (`routes/tracking/identify.ts`)

Today the route pulls only `{env}` and returns `{distinctId, emailSendId}` (`:52-63`). Changes:

1. Body gains optional `currentDistinctId` (`:24-31`) — the caller's *own* browser anon distinct id.
2. **MF-5 — wire `analytics` and respond synchronously.** Reach `c.get("container").analytics`. When `currentDistinctId` is present and `analytics.capabilities.identityMerge`, fire **fire-and-forget** (do NOT await the alias on the response path): `analytics.mergeIdentities({distinctId: payload.distinctId /*token-proven canonical, survivor*/, alias: currentDistinctId /*caller's own session, absorbed*/})`. Return 200 synchronously.
3. **alias-not-overwrite (the core anti-hijack invariant).** The route NEVER passes `currentDistinctId` as the survivor and NEVER server-`identify`s it. A forwarded-token holder can, at worst, fold *their own* anonymous session into the subject — never overwrite the subject's identified properties, never *become* the subject on their own future identified events, never name a *victim's* anon id (they don't know it; supplying their own is the only useful move). If the caller's session was already identified, PostHog's R2/R4 refusal safely no-ops — exactly desired.
4. **MF-4/scanner (MF-missing prefetch):** the engine already defers semantic-click confirmation past a scanner-burst window (`click.ts:92-110`) because corporate scanners GET every link. The identity token is minted on the *first* GET of `/v1/t/c/:id` regardless of fetcher. State explicitly: a scanner following the redirect supplies **no `currentDistinctId`** (it runs no posthog-js), so the merge no-ops — the exchange is inert for headless prefetch. A browser preview that *does* render the page and supplies its own anon id folds only that preview session, which is the bounded, accepted cost. This is the documented resistance, not silence.
5. **MF-7 scope:** reject only a present-and-wrong `scope`; missing = allow.
6. **Backward-compatible fallback + MF-5 single response schema.** When `currentDistinctId` is absent OR `identityMerge` is false, return the legacy body and let the client do its existing best-effort `posthog.identify(distinctId)` (`posthog-boot.tsx:71`). **Pin ONE response schema across §6 and the API surface: `{ distinctId, src, emailSendId? }`** — `src` is the new field, `emailSendId` retained for the one-minor deprecation window. No forced consumer migration.

### 6.7 New mint surface (`lib/tracking.ts`)

`createTrackedLink({ db, url, distinctId?, source })` → the `/v1/t/c/:id` redirect URL; inserts a row with NULL `emailSendId`. A caller must **explicitly** pass `distinctId` to make a link stitch-bearing — the single chokepoint enforcing "broadcast links carry no subject." Per MF-4, the referral path does **not** pass `distinctId` by default; the Discord destination passes `distinctId: undefined`.

Defaults unchanged: gated by `TRACKING_IDENTITY_TOKEN` (default false, `env.ts:165`), AES-256-GCM, 1h TTL, token `distinctId` always the canonical key.

---

## 7. Part 4 — Discord `/link` (pure reuse of Part 2)

`/link` calls the consumer-injected `resolveContact` wired to `resolveOrCreateContact` (`plugin-discord/src/connector.ts:255-267`), which already merges the discord-keyed contact into the email contact (collide-MERGE, `contacts.ts:437-446`). Nothing emits a PostHog merge today, so Discord-platform events stay on a separate person.

Fix reuses §5.3 emission point 1: when the resolve returns `{merged, mergedKeys, resolvedKey}`, fire `mergeAnalyticsIdentities({analytics: client.analytics, survivorKey: resolvedKey, loserKeys: <safe keys>})`. The SURVIVOR RULE prefers `external_id` rows (`contacts.ts:286`), so `distinctId = resolvedKey` (survivor) and `alias = <discord-contact uuid>` (the loser's anon/uuid key — Discord events were captured under it). Surface via an additive `client.identity.linkContact(...)` so consumers and the connector get it for free.

**MF-missing #4 (tie to MF-2):** a Discord loser that *also* later got an `external_id` (linked, then the Discord side was promoted) is the twin case — its `external_id` is excluded from `loserKeys` and recorded as residual (§10), exactly as in §5.3.

---

## 8. Web & consent (consumer half — outside the engine semver boundary)

The engine cannot fix this for you: **no server-side stitching recovers an anon trail the browser discarded** (`posthog-boot.tsx:35`).

### 8.1 Why `persistence:"memory"` is the load-bearing blocker

`posthog-js` boots `persistence:"memory"` (`:35`) so the site is "strictly cookieless, no consent banner" (`:50-52,87-89`; reinforced in `apps/docs/lib/analytics.ts:90-91,113,124-129`). Defensible for privacy, but it regenerates the anon id every full page load, so both web merge paths fold only the current session. The reverse proxy (`api_host:"/relay"`, `:33`) is **orthogonal to persistence** — it fixes ad-block ingestion, not reload-loss — so the regeneration fact still holds with the proxy in place (the "rejected alternative" below cross-references this).

### 8.2 Recommended default: consent-aware persistence upgrade

Memory pre-consent → `localStorage+cookie` on explicit consent (the subscribe terms checkbox already collected, `email-capture.tsx:489-515`), via `posthog.set_config({ persistence })` — no re-init. Pre-consent stays strictly cookieless (privacy floor preserved); from consent forward the visitor is durably one person with zero further merges.

**⚠️ MF-8 — exact ordering, because `set_config` can rotate the stored id.** To avoid a fork at the consent boundary, do precisely: (1) read `posthog.get_distinct_id()` **once** → `id`; (2) send `id` as top-level `anonymousId` on subscribe; (3) `posthog.set_config({ persistence: "localStorage+cookie" })`; (4) `posthog.identify(id)` with the **same** `id`. Confirm `set_config` does not rotate the id between (1) and (4); if it can, capture `id` before (3) and pass that exact value to (4), so the "self-alias no-op" claim actually holds. Persist the consent decision (e.g. `hs_consent=granted`) and read it in `boot()` (`:26-44`) so a returning consented visitor boots straight into durable persistence.

### 8.3 Rejected alternative — cookieless reverse-proxy as the *primary* fix

Tempting to "go fully server-side cookieless." Rejected as the primary mechanism: the durable cross-pageload binding must live *somewhere on the device* to survive a reload; moving it to a first-party `/relay` cookie just relocates the same ePrivacy consent question. Keep the proxy (right hosting story); `set_config`-on-consent is the honest minimal change.

### 8.4 Subscribe + `hs_t` consumer corrections

- **`apps/docs/app/api/subscribe/route.ts:83`** — forward the captured id as top-level `anonymousId` (prefer dropping the inert `posthogDistinctId` property). Requires `anonymousId?` on the `IngestEventBody` type + `forwardToIngest` in `apps/docs/lib/ingest.ts:9-15,38-72`.
- **`email-capture.tsx:187-204`** — on success, apply the MF-8 ordering; the `identify(contactKey,…)` stays as a consented person-property write (now a self-alias).
- **`posthog-boot.tsx:53-76`** — send `{ token, currentDistinctId: posthog.get_distinct_id() }` to `/api/identity`; forward `currentDistinctId` through `apps/docs/app/api/identity/route.ts:42-48` to the engine `/v1/t/identify`. Keep the client `identify` as a same-session convenience (no longer the durable stitch). Preserve the address-bar token strip (`:56-61`) and the `/hey/<name>` URL scrubbing (`:11-24,42-43`).
- **`apps/docs/lib/analytics.ts:86-129`** — update the `getDistinctId`/`identify`/`sessionIdentity` docs to the upgrade-on-consent lifecycle; add the `set_config` consent helper.

### 8.5 Scaffold / create-hogsend

The template is API-content-only (no `posthog-js`, verified 0 hits under `packages/create-hogsend/template`), so the engine minor needs **no scaffold code change** — only **guidance** in the scaffold's `.claude/skills/` analytics docs: always send `anonymousId` (your provider's anon id, provider-neutral) on `/v1/events` + contact upserts; if you front the engine with a web app, default `posthog-js` to memory and upgrade to `localStorage+cookie` only on explicit consent (MF-8 ordering); `TRACKING_IDENTITY_TOKEN` is opt-in and makes `/v1/t/identify` a server-side `alias`; use the SDK's new optional `anonymousId` rather than hand-rolling an ingest body.

---

## 9. API surface, provider-neutral contract & semver

### 9.1 PostHog destination preset — no contract change (MF-smaller)

Merges are once-per-pair lifecycle moments, not per-event fan-out — the destination transform (which fires per outbound envelope) MUST NOT emit `alias`/merge (would violate the "never per-event" rule). The capture body stays exactly `{api_key,event,distinct_id,timestamp,properties}` (`posthog.ts:62-73`). The anon-keying limitation comment (`:134-141`) is healed **only for contacts resolved with a threaded `anonymousId`** (tighten the wording per the review — a contact created anon-only earlier still omits `anonymousId` in `contact.*` payloads). Comment-only delta → PATCH/none.

### 9.2 `TRACKING_IDENTITY_TOKEN` kept, redefined, NOT retired (`env.ts:159-165`)

Keep the flag, keep `default(false)`, widen the doc only: the token now rides any Hogsend-tracked link (email by default; broadcast links carry none) and drives a **server-side `alias`** at `/v1/t/identify`. Keep it opt-in because it changes outbound URLs (can break pre-signed destinations) and Part 3 *broadens* its blast radius. No new env var — the primitive is gated by `capabilities.identityMerge` at runtime. Env *schema* unchanged → behavioral widen behind an existing opt-in = MINOR.

### 9.3 Semver table

| Change | Package | Verdict | Guard that makes it safe |
|---|---|---|---|
| `/v1/events` `anonymousId` field | `@hogsend/engine` | **MINOR** | optional field; absent = today; `requireIdentity` still enforces email/userId |
| SDK `anonymousId` on event/contact inputs | `@hogsend/client` | **MINOR** | optional intersection extra; `Identity` union + `assertIdentity` unchanged |
| `mergeIdentities` + `identityMerge` capability | `@hogsend/core` | **MINOR** | both optional members; pass-through `defineAnalyticsProvider`; no required member |
| PostHog `mergeIdentities` via native `alias` | `@hogsend/plugin-posthog` | **MINOR** | additive; existing wires untouched; peers new `@hogsend/core` minor |
| Legacy adapter `identityMerge` absent | `@hogsend/engine` | rides engine MINOR | omits method → helper no-ops |
| `/v1/t/identify` `currentDistinctId` + server alias | `@hogsend/engine` | **MINOR** | optional body field; absent = legacy `{distinctId,src,emailSendId?}` response; **`scope` missing=allow (MF-7)** |
| `tracked_links` nullable `emailSendId` + `distinctId`/`source` | `@hogsend/db` | **MINOR** | loosen NOT NULL + add nullable cols; `db:generate`, runs at pre-deploy `db:migrate` |
| Identity-token `src` (+ deprecated `emailSendId`) | `@hogsend/engine` | **MINOR** | old tokens validate (`validateIdentityToken` checks distinctId+exp only); one-minor alias |
| PostHog destination preset | `@hogsend/engine` | **none/PATCH** | comment-only |
| `TRACKING_IDENTITY_TOKEN` widened semantics | `@hogsend/engine` | **MINOR** | same schema, `default(false)`; expands only when opted in |

**Net:** one coordinated additive minor across the version line, ENGINE_VERSION bumped, all scaffold packages kept on the engine minor; no new `@hogsend/*` package (no manual-first-publish gotcha). Zero forced migration; no MAJOR. The one rolling-deploy hazard is MF-7 (`scope` 400) — neutralized by missing-scope-allow.

---

## 10. Migration, backfill, rollout, testing & observability

### 10.1 What is and isn't retroactively mergeable

This release **stops the bleed and stitches forward; it does NOT heal historical orphans.** Two populations:

- **(a) Anonymous orphans never identified** (web-anon persons from `"memory"` regeneration, `is_identified=false`) — *eligible* for safe `alias` (R4), but **unaddressable** because Hogsend never recorded which discarded browser anon id belonged to which contact (it was written only as the inert `posthogDistinctId` property, `subscribe/route.ts:83`). A one-off job reading `contacts.properties->>'posthogDistinctId'` and emitting `mergeIdentities({distinctId: contactKey, alias: <that property>})` covers only contacts created after that property write. **Deferred (OQ-2).**
- **(b) Twin identified persons** — two already-identified persons for one human. PostHog refuses safe merges (R2/R4); only `$merge_dangerously` repairs it. We ship **no** dangerous path (OQ-1). **These twins are the known steady-state residual, not an edge case** (MF-2): the fill-in-link flip path *manufactures* identified persons, so any later collision into one is the twin case. The honest outcome statement is **"one email → one person, except across two prior identified persons."** Parts 1/2/4 make this *less frequent* by absorbing early, but do not eliminate it.

No batch merge API exists — every merge is one `client.alias` call (`client.d.ts:335`), so any backfill is N queued calls.

### 10.2 Staged, independently-reversible rollout

| Stage | Switch | Default | Turns on | Revert by |
|---|---|---|---|---|
| 0 | ship code | — | nothing (legacy adapter omits `mergeIdentities` → no-op) | n/a |
| 1 | consumer sends `anonymousId` | absent=today | anon threading (Part 1) | omit the field |
| 2 | PostHog plugin ships `mergeIdentities`+`identityMerge` | active provider only | `alias` wire on collide-merge + key-flip | downgrade plugin / provider without it |
| 3 | **persistence flip** (consumer, consent-gated) — **its own stage (MF-8)** | `"memory"` | durable cross-pageload binding | revert to `"memory"` |
| 4 | `TRACKING_IDENTITY_TOKEN=true` | `false` | `hs_t` mint + server-side `/v1/t/identify` alias | set `false` |
| 5 | consumer wraps non-email links via `createTrackedLink` | unwrapped=today | click-stitch on non-email links | stop wrapping |

**MF-8:** the persistence flip is a **separate stage** from `anonymousId` threading (they are independent; threading works under `"memory"`) so its rollback is clean. Recommended dogfood order: 1+2 together (fixes the dominant "subscriber later identifies" fork + lands the wire), soak, then 3, then 4, then 5. No global kill-switch — each part fails safe independently; a provider without `identityMerge` skips all emission with zero config.

### 10.3 Back-compat (rolling deploy)

Verified safe: optional contract members; optional `/v1/events` field; optional `currentDistinctId` (absent = byte-identical response); nullable `tracked_links` migration (loosen + add); `src` with `emailSendId` deprecated-alias; `validateIdentityToken` checks only `distinctId`+`exp` so old tokens validate; **`scope` missing=allow (MF-7)** so a new identify-route accepts old click-route tokens mid-deploy. `overrides` has no `analytics` slot (`container.ts:329-334`) — tests inject via the public `analytics:{provider}` arm (MF-9).

### 10.4 Test plan (vitest, `apps/api/src/__tests__/`, `app.request()` against Hono, Hatchet stubbed via override seam)

- **Unit — `mergeIdentities` wire (`plugin-posthog/.../provider.test.ts`)**, `vi.spyOn(PostHog.prototype, "alias")`: `identityMerge===true`; `mergeIdentities({distinctId:"canon",alias:"sess"})` → `client.alias({distinctId:"canon",alias:"sess"})` once, **asserting direction against the PostHog-docs rule, NOT the `.d.ts` example (MF-1)** — survivor=`distinctId`, absorbed=`alias`; guards (`distinctId===alias`, empty) → zero calls; legacy adapter `identityMerge===false`, method undefined, helper doesn't throw.
- **Unit — `analytics-identity.test.ts`**: no-op when `analytics` absent / `identityMerge` falsy; one call per loser key, skipping `loser===survivor`; **never emits the loser's `external_id` as `alias` (MF-2)**; never throws on provider error.
- **Integration — alias on resolver outcomes (extend `identity-merge.test.ts`)**, spy provider via `createHogsendClient({ analytics:{ provider: spy }, overrides:{ hatchet: mock } })`, **assert `client.analytics === spy` and the vitest env does NOT also configure a real PostHog provider that would win resolution (MF-9)**: collide-merge → `{distinctId: survivorKey, alias: loser ANON key}` (and **assert the loser's `external_id` is NOT aliased — MF-2**); fill-in-link flip → one `{distinctId: newKey, alias: oldKey}` **only when `oldKey` is anon/uuid (MF-3)**; re-resolve → zero new calls (idempotency, inside the guarded block); provider absent → DB re-point unchanged, still 202.
- **Integration — `/v1/t/identify` (extend `tracking-identity.test.ts`, `TRACKING_IDENTITY_TOKEN=true`)**: `{token, currentDistinctId}` → server `alias({distinctId: token canonical, alias: currentDistinctId})`, 200 returned synchronously (no await on alias); `{token}` only → no merge, legacy `{distinctId,src,emailSendId?}` body; provider lacks `identityMerge` → client-fallback; **trust: no request shape lets a token absorb a victim's anon id (MF-4/OQ-3)**; **missing-`scope` token still accepted, present-wrong-`scope` 400 (MF-7)**.
- **Integration — non-email tracked link**: row `emailSendId=NULL, distinctId="canon", source="link"`; GET `/v1/t/c/:id` → 302 + `hs_t` from `link.distinctId`; **zero `email_sends`/`semanticEmittedAt` writes**; **emits `link.clicked`, NOT `email.clicked` (MF-missing #3)**; email link still resolves via `resolveEmailSendContext` + writes `clickedAt`.
- **E2E — `identity-stitch-e2e.test.ts`**: `$pageview {anonymousId:"web-1"}` → `contactKey=="web-1"`, no merge; upsert gains `userId:"u-9"` → one `{distinctId:"u-9",alias:"web-1"}`; `/v1/t/identify {token(u-9), currentDistinctId:"web-2"}` → one `{distinctId:"u-9",alias:"web-2"}`; **assert the union: every `alias` target ∈ {web-1,web-2} absorbed into `u-9`; `u-9` never appears as an `alias`** (the machine-checkable "one email → one person"). Real-PostHog e2e is out of CI; manual pre-release via §10.5.

### 10.5 Observability

- **Structured logs** at every emission: `identity.merge.emitted {provider, survivorKey, alias, reason: "collide_merge"|"key_flip"|"click_identify"|"discord_link", contactId}` (`reason` shows which path is stitching; a declining `collide_merge`/`key_flip` volume after Stage 1 = anon threading working); `identity.merge.skipped {reason: "no_provider"|"no_capability"|"self_alias"}`; **new `identity.merge.residual_twin {survivorKey, loserExternalId}`** when MF-2 excludes an identified loser key (the OQ-1 residual made visible). Hash/truncate keys that are emails per PII discipline.
- **DB metrics (source of truth, PostHog-independent):** `contact_aliases` is the merge ledger (`reason:"merge"`/`"promote"` rows, `contacts.ts:526-539`) — a *declining* `merge` rate after Stage 1 is the empirical "forks prevented" signal; `GROUP BY contact_id ORDER BY count DESC` surfaces the most-fragmented humans (OQ-2 backfill list); count `contacts` with `anonymousId` set but no email/externalId as the forward-fork canary (flat/declining after the persistence flip = session-scope fixed).
- **PostHog confirmation (manual pre-release + periodic):** HogQL `SELECT count(DISTINCT person_id) FROM events WHERE properties.email='<known>'` — should trend to **1** after Stages 1–4; record before/after each stage flip. Watch PostHog ingestion for "Refused to merge an already identified user" warnings — a spike = the OQ-1 twin residual and the trigger to revisit the dangerous path.
- **Alert:** `identity.merge.skipped {reason:"no_capability"}` in prod = the active provider silently isn't merging (misconfig / legacy adapter) → page, because every other metric looks healthy while nothing stitches.

---

## 11. Risks & open questions

**Risks**
- **R-1 (steady-state twin residual).** MF-2/MF-3 — collisions/flips involving an already-identified loser/old-key cannot be repaired on the safe path; they leave a residual twin and emit PostHog "Refused to merge" warnings. Mitigated (not eliminated) by early anon-absorb; surfaced via `identity.merge.residual_twin`. **The release's outcome is explicitly "one email → one person except across two prior identified persons."**
- **R-2 (direction footgun).** MF-1 — implementing `alias` per the `.d.ts` example burns the canonical key. Mitigated by the docs-rule code-review law + the direction unit test.
- **R-3 (referral hijack).** MF-4 — generalizing `hs_t` to shareable referral links would re-open identity hijack; mitigated by shipping referral links token-less by default (single-use opt-in only).
- **R-4 (rolling-deploy `scope` 400).** MF-7 — neutralized by missing-scope-allow.
- **R-5 (`alias` queue volume).** The flip path fires a per-login `alias`; it rides the same async posthog-node queue as `capture` (won't block, counts toward flush). Acceptable; monitor flush lag on high-traffic consumers.

**Open questions (deferred)**
- **OQ-1 — `$merge_dangerously` for two already-identified persons.** No native posthog-node method (raw `capture({event:"$merge_dangerously"})` only), irreversible, can't cheaply read `is_identified`. If pursued: track "ever emitted an identified write under this key" via the existing `contact_aliases` provenance, emit a deduped `contact.merged` outbound event, gate behind a provider option.
- **OQ-2 — backfill of existing fragmentation.** Needs OQ-1 or the `posthogDistinctId`-property reconciliation job; out of scope.
- **OQ-3 — `currentDistinctId` trust hardening.** Token-gated and structurally safe (caller supplies only their own anon id), but confirm no path lets a token-proven key absorb a victim's anon id before enabling broadly.

---

## 12. Phased implementation plan & effort

| Phase | Scope | Packages | Effort |
|---|---|---|---|
| **P1 — Threading + primitive (ship together)** | `/v1/events` `anonymousId` + SDK field (§4); `AnalyticsProvider.mergeIdentities`+`identityMerge` (§5.1); PostHog impl via native `alias`, **docs-direction** (§5.2); `mergeAnalyticsIdentities` helper with **identified-key filtering (MF-2)** + the two emission points with the **MF-3 gate** and **idempotency placement**; legacy adapter `identityMerge` absent; observability logs + `identity.merge.residual_twin` | core, engine, plugin-posthog, client | ~4–5 d |
| **P2 — Identity-bearing links** | `tracked_links` migration (MF-6); token `src`+`scope` with **missing-scope-allow (MF-7)**; click route gating + **`link.clicked` outbound (MF-missing #3)** + `resolveEmailSendContext` NULL check; `/v1/t/identify` server alias **fire-and-forget + single response schema (MF-5)** + scanner note (MF-4); `createTrackedLink`; **referral links token-less by default (MF-4)** | engine, db | ~3–4 d |
| **P3 — Discord `/link`** | reuse P1 emission hook via `client.identity.linkContact` (§7); twin-loser handling per MF-2 | engine, plugin-discord | ~1 d |
| **P4 — Consumer (dogfood) + scaffold guidance** | subscribe `anonymousId` (§8.4); **persistence upgrade with MF-8 ordering** (own stage); `currentDistinctId` in `/api/identity`; analytics-lib doc updates; scaffold skill-doc guidance (§8.5) | apps/docs, create-hogsend | ~2–3 d |
| **P5 — Tests + rollout + pre-release verify** | full test plan (§10.4) incl. direction/MF-2/MF-3/MF-4/MF-7 assertions and the union E2E; staged rollout (§10.2); HogQL `count(DISTINCT person_id)→1` pre-release check (§10.5) | apps/api, ops | ~2–3 d |

**Total ≈ 12–16 dev-days** for the safe-only release. OQ-1 (`$merge_dangerously` twin repair) and OQ-2 (backfill) are explicitly out of this estimate.

---

**Load-bearing files (all under `/Users/godzillaaa/Documents/WEB_PROJECTS/clients/growthhog`):** contract `packages/core/src/providers/analytics.ts:52-93,100-104,111-124`; PostHog impl `packages/plugin-posthog/src/provider.ts:45-94`, `src/client.ts:5-10` (native `alias` `node_modules/.pnpm/posthog-node@5.35.1/.../dist/client.d.ts:335`, misleading example `:320-339`, `aliasImmediate` `:357`, NO `$merge_dangerously`); legacy adapter `packages/engine/src/lib/analytics-adapter.ts:18-54,26`; resolver `packages/engine/src/lib/contacts.ts:279-306,315-317,363-367,437-446,515-524,556-579,1018-1040`; ingest `packages/engine/src/lib/ingestion.ts:8,15-16,55-78,87,136-145`; events schema `packages/engine/src/routes/events/index.ts:8-17,28-38,74,86-96`; tracking `packages/engine/src/routes/tracking/click.ts:36-46,64-88,92-110,117-142,150-195`, `routes/tracking/identify.ts:24-71`, `lib/tracking.ts`, `lib/tracking-events.ts:25,37,53-58`, `lib/identity-token.ts:21-26,35,56-65,102-107`; env `packages/engine/src/env.ts:151,153-158,159-165`; container `packages/engine/src/container.ts:329-342`; destination preset `packages/engine/src/destinations/presets/posthog.ts:62-73,110-159,134-141,166`; schemas `packages/db/src/schema/tracked-links.ts:13-36`, `packages/db/src/schema/contact-aliases.ts:13-41`; SDK `packages/client/src/types.ts:24-26,151-166`, `resources/events.ts:18-35`, `internal/identity.ts:7-18`; Discord `packages/plugin-discord/src/connector.ts:255-267`; consumer `apps/docs/components/analytics/posthog-boot.tsx:11-24,33,35-36,42-43,53-76,89`, `components/landing/email-capture.tsx:169,178,187-204,489-529`, `lib/analytics.ts:86-129`, `app/api/subscribe/route.ts:21-24,51,64,83,86`, `lib/ingest.ts:9-15,38-72`, `app/api/identity/route.ts:7-13,42-48`; tests `apps/api/src/__tests__/identity-merge.test.ts:10-287`, `tracking-identity.test.ts:8-173`, `analytics-provider.test.ts:10-71`, `phase2-posthog-destination.test.ts:25-63`; scaffold (guidance only) `packages/create-hogsend/template/.claude/skills/`.