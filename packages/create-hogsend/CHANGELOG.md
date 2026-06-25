# create-hogsend

## 0.36.0

### Minor Changes

- 02dab59: Client-side layer: `@hogsend/js` (zero-dependency browser core — identity, capture, preferences, in-app feed, banners, toasts, reactive store) and `@hogsend/react` (provider, hooks, and the `NotificationBell`/`FeedPopover`/`NotificationFeed`/`Banner`/`Toast` components with a `--hs-*` themed override surface), plus the engine pieces that power them:

  - Publishable-key (`pk_`) browser-ingest auth (`requirePublishableOrIngest`, per-key origin allowlist, `allowed_origins` migration, reflective CORS, `GET /v1/lists/preferences`).
  - The in-app feed backend: `feed_items` table, `sendFeedItem()` + `send-feed` workflow, recipient-scoped `/v1/feed/*` routes with SSE fan-out.
  - `sendBanner()` on the feed primitive, and the server-side `generateUserToken` mint helper for identified browser sessions.

  Every client interaction is a first-party `inapp.*`/`banner.*` event through the ingest spine, so it can trigger a journey and fan to PostHog. `@hogsend/js` and `@hogsend/react` ride the engine version line but are opt-in (not `create-hogsend` scaffold defaults).

## 0.35.1

### Patch Changes

- afbfa22: Fix scaffolded apps crashing at boot ("Dynamic require of X is not supported") on engine 0.35.0+

  engine 0.35.0 added `ai` + `@openrouter/ai-sdk-provider` (for the Studio agent), but the `create-hogsend` template's `package.json` never declared them — so a consumer's tsup (which externalizes everything outside `@hogsend/*`) had no node_modules copy to externalize and instead bundled the CJS `ai` tree (transitively `@vercel/oidc`) into the ESM `dist`, which crashes at module-eval. The template now declares `ai`, `@openrouter/ai-sdk-provider`, plus the two other engine runtime deps that were also missing (`svix`, `picocolors`), so tsup externalizes them and they resolve from node_modules at runtime. `verify-scaffold` now boots the built app (api + worker) to catch this class of bundling regression, which a build-only smoke missed.

## 0.35.0

### Minor Changes

- d510956: Studio co-working AI agent (GLM-5.2 via OpenRouter)

  Adds an in-Studio co-working agent: a bottom-right chat panel that reads the live
  instance (contacts, events, journeys, buckets, sends) and can act through the
  existing data plane — every write gated behind a human-in-the-loop confirmation.

  - Engine: streaming `POST /v1/admin/agent/chat` (Vercel AI SDK + OpenRouter,
    default model `z-ai/glm-5.2`) under the admin auth/rate-limit/audit stack; the
    OpenRouter key never leaves the server. Read tools auto-run; write tools mint a
    single-use, encrypted, Redis-burned proposal token that only
    `POST /v1/admin/agent/confirm` can execute (idempotent, audited,
    test-mode-aware tier reclassification).
  - Studio: launcher → slide-over drawer, multi-chat (localStorage), markdown
    rendering, tool-call cards, a tier-driven confirmation card, and per-message
    edit / rollback / regenerate over a virtualized thread.

  Opt-in and fail-closed: with no `OPENROUTER_API_KEY` the panel shows a calm
  "not configured" state and the routes 503. The rest of the engine-line packages
  move with the engine version line (no functional change in those).

## 0.34.0

### Minor Changes

- 7abff9e: feat(engine): fan ingested events out to PostHog + fix Discord identity direction

  Mirror every ingested event into the active analytics provider from the ingest
  spine, keyed to the resolved canonical contact key. Opt-in via
  `analytics.eventMirror` (or the `ANALYTICS_EVENT_MIRROR` env override), default
  off. Excludes `source: "posthog"` events (echo-loop guard) and supports
  `allow`/`deny` event-name filters. Fires once on the fresh-insert side of the
  ingest idempotency guard, so retries never double-capture and journeys never
  call it.

  Discord inbound transforms no longer mint `userId: "discord:<id>"` — a pre-link
  member is anonymous (keyed by the `discord_id` column), so a later `/link`
  merges it into the email/web contact in the correct direction (`$create_alias`
  folds the Discord person onto the canonical one). Each inbound event now carries
  the actor's own snowflake in its properties (`authorId` / `reactorId` /
  `memberId`), so role grants and DMs fire for members who have not linked yet.

  Widen the connector-action contact resolver to also match `anonymous_id` and the
  uuid `id` column (uuid-shape-gated to avoid an invalid-uuid cast), so
  `member: user.id` resolves any canonical-key form for outbound actions.

## 0.33.0

### Minor Changes

- 855b3e4: feat(plugin-discord): `removeRole` outbound action for tenure ladders.

  Adds a `removeRole` action mirroring `grantRole` (bot-REST `DELETE
.../roles/{roleId}`, idempotent, soft-fails on an unresolved member or a
  permission/hierarchy 403) so journeys can demote as well as promote — e.g. a
  Stranger → Piglet → Hog member lifecycle (drop Stranger on `/link`, drop Piglet
  on graduating to Hog after a 7-day tenure + a message). The rest of the engine
  line rides the version bump.

## 0.32.1

### Patch Changes

- 51afd44: fix(engine): preserve Hatchet `this` binding in the journey side-effect memoize.

  `createMemoize` extracted Hatchet's `memo` into a variable and called it unbound
  (`const memo = ctx.memo; memo(fn, deps)`). The SDK's `memo` body opens with
  `this.throwIfCancelled()` and reads other `this`-bound fields, so the unbound
  call threw `Cannot read properties of undefined (reading 'throwIfCancelled')` —
  crashing EVERY journey side effect (`sendEmail` / `sendConnectorAction` /
  `ctx.trigger`) the moment an eviction-capable engine (hatchet-lite ≥ v0.80.0)
  made `supportsEviction === true`. Tests stub `memo` as a plain arrow fn and CI's
  hatchet-lite reports `supportsEviction: false`, so the buggy path was never
  exercised. Fixed by invoking `ctx.memo(fn, deps)` directly; added a regression
  test whose stub `memo` is a method that touches `this`.

## 0.32.0

### Minor Changes

- 8c672dc: Managed-link campaigns + connector engagement events.

  `link.clicked` is now a first-party bus event: a click on any NON-email managed
  link (Discord, SMS, referral, standalone Studio link) re-ingests through the
  journey pipeline, so a journey can `trigger` on — or `ctx.waitForEvent` for — a
  click of a SPECIFIC managed link (filter by `linkId`/`campaign`). The re-ingest
  is gated on `!isBot` (unfurl/prefetch bots that auto-fetch DM'd links are
  suppressed) and a personal link's `distinctId` (broadcast/public links carry no
  person). The per-hit outbound `link.clicked` webhook and the entire email
  branch are unchanged.

  `ctx.waitForEvent` gains an optional `where` predicate (the same model as
  `trigger.where`) so a journey can await a specific link's click mid-run. It runs
  an engine-side durable re-arm loop with a persisted `wait_deadline` (survives
  Hatchet replay), gap-proof re-scans, and scalar-narrowed properties; omitting
  `where` keeps the exact legacy single-wait. `ctx.history.events` gains an
  `event` name filter.

  Connector engagement events: the connector transform contract widens to
  `IngestEvent | IngestEvent[] | null`, and Discord reactions now fan out into a
  reactor-keyed `discord.reaction_added` (carrying the target author for
  distinct-people counting) plus, when the message author is known (resolved
  cache-only in the gateway worker — no REST), an author-keyed
  `discord.reaction_received` powering "your post resonated with N people". Adds
  `discord.reaction_removed` and a `grantRole` outbound action for the
  community-gamification loop (count an engagement event → grant a role + DM).

