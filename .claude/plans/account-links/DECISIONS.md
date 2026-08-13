# DECISIONS — account linking (`defineAccountLink`)

Branch `feat/account-links`, worktree `.claude/worktrees/account-links`, branched from `main` at
`a4bbec5a` (#668 merged). Locked global choices every PRD inherits. **Settled — do not
re-litigate.** Derived from two advisor memos and the design conversation of 2026-08-13.

---

## 1. What this is

A first-class channel-shaped primitive for **linking a player's third-party platform account to a
Hogsend contact**, so that the link is (a) an identity fact, (b) a lifecycle event, and (c) visible
to the customer's own system of record.

ICP driver: game publishers. A player links Steam / Discord / Twitch; that linkage triggers journeys
and enriches the contact with platform properties (playtime, guild membership) that journeys and
buckets read with no new machinery.

**This is a full feature, not a demo.** Scope is not to be trimmed toward "demoable".

## 2. Naming (locked)

| Thing | Name | Why not the alternative |
| --- | --- | --- |
| The primitive | `defineAccountLink()` | NOT `defineOAuthLink` (Steam is OpenID 2.0, not OAuth2, so the protocol cannot be in the name). NOT `defineLinkProvider` ("link" is saturated in this repo: `mintLink`, `/l/:slug`, `tracked_links`, `link_clicks`; `mintLinkUrl` beside `mintLink` is a trap) |
| Route namespace | `/v1/accounts/*` | Matches the noun, not the protocol |
| Mint helper | `mintAccountLinkUrl` | Unambiguous against `mintLink` |
| One-per-contact policy | `multiple: true \| false` (default `true`) | NOT `cardinality` — jargon that does not earn its keep |
| Contested-link policy | `onConflict: "replace" \| "reject"` (default `"replace"`) | Upsert vocabulary people already have. Only meaningful when `multiple: false` |
| Table | `linked_accounts` | — |

## 3. Architecture

### 3.1 Where code lives

- **`@hogsend/core`** — the `AccountLinkProvider` contract, `LinkedIdentity`, `AccountLinkHooks`
  types, `defineAccountLink()`, and the two preset factories `oauth2Link()` / `steamOpenIdLink()`.
  Types + pure functions only. No DB, no engine imports.
- **`@hogsend/engine`** — everything stateful: the link store, the hosted flow routes, the data
  plane, the hosted pages, the enrichment cron, container wiring, **and the three concrete provider
  definitions (Steam, Discord, Twitch)**.
- **`@hogsend/db`** — the `linked_accounts` table + migration.
- **`@hogsend/client`** — the `accounts.*` server SDK resource.
- **`@hogsend/js` / `@hogsend/react`** — the browser embed SDK.
- **`@hogsend/cli`** — vendored webhook-catalog copy only.
- **`packages/studio`** — the observe-only contact-detail panel.

**Providers are NOT plugin packages.** Locked 2026-08-13. Rationale: the plugin boundary in this
repo is "does it drag in a dependency or a runtime?" — `plugin-resend`, `plugin-twilio` and
`plugin-discord` all do. An account-link provider is a URL, one `fetch`, and a field mapping: zero
dependencies, no runtime. That is config, not a plugin. Shipping three packages for config also
inherits the opt-in-plugin bundling trap (a consumer must depend on it DIRECTLY before it works),
for no benefit.

Industry precedent agrees: Auth.js ships ~80 providers inside one package under
`next-auth/providers/*`; better-auth puts social providers in core config and reserves plugins for
*generic* OAuth; Arctic ships ~50 providers in one tree-shaken package. Passport.js is the one that
did package-per-strategy and is the universal cautionary tale.

The set stays open: a third party authors their own with `defineAccountLink` in their own repo, and
passes it via `accountLinks.providers`. Nothing closes.

### 3.2 The three planes

A customer integrates through exactly three surfaces, and each does a job the other two cannot.
State this explicitly in docs so nobody guesses.

| Plane | Surface | Job | Guarantee |
| --- | --- | --- | --- |
| **PULL** | `/v1/accounts/*` | **AUTHORITATIVE.** The system of record. Reconciliation, backfill, "what is true right now", reverse lookup | Strongly consistent; Hogsend wins any disagreement |
| **PUSH** | outbound webhooks | The mirror feed, for a production DB that Hogsend is not deployed inside | At-least-once, retried, **reorderable** — hence §5 |
| **IN-PROCESS** | `AccountLinkHooks` | The only place a **veto** can live, and the only place an in-band write to the consumer's own DB can happen | Not a delivery mechanism; a throw does not retry |

Cut none of them.

### 3.3 What this reuses rather than reinvents

Verified against the tree at `a4bbec5a`. Every PRD must reuse these, not fork them.

| Existing | Path | Reuse as |
| --- | --- | --- |
| Signed OAuth state (HMAC on `BETTER_AUTH_SECRET`, TTL, nonce) | `packages/engine/src/lib/connector-state.ts` | Add an `account_link` purpose to `ConnectorStateIntent`. Do NOT invent a second token format |
| Generic callback dispatcher (verify-before-dispatch, cross-id replay rejection, Redis single-use nonce burn) | `packages/engine/src/routes/connectors/index.ts` | Same hardening, applied to the `/v1/accounts` callback |
| Hosted-page branding + XSS discipline (`textContent` writes, accent regex, `jsonForScript`) | `packages/engine/src/cold-connect/page.ts` | Generalize `ColdConnectBranding` into a shared branding module |
| Redis throttle, fail-closed | `packages/engine/src/cold-connect/throttle.ts` | Throttle state mints and the public callback |
| AES-256-GCM sealer | `packages/engine/src/lib/provider-credentials.ts` | Seal per-contact tokens into `linked_accounts.tokens` |
| Outbound spine + delivery dedupe | `packages/engine/src/lib/outbound.ts`, `webhook_deliveries.dedupeKey` | Emit the three new events |
| Unsubscribe-token HMAC **crypto shape and helpers** (NOT the payload) | `@hogsend/email` | A dedicated, contact-id-keyed account-manage token. See §14 |
| `groups.ts` SDK resource shape | `packages/client/src/resources/groups.ts` | Template for `accounts.ts` |
| The existing `member_link` OAuth branch | `packages/plugin-discord/src/connector.ts:463` | **This feature is largely an extraction of this.** Read it first |

## 4. Quality gates

Every task runs these from the worktree root before it is accepted. Verbatim:

```
pnpm lint
pnpm check-types
cd apps/api && pnpm test
```

Plus, for tasks touching the engine's public surface: `pnpm build`.

Additional standing rules:

- **TDD.** A failing test first, then green. A guard without a test that fails when the guard is
  removed is a vacuous green.
- **Changesets** for every package with a public-surface change.
- **Conventional commits**, one per task, plain and factual. No AI/vendor mention, no
  `Co-Authored-By`.
- **Never push, branch off this branch, or open a PR** without being told. Local commits only.
- Delivery agents: no commits, no plan-doc edits, stay inside the stated boundary.

## 5. The consistency contract (the load-bearing decision)

A relink moves a platform account from contact A to contact B and emits `account.unlinked` then
`account.linked`. Those are two independent deliveries with independent retries, so a consumer can
receive them **out of order, duplicated, or a day late**. A naive upsert then records the wrong
owner permanently and never finds out.

Locked mechanism:

1. `linked_accounts.version bigint NOT NULL` — monotonic per `(provider, provider_user_id)`,
   computed across **all** rows for that pair, live and unlinked. Every mutation gets its own
   version. **It is a `bigint`, so it crosses every boundary as a STRING**, never a JS `number`:
   Postgres bigint exceeds `Number.MAX_SAFE_INTEGER`, so read it as `string`/`bigint` and serialize
   with `String(row.version)`. This applies to the DB read, the hook context types, the outbound
   payloads and the SDK types. Comparing it in a consumer's `incoming.version > stored.version`
   guard is the whole point of the design, and a silently-rounded version breaks that guard in
   exactly the case it exists for.
2. **Every outbound payload carries FULL CURRENT STATE, never a delta**, including
   `{ state: "linked" | "unlinked", version, ... }`.
3. The documented customer rule, stated verbatim in docs: *upsert keyed on
   `(provider, providerUserId)`; apply only when `incoming.version > stored.version`; otherwise
   discard.* One guard makes reorder, duplicate and late delivery all no-ops.
4. No timestamps as tiebreakers. Clocks lie.
5. Producer-side dedupe: `webhook_deliveries.dedupeKey = "al:<provider>:<uid>:v<version>"`, riding
   the existing `(endpointId, dedupeKey)` partial-unique index.
6. **The version computation races** under the two-write relink sequence. This is REQUIRED to solve,
   not an optimization: take a Postgres advisory lock on `hashtext(provider || ':' || provider_user_id)`
   for the whole mutation transaction, and back it with a unique constraint on
   `(provider, provider_user_id, version)` so a lost race surfaces as a retryable 23505 rather than
   a silent duplicate version.

Precedent: the SMS status path already does guarded-monotonic transitions (a late `sent` never
regresses a `delivered`, duplicates emit nothing) in `routes/webhooks/sms-provider.ts`. Same idiom,
applied per platform account.

## 6. Security invariants (non-negotiable)

1. **Only a completed hosted callback may MOVE a link.** Proof of control of the platform account is
   the only thing that can take an account away from its current owner. No API, SDK, webhook or
   import path may displace a live owner.
2. **`POST /v1/accounts/import` is the one carve-out, and it is INSERT-ONLY** where no live owner
   exists. It returns `{ inserted, conflicts }` and stamps `method: "import"`. Grafting requires
   *moving* a link; an insert-only path structurally cannot graft. This exists because a real
   publisher arrives with millions of already-verified links and "everyone re-OAuths" is not an
   answer.
3. **The authoritative contact is the one sealed into the state token**, never the email the
   provider reports. Using provider-reported email as a resolution key is the grafting vector the
   cold-connect design exists to close. See the comment at `plugin-discord/src/connector.ts:465`.
4. **A provider-reported email is NEVER a merge key.** Tightened 2026-08-13 (this reverses the
   original, looser wording). Even when the provider marks it `verified`, it becomes a contact
   PROPERTY and may MATCH an existing contact; it may never silently MERGE one. An unverified
   provider email is dropped entirely.

   Why the tightening: merging two contacts is irreversible, and "Discord says this address is
   verified" is a trust delegation to a third party's historical state, not a proof we performed.
   This repo has already been burned once by folding identity on a VALUE rather than a proven key
   (the 0.36.1 security fix). The existing Discord code independently reached the stricter position
   and says so at `plugin-discord/src/connect/member-link.ts` ("the Discord-reported email is NEVER
   a resolution/merge KEY here... This closes the grafting/account-takeover vector"). Two positions
   could not both stand; the stricter one wins.

   This costs nothing real: a Steam-only or Discord-only contact simply waits, and the email folds in
   later through a path we do trust. See §16.
5. **Browsers can never mint for an arbitrary contact.** `pk_` is anon-only. Minting is an identity
   assertion, so `POST /v1/accounts/link-url` requires the server-minted **userToken** and mints for
   that user only.
6. **`postMessage` targets a configured origin allowlist, never `*`.**
7. `beforeLink` is **fail-closed**: a throw, a timeout, or `{ allow: false }` rejects the link. A
   veto hook that fails open is not a veto hook.
8. The public callback and the mint path are Redis-throttled, fail-closed.
9. `GET /v1/accounts/me` returns display fields only and **never confirms existence** — no token
   yields an empty list, not an error.
10. **A COLD link may attach only to an anonymous-only contact. Only the WARM path may displace.**
    Added 2026-08-13 after the plan critique found an account-takeover vector. `/start` on the cold
    path takes an attacker-supplied `anonymous_id` over an unauthenticated route, and the OBVIOUS
    implementation (`resolveOrCreateContact({ anonymousId })`) inherits the default policy at
    `lib/contacts.ts:1146-1151`, which is `allowMerge: "any"` with `trustedKinds:
    ALL_IDENTITY_KINDS`. That fill-in-links onto whatever contact already owns that anon alias,
    **including an identified victim's**, which is precisely the write `contacts.ts:1338-1339`
    exists to refuse. An attacker would graft their own genuinely-proven Steam account onto someone
    else's contact. The cold resolve MUST be spelled out explicitly as
    `resolveOrCreateContact({ anonymousId, policy: { create: "on-miss", allowMerge: "anonymous-only",
    trustedKinds: ["anonymous"] } })` (all three `ResolvePolicy` fields are required,
    `contacts.ts:529-572`), and a `PublishableAnonymousMergeError` is a **hard refusal**: no link
    row, no contact minted, `account.link_failed{ reason: "state_invalid" }`, error page. Pin it with
    a mutation-guarded test: *a cold callback whose `anonymous_id` names an IDENTIFIED contact writes
    no link row and mints nothing.*

## 7. Identity model

- `linked_accounts` is a **new table**, not new columns on `contacts`. A suite of N providers cannot
  keep adding columns.
- **Do NOT widen the `IdentityKind` union.** That union is trust-enforced (`trustedKinds`,
  `UntrustedKeyKindError`) and widening it to N dynamic provider kinds is a merge-semantics project,
  not a feature. Instead do a **direct lookup outside the resolver**, exactly as `phone` does today
  (documented at `lib/contacts.ts:512`). This is sufficient because a link row is only ever created
  from a callback where the contact is already bound, so there is no orphan-key-awaiting-merge case.
- `contacts.discordId` stays as a **dual-written mirror** (the PRD 07 verdict: demote, do not drop)
  and gets a one-shot backfill into `linked_accounts`.
- **Contact merge must repoint `linked_accounts.contact_id`** (the hand-maintained list at
  `lib/contacts.ts` ~1875-1927). Missing it silently strands a player's link on a soft-deleted
  contact. With `multiple: true` no arbitration is needed; with `singleton` rows a merge can violate
  the partial unique index, so that case must be handled explicitly.
- **`adoptOrphanHistory` is a PROVEN NO-OP for links, not a second repoint site.** Corrected
  2026-08-13 after PRD 04 checked the real code. That path stamps rows matching
  `WHERE user_id = :fromKey AND contact_id IS NULL` (`lib/contacts.ts:2545-2574`), and the
  `contact_id IS NULL` predicate is its documented anti-theft guard. `linked_accounts` has no
  `user_id` column and its `contact_id` is `NOT NULL`, so nothing can ever match. Making it match
  would require a nullable `contact_id` plus a key column, which re-opens the
  orphan-key-awaiting-merge case this section explicitly says does not exist for links. Pin the
  no-op with tests and leave a comment at the site so nobody later adds a statement that can only
  match zero rows. The merge leg carries the whole invariant.
- **Mutations called from inside the merge transaction must use a tx-scoped entry point.** The merge
  already holds contact-key advisory locks, so PRD 03's public `unlinkAccount` (which opens its own
  transaction and takes the pair lock) cannot be called from it: a different connection deadlocks
  and the same connection nests. PRD 03 must export `unlinkAccountInTx` for this caller.

## 8. Events

Exactly three, appended to `WEBHOOK_EVENT_TYPES` (`packages/engine/src/lib/webhook-signing.ts:57`)
and **hand-synced into both vendored copies** (`packages/cli/src/commands/webhooks.ts`,
`packages/client/src/types.ts`).

| Event | Payload | Notes |
| --- | --- | --- |
| `account.linked` | `{ state: "linked", provider, providerUserId, contactId, userId, email, username, method: "oauth" \| "import", relink: boolean, version, at }` | |
| `account.unlinked` | `{ state: "unlinked", provider, providerUserId, contactId, userId, email, reason: "player" \| "api" \| "relinked", version, at }` | |
| `account.link_failed` | `{ provider, reason: "denied" \| "vetoed" \| "exchange_failed" \| "state_invalid", contactId: string \| null, at }` | No version (nothing mutated). **Never mints a contact** |

Emitted from the **commit / intent layer only**, never the ingest path. This mirrors the locked
`group.*` rule. Event properties are **scalars only** — journeys branch on `eventProperties`, never
`contactProperties`.

Deliberately rejected: `account.link_started` (journeys mint URLs at volume and most are never
clicked, so it is pure noise) and `account.updated` (deferred; a customer who cares about token
revocation reads `tokensRevokedAt` from the pull plane).

## 9. Hooks

```ts
beforeLink   // after identity is proven, BEFORE the write. BLOCKING, 5s, FAIL-CLOSED. In-process only.
afterLink    // post-commit, at-least-once, FAIL-OPEN, bounded 5s. Page renders anyway on timeout.
afterUnlink  // same posture as afterLink. reason: "player" | "api" | "relinked".
```

No `onLinkStarted`, no `onRedirect`. `afterLink` runs **before** the success page renders (bounded)
so "you now have your reward" is true when the player reads it. Posture precedent: cold-connect's
`afterBind` (`packages/engine/src/cold-connect/index.ts:224`).

## 10. Token custody

- Sealed with the existing AES-256-GCM helper into `linked_accounts.tokens`, **only** for providers
  declaring token use. Steam stores nothing (no tokens exist in OpenID 2.0).
- `refresh()` wire on the provider; best-effort `revoke()` on unlink.
- Per-provider **opt-in** `sync: { every: Duration, read() }`, run by ONE Hatchet cron, writing
  namespaced scalars onto `contacts.properties` (`steam_playtime_2wk`, `discord_guild_member`) so
  journeys and buckets read them with zero new machinery.

  **Named `sync`, not `enrichment`** (corrected 2026-08-13). `enrichment` is already a saturated term
  in this repo: there is a whole unrelated subsystem meaning "buy B2B firmographic data from a
  vendor" (`EnrichmentProvider`, `enrichment-provider-registry.ts`, `enrichment-ledger.ts`,
  `refineContact()`, the `ENRICHMENT_*` env vars, and a top-level `createHogsendClient({ enrichment })`
  option at `container.ts:483`). This field means "re-read a platform's own API for an account we
  already own". Different thing, same word. This is the exact test that killed `defineLinkProvider`
  in §2, so it must kill `enrichment` here too.

  **`every` is a `Duration`, not a cron string** (corrected 2026-08-13). It expresses the MINIMUM AGE
  before a row is re-read, so the single cron's `WHERE synced_at < now() - :every` predicate reads it
  per row with no parser. A per-provider cron STRING would need a cron parser this repo does not have
  and does not otherwise need, to express something `hours(24)` already says. `Duration` is the house
  vocabulary (`days()`, `hours()`, `minutes()` from `@hogsend/core`).
