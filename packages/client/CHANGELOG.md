# @hogsend/client

## 0.30.0

### Minor Changes

- e5f720e: feat(plugin-discord): adopt the cold-connect link-confirm flow (drop the typed-code /verify)

  Refactors `@hogsend/plugin-discord` onto the engine `createColdConnect()` primitive so Discord linking matches Telegram: `/link <email>` → emailed one-click confirm LINK → click → the engine-served connect page binds `discord_id` + email onto one contact + client-identifies. **`/verify` and the typed-code path are removed.**

  - **`@hogsend/plugin-discord`** — `InteractionDeps` is reworked (breaking): the code-flow callbacks (`mintCode`, `sendLinkCode`, `redeemCode`, `recordVerifyAttempt`) are dropped in favour of a single consumer-supplied **`requestConfirm({ discordUserId, email }) → { ok } | { ok: false, reason }`** that mints a server-sealed cold-connect token and emails the confirm link (the token never reaches the handler). The Enter-code component/modal, the `/verify` slash command, and the `CODE_MODAL`/`ENTER_CODE_BUTTON` custom-ids are deleted; `CustomIds` is now just `{ EMAIL_MODAL }`. The mint throttle moved entirely into `mintConfirm` (Redis-INCR, fail-closed). New export: `RequestConfirmResult`.
  - **`member_link` OAuth path is preserved** — its `resolveContact` (which runs `linkContact` + role-grant + the `discord.linked` emit for the operator/known-contact web-bind) is kept and is used ONLY by the OAuth branch, not the `/link` interactions path. Both bind paths stay at parity: `/link` grants the role via the cold-connect `afterBind` + emits via the exchange's `ingestEvent`; the OAuth branch keeps doing it via `resolveContact`.
  - **`apps/api`** is the in-monorepo reference consumer: it constructs `discordColdConnect = createColdConnect({ identityKind: "discordId", platformKey: id => id, buildIngest: scalar discordId, … })`, wires `requestConfirm` to `mintConfirm` + the transactional confirm email, and mounts the routes via the array form of `CreateAppOptions.routes`. The now-orphaned `transactional/discord-link-code` template is removed.

  The remaining engine-line packages are version-only bumps to keep the engine release line uniform.

## 0.29.0

### Minor Changes

