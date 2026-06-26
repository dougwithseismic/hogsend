# @hogsend/plugin-discord

## 0.37.2

### Patch Changes

- 19ba821: `@hogsend/react`: clean feed-notification truncation + a reveal animation. Long titles and bodies now clamp to a token-driven N-line ellipsis (`--hs-feed-item-title-lines` / `--hs-feed-item-body-lines`, default 2) instead of being ragged-clipped mid-line with shaved descenders; the inline survey block is left untouched. New feed items also fade + lift in as they mount (`--hs-feed-item-enter-ms`), gated behind `prefers-reduced-motion` and kept clear of the swipe-to-archive exit animation.
- Updated dependencies [19ba821]
  - @hogsend/engine@0.37.2

## 0.37.1

### Patch Changes

- a9b12de: `@hogsend/react`: responsive in-app feed + survey card. The feed now sets its own type baseline so notification items don't balloon to a large host font-size, bodies are sized and muted for readability, and the `scale`/`nps` survey scale flows as a single shrink-to-fit row instead of wrapping into a ragged grid in narrow feeds (including the 380px bell popover).
- Updated dependencies [a9b12de]
  - @hogsend/engine@0.37.1

## 0.37.0

### Minor Changes

- f21fb2b: In-app component kit — survey/rating primitive, preference center, swipe-to-archive, BYO toast, and a notification-badge fix.

  - **Survey / rating primitive** — a surface-neutral `<Survey>` email component and an in-app survey feed block (`SurveyBlockView`) plus `sendSurvey()`. Answers ride the existing event spine (no new write path) and are readable from journeys via `ctx.waitForEvent`. New read-only `GET /v1/admin/reporting/breakdown` aggregates any event by a property value (count, average, optional NPS).
  - **`<PreferenceCenter>`** — per-category × per-channel notification preferences over `usePreferences`, bundleable into `<FeedPopover>` as a tab. New read-only `GET /v1/lists` catalog.
  - **Swipe-to-archive** — brought into `@hogsend/react` as a first-class affordance (pointer/touch swipe + an accessible archive button, wired to the existing `markAsArchived`).
  - **Toast** — polished default skin and first-class custom rendering (`renderToast`).
  - **Notification bell badge** — fixed `box-sizing` so the unread count renders as a solid, pinned circle under any host CSS reset.

### Patch Changes

- Updated dependencies [f21fb2b]
  - @hogsend/engine@0.37.0

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

## 0.27.0

### Minor Changes

- f771ae0: feat(links): generic first-party link tracker — mint, manage, and stitch tracked links outside email

  Extracts the email link-tracking machinery into a channel-agnostic primitive so any
  channel (Studio, Discord, SMS, share links) can mint first-party tracked links.

  - **`@hogsend/engine`**: new `mintLink({ db, url, baseUrl, source, type, label?, campaign?, distinctId?, createdBy? })` — the managed counterpart to the email HTML-rewrite path. Inserts a durable `links` row (operator/campaign identity) plus a `tracked_links` click-counter row that back-references it via `link_id`, and returns the `/v1/t/c/:id` redirect URL. Email is unchanged: it keeps rewriting HTML at send time with `tracked_links.link_id` NULL, so the two stay independent consumers of the same click spine.
  - **Share-safe by construction**: a link is identity-bearing (carries a `distinctId` the click can stitch) ONLY when `type: "personal"`. A `public` link NEVER carries a person token — a reshared public link attributes by campaign only. Destinations are validated http(s) at mint time (closes the latent open-redirect).
  - **Single-use identity-token burn**: the `hs_t` redirect token is now single-use — the first `POST /v1/t/identify` exchange wins; a replayed/reshared token is a 200 no-op (Redis `SET NX` on a sha256 of the token, TTL = token lifetime). Best-effort: a Redis fault degrades to the pre-burn behaviour rather than coupling the exchange to Redis liveness.
  - **`@hogsend/studio`**: a new "Links" view to create and manage tracked links (mint personal/public links, copy the short URL, view per-link click counts, archive). Backed by admin CRUD at `/v1/admin/links` (list/get/create/update/archive), with the click count computed on read from `tracked_links.click_count`.
  - **`@hogsend/db`**: new `links` table + `tracked_links.link_id` FK (additive migration `0028`).

  The remaining engine-line packages are version-only bumps to keep the engine release line uniform (the scaffold pins `^ENGINE_VERSION`).