- **Provider-side revocation (`invalid_grant`) keeps the link and kills the enrichment**: set
  `tokens_revoked_at`, null the blob, skip in future cron runs, expose the field on the pull plane.
  Do NOT auto-unlink. The link is an identity claim proven once; the token is plumbing, and refresh
  tokens die from password changes as often as from intent. Steam has no tokens at all.

## 11. Embed model

Button + popup + `postMessage`. **Explicitly not an iframe**: Steam, Discord and Twitch all send
`X-Frame-Options: DENY` / restrictive `frame-ancestors` on their consent screens (deliberately, since
a framed consent screen is a clickjacking primitive), so a framed flow is structurally impossible and
would have to pop out anyway.

The DX unlock: `POST /v1/accounts/link-url` accepts the userToken, so the customer needs no backend
endpoint at all. Drop in a component, done.

## 12. Out of scope (v1)

- **Discord as a `defineAccountLink` provider.** Dropped 2026-08-13, confirmed by Doug. First-party
  providers are **Steam and Twitch only**. Discord account linking ALREADY EXISTS and works
  (`plugin-discord`'s `member_link` OAuth + `discordColdConnect` + `contacts.discordId`, which has 84
  non-test references and is load-bearing for DM recipient resolution at
  `plugin-discord/src/actions/rest.ts:58`, the `discord` resolver kind, `campaigns/cohort-sql.ts`
  targeting, `lib/feed.ts` and Studio's contact picker). Adding a second writer to that column is
  what created the bidirectional-drift and duplicate-contact risks; the cleanest fix to two writers
  is one writer. Steam and Twitch have no pre-existing surface, so they are clean, and they are what
  the game-publisher pitch actually needs. Migrating Discord onto `defineAccountLink` is real work
  with a backfill and a dual-write window, and it gets its own stack later. **DECISIONS §7's
  `contacts.discordId` mirror requirement is withdrawn as a consequence**, along with the §15.6 fork.
- Epic Games / Xbox / PSN presets. **Action owed outside this stack: file the Epic org application
  now**, approval takes weeks.
- A Framer / script-tag third-party JS drop-in. Separate task; `pk_` is anon-only so the userToken
  story there is genuinely unsolved.
- Promoting a provider to a real `IdentityKind` in the resolver.
- An `account.updated` outbound event.
- Any authoring UI in Studio. Observe-only.

## 13. Publish mode

`local-commits-only`. Commit locally, one commit per task. Never push, never open a PR, never deploy
without being told.

## 14. This feature is ID-keyed, never email-keyed

Added 2026-08-13, resolving the "can a player with no email revoke a link?" question.

Hogsend's contact model is already ID-first: the canonical key is
`external_id ?? anonymous_id ?? id`, and since identity wave 2 `contact_aliases` is the source of
truth with many keys per person. Email is one identity among several, not the primary.

The unsubscribe token is email-first for one good reason: it exists to unsubscribe an email address,
so an email is guaranteed present. That is correct for that token and wrong everywhere else. Reusing
its payload here would have made the manage page unreachable for exactly this feature's normal case,
since **Steam never yields an email, ever**.

So:

- **Mint a dedicated account-manage token keyed on `contactId`**, reusing the HMAC shape and helpers
  from `@hogsend/email` but NOT its payload or its validator. This requires no email, touches no
  shared security-relevant validator, and is immune by construction to the action-segregation
  weakness described below.
- **`validateUnsubscribeToken` checks that `payload.action` is present but never checks its VALUE**
  (`packages/email/src/unsubscribe-tokens.ts:104-111`), and the preference-center route does not
  check it either (`routes/email/preferences.ts:51-67`). Since `generatePreferenceCenterUrl` mints an
  `action: "manage"` token into every email footer with a 30-day TTL, a manage page that accepted
  `"manage"` would turn every historical email into a live account-revocation credential. The
  dedicated token must validate its action value strictly. **Fixing the shared validator is a
  separate ticket, deliberately out of this stack.**

### The two revoke surfaces, both ID-based

| Surface | Who | Auth | Notes |
| --- | --- | --- | --- |
| In-app: `GET /v1/accounts/me` + authenticated revoke | A player signed in on the publisher's own site. **The normal case for this ICP** | server-minted **userToken**, keyed on `externalId` | No email anywhere. No hosted page needed. Same token that gates `POST /v1/accounts/link-url` |
| Hosted manage page | A player with no session who arrived from a link in an email or a DM | dedicated account token, keyed on `contactId` | The fallback, not the default |

The publisher's signed-in flow is the primary integration story: their server already knows the
player's user id, mints a userToken as it does for the rest of the SDK, and our button does the
rest.

## 15. Rulings from the plan critique (2026-08-13)

A four-lens adversarial panel read the stack against the real repo before any code was written. 24
findings raised, 15 confirmed after independent refutation. The cross-cutting rulings live here so
every PRD inherits one answer.

### 15.1 Route shape: do NOT guard the data plane with a two-segment param pattern

**Hono runs every matching `use`.** A guard registered on `/accounts/:provider/:providerUserId`
therefore also fires on `/accounts/me/revoke`, on `/accounts/:provider/start`, and on
`/accounts/:provider/callback`. As originally specified that made **the entire hosted OAuth flow
dead**: `/start` and `/callback` carry no `Authorization` header and would 401, and the primary
player revoke would 403 because a `pk_` key carries only `["ingest-public"]`
(`middleware/api-key.ts:35-40`). Mounting the flow on `app` rather than `v1` does not save it,
because `app.route("/v1", v1)` flattens the middleware into the same router.

Ruling: apply the repo's committed idiom, a single guard on the param pattern that branches
internally (mirroring the method-branching `/contacts` guard at `routes/index.ts:89-109`), OR move
the colliding routes off the two-segment shape. Every affected route needs a test asserting it is
**neither 401 nor 403**, each with a mutation check proving the test fails if the blanket guard is
restored. A test asserting only "not 401" ships the broken route green.

### 15.2 `mintAccountLinkUrl` returns an ENGINE-origin URL

Three mutually exclusive answers were live in the stack. Locked:
`<API_PUBLIC_URL>/v1/accounts/<provider>/start?t=<signed account_link state>`, and `/start` accepts
that pre-sealed warm token as its warm binding. **The provider authorize URL is only ever a 302
target, never a value handed to a caller.** This matters beyond tidiness: PRD 13 derives its
`postMessage` `expectedOrigin` from this value, so returning a provider URL would make the embed
silently drop every success message and time out despite the link having committed server-side, and
fake-window tests cannot detect it. Add a test asserting
`expectedOrigin === new URL(apiUrl).origin` for a minted URL.

### 15.3 Contact deletion and erasure

Nothing in the stack handled it, and no production path in this repo hard-deletes a contact, so
PRD 02's cascade criterion described behaviour that never fires while reading as "deletes are
covered".

Ruling: inside the same transaction as `softDeleteContact` (`lib/contacts.ts:2873`) and the admin
delete route (`routes/admin/contacts.ts:651-671`), call a tx-scoped
`unlinkAccountsForContactInTx(tx, contactId, { reason: "api" })` that soft-unlinks every live link,
allocating a version per row under the pair lock exactly like the merge leg, and **hard-deletes the
token blob**. Queue one `account.unlinked` per row post-commit so mirrors converge. On erasure, also
null `verified_email`, `username` and `avatar_url` on the historical rows, keeping only
`(provider, provider_user_id, version, unlinked_at)` so the version sequence stays monotonic without
retaining personal data.

Why this is not cosmetic: without it a live row survives its owner forever and the pair stays
permanently locked, so a player who was erased and later re-registers can **never relink their own
Steam account** under `onConflict: "reject"`, and under `"replace"` the link silently repoints.

### 15.4 Hooks have exactly ONE invoker

`afterLink` / `afterUnlink` were specified as invoked by both the store and each of its callers, so
every hook would fire twice. Ruling: **the store (PRD 03) is the sole invoker**, post-commit. No
route, page or SDK path invokes them. `beforeLink` remains the callback's (PRD 07), pre-write.

### 15.5 Event payload fields must exist

`account.linked` / `account.unlinked` payloads carried `userId` and `email`, which exist on neither
the table nor the store's returned facts. Either the store returns them explicitly (a join the store
owns) or they leave the payload. Do not let a delivery agent invent a lookup at emit time.

