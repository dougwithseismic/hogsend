# @hogsend/plugin-telegram

## 0.36.1

### Patch Changes

- 3853800: fix(engine): provenance-pin engine-internal re-ingests so a contact's own canonical key never mints a phantom identified twin

  A server-side re-ingest keyed by `userId = <a contact's canonical key>` (which for an anonymous — or email+anon — contact IS its `anonymous_id`) was resolved through the value path, which only matches `external_id`, so it minted a second "identified" contact `{ external_id: <anonId> }`. That phantom twin then tripped the in-app feed's `collidesWithIdentified` guard, 403-ing the visitor out of their OWN feed (`anonymousId is not addressable`). The most direct trigger was the feed's own mark-read / mark-all re-ingests.

  Fix: engine-internal re-emit sites now carry the subject's unforgeable contact row id (`contactId`) and the resolver pins to that exact row (`resolveByContactId`, `FOR UPDATE`, follows merge-aliases to the survivor) — never value-resolving, never minting. The public `/v1/events`/`/v1/feed` routes cannot supply `contactId` (schemas omit it, handlers build the resolve literally, and it's mutually exclusive with the publishable clamp), so the anti-impersonation boundary is unchanged and `collidesWithIdentified` stays strict. Threaded through `ingestEvent` + the feed mark/clear re-ingests; genuine external identities (no `contactId`) take the unchanged value path.

- Updated dependencies [3853800]
  - @hogsend/engine@0.36.1

## 0.36.0

### Minor Changes

- 02dab59: Client-side layer: `@hogsend/js` (zero-dependency browser core — identity, capture, preferences, in-app feed, banners, toasts, reactive store) and `@hogsend/react` (provider, hooks, and the `NotificationBell`/`FeedPopover`/`NotificationFeed`/`Banner`/`Toast` components with a `--hs-*` themed override surface), plus the engine pieces that power them:

  - Publishable-key (`pk_`) browser-ingest auth (`requirePublishableOrIngest`, per-key origin allowlist, `allowed_origins` migration, reflective CORS, `GET /v1/lists/preferences`).
  - The in-app feed backend: `feed_items` table, `sendFeedItem()` + `send-feed` workflow, recipient-scoped `/v1/feed/*` routes with SSE fan-out.
  - `sendBanner()` on the feed primitive, and the server-side `generateUserToken` mint helper for identified browser sessions.

  Every client interaction is a first-party `inapp.*`/`banner.*` event through the ingest spine, so it can trigger a journey and fan to PostHog. `@hogsend/js` and `@hogsend/react` ride the engine version line but are opt-in (not `create-hogsend` scaffold defaults).

### Patch Changes

- Updated dependencies [02dab59]
  - @hogsend/engine@0.36.0

## 0.35.1

### Patch Changes

- afbfa22: Fix scaffolded apps crashing at boot ("Dynamic require of X is not supported") on engine 0.35.0+

  engine 0.35.0 added `ai` + `@openrouter/ai-sdk-provider` (for the Studio agent), but the `create-hogsend` template's `package.json` never declared them — so a consumer's tsup (which externalizes everything outside `@hogsend/*`) had no node_modules copy to externalize and instead bundled the CJS `ai` tree (transitively `@vercel/oidc`) into the ESM `dist`, which crashes at module-eval. The template now declares `ai`, `@openrouter/ai-sdk-provider`, plus the two other engine runtime deps that were also missing (`svix`, `picocolors`), so tsup externalizes them and they resolve from node_modules at runtime. `verify-scaffold` now boots the built app (api + worker) to catch this class of bundling regression, which a build-only smoke missed.

- Updated dependencies [afbfa22]
  - @hogsend/engine@0.35.1

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

### Patch Changes

- Updated dependencies [d510956]
  - @hogsend/engine@0.35.0

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

### Patch Changes

- Updated dependencies [7abff9e]
  - @hogsend/engine@0.34.0

## 0.33.0

### Minor Changes