### Patch Changes

- Updated dependencies [f771ae0]
  - @hogsend/engine@0.27.0

## 0.26.0

### Minor Changes

- 78c9ef6: feat(connectors): connect-DX polish + multi-bot-shaped readiness

  - **`@hogsend/engine`**: the connect-info `ingressSecretConfigured` field is renamed `legacyIngressSecretConfigured` (deprecated, kept one minor) — readiness is now driven off `workerOnline` (the owned heartbeat), since the inline runtime never uses the ingress secret. The connector runtime also logs a loud, actionable error when a configured runtime can't acquire its lease for ~30s (Redis unreachable or contended) instead of silently never connecting (which previously mis-read as "intents not enabled").
  - **`@hogsend/plugin-discord`**: the gateway runtime auto-registers the `/link` + `/verify` slash commands (globally + idempotently) when the socket comes up — no more separate `discord:register-commands` step, and it self-heals after a token rotation. Exports `registerSlashCommands` + `LINK_VERIFY_COMMANDS`.
  - **`@hogsend/cli`**: `hogsend connect discord --status` drops the stale ingress-secret line for `worker online`, adds a worker-offline hint, and returns a 404-specific error when the consumer `/secrets`+`/wire` routes aren't mounted.
  - **`@hogsend/studio`**: the integrations card drops the ingress-secret signal, adds a worker-offline hint panel, and renders the rich gateway card for ANY `transport === "gateway"` connector (not the literal `"discord"` id) — so a second Discord bot would render its own card for free (the seam stays many-bots-shaped).

  The remaining engine-line packages are version-only bumps to keep the engine release line uniform (the scaffold pins `^ENGINE_VERSION`).

### Patch Changes

- Updated dependencies [78c9ef6]
  - @hogsend/engine@0.26.0

## 0.25.0

### Minor Changes

- 9a87335: feat(engine): the connector runtime — a worker-hosted, leader-leased inbound gateway socket plus a journey-callable outbound action API.

  - **`@hogsend/engine`**: gateway-transport connectors (Discord) now run their long-lived socket **inline inside the Hatchet worker** — no separate service, no `CONNECTOR_INGRESS_SECRET`. A Redis leader lease guarantees exactly one replica holds the socket per bot token, with bounded automatic failover; dispatches feed `transform`→`ingest` in-process, and only the lease-holder writes the (now connector-neutral) liveness heartbeat Studio reads, so "Worker Online / Bot Installed" reflects OWNED liveness a stray process cannot fake. Activation is automatic when a gateway connector + its bot token are present (`ENABLE_CONNECTOR_RUNTIMES`, `CONNECTOR_RUNTIME_HOST=worker` by default). Wire it with `createWorker({ connectorRuntimes: { discord: createDiscordRuntime } })`. The seam is connector-agnostic — a second connector (Slack, …) implements only `defineConnector` + a `ConnectorRuntime` factory and reuses lease election, the heartbeat, and the admin projection unchanged.
  - **`@hogsend/engine`**: outbound actions are a separate, socket-free face — `sendConnectorAction({ connectorId, action, args })` (a standalone import, not on `ctx`) invokes registered `defineConnectorAction`s, independent of the inbound socket (a deployment with the gateway off can still send).
  - **`@hogsend/plugin-discord`**: ships `createDiscordRuntime` (the gateway runtime factory) and `discordActions` (`sendChannelMessage`, `broadcastToChannel`, `mentionMembers`, `mentionRole`, `dmMember`); register the actions via `createHogsendClient({ connectorActions: discordActions })`. The standalone `discord-worker` entry remains as an advanced escape hatch (`CONNECTOR_RUNTIME_HOST=standalone`).

  Additive and opt-in. The remaining engine-line packages are version-only bumps to keep the engine release line uniform (the scaffold pins `^ENGINE_VERSION`).