### 15.6 Ownership of the `discord` mirror must be decided, not inherited

§7 locks `contacts.discordId` as a dual-written mirror with a one-shot backfill, and **no PRD owned
either half**. Worse, the drift is bidirectional: `plugin-discord`'s `member_link` branch
(`connector.ts:463-490`) writes only `contacts.discordId` and never `linked_accounts`, so after any
backfill every new connector link is again missing from the authoritative PULL plane. And because
§7 forbids widening `IdentityKind`, a link living only in `linked_accounts` is invisible to the
`discord` resolver kind, so a later discord-keyed resolve can mint a **second contact for the same
human**.

This is a genuine fork and it is called out for the approval gate rather than settled unilaterally:
either make the mirror bidirectional (both legs, plus the backfill, plus an explicit rule for a
colliding existing `discordId` against `contacts_discord_id_unique_idx`), or amend §7 to drop the
mirror and state that the account-link Discord provider and the connector's `discordId` are
deliberately separate universes, with the duplicate-contact risk written down.

### 15.7 Smaller confirmed rulings

- **PRD 05 and PRD 06 are circularly dependent** and both claim `lib/account-links-from-env.ts`.
  Split ownership so PRD 05 can go green in BACKLOG order.
- **The two-stage advisory locking in the `multiple: false` replace path is not deadlock-free** as
  claimed, and `40P01` is explicitly not retried. Take both locks in one deterministic order, or
  retry the serialization failure.