### Patch Changes

- 092cc7c: create-hogsend: finish the onboarding hand-off — Studio, Discord, and docs, not just Hatchet.

  Once a scaffold (and `bootstrap`) finishes, the "what now" now leads with the three
  touchpoints that matter — the Studio dashboard (`http://localhost:3002/studio`), the
  Discord invite (`discord.gg/rv6eZNvYrr`), and the docs — instead of dropping the user
  at the Hatchet dashboard. The bootstrap summary also states plainly that local infra
  is up but the app itself is NOT running yet: the compose stack is only Postgres + Redis

  - Hatchet, while the API and worker are your code, started with `dev` + `worker:dev`.
    A closing "Welcome to Hogsend" bookends the scaffolder's opening note.

  Two fixes ride along:

  - The CLI's git-init and dependency-install now run as async `spawn` instead of the
    blocking `spawnSync`. A clack spinner animates on a `setInterval`, and `spawnSync`
    froze the event loop for the whole (often 30s+) install — so the spinner sat dead on
    one frame and read as "is this stuck?". `spawn` keeps the loop free so it actually
    spins.
  - The engine dev banner pointed Studio at a Vite `:5173` origin that only exists in
    the monorepo, so a scaffolded `pnpm dev` showed a link that 404'd. It now points at
    the API's own `${url}/studio`, where the Studio SPA is actually served, and adds the
    Discord link.

  The rest of the `@hogsend/*` line moves with this patch to stay on a single engine
  version line.

- e7583f3: Journeys: exactly-once side effects across a Hatchet durable replay.

  Journey `run()` bodies call `sendEmail()`, `ctx.trigger()`, and `sendConnectorAction()` inline between durable waits. Hatchet replays a durable task from the top on worker crash, OOM, or redeploy, so these previously re-fired and could deliver duplicate emails / events / connector messages.

  Side effects are now exactly-once with **no journey-authoring change in the common case**. An `AsyncLocalStorage` journey boundary auto-derives a deterministic, branch-stable idempotency key (`workflowRunId : nearest-wait-label : discriminant`) and threads it through the existing `email_sends` / `user_events` unique-index short-circuits, plus a new `connector_deliveries` table (migration `0031`) for Telegram/Discord sends. A Hatchet `memo()` fast path skips the effect entirely before the DB on eviction-capable engines (>= v0.80.0). The one authoring rule (enforced by a loud throw on an intra-run key collision): pass a distinct `idempotencyLabel` when sending the same template, triggering the same event, or running the same connector action more than once in one journey on divergent branches. Adds `ctx.now()` (replay-stable clock) and `ctx.once()` (record-once per enrollment).

  The rest of the `@hogsend/*` line moves with this patch to stay on a single engine version line.

- ea4d9d0: Studio: Debug is now a global drawer with a typed (scalar) property builder.

  Firing a test event no longer means navigating to a `/debug` page. A **Fire event**
  button in the header (and the Overview getting-started CTA) opens a slide-out drawer
  from anywhere in Studio, so you can trigger a journey without leaving the page you're
  on. The `/debug` route, its sidebar item, and the old page are removed.

  The drawer also replaces the raw-JSON properties textarea with a **typed scalar
  editor**: each property is a key + a type (string / number / boolean) + a value, so
  the test event exercises `POST /v1/admin/events` with the same scalar types real code
  sends. Numbers that don't parse to a finite value fail loudly (no silent `NaN`/`null`),
  and a duplicate key is rejected rather than silently overwritten.

  The rest of the `@hogsend/*` line moves with this patch to stay on a single engine
  version line.

- ce700ae: Studio: an Events feed with source provenance + person drill-in, and event provenance on every ingested event.

  Studio gains an **Events** view — a filterable, paginated feed of every event ingested
  into the pipeline (`Event · Source · Person · Properties · Time`), with a **Live**
  auto-refresh toggle. Clicking an event opens its properties as **typed key/value rows**
  (string/number/boolean/null type chips); clicking the **person** opens the full contact
  drawer (properties + email activity + a timeline of their other events). The contact
  drawer also now renders the contact's **properties** (previously fetched but hidden).

  To make "where did this event come from?" answerable, events now carry a **source**.
  A new nullable `user_events.source` column (migration `0030`) is stamped at every
  ingestion entry point: webhook sources record their id (so PostHog → `posthog`, Stripe
  → `stripe`, …), the public data-plane API → `api`, the Studio Debug panel + admin
  enroll → `studio`, connectors → `connector`, journey triggers → `journey`, plus
  `bucket` / `tracking` / `import`. The Events feed shows + filters by it.

  The admin events list endpoint LEFT JOINs the live contact (matching the resolved key
  across `externalId` / `anonymousId` / `id`) so each event carries its person's email +
  contact id, and accepts a `source` filter. Pre-existing events have `source = null`.

  The rest of the `@hogsend/*` line moves with this patch to stay on a single engine
  version line.

- 32d9875: Studio: per-journey detail pages.

  Journeys in Studio were a single list with an inline funnel — there was no way to
  drill into one. Clicking a journey now opens a dedicated `/journeys/:id` page:

  - **Definition** — trigger event + `where` conditions, `exitOn` rules, `entryLimit`,
    and the `suppress` window.
  - **Funnel** — the existing enrolled → sent → opened → clicked → completed funnel.
  - **Email** — the templates the journey has actually sent, with sent/opened/clicked
    counts and an inline rendered preview (reusing the template-preview iframe). Scoped
    to email; other channels (Discord/Telegram) aren't shown.
  - **Instances** — a filterable, paginated browser of `journey_states`; each row opens
    a slide-out drawer with the instance's transition log and enrollment context.

  Backed by a new `GET /v1/admin/journeys/:id/templates` endpoint (distinct templates
  sent within the journey, derived from `email_sends` joined through `journey_states`).
  `StatusBadge` also gained journey-instance statuses (active/waiting/completed/exited)
  so they're visually distinguishable.

  The rest of the `@hogsend/*` line moves with this patch to stay on a single engine
  version line.

- 28e14de: Studio: a non-blocking setup checklist, and stop the domain page erroring without a Resend key.

  Opening Studio with no (or a send-only) email provider key made `GET /v1/admin/domain`
  return a 502 — "domains request to provider resend failed: … API key is invalid" — which
  the Setup view rendered as a scary error. A permission-denied (401/403) from the provider's
  domains API is a CONFIGURATION state, not a server error, so it now degrades gracefully:
  the domain status service catches it, engages the same warn-once + back-off the per-send
  path already uses, and returns a `200` with `status: null`. Transient failures (network/5xx)
  still surface as `502`.

  On top of that, a new `GET /v1/admin/readiness` endpoint reports per-area setup state
  (Studio admin, Hatchet, email provider key, data-plane API key, sending domain, PostHog) as
  `ok` / `action` / `optional`, and the Studio Setup page renders it as a non-blocking
  checklist above the sending-domain section. Nothing gates the UI: while it loads it shows a
  skeleton, and any probe failure degrades a single row rather than the page.

  The rest of the `@hogsend/*` line moves with this patch to stay on a single engine version
  line.

## 0.31.1

### Patch Changes

- 79bb505: create-hogsend: repair the pnpm/yarn admin-create crash + onboarding UX pass.

  The scaffold's Studio-admin step (and the `studio:admin` package.json script) ran
  `node node_modules/.bin/hogsend …`, but under pnpm/yarn that bin is a POSIX shell
  shim — pointing `node` at it parsed shell as JavaScript and crashed with
  `SyntaxError: missing ) after argument list`. Both call sites now target the CLI's
  real ESM entry `node_modules/@hogsend/cli/dist/bin.js`, which resolves identically
  on npm/pnpm/yarn/bun. Plus a UX pass on the creator: a welcome banner, a
  dependency-free spinner on the silent Hatchet-token wait, and `hogsend connect
posthog` surfaced as a guided post-deploy step (shown even when PostHog is chosen
  without a pasted key).

  The rest of the `@hogsend/*` line moves with this patch to stay on a single
  engine version line (no code changes outside create-hogsend).