- 855b3e4: feat(plugin-discord): `removeRole` outbound action for tenure ladders.

  Adds a `removeRole` action mirroring `grantRole` (bot-REST `DELETE
.../roles/{roleId}`, idempotent, soft-fails on an unresolved member or a
  permission/hierarchy 403) so journeys can demote as well as promote — e.g. a
  Stranger → Piglet → Hog member lifecycle (drop Stranger on `/link`, drop Piglet
  on graduating to Hog after a 7-day tenure + a message). The rest of the engine
  line rides the version bump.

### Patch Changes

- Updated dependencies [855b3e4]
  - @hogsend/engine@0.33.0

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

- Updated dependencies [51afd44]
  - @hogsend/engine@0.32.1

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

- Updated dependencies [092cc7c]
- Updated dependencies [e7583f3]
- Updated dependencies [8c672dc]
- Updated dependencies [ea4d9d0]
- Updated dependencies [ce700ae]
- Updated dependencies [32d9875]
- Updated dependencies [28e14de]
  - @hogsend/engine@0.32.0

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

- Updated dependencies [79bb505]
  - @hogsend/engine@0.31.1

## 0.31.0

### Minor Changes

- 8422893: Restyle the cold-connect confirmation page + realign the scaffolder to the engine line.

  - **`@hogsend/engine`** — the engine-served cold-connect connect page (`GET /connect/<connector>`) is restyled to the Hogsend Studio "Crimzon" design language (ink surface, hairline-bordered card, Inter, eyebrow label, faint grain). New optional `ColdConnectBranding` fields — `iconSvg` (inline platform-logo SVG, shape-checked and fail-closed to the emoji badge), `eyebrow`, and `reassurance` (an "if this wasn't you, ignore this" footnote). Hardening: branding JSON embedded in the page's inline `<script>` is escaped against a `</script>` breakout, the page clears WCAG AA contrast, and it no longer pulls a third-party webfont.
  - **`@hogsend/plugin-telegram`** — the Telegram cold-connect branding now ships the real Telegram paper-plane logo + the reassurance copy, and its accent is darkened to `#1f6feb` so the white Confirm-button label clears WCAG AA.
  - **`create-hogsend`** — realigned to the engine version line. It had silently drifted to `0.22.0` on npm (8 minors behind) because it sits outside the `@hogsend/*` scope the release gate enforces uniformity on, so `create-hogsend@latest` scaffolded a stale app. `release-doctor` now asserts the scaffolder tracks the engine version so this can't recur.

  The remaining engine-line packages are version-only bumps to keep the engine release line uniform.

### Patch Changes

- Updated dependencies [8422893]
  - @hogsend/engine@0.31.0

## 0.30.0

### Minor Changes

- e5f720e: feat(plugin-discord): adopt the cold-connect link-confirm flow (drop the typed-code /verify)

  Refactors `@hogsend/plugin-discord` onto the engine `createColdConnect()` primitive so Discord linking matches Telegram: `/link <email>` → emailed one-click confirm LINK → click → the engine-served connect page binds `discord_id` + email onto one contact + client-identifies. **`/verify` and the typed-code path are removed.**

  - **`@hogsend/plugin-discord`** — `InteractionDeps` is reworked (breaking): the code-flow callbacks (`mintCode`, `sendLinkCode`, `redeemCode`, `recordVerifyAttempt`) are dropped in favour of a single consumer-supplied **`requestConfirm({ discordUserId, email }) → { ok } | { ok: false, reason }`** that mints a server-sealed cold-connect token and emails the confirm link (the token never reaches the handler). The Enter-code component/modal, the `/verify` slash command, and the `CODE_MODAL`/`ENTER_CODE_BUTTON` custom-ids are deleted; `CustomIds` is now just `{ EMAIL_MODAL }`. The mint throttle moved entirely into `mintConfirm` (Redis-INCR, fail-closed). New export: `RequestConfirmResult`.
  - **`member_link` OAuth path is preserved** — its `resolveContact` (which runs `linkContact` + role-grant + the `discord.linked` emit for the operator/known-contact web-bind) is kept and is used ONLY by the OAuth branch, not the `/link` interactions path. Both bind paths stay at parity: `/link` grants the role via the cold-connect `afterBind` + emits via the exchange's `ingestEvent`; the OAuth branch keeps doing it via `resolveContact`.
  - **`apps/api`** is the in-monorepo reference consumer: it constructs `discordColdConnect = createColdConnect({ identityKind: "discordId", platformKey: id => id, buildIngest: scalar discordId, … })`, wires `requestConfirm` to `mintConfirm` + the transactional confirm email, and mounts the routes via the array form of `CreateAppOptions.routes`. The now-orphaned `transactional/discord-link-code` template is removed.

  The remaining engine-line packages are version-only bumps to keep the engine release line uniform.