- bbfd270: feat(engine): createColdConnect() — a reusable cold-connect primitive (generalizes the Telegram email-link flow)

  Extracts the Telegram cold-connect flow (`/link <email>` → emailed confirm link → click → server-sealed bind → client-side `posthog.identify`) into a channel-agnostic engine primitive so Discord, Telegram, and future connectors share one mechanism.

  - **`@hogsend/engine`**: new `createColdConnect({ connectorId, identityKind, platformKey, linkedEvent, identifyPropKey, buildIngest, branding, ttlSeconds?, throttle?, afterBind? })` → `{ mintConfirm, confirmUrl, routes }`. The factory owns the sealed-token store (Redis, `connectorId` sealed in the value), the connect page, and the `peek → ingestEvent → consume` exchange. Security invariants baked in: the bind runs only on a human POST (never a GET prefetch); the exchange body is `{tok}`-only (ids come solely from the sealed token — no graft); single-use peek-then-consume (a webhook/retry can't burn the link), and the token is consumed even if `afterBind` throws (at-least-once, idempotent-required); a fail-closed Redis-INCR mint throttle; cross-connector token isolation (basePath + idempotency key + a `binding.connectorId === connectorId` assert, 410 on mismatch). The exchange uses `ingestEvent` (folds the platform key + email onto one contact and routes the welcome journey) and returns the canonical `contactKey`, which the page hands to `posthog.identify` — keyed to the server-proven id, never a client-supplied one.
  - **`CreateAppOptions.routes`** now accepts a single fn **or an array** of route fns, so a consumer can mount `[existingRoutes, coldConnect.routes]` without clobbering.
  - **`@hogsend/plugin-telegram`**: refactored onto the primitive (`telegramColdConnect = createColdConnect(...)`); the bespoke `telegram-connect.ts` page/exchange and the confirm-token family in `link.ts` are removed (the `/start` deep-link path stays). The connect basePath is unchanged (`/connect/telegram`), so confirmation emails in flight keep resolving.
  - **`apps/docs`**: the marketing PostHog init now sets `cross_subdomain_cookie: true` so a **consented** visitor's distinct_id is written to a `.hogsend.com` cookie — letting a cold-connect connect page (served off the API host) read their existing id and fold prior browsing into the proven identity. Pre-consent behaviour (memory-only, no cookie) is unchanged.

  The remaining engine-line packages are version-only bumps to keep the engine release line uniform.

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

## 0.26.0

### Minor Changes

- 78c9ef6: feat(connectors): connect-DX polish + multi-bot-shaped readiness

  - **`@hogsend/engine`**: the connect-info `ingressSecretConfigured` field is renamed `legacyIngressSecretConfigured` (deprecated, kept one minor) — readiness is now driven off `workerOnline` (the owned heartbeat), since the inline runtime never uses the ingress secret. The connector runtime also logs a loud, actionable error when a configured runtime can't acquire its lease for ~30s (Redis unreachable or contended) instead of silently never connecting (which previously mis-read as "intents not enabled").
  - **`@hogsend/plugin-discord`**: the gateway runtime auto-registers the `/link` + `/verify` slash commands (globally + idempotently) when the socket comes up — no more separate `discord:register-commands` step, and it self-heals after a token rotation. Exports `registerSlashCommands` + `LINK_VERIFY_COMMANDS`.
  - **`@hogsend/cli`**: `hogsend connect discord --status` drops the stale ingress-secret line for `worker online`, adds a worker-offline hint, and returns a 404-specific error when the consumer `/secrets`+`/wire` routes aren't mounted.
  - **`@hogsend/studio`**: the integrations card drops the ingress-secret signal, adds a worker-offline hint panel, and renders the rich gateway card for ANY `transport === "gateway"` connector (not the literal `"discord"` id) — so a second Discord bot would render its own card for free (the seam stays many-bots-shaped).

  The remaining engine-line packages are version-only bumps to keep the engine release line uniform (the scaffold pins `^ENGINE_VERSION`).

## 0.25.0

### Minor Changes

- 9a87335: feat(engine): the connector runtime — a worker-hosted, leader-leased inbound gateway socket plus a journey-callable outbound action API.

  - **`@hogsend/engine`**: gateway-transport connectors (Discord) now run their long-lived socket **inline inside the Hatchet worker** — no separate service, no `CONNECTOR_INGRESS_SECRET`. A Redis leader lease guarantees exactly one replica holds the socket per bot token, with bounded automatic failover; dispatches feed `transform`→`ingest` in-process, and only the lease-holder writes the (now connector-neutral) liveness heartbeat Studio reads, so "Worker Online / Bot Installed" reflects OWNED liveness a stray process cannot fake. Activation is automatic when a gateway connector + its bot token are present (`ENABLE_CONNECTOR_RUNTIMES`, `CONNECTOR_RUNTIME_HOST=worker` by default). Wire it with `createWorker({ connectorRuntimes: { discord: createDiscordRuntime } })`. The seam is connector-agnostic — a second connector (Slack, …) implements only `defineConnector` + a `ConnectorRuntime` factory and reuses lease election, the heartbeat, and the admin projection unchanged.
  - **`@hogsend/engine`**: outbound actions are a separate, socket-free face — `sendConnectorAction({ connectorId, action, args })` (a standalone import, not on `ctx`) invokes registered `defineConnectorAction`s, independent of the inbound socket (a deployment with the gateway off can still send).
  - **`@hogsend/plugin-discord`**: ships `createDiscordRuntime` (the gateway runtime factory) and `discordActions` (`sendChannelMessage`, `broadcastToChannel`, `mentionMembers`, `mentionRole`, `dmMember`); register the actions via `createHogsendClient({ connectorActions: discordActions })`. The standalone `discord-worker` entry remains as an advanced escape hatch (`CONNECTOR_RUNTIME_HOST=standalone`).

  Additive and opt-in. The remaining engine-line packages are version-only bumps to keep the engine release line uniform (the scaffold pins `^ENGINE_VERSION`).

## 0.24.0

### Minor Changes

- a637866: feat: AI agent integration — recent-events history read, AI SDK journeys, and Eve durable churn-save

  - **`@hogsend/core` / `@hogsend/engine`**: add `ctx.history.events({ userId, limit?, within? })` — a generic newest-first read of a user's recent events (with `RecentEventsOptions` / `RecentEvent` types), the foundation for assembling agent context bundles.
  - **`@hogsend/engine`**: the webhook-source route now resolves a source's auth secret from `process.env[auth.envKey]` when the engine's validated env doesn't declare that key, so a consumer-defined `signature`/`match` webhook source can bring its own secret. Behavior is unchanged for engine presets and stays fail-closed (an unset `signature` secret is still a 401) — this fixes BYO signature sources (e.g. an Eve HITL callback) that previously could not resolve their secret.
  - **`create-hogsend`**: a freshly scaffolded app now ships a working Tier-1 AI onboarding journey (`src/agents/` + `ctx.history.events()`-backed user context) and gains `ai` + `@ai-sdk/anthropic`; new docs cover the three AI SDK integration tiers (inline, tools, and Eve durable HITL).

  The remaining engine-line packages are version-only bumps to keep the engine release line uniform (the scaffold pins `^ENGINE_VERSION`).

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

## 0.19.0

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

## 0.18.0

### Minor Changes

- 6434a65: Close the analytics identity loop: `POST /v1/events` now returns `contactKey` —
  the contact's canonical key (`external_id ?? anonymous_id ?? id`), the same key
  outbound destinations emit as `userId` and `hs_t` identity tokens resolve to —
  so a consumer site can `identify()` its analytics session against the contact
  without any PII round-trip.

  To make that key safe to circulate, identity resolution now round-trips it:
  `findByKey` falls back to the contact row id for external-kind lookups (an
  email-only contact's canonical key IS its row id), and a merge records the
  email-only loser's row-id key as an external alias — so a key that left the
  system (Hatchet payloads, destination `userId`s, `hs_t` stitches, forwarded
  PostHog webhooks) always resolves back to the same live contact instead of
  minting a duplicate. (The full engine line rides together per release
  discipline.)

## 0.17.1

### Patch Changes

- e459fb5: Fix the Studio password-reset link landing on the login card instead of the reset form. The engine's bare `/studio` → `/studio/` redirect dropped the query string, losing better-auth's `?token=…`; the redirect now preserves it, and the Studio's reset redirect targets `/studio/` directly so the link skips the hop entirely. (The full engine line rides together per release discipline.)

## 0.17.0

### Minor Changes

- a3e15c4: Keep the engine version line uniform for the Studio crimzon design-system release — all engine-line packages move to the same minor together, and the scaffold republishes with the matching `ENGINE_VERSION` pins.

## 0.16.0

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

## 0.15.0

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

## 0.14.0

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

## 0.13.2

### Patch Changes

- f6ae542: Claim the bare `hogsend` npm name: a new alias package whose bin forwards to `@hogsend/cli`, so `npx hogsend` / `pnpm dlx hogsend upgrade` work without the scope. `@hogsend/cli` now exports `./bin` (and `./package.json`) to support it.

## 0.13.1

### Patch Changes

- d632763: Allow a display name in the configured from address: `RESEND_FROM_EMAIL` and `EMAIL_FROM` now accept `Doug at Hogsend <doug@hogsend.com>` as well as a bare address. Sending-domain derivation (test mode, domain status) parses either form.

## 0.13.0

### Minor Changes

- 4d605bd: First-run experience hardening, found by dogfooding a fresh create-hogsend app:

  - `/v1/health` gains a non-breaking `activity` section (24h failed/completed journeys, failed/sent emails) so silent failures are visible; `check-alerts` now surfaces recent failures even with zero alert rules configured; journey run failures get a proper error log line.
  - First boot with an empty `api_keys` table mints an ingest-scoped key and prints it once to the deploy log (opt out with `HOGSEND_BOOTSTRAP_API_KEY=false`) — a template deploy now has a working data-plane credential out of the box.
  - New `hogsend hatchet token` CLI command mints a Hatchet client token headlessly (register/login → tenant → token) against a hatchet-lite instance.
  - Restricted email-provider keys (can send, can't read domains) now warn once with a clear explanation that `HOGSEND_TEST_MODE=auto` is inert, then back off for 6h instead of warning every 40s; a real fetched domain status is never overwritten by the fail-open path.
  - Worker startup logs the registered journey ids (not just a count) so a stale dev worker is visible at a glance.
  - Engine logger's default service name no longer leaks "growthhog-api" into consumer apps.
  - New index on `journey_states.updated_at` (migration 0022) backing the health activity counts.

## 0.12.2

### Patch Changes

- d9a1a47: Keep the engine version line uniform for the plugin-resend tag-sanitization patch — all engine-line packages move to the same patch version together.

## 0.12.1

### Patch Changes

- ee5a10f: fix: surface provider domains-API failures as 502 with the provider message

  `GET/POST /v1/admin/domain` (and `/verify`) let a provider error — e.g. a
  send-only restricted Resend key that cannot read the domains API — escape as
  an opaque 500. The routes now catch provider failures and return
  `502 { error: "domains request to provider \"resend\" failed: …" }`, which
  `hogsend domain status` and Studio's Setup view render directly, so a
  restricted key tells you exactly what to fix (use a full-access key) instead
  of "Internal Server Error". Found by the live test-mode smoke; the send path
  was already fail-open and unaffected.

  The rest of the engine-line packages bump in lockstep to keep the version
  line uniform; they carry no functional change here.

## 0.12.0

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

## 0.11.0

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

## 0.10.0

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

## 0.9.0

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

## 0.8.0

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

## 0.7.0

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

### Patch Changes

- Updated dependencies
  - @hogsend/email@0.7.0