## 0.31.0

### Minor Changes

- 8422893: Restyle the cold-connect confirmation page + realign the scaffolder to the engine line.

  - **`@hogsend/engine`** — the engine-served cold-connect connect page (`GET /connect/<connector>`) is restyled to the Hogsend Studio "Crimzon" design language (ink surface, hairline-bordered card, Inter, eyebrow label, faint grain). New optional `ColdConnectBranding` fields — `iconSvg` (inline platform-logo SVG, shape-checked and fail-closed to the emoji badge), `eyebrow`, and `reassurance` (an "if this wasn't you, ignore this" footnote). Hardening: branding JSON embedded in the page's inline `<script>` is escaped against a `</script>` breakout, the page clears WCAG AA contrast, and it no longer pulls a third-party webfont.
  - **`@hogsend/plugin-telegram`** — the Telegram cold-connect branding now ships the real Telegram paper-plane logo + the reassurance copy, and its accent is darkened to `#1f6feb` so the white Confirm-button label clears WCAG AA.
  - **`create-hogsend`** — realigned to the engine version line. It had silently drifted to `0.22.0` on npm (8 minors behind) because it sits outside the `@hogsend/*` scope the release gate enforces uniformity on, so `create-hogsend@latest` scaffolded a stale app. `release-doctor` now asserts the scaffolder tracks the engine version so this can't recur.

  The remaining engine-line packages are version-only bumps to keep the engine release line uniform.

## 0.22.0

### Minor Changes

- a637866: feat: AI agent integration — recent-events history read, AI SDK journeys, and Eve durable churn-save

  - **`@hogsend/core` / `@hogsend/engine`**: add `ctx.history.events({ userId, limit?, within? })` — a generic newest-first read of a user's recent events (with `RecentEventsOptions` / `RecentEvent` types), the foundation for assembling agent context bundles.
  - **`@hogsend/engine`**: the webhook-source route now resolves a source's auth secret from `process.env[auth.envKey]` when the engine's validated env doesn't declare that key, so a consumer-defined `signature`/`match` webhook source can bring its own secret. Behavior is unchanged for engine presets and stays fail-closed (an unset `signature` secret is still a 401) — this fixes BYO signature sources (e.g. an Eve HITL callback) that previously could not resolve their secret.
  - **`create-hogsend`**: a freshly scaffolded app now ships a working Tier-1 AI onboarding journey (`src/agents/` + `ctx.history.events()`-backed user context) and gains `ai` + `@ai-sdk/anthropic`; new docs cover the three AI SDK integration tiers (inline, tools, and Eve durable HITL).

  The remaining engine-line packages are version-only bumps to keep the engine release line uniform (the scaffold pins `^ENGINE_VERSION`).

## 0.21.2

### Patch Changes

- 4a742dd: fix(connect): purge derived credentials on disconnect, enforce minted secret immediately, validate region URL

  Fast-follows on the one-click PostHog connect:

  - Disconnect (`DELETE /v1/admin/provider-credentials/:providerId`) now purges
    the `derived` credential row (minted webhook secret + grabbed `phc_`) too,
    not just the oauth grant — no orphaned rows linger.
  - The inbound webhook source's secret cache is busted the moment connect mints
    a secret, so it is enforced immediately instead of after the ~30s recheck TTL.
  - Removed the now-unreachable `webhook_secret_missing` 409 branch (the loop
    always resolves or mints a secret before provisioning).
  - The CLI region prompt validates a custom host URL up front instead of
    surfacing a cryptic "Failed to parse URL" during discovery.

## 0.21.1

### Patch Changes

- 6fe64f6: fix(connect): purge derived credentials on disconnect, enforce minted secret immediately, validate region URL

  Fast-follows on the one-click PostHog connect:

  - Disconnect (`DELETE /v1/admin/provider-credentials/:providerId`) now purges
    the `derived` credential row (minted webhook secret + grabbed `phc_`) too,
    not just the oauth grant — no orphaned rows linger.
  - The inbound webhook source's secret cache is busted the moment connect mints
    a secret, so it is enforced immediately instead of after the ~30s recheck TTL.
  - Removed the now-unreachable `webhook_secret_missing` 409 branch (the loop
    always resolves or mints a secret before provisioning).
  - The CLI region prompt validates a custom host URL up front instead of
    surfacing a cryptic "Failed to parse URL" during discovery.

## 0.21.0

### Minor Changes

- ccc89ed: feat(connect): one-click PostHog connect — derive key, mint secret, keyless start

  `hogsend connect posthog` becomes the single front door. It runs the OAuth
  handshake first (region via prompt or `--posthog-host`, no `phc_` paste needed),
  mints + persists the webhook secret server-side, creates the PostHog→Hogsend
  webhook destination, and grabs the project's public key on the way through. The
  inbound webhook source resolves the minted secret from the credential store at
  request time, so the loop verifies without a redeploy.

  The OAuth scope set is front-loaded (4 → 13) so future features land without
  forcing a reconnect; `connect-info` surfaces a `scopeGap` to nudge
  already-connected users to re-consent. The `create-hogsend` scaffold makes the
  `phc_` paste optional, pointing at `hogsend connect posthog` instead.

  Engine additions (additive): `getDerivedCredential`/`saveDerivedCredential` +
  `DerivedCredentialPayload`, the `"derived"` `CredentialKind`, and
  `EXPECTED_POSTHOG_SCOPES`.

  Note (deploy ordering): the hosted CIMD document must serve the 13-scope set
  before the new CLI requests it, or PostHog rejects the broader consent.

## 0.20.0

### Minor Changes

- 671ac16: PostHog setup at scaffold time: `create-hogsend` asks "Are you using
  PostHog?" (or take the non-interactive `--posthog-key` / `--posthog-host`
  / `--no-posthog` flags), validates the project key and region, and
  materializes `POSTHOG_API_KEY`, `POSTHOG_HOST`,
  `ENABLE_POSTHOG_DESTINATION=true`, and a freshly minted
  `POSTHOG_WEBHOOK_SECRET` into the scaffolded env — so capture, person
  writes, the outbound PostHog destination, and a locked inbound webhook
  endpoint all work from first boot. The next-steps output ends with the
  one command that finishes the loop once deployed: `hogsend connect
posthog`. Skipping the prompt leaves the scaffold byte-identical to
  before.

## 0.19.0

### Minor Changes

- e44d400: `hogsend connect posthog` — one command wires the whole PostHog loop. The
  CLI runs a public-client OAuth flow (PKCE S256, loopback callback, no
  client secret; the OAuth server is discovered from your instance's own
  PostHog host so the region is always right and self-hosted instances
  degrade to the personal-key path), stores the credential encrypted at rest
  (new `provider_credentials` table + admin routes; tokens never leave the
  server once stored), and provisions the PostHog → Hogsend webhook
  destination idempotently (adopts an existing destination instead of
  duplicating; refuses when `POSTHOG_WEBHOOK_SECRET` is unset rather than
  wiring an unauthenticated endpoint). Person reads prefer the OAuth token
  and fall back to `POSTHOG_PERSONAL_API_KEY`; a credential stored at
  runtime is picked up by the running api and worker within ~30 seconds, no
  restart. (The full engine line rides together per release discipline.)