- **`expectContactId` is defined but no caller passes it**, so every player-facing revoke checks
  ownership OUTSIDE the advisory-locked transaction. Thread it through.
- **PRD 11's revoke form cannot be built as written**: the POST needs `providerUserId` in the body
  while the page is forbidden from rendering it, and the `revokeToken` it substitutes is never
  defined.
- **PRD 08's new emit-asserting tests are not registered** in `apps/api`'s `WEBHOOK_FANOUT` serial
  barrier in `vitest.config.ts`.
- **PRD 08 and PRD 09 both claim the same emit sites.** One owner each.
- **The cold-path contact resolve has no owner.** PRD 07 delegates it to "PRD 03's contact resolve",
  which PRD 03 does not have. See §6.10 for the required policy.
- **§15.6 (the `discordId` mirror fork) is WITHDRAWN**, resolved by dropping Discord from v1. See §12.

## 16. One pattern, and the one named exception

Doug's directive, 2026-08-13: *"we should just have one pattern that works for everything as possible
with this defineAccountLink."* That is the standing rule. `defineAccountLink` is THE way to link a
third-party account to a contact. A new platform does not get a bespoke flow.

**The one exception, and why it is genuinely different rather than merely unmigrated:**
`createColdConnect` (`packages/engine/src/cold-connect/`, consumers: Discord at
`apps/api/src/discord.ts:90`, Telegram at `plugin-telegram/src/cold-connect.ts`) solves the mirror-
image problem, and the two are not the same shape:

| | `defineAccountLink` | `createColdConnect` |
| --- | --- | --- |
| What we hold | a browser session | a platform session (a signed slash command / DM) |
| What gets proven, and by whom | the PROVIDER proves the platform account (OAuth / OpenID) | the platform proves the account at mint; the EMAIL is proven by click + confirm |
| What is being attached | a platform account, to a contact | an email, to a platform account |
| Email involved | never (§14) | always, it is the payload |
| Works when the platform has no OAuth | no | yes |

So they are not two solutions to one problem; each is unusable for the other's case. Do NOT build a
second abstraction and do NOT fold cold-connect into `defineAccountLink`.

**The direction of travel, for v2 and for any new platform:** if a chat platform supports OAuth, its
slash-command or DM entry point should mint an **account-link URL** rather than roll a bespoke flow.
That is Doug's instinct applied narrowly and correctly. It is a sentence of policy now, not machinery
to build in this stack.

Discord is the only platform that supports BOTH shapes, which is exactly why it accumulated three
paths and exactly why it is the wrong v1 provider (§12).

### Owed as a separate ticket, NOT part of this stack

Established 2026-08-13 by reading the real code (the third advisor memo):

1. **Delete the dead OTP machinery.** `lib/connector-link-codes.ts` and the `connector_link_codes`
   table are retired but never removed, and are still exported from `engine/src/index.ts`. The OTP
   path is already gone: `/link` collects an email in a modal and sends a one-click browser link
   (`plugin-discord/src/connect/interactions.ts:16-26`). Confirm no consumer imports it, then delete.
2. **Make cold-connect consent INFORMED rather than nominal.** The confirm page renders generic
   branding and shows neither WHICH platform account nor WHICH email, so a victim cannot distinguish
   their own pending link from someone else's graft attempt. Carry the platform username through
   `mintConfirm`'s existing `scalars` field plus a masked email, add a read-only peek endpoint over
   the existing non-consuming `peekColdConnectToken`, and render "Link Discord account @name to
   v•••@e•••.com" above the button. Engine-side, no schema change. The residual risk this closes (a
   victim completing a bind they did not initiate) is identical in the OTP and link flows, so
   retiring the OTP neither created nor fixed it.