### Patch Changes

- Updated dependencies [e5f720e]
  - @hogsend/engine@0.30.0

## 0.29.0

### Minor Changes

- bbfd270: feat(engine): createColdConnect() — a reusable cold-connect primitive (generalizes the Telegram email-link flow)

  Extracts the Telegram cold-connect flow (`/link <email>` → emailed confirm link → click → server-sealed bind → client-side `posthog.identify`) into a channel-agnostic engine primitive so Discord, Telegram, and future connectors share one mechanism.

  - **`@hogsend/engine`**: new `createColdConnect({ connectorId, identityKind, platformKey, linkedEvent, identifyPropKey, buildIngest, branding, ttlSeconds?, throttle?, afterBind? })` → `{ mintConfirm, confirmUrl, routes }`. The factory owns the sealed-token store (Redis, `connectorId` sealed in the value), the connect page, and the `peek → ingestEvent → consume` exchange. Security invariants baked in: the bind runs only on a human POST (never a GET prefetch); the exchange body is `{tok}`-only (ids come solely from the sealed token — no graft); single-use peek-then-consume (a webhook/retry can't burn the link), and the token is consumed even if `afterBind` throws (at-least-once, idempotent-required); a fail-closed Redis-INCR mint throttle; cross-connector token isolation (basePath + idempotency key + a `binding.connectorId === connectorId` assert, 410 on mismatch). The exchange uses `ingestEvent` (folds the platform key + email onto one contact and routes the welcome journey) and returns the canonical `contactKey`, which the page hands to `posthog.identify` — keyed to the server-proven id, never a client-supplied one.
  - **`CreateAppOptions.routes`** now accepts a single fn **or an array** of route fns, so a consumer can mount `[existingRoutes, coldConnect.routes]` without clobbering.
  - **`@hogsend/plugin-telegram`**: refactored onto the primitive (`telegramColdConnect = createColdConnect(...)`); the bespoke `telegram-connect.ts` page/exchange and the confirm-token family in `link.ts` are removed (the `/start` deep-link path stays). The connect basePath is unchanged (`/connect/telegram`), so confirmation emails in flight keep resolving.
  - **`apps/docs`**: the marketing PostHog init now sets `cross_subdomain_cookie: true` so a **consented** visitor's distinct_id is written to a `.hogsend.com` cookie — letting a cold-connect connect page (served off the API host) read their existing id and fold prior browsing into the proven identity. Pre-consent behaviour (memory-only, no cookie) is unchanged.

  The remaining engine-line packages are version-only bumps to keep the engine release line uniform.

### Patch Changes

- Updated dependencies [bbfd270]
  - @hogsend/engine@0.29.0

## 0.28.0

### Minor Changes

- ed06b92: feat(connectors): @hogsend/plugin-telegram + live-only journey_states unique index

  Adds `@hogsend/plugin-telegram` — an inbound webhook connector (messages, `/start`
  deep-link, `/link` email-confirm cold connect) with journey-callable
  `sendMessage`/`dm` actions and Redis-token linking (peek-then-consume so a Telegram
  webhook retry can't burn a link mid-flight).

  Engine: `uq_user_journey_active` is now a PARTIAL unique index scoped to live rows
  (`status IN ('active','waiting')`) so an `unlimited` journey can complete more than
  once per user — the old full `(user_id, journey_id, status)` index threw `23505` on
  the second completion. Ships migration `0029`. `contacts.properties.telegram` now
  deep-merges (mirrors `discord`).

  All engine-line packages are bumped uniformly to keep the version line and the
  scaffold's caret pins consistent.

### Patch Changes

- Updated dependencies [ed06b92]
  - @hogsend/engine@0.28.0