- 9710ced: Contact → analytics-person propagation: the `posthog` destination preset
  gains `config.syncPersons` — `contact.created` / `contact.updated` events
  become `$set` captures of the contact's `properties` under its canonical
  key (the same distinct id the identify loop uses), and a scope-`all`
  `contact.unsubscribed` sets `hogsend_unsubscribed: true`. Privacy-first:
  only `properties` travel, never email or identifiers; without the flag,
  `contact.*` events are skipped (previously they fell through to the
  generic capture branch, which could never address them correctly). The
  engine-seeded destination (`ENABLE_POSTHOG_DESTINATION`) subscribes the
  contact events and enables the flag, reconciling pre-upgrade seeded rows
  without overriding an explicit operator `syncPersons: false`. (The full
  engine line rides together per release discipline.)

## 0.18.0

### Minor Changes

- bbc37e7: Provider-neutral analytics: the `AnalyticsProvider` contract (the analytics
  sibling of `EmailProvider`, authored via `defineAnalyticsProvider`) lands in
  `@hogsend/core`, with person reads (`getPersonProperties`), person writes
  (`setPersonProperties` — `set`/`setOnce`/`unset`), and capture.
  `createHogsendClient`'s `analytics` option now mirrors `email`
  (`{ provider?, providers?, defaultProvider? }`, env preset + consumer-last,
  `ANALYTICS_PROVIDER` selection); legacy `PostHogService` inputs are
  adapter-wrapped and keep working. `client.analyticsProviders` is the registry,
  `client.analytics` the resolved active provider.

  PostHog person reads are FIXED — they were silently dead (the write-only
  `phc_` project key sent to the ingestion host at a legacy path). Reads now use
  `POSTHOG_PERSONAL_API_KEY` (a personal API key scoped `person:read`) against
  the private API host (derived from `POSTHOG_HOST`, override
  `POSTHOG_PRIVATE_HOST`) with one-shot project-id discovery (override
  `POSTHOG_PROJECT_ID`). Without the personal key, reads soft-fail to contact
  property fallbacks — now surfaced once at boot and by `hogsend doctor`
  instead of silently. Person WRITES need no extra credential (they ride the
  capture pipeline as `$set`/`$set_once`/`$unset`); `createPostHogProvider` is
  the reference implementation. The scaffold's `env.example` documents the
  two-credential model. (The full engine line rides together per release
  discipline.)

## 0.17.0

### Minor Changes

- e9b9c67: Republish the scaffolder on the 0.18 engine line so fresh scaffolds pin
  `^0.18.0` — the caret on the previous `^0.17.x` pin does not reach a new
  minor.

## 0.16.0

### Minor Changes

- a3e15c4: Keep the engine version line uniform for the Studio crimzon design-system release — all engine-line packages move to the same minor together, and the scaffold republishes with the matching `ENGINE_VERSION` pins.

## 0.15.0

### Minor Changes

- 5fdd9fa: Semantic links follow-ups: the hosted answer page and cross-device identity.

  **Hosted answer page** — a semantic link with no landing page of its own can
  point at the engine: `href={HOSTED_ANSWER_HREF}` (new in `@hogsend/email`)
  resolves at send time to `GET /v1/t/a/:linkId`, a minimal engine-served page
  that confirms the recorded answer and offers a free-text box. Submissions
  ingest as `<event>.comment` (one per send + event, `semc:` idempotency key) —
  a real consumer event journeys can wait on and destinations receive. The
  scaffold's `feedback-checkin` example now lands there by default.

  **Cross-device identity (`hs_t`)** — opt-in via `TRACKING_IDENTITY_TOKEN=true`:
  tracked-link redirects append a one-hour identity token to the destination
  URL; the landing site exchanges it at the new `POST /v1/t/identify` for the
  distinct id and calls `posthog.identify`, merging the email click with the
  web session. Tokens are AES-256-GCM **encrypted** with `BETTER_AUTH_SECRET`
  (a distinct id can be an email address — nothing readable travels in a URL,
  history entry, or referrer). New exports: `generateIdentityToken`,
  `validateIdentityToken`, `InvalidIdentityTokenError`.

## 0.14.0

### Minor Changes

- ee3b670: Journey `where` builder — code-first trigger/exit conditions.

  `trigger.where` and `exitOn[].where` now accept a builder function alongside
  the declarative array, mirroring bucket criteria:

  ```ts
  trigger: {
    event: "nps.detractor",
    where: (b) => b.prop("score").lte(3),
  },
  ```

  The function resolves ONCE at `defineJourney` time (via the existing
  `criteriaBuilder`) into the byte-identical `PropertyCondition[]` POJOs, so the
  stored `JourneyMeta`, registry zod parse, `checkExits`, admin routes, and
  Studio all keep seeing plain data. Return a single condition or an array
  (AND-ed). New types: `JourneyMetaInput`, `JourneyWhere`, `JourneyWhereBuilder`
  in `@hogsend/core`. Fully backward compatible — the array form is unchanged
  and remains the wire/HTTP format.

## 0.13.0

### Minor Changes

- b644a01: Semantic email links — in-email surveys, actions & enrichment.

  `EmailAction` (new in `@hogsend/email`) renders an anchor whose click MEANS
  something: it carries an event name + scalar properties that the engine lifts
  into `tracked_links` at send time (the attributes never reach the inbox) and
  emits through the full ingest pipeline at click time. In-email yes/no
  questions, NPS scores, and one-tap choices become real events that route to
  journeys, persist to `user_events`, and fan out to destinations as the new
  `email.action` outbound type (the PostHog preset captures it under the
  consumer's event name).

  - First answer wins per (send, event name) via a `sem:` idempotency key.
    Answers are confirmed by a deferred task after a ~30s window, so scanner
    click-bursts (SafeLinks/Proofpoint) are judged with the WHOLE burst visible
    — including the scanner's first click — before any answer is recorded.
  - `ctx.waitForEvent` now returns `{ timedOut, properties? }` — the matched
    event's payload, so journeys branch on the answer directly (additive,
    backward compatible) — and accepts an optional `lookback` window that checks
    recent `user_events` first, closing the gap where an answer lands between a
    send (or a previous wait) and the wait being established.
  - `tracked_links` gains nullable `event`, `event_properties`,
    `semantic_emitted_at` columns (expand-only migration 0023). Same-URL links
    carrying different answers no longer collapse into one row.
  - Reserved event namespaces (`email.`/`journey.`/`bucket.`/`contact.`) are
    rejected at send time; semantic properties are scalars-only, size-capped.
  - Outbound catalog grows to 14 events (`email.action`) — engine, CLI mirror,
    and client mirror updated. Seeded PostHog destinations subscribe to it, and
    an existing engine-seeded endpoint is reconciled (missing funnel events
    unioned in) at boot. A failed Hatchet publish now rolls back the
    idempotency claim inside `ingestEvent`, so a transient broker error can't
    permanently consume an answer slot.
  - Scaffold ships a `feedback-checkin` example (semantic yes/no email + journey
    reacting via `waitForEvent` properties).

## 0.12.0

### Minor Changes

- 4d605bd: Scaffold first-run polish: `dev`/`worker:dev` watch `src/**` explicitly so newly added journeys restart the worker; ships a `hatchet.yaml` for the `hatchet worker dev` path; migration output no longer leaks raw Postgres NOTICE objects; the post-setup summary prints once; template database credentials are neutral `hogsend` (not `growthhog`); env.example documents the first-boot ingest-key mint.

## 0.11.0

### Minor Changes