### Patch Changes

- Updated dependencies [9a87335]
  - @hogsend/engine@0.25.0

## 0.24.0

### Minor Changes

- a637866: feat: AI agent integration — recent-events history read, AI SDK journeys, and Eve durable churn-save

  - **`@hogsend/core` / `@hogsend/engine`**: add `ctx.history.events({ userId, limit?, within? })` — a generic newest-first read of a user's recent events (with `RecentEventsOptions` / `RecentEvent` types), the foundation for assembling agent context bundles.
  - **`@hogsend/engine`**: the webhook-source route now resolves a source's auth secret from `process.env[auth.envKey]` when the engine's validated env doesn't declare that key, so a consumer-defined `signature`/`match` webhook source can bring its own secret. Behavior is unchanged for engine presets and stays fail-closed (an unset `signature` secret is still a 401) — this fixes BYO signature sources (e.g. an Eve HITL callback) that previously could not resolve their secret.
  - **`create-hogsend`**: a freshly scaffolded app now ships a working Tier-1 AI onboarding journey (`src/agents/` + `ctx.history.events()`-backed user context) and gains `ai` + `@ai-sdk/anthropic`; new docs cover the three AI SDK integration tiers (inline, tools, and Eve durable HITL).

  The remaining engine-line packages are version-only bumps to keep the engine release line uniform (the scaffold pins `^ENGINE_VERSION`).

### Patch Changes

- Updated dependencies [a637866]
  - @hogsend/engine@0.24.0

## 0.23.1

### Patch Changes

- 14296d8: fix(admin): suppressions "All" view listed every contact, and harden two sibling unbounded-query routes

  The admin Suppressions "All" filter built no WHERE clause (`typeFilter` returned
  `undefined`), so Drizzle returned every `email_preferences` row — making every
  contact look suppressed even though none were (deliverability was never affected;
  the send-gate only blocks on `suppressed`/`unsubscribedAll`). The "All" case now
  restricts to genuinely-suppressed recipients (`suppressed OR unsubscribedAll OR
bounceCount > 0`).

  - **preferences PUT**: un-suppressing (`suppressed: false`) now also clears
    `bounceCount`/`lastBounceAt`, so a bounced recipient actually leaves the list
    instead of being pinned there forever.
  - **studio contact drawer**: its un-suppress button now sends `unsubscribedAll:
false` too, so it works for unsubscribed contacts (previously a no-op for them).
  - **bulk events replay**: refuses an unscoped replay (`400`) instead of silently
    re-pushing the most-recent events through ingestion when no `eventIds`/filter
    is given.
  - **sends CSV export**: signals truncation via `X-Hogsend-Export-Truncated` when
    the 50k row cap is hit, so a partial export isn't mistaken for the full history.

- Updated dependencies [14296d8]
  - @hogsend/engine@0.23.1

## 0.23.0

### Minor Changes

- 45f68d3: PostHog identity stitching across web, email, server & Discord.

  Establishes one canonical, ever-identified `distinct_id` per person (the Hogsend
  contact key) and absorbs every other id into it while still anonymous, fixing
  the one-email-many-persons fragmentation.

  - `@hogsend/core`: provider-neutral `mergeIdentities` + `identityMerge`
    capability on the `AnalyticsProvider` contract (both optional; `distinctId` is
    the surviving/canonical id, `alias` the absorbed anonymous one).
  - `@hogsend/plugin-posthog`: `mergeIdentities` via native `client.alias` in the
    correct (PostHog docs) direction, fire-and-forget.
  - `@hogsend/engine`: `mergeAnalyticsIdentities` helper + two resolver emission
    points (collide-merge + key-flip) with identified-key filtering and
    idempotency so a retry never re-aliases; `/v1/events` `anonymousId` threading
    so the contact key can equal the browser anon id (zero-merge); identity-bearing
    tracked links (`link.clicked` event, scoped tokens, server-side alias at
    `/v1/t/identify`) with referral links token-less by default (anti-hijack).
  - `@hogsend/client`: optional `anonymousId` on event/contact inputs.
  - `@hogsend/plugin-discord`: `/link` contact-merge propagates a PostHog merge via
    the shared identity service.

  Additive and off by default; no forced migration. The other engine-line packages
  ride the same minor to keep the version line uniform.