- b84092d: feat: zero-to-verified-domain onboarding — create --domain, hogsend dev, domain verification, provider-neutral test mode, agent skills

  The DX-onboarding train: `pnpm create hogsend@latest my-app --domain mysite.com`
  then `hogsend dev` takes a developer from nothing to a running local loop with a
  sending domain wired — and test mode keeps every send safe (redirected to your
  own inbox) until the domain's DNS verifies.

  Core (`@hogsend/core`):

  - **Domains capability contract** (`providers/domains.ts`, new): `DnsRecord`,
    `DomainStatus`, `DomainVerificationState`, and the optional
    `DomainsCapability` (`create`/`get`/`records`/`verify?`). `EmailProvider`
    gains one optional member — `domains?` — whose presence is the capability
    gate; providers without it degrade gracefully everywhere.

  Engine (`@hogsend/engine`):

  - **Domain-status service** (`lib/domain-status.ts`, exposed as
    `client.domainStatus`): the cached `EngineDomainStatus` snapshot every
    surface consumes (admin route, CLI, Studio, mailer). In-memory cache —
    10 min TTL once verified, 60 s while unverified (so test mode auto-exits
    ≤ 60 s after DNS verifies). The per-send path is sync + cache-only and
    **fail-open**: a provider outage can never silently redirect production mail.
  - **Admin domain routes**: `GET /v1/admin/domain` (`?refresh=true` busts the
    cache), `POST /v1/admin/domain` (register), `POST /v1/admin/domain/verify`
    (provider verification pass). 501 `provider_unsupported` when the active
    provider has no domains capability. Provider API keys never leave the server.
  - **Provider-neutral test-mode sends** (`lib/test-mode.ts` + the mailer): with
    `HOGSEND_TEST_MODE=auto` (default), every send is redirected to
    `HOGSEND_TEST_EMAIL ?? STUDIO_ADMIN_EMAIL` while the configured
    `EMAIL_DOMAIN` is unverified — subject prefixed `[TEST → original@…]`, cc/bcc
    dropped, Resend `from` overridden to `onboarding@resend.dev`,
    `email_sends.metadata.originalTo` recorded, structured
    `email.test_mode_redirect` WARN per send plus a one-line banner per
    activate/exit flip. Active-but-unaddressable sends are BLOCKED (recorded as
    failed), never delivered to the real recipient. `auto` only arms when
    `EMAIL_DOMAIN` is set AND the provider supports domains — existing deploys
    are untouched.
  - New env: `EMAIL_DOMAIN`, `HOGSEND_TEST_MODE` (`auto`|`true`|`false`, default
    `auto`), `HOGSEND_TEST_EMAIL`, `POSTMARK_ACCOUNT_TOKEN`.

  CLI (`@hogsend/cli`):

  - **`hogsend dev`** — the one-command local loop: detect/start infra, ensure
    `.env` + auth secret, migrate, spawn API + worker (line-prefixed), wait for
    health, print the URL block (API / Studio / Hatchet / docs) and a
    domain/test-mode status line. Flags: `--cwd`, `--no-worker`, `--no-infra`,
    and `--fire <event>` (sends a test event to the running instance, accepting
    every `events send` option). Ctrl+C tears down the whole process tree
    (SIGTERM, SIGKILL after 5 s).
  - **`hogsend domain add|check|status`** — register the domain through the
    running instance's admin routes, print the DNS records formatted for YOUR
    DNS host (NS-lookup detection: Cloudflare, Vercel, Route 53, GoDaddy,
    Namecheap, Porkbun, Google Domains) with a panel deep link, auto-apply on
    Cloudflare/Vercel when `CLOUDFLARE_API_TOKEN` / `VERCEL_TOKEN` is present
    (CLI-side only), and poll verification every 15 s (`--timeout`, `--once`,
    `--json`).
  - New libs: `lib/dns.ts`, `lib/dns-apply.ts`, `lib/proc.ts`, and
    `lib/setup-steps.ts` (the setup flow extracted so `setup` and `dev` share
    it). `ensureAuthSecret` now also treats `REPLACE_ME…` values as placeholders.
  - **Two new skills**: `hogsend-integrate` (wire an existing product codebase to
    a running instance via `@hogsend/client`) and `hogsend-migrate` (audit +
    dual-write cutover off Loops / Customer.io / Resend Broadcasts) — bringing
    the bundle to 14, with `/llms.txt` + a docs `agents` page as the stable
    agent entrypoints.

  Providers (`@hogsend/plugin-resend`, `@hogsend/plugin-postmark`): both
  implement the optional `domains` capability — Resend via its Domains API
  (create/get/records/verify), Postmark via the account-level Domains/DKIM API
  (requires `POSTMARK_ACCOUNT_TOKEN`; without it the provider still sends, it
  just reports `supported: false`).

  Studio (`@hogsend/studio`): a new `/setup` view renders the
  `EngineDomainStatus` — domain, per-record DNS state, and the test-mode block.

  Scaffold (`create-hogsend`): a `--domain <domain>` flag (and interactive
  prompt) writes `EMAIL_FROM=hello@<domain>` + `EMAIL_DOMAIN=<domain>` into
  `env.example` so the bootstrap-copied `.env` inherits them; with no app-name
  positional the name defaults to the first domain label. `env.example` gains
  the commented "Sending domain" + test-mode block; the README leads with
  `hogsend dev`; the two new skills ship in `.claude/skills/`.

  The rest of the engine-line packages bump in lockstep to keep the version line
  uniform (release-doctor invariant); they carry no functional change here.

## 0.10.0

### Minor Changes