### Patch Changes

- Updated dependencies [45f68d3]
  - @hogsend/engine@0.23.0

## 0.22.0

### Minor Changes

- 4a742dd: feat(discord): inbound Gateway connector + outbound destination + in-Discord email linking

  Adds `@hogsend/plugin-discord` — both faces of one integration under
  `meta.id = "discord"`, plus the engine connector subsystem it rides on.

  - **Inbound** — a `transport: "gateway"` connector. A separate long-lived
    Gateway worker (`@hogsend/plugin-discord/gateway`, its own process) dials
    Discord and POSTs raw dispatches to `POST /v1/connectors/discord/ingress`
    (header `x-hogsend-ingress-secret`, env `CONNECTOR_INGRESS_SECRET`, ≥32 chars,
    fail-closed). The server-side transform emits `discord.message_sent`,
    `discord.reaction_added`, `discord.member_joined`, and
    `discord.presence_active` into `ingestEvent` — stored in `user_events` and
    upserted onto a contact. Bot/webhook/system messages and offline/absent
    presence are dropped; each event carries a deterministic `idempotencyKey`.
  - **Identity** — `contacts.discord_id` is a new indexed merge key (a 4th
    identity Kind, with a partial unique index; migration ships in `@hogsend/db`).
    `contacts.properties.discord` carries `id` and derived first-party `last_seen`
    always, plus observed `username`/`global_name`/`avatar`/`joined_at`/`roles`
    (deep-merged one level, non-clobbering; `null` is never written).
  - **In-Discord linking** — `/link` opens an email modal; a valid address mails a
    6-digit single-use code via a transactional template (15-min TTL, bound to the
    invoking Discord user, hashed at rest, rate limited 5/user + 3/email per
    15 min). An "Enter code" button opens a code modal that redeems it and resolves
    the contact via an ephemeral Components-V2 card. `/verify <code>` is the typed
    fallback. Every interaction is ed25519-verified (native `node:crypto`) with a
    ±300s timestamp replay window. A new `connector_link_codes` table backs the
    codes.
  - **Outbound** — `discordDestination` posts one Discord-markdown line per
    lifecycle event to a channel on the durable outbound spine. Wire resolution
    prefers the no-bot-token incoming webhook (`config.webhookUrl`, accepts 204),
    falling back to bot-REST (`config.channelId` + `endpoint.secret`).
  - **Routes** — the engine adds `/v1/connectors/discord/{ingress,interactions,
oauth/callback}` (per-IP rate-limited at 60/min except `/ingress` and
    `/interactions`, which are gated by the ingress secret and ed25519+replay
    respectively). `@hogsend/cli` gains a `connect discord` flow; `@hogsend/studio`
    gains a Discord integration view.

  The package is consumer-mounted (the engine ships no Discord code; wire it with
  `createDiscordConnector` + `createHogsendClient`, and run the Gateway worker as a
  separate process). The one-click `hogsend connect discord` install / OAuth
  member-link is not wired in the dogfood consumer yet (the consumer-mounted
  `secrets`/`wire` admin routes are unmounted), so that CLI path 404s today — the
  env-only inbound path and the modal `/link` are the live identity paths.

  First npm publish of `@hogsend/plugin-discord` is MANUAL — CI cannot create a
  brand-new `@hogsend/*` package.

  `contacts.discord_id` (and `connector_link_codes`) are schema changes — run
  `db:migrate` before deploying.

### Patch Changes

- Updated dependencies [4a742dd]
- Updated dependencies [4a742dd]
  - @hogsend/engine@0.22.0