- 39db4fa: feat: secure Studio auth — close public sign-up, CLI-first + env-bootstrap first admin, self-service reset

  Closes the first-run land-grab on the Studio admin by removing the create path
  from the network entirely, and adds two recovery paths — modelled on how
  PostHog/GitLab/Rails (shell management commands) and Supabase (env-provisioned
  admin + email reset) ship admin recovery. There is **no unauthenticated network
  path that creates any user**.

  Engine (`@hogsend/engine`):

  - **Public sign-up disabled** (`lib/auth.ts` `disableSignUp: true`). In
    better-auth 1.6.11 the check lives inside the sign-up endpoint handler, so
    `POST /api/auth/sign-up/email` returns `400 EMAIL_PASSWORD_SIGN_UP_DISABLED`
    for everyone AND the in-process `auth.api.signUpEmail` is blocked too. Login
    (`sign-in/email`) and the password-reset endpoints are untouched.
  - **Shared admin-create primitive** (`lib/create-admin.ts`, new export
    `createAdminUser` via the narrow `@hogsend/engine/create-admin` subpath). Mints
    via better-auth's internal adapter (scrypt-identical to the running app, not
    subject to `disableSignUp`) — `ctx.password.hash` + `createUser` +
    `createAccount`. One scrypt-correct implementation shared by the CLI and the
    boot bootstrap; no raw SQL password writes.
  - **Boot-time env bootstrap** (`lib/bootstrap-admin.ts`, new export
    `bootstrapAdminFromEnv`, called from the API process after the schema-check
    boot guard). When `STUDIO_ADMIN_EMAIL` is set AND the `user` table is empty,
    the API mints that admin on boot. Password from `STUDIO_ADMIN_PASSWORD` if set
    (never logged), else auto-generated and printed ONCE to the server log ("save
    this, shown once" — the single intended secret-logging exception). Idempotent
    (only on a zero-user DB) and race-safe across replicas (a unique-violation on
    the loser is treated as already-created).
  - **Self-service password reset** (`lib/reset-email.ts`, new export
    `sendResetPasswordEmail`; `lib/auth.ts` new `SendResetPasswordFn`). Wires
    better-auth's `request-password-reset`/`reset-password` to the engine mailer
    with a dependency-free, self-contained reset email (no consumer template
    required). Tokens are single-use, 15-minute TTL, constant-time compared
    (better-auth internals); a reset revokes existing sessions. Delivery failures
    resolve silently to preserve better-auth's neutral, no-enumeration response and
    never log the reset URL/token; a missing provider steers the operator to the
    CLI `reset`.
  - **Shared cross-replica auth rate limiting.** better-auth's `secondaryStorage`
    is wired (`lib/redis.ts`, new exports `createRedisSecondaryStorage`,
    `AuthSecondaryStorage`, `getRedisIfConnected`) to the engine's existing shared
    Redis singleton, flipping rate-limit storage to `secondary-storage` so the
    sign-in / request-password-reset counters are shared across replicas and
    survive restarts. Only wired when `REDIS_URL` is set; degrades to a no-op on
    any Redis fault.
  - New env: `STUDIO_ADMIN_EMAIL`, `STUDIO_ADMIN_PASSWORD` (first-admin
    bootstrap), `BETTER_AUTH_TRUSTED_ORIGINS` (so a remotely served Studio origin
    can reach the auth endpoints). The old `STUDIO_SETUP_TOKEN` is removed (the
    web setup-token gate and `lib/setup-token.ts` are gone).

  CLI (`@hogsend/cli`):

  - **`hogsend studio admin <create|reset|list>`** — a shell-gated create +
    recovery primitive (no HTTP, no running API). Gated by holding `DATABASE_URL` +
    `BETTER_AUTH_SECRET`, read from the environment only (not a `.env` file).
    `create` uses the shared `createAdminUser` (internal adapter; public sign-up is
    closed). Every password write goes through better-auth's server API (scrypt) —
    never raw SQL, never plaintext at rest, never logged. `list` selects only
    non-secret columns.

  Studio (`@hogsend/studio`): the web is **login + forgot/reset only** — the
  setup-mode create form and the `signUp` export are removed. The zero-users state
  renders a read-only info card pointing the operator at `hogsend studio admin
create` / the `STUDIO_ADMIN_EMAIL` env bootstrap, with a reload button — no way
  to create a user over the network.

  Scaffold (`create-hogsend`): `.env.example` gains commented `STUDIO_ADMIN_EMAIL`
  / `STUDIO_ADMIN_PASSWORD` placeholders (no `STUDIO_SETUP_TOKEN`); a
  `studio:admin` package.json script (`node --env-file=.env … hogsend studio admin
create`, loading `.env` the same way `dev` does); and an interactive, skippable
  "create your first Studio admin" step in `bootstrap.ts`.

  The rest of the engine-line packages bump in lockstep to keep the version line
  uniform (release-doctor invariant); they carry no functional change here.

## 0.9.0

### Minor Changes

- 4153964: feat(email): provider-neutral EmailEvent + HTML-only send wire

  The breaking contract change that makes "the EmailProvider is the swappable
  wire" actually true. The provider contract in `@hogsend/core` no longer
  traffics in Resend's wire shapes.

  What changed (compile-caught, plus one deprecated alias for handler bodies):

  - **`EmailEvent` replaces the Resend-shaped webhook union.**
    `verifyWebhook`/`parseWebhook` now return a provider-neutral `EmailEvent`
    (`{ type, messageId, recipients, occurredAt, bounce?, click?, raw }`,
    `email.` event-type prefix kept). `verifyWebhook` MAY be async. New
    `WebhookHandshakeSignal` lets a provider 200 a non-status handshake
    (SNS confirm, Postmark subscription change) without the route sniffing the
    body.
  - **HTML-only send wire.** `SendEmailOptions`/`BatchEmailItem` drop
    `react?: ReactElement` — `html` is now required, `text` optional. The engine
    ALWAYS renders React → HTML itself before `provider.send`. React Email stays
    first-class for template authoring AND Studio preview; only the provider wire
    is HTML. `@hogsend/core` no longer depends on React.
  - **Neutral tagging.** The provider wire keeps a neutral
    `tags?: Array<{ name; value }>` — the most portable shape (SES uses it
    verbatim; Postmark maps first → `Tag` + all → `Metadata`; Resend passes it
    through). The higher-level engine send API (`EmailServiceSendOptions.tags`,
    `POST /v1/emails`) is unchanged.
  - **New opt-in provider `@hogsend/plugin-postmark`.** Postmark support behind
    `createPostmarkProvider` / `EMAIL_PROVIDER=postmark` — native open/click
    tracking forced off (first-party is sovereign), fail-closed webhook auth. It
    is an `optionalDependency` of the engine (guarded dynamic import gated on
    `POSTMARK_SERVER_TOKEN`), so the engine installs/ships fine without it. NOTE:
    its FIRST npm publish must be MANUAL — CI cannot create a brand-new
    `@hogsend/*` package.
  - **Bounce normalization + suppression.** `dispatchWebhook` reads `EmailEvent`
    fields and persists `bounce.class → bounceType`, `bounce.reason →
bounceReason`. Auto-suppression now fires ONLY on `class === 'permanent'`;
    transient/soft bounces are RECORDED as `email.bounced` (class `transient`) but
    do NOT increment the suppression counter — the old `delivery_delayed` no-op is
    gone. `handleBounce`/`handleComplaint` iterate ALL `event.recipients`
    (de-duped, capped at 100 to avoid a fan-out mass-suppression).
  - **Per-provider secrets.** The mailer-level `EmailServiceConfig.webhookSecret`
    hard-gate is removed; each provider owns its own webhook secret at
    construction. The webhook route resolves the provider, verifies, and hands
    `handleWebhook(event, providerId)` an already-verified `EmailEvent`.
  - **Tracking sovereignty.** At boot, if the active provider declares
    `capabilities.nativeTracking: true` (Resend), the engine logs a WARN that
    account-level native tracking must be disabled (first-party is the source of
    truth). The outbound-echo suppression for provider open/click is retained.

  **Escape hatch (one minor):** `LegacyResendWebhookEvent` (= the frozen Resend
  union) is shipped `@deprecated`. A `webhookHandler` body that still reads the
  old nested shape can cast `event.raw as LegacyResendWebhookEvent` while
  migrating to `EmailEvent` fields (`event.messageId`, `event.bounce`,
  `event.recipients`). The old `WebhookEvent`/`WebhookEventType` exports remain
  `@deprecated` for one minor and are removed the following minor.

## 0.8.0

### Minor Changes

- 7229385: feat: outbound destinations on the delivery spine (PostHog/Segment/Slack)

  Turns the durable outbound webhook spine into a fan-out engine: a new
  `kind` column on `webhook_endpoints` selects a delivery-time TRANSFORM adapter,
  so a keyed destination (PostHog, Segment, Slack, or a code-defined
  `defineDestination()`) reuses ALL the existing retry/backoff/DLQ/reaper/CAS
  machinery — only the per-vendor HTTP projection differs. The default
  `kind="webhook"` signed Standard-Webhooks POST is byte-identical to before.
  `@hogsend/client` and `@hogsend/engine` move together on this version line so
  the SDK types can never describe a server response shape the engine does not
  yet return.

  ## Consumer-visible behavioral changes (read before upgrading)

  - **BREAKING: `ctx.posthog.capture` and `ctx.identify` were REMOVED from the
    journey context.** These were single-vendor, fire-and-forget PostHog shims;
    they no longer exist on `JourneyContext` (`@hogsend/core`). Now that PostHog is
    just one outbound DESTINATION among many, the journey context exposes only
    vendor-neutral orchestration primitives (`sleep`, `sleepUntil`, `when`,
    `waitForEvent`, `checkpoint`, `trigger`, `guard`, `history`). To send the
    lifecycle catalog (`contact.*`, `email.*`, `journey.completed`, `bucket.*`) to
    PostHog/Segment/Slack/a CRM, configure an outbound destination. For a custom
    journey signal, fire `ctx.trigger()` (it joins the internal pipeline) and
    capture it where you detect it via your app's PostHog SDK. The `PostHogService`
    provider itself is unchanged and still load-bearing for the identity PULL
    (`getPersonProperties` → timezone resolution) and the opt-in
    `bucket.syncToPostHog` person-property mirror.

  - **Open/click are now PER-HIT, not first-touch.** Previously `email.opened` /
    `email.clicked` emitted exactly ONCE per send (a first-touch gate plus a
    per-send `dedupeKey` of `email.opened:<id>` / `email.clicked:<id>`). They now
    emit on EVERY open and EVERY click with NO `dedupeKey`, so every hit is a
    distinct delivery to every subscribed endpoint. This is intentional — every
    destination must receive every engagement event — and it is the right shape
    for product-analytics destinations (PostHog/Segment per-hit funnels). The
    per-delivery wire bytes for `kind="webhook"` subscribers are UNCHANGED, but a
    live subscriber to `email.opened` / `email.clicked` will now receive many
    deliveries per send instead of one. This is defensible under the documented
    at-least-once + `Webhook-Id` dedup model (each delivery still carries a unique
    `Webhook-Id`), but it is NOT a no-op for existing production endpoints
    subscribed to those two events — size your consumer + dedup accordingly. The
    row-level `emailSends.openedAt` / `clickedAt` first-touch state is unchanged.

  - **`@hogsend/client` outbound-webhook return types gained nullability** to
    model keyed destinations (which carry no signing secret). `WebhookEndpoint.secretPrefix`
    is now `string | null` (null for `kind !== "webhook"`), and
    `CreatedWebhookEndpoint` is now `WebhookEndpoint & { secret?: string }` (the
    full secret is present only for `kind="webhook"`). Under `strictNullChecks`,
    consumer code that read `endpoint.secretPrefix` as a non-null `string`, or
    `created.secret` as a guaranteed `string` on the create/rotate "store it now"
    flow, will get a TS error — narrow before use (the secret is still always
    present for `kind="webhook"` creates at runtime). This ships in lockstep with
    the engine route change that makes the server actually return those nulls.

  - **The admin `kind` enum now accepts every shipped preset.** `POST`/`PATCH
/v1/admin/webhooks` previously rejected `kind` values other than
    `"webhook"`/`"posthog"` with a 400; it now accepts any shipped preset id
    (`webhook`, `posthog`, `segment`, `slack`), derived from `PRESET_DESTINATIONS`
    so the catalog stays the single source of truth. This makes the
    admin-API / `hs.webhooks` SDK path documented in the destinations skill +
    `env.example` actually reachable for `segment`/`slack` endpoints (a `kind`
    whose transform is not registered at delivery still DLQs as a config error).

  ## What's new

  - `defineDestination()` + a `DestinationRegistry`, threaded into
    `createHogsendClient({ destinations })` and `createWorker`. Four shipped
    presets: `webhook` (default), `posthog`, `segment`, `slack`.
  - `ENABLED_DESTINATION_PRESETS` env (csv / `*` / `none`) selects which optional
    presets register; `webhook` + `posthog` are always on. Destination credentials
    are per-endpoint in `webhook_endpoints.config`, never env vars.
  - `ENABLE_POSTHOG_DESTINATION` auto-seeds one `kind="posthog"` endpoint on the
    email funnel so the full email lifecycle fans out to PostHog DURABLY.
  - A new `hogsend-authoring-destinations` skill.

## 0.7.0

### Minor Changes

- e2e254c: feat: outbound webhooks + integration presets

  Adds a Svix-style HMAC-signed outbound webhook stream — a 12-event catalog,
  managed endpoints (`/v1/admin/webhooks` CRUD + rotate-secret + test), and
  durable delivery (per-endpoint retry/backoff, dead-letter, and a 1-minute
  reaper that re-drives due retries and recovers orphaned `sending` rows). The
  `hs.webhooks.*` client resource ships with `verifyHogsendWebhook` (svix +
  node:crypto fallback), and the CLI gains a `hogsend webhooks` command.

  Adds inbound integration presets (Clerk, Supabase `auth.users`, Stripe,
  Segment) as `defineWebhookSource` presets, enabled by env. The webhook-source
  auth contract is widened to a discriminated union with a fail-closed
  `signature` scheme (svix / Stripe `node:crypto` / generic HMAC-hex), and the
  route reads the raw body once so signatures verify against the exact bytes.

  All engine-line packages move together on the version line so the scaffold's
  caret pins keep resolving.

## 0.6.0

### Minor Changes

- Front door: public data-plane API + client SDK.

  Adds the public `/v1` data plane — `contacts` (upsert/find/delete), `events`,
  `emails` (transactional), `lists`, and `campaigns` (broadcast to a list or
  bucket) — behind an API key with a new orthogonal `ingest` scope, plus the new
  `@hogsend/client` SDK. Identity gains email/anonymous keys with a real
  merge/alias resolver (anonymous→identified). Lists are code-defined over the
  existing preference store; campaigns are durable, idempotent, preference-checked
  broadcasts. The CLI moves onto the engine version line and gains write commands.

  The unauthenticated `POST /v1/ingest` is removed — use `POST /v1/events`.
  Event properties no longer merge onto the contact: `contactProperties` write to
  the contact, `eventProperties` to the event (trigger/exit conditions).

## 0.5.0

### Minor Changes

- cd86e13: Bucket lifecycle: colocated reactions + member access on `defineBucket`

  - Typed transition refs `bucket.entered` / `bucket.left` (literal-typed off the
    bucket's own id) usable directly as journey `trigger` / `exitOn` values.
  - Colocated reactions `bucket.on("enter" | "leave" | "dwell", opts?, handler)`
    that desugar to tagged durable journeys with the full `JourneyContext`.
  - `dwell` reactions driven by the reconcile cron over the existing active
    population, with a historical `dwellAnchorAt` derived during backfill so dwell
    fires for the genuinely long-dwelling population on first deploy.
  - Member access `bucket.count()` / `has()` / `members()` / `membersIterator()`.
  - Studio groups generated reactions under their bucket via `sourceBucketId`.

  Deprecates (kept for one release) the hand-maintained `BucketId` union and the
  `bucketEntered` / `bucketLeft` string helpers in favour of the typed refs. The
  scaffold drops the re-widening `DefinedBucket[]` annotation so literal ids infer.

## 0.4.1

### Patch Changes

- 8e7d7a2: A scaffolded app's `src/index.ts` now calls the engine's `reportApiReady`, so a fresh `create-hogsend` app gets the branded boot banner out of the box. This depends on the engine pinned by `ENGINE_VERSION` exporting `reportApiReady` — keep `ENGINE_VERSION` aligned with the engine minor that ships it in the Version PR (see the `release` skill).

## 0.4.0

### Minor Changes

- 0db58c6: Align the scaffold-pinned packages to the engine 0.4 line (no functional changes) so a fresh `create-hogsend` install resolves every `@hogsend/*` dependency on one compatible minor. Remember to bump `ENGINE_VERSION` in `packages/create-hogsend/src/template-manifest.ts` to match in the Version PR.

## 0.3.2

### Patch Changes

- 8a6aa5f: Ship Claude Code agent skills with scaffolded apps, plus a one-step engine + skills upgrade path.

  - **Exhaustive skill set** (8 skills) authored once in `packages/cli/skills/` — the single source `@hogsend/cli` ships and `hogsend skills add` installs: `hogsend-cli`, `hogsend-authoring-journeys`, `hogsend-authoring-emails` (incl. tracking + unsubscribe), `hogsend-authoring-buckets`, `hogsend-conditions`, `hogsend-webhooks-and-workflows`, `hogsend-database`, `hogsend-deploy`. Each is a lean `SKILL.md` with progressive-disclosure `references/`.
  - **`create-hogsend`** now prompts to include skills (default yes; `--skills` / `--no-skills`) and emits committed `.claude/skills/` + a tailored `CLAUDE.md` (app-name + engine-version substituted) that routes agents to the right skill. Skills are build-copied into the template by a new `sync-skills` prebuild, so the scaffold and the CLI never drift.
  - **`hogsend upgrade`** — new CLI command that bumps every `@hogsend/*` dependency to latest (or `--to`) and refreshes the vendored skills in one step. A provenance stamp + a `hogsend doctor` nudge surface when installed skills fall behind the latest CLI.
  - `hogsend skills add` gains `--all` and documents `--force` as the post-upgrade refresh.

## 0.3.1

### Patch Changes

- abed12b: Magical local onboarding + a smoother scaffolder CLI:

  - **One-command `pnpm bootstrap`** in scaffolded apps — checks Docker, generates `.env` with a real `BETTER_AUTH_SECRET`, auto-remaps conflicting host ports (so multiple stacks coexist), mints a Hatchet token, and runs migrations. Idempotent.
  - **`--yes` / `-y`** for a fully non-interactive scaffold, and **`.`** to scaffold into the current folder.
  - **Package-manager-aware** command hints (npm/yarn/bun) and clearer step-by-step progress, pointing at docs.hogsend.com.
  - **Fix:** the scaffolded email logo no longer renders the literal `{{APP_NAME}}` — it's now substituted with your app name (added `logo.tsx` to the token-substituted files).

## 0.3.0

### Minor Changes

- aac7394: Buckets feature-complete — fluent criteria builder, dormancy joins, and a journey-aligned `entryLimit` rename

  Rounds the Buckets primitive out to a complete dynamic-membership feature and aligns its vocabulary with journeys.

  **BREAKING (cheap now, at ~zero adoption): `reentry` → `entryLimit`.** `BucketMeta.reentry`/`reentryPeriod` are renamed to `entryLimit`/`entryPeriod` to match `defineJourney` exactly (same `"once" | "once_per_period" | "unlimited"` values). The `/v1/admin/buckets` responses use the new keys too. Rename the field in your `defineBucket` calls. Note: on a bucket, `entryLimit` throttles the emitted `bucket:entered` _event_ — membership itself is always live (it re-computes every time criteria match); the journey a bucket triggers has its own `entryLimit` for enrollment.

  - `@hogsend/core` — `defineBucket` `criteria` now accepts a fluent builder
    `(b) => b.all(b.event(X).exists(), b.event(X).within(days(7)).notExists())`
    alongside the declarative `ConditionEval` tree. It runs once at definition time
    and returns the same canonical data, so registry indexes, schema validation,
    the reconcile cron, and Studio are unaffected. The declarative form still works.
  - `@hogsend/engine` — absence-shaped buckets auto-enable the cron join path so
    lapsed-active "went dormant" buckets materialize ongoing without a config flag
    (opt out with `reconcileJoins: false`); single-event and composite absence
    joins are bounded by an exists-ever floor that excludes never-active users.
    Precise `entryLimit: "once_per_period"` — the `bucket:entered:<id>` emit is
    suppressed until `entryPeriod` has elapsed since the most-recent prior leave
    (membership + `entryCount` still advance; an undefined `entryPeriod` emits as
    before). **Boot-time backfill now actually fires** — it was previously placed
    after the blocking `worker.start()` and never ran; it is now triggered before
    the listener (fire-and-forget) so new/changed buckets seed existing matching
    contacts on deploy (silently, no `bucket:entered`), with entry-count and
    live-contact parity. Registering `kind:"manual"` throws at startup
    (`not implemented in v1`) instead of registering a silently-inert bucket.
  - `@hogsend/studio` — the bucket detail panel surfaces `maxDwell` as a
    `Time-boxed · <dwell>` badge.
  - `create-hogsend` — the scaffold's example bucket uses `entryLimit`.

  No new migration — `max_dwell_at`, `left_at`, and `criteria_hash` already exist.
  The canonical `went-dormant` example is now a lapsed-active composite (active at
  some point, but not in the last 7 days), so it excludes never-active signups.

  Hardening (from a full pre-release review): the cron join path is gated by
  `entryLimit` (no re-emit on every tick after re-dormancy); a brand-new absence
  bucket does NOT blast historically-dormant users into journeys (the cron join
  path waits for the first-time backfill to claim them silently); the safe absence
  shapes (single-event `not_exists within` and the lapsed-active composite) join
  via an exact set-based query (no per-member starvation), and other absence
  composites require an explicit `reconcileJoins: true`; backfill and cron agree on
  never-active exclusion; composite backfill is keyset-paged. Deferred to 0.3.1
  (non-gating): parallelizing the per-event candidate evaluation on the ingest hot
  path, and dedicated indexes (`user_events(event, occurred_at, user_id)` and an
  `entryLimit` cooldown index).

## 0.2.0

### Minor Changes

- 31e5ed7: Add Buckets — first-class, code-defined segments with real-time membership

  `defineBucket()` introduces named membership groups as a peer primitive to
  journeys. A user joins a bucket the moment their data satisfies its criteria and
  leaves when it stops; each transition emits `bucket:entered` / `bucket:left`
  (plus per-bucket aliases `bucket:entered:<id>` / `bucket:left:<id>`) through the
  ingest pipeline, so a bucket join/leave can trigger a journey via the journey's
  `trigger.event` (Hatchet `onEvents`). Criteria reuse the existing `@hogsend/core`
  condition engine.

  - `@hogsend/core` — `BucketMeta`, `bucketMetaSchema`, and `BucketRegistry`
    (event/property indexes for candidate narrowing).
  - `@hogsend/db` — `bucket_memberships` (re-entry-safe partial unique active
    index) and `bucket_configs` tables on the engine migration track.
  - `@hogsend/engine` — `defineBucket`, real-time inclusion/exclusion evaluation
    inside the ingest pipeline (recursion-guarded, transition-only emission), an
    engine-owned cron reconciliation for time-based/absence leaves, opt-in
    fast-expiry timers, an unconditional `maxDwell` membership TTL (force-leave N
    after joining regardless of criteria; re-entry governed by `reentry`), backfill
    - criteria-change re-evaluation, admin routes (`/v1/admin/buckets`), an optional
      off-by-default PostHog person-property sync, and `buckets` / `ENABLED_BUCKETS`
      wiring on `createHogsendClient` and `createWorker`.
  - `@hogsend/studio` — an observe-only Buckets view (size, enter/leave over time,
    which journeys a bucket feeds).
  - `create-hogsend` — the scaffold template ships a `src/buckets/` example and the
    client/worker wiring.

  All changes are additive; existing journeys, the engine factories, and consumer
  types are unaffected. Consumers pick up a new engine-track migration applied by
  the standard pre-deploy `db:migrate`.

## 0.1.0

### Minor Changes

- 3601a18: Scaffolded apps now ship Hogsend Studio. `@hogsend/studio` is published and wired into the template, so the admin UI auto-mounts at `/studio` with no extra build step. The `@hogsend/*` version pin is updated to the 0.1.0 line so every dependency resolves at one version.

## 0.0.2

### Patch Changes

- 3aeeda0: Interactive scaffolding via `@clack/prompts` — prompts for project name, package
  manager, install, and git, with spinners — plus a guided "Next steps" note so a
  freshly scaffolded app tells you exactly what to run (docker compose, `.env` +
  the Hatchet token, `db:migrate`, `dev`, `worker:dev`, and your first journey).
  The flag-driven non-interactive path (`--pm`, `--no-install`, `--no-git`) is
  unchanged for CI.
