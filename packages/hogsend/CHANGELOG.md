# hogsend

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
  - @hogsend/cli@0.28.0

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
  - @hogsend/cli@0.27.0

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
  - @hogsend/cli@0.26.0

## 0.25.0

### Minor Changes

- 9a87335: feat(engine): the connector runtime — a worker-hosted, leader-leased inbound gateway socket plus a journey-callable outbound action API.

  - **`@hogsend/engine`**: gateway-transport connectors (Discord) now run their long-lived socket **inline inside the Hatchet worker** — no separate service, no `CONNECTOR_INGRESS_SECRET`. A Redis leader lease guarantees exactly one replica holds the socket per bot token, with bounded automatic failover; dispatches feed `transform`→`ingest` in-process, and only the lease-holder writes the (now connector-neutral) liveness heartbeat Studio reads, so "Worker Online / Bot Installed" reflects OWNED liveness a stray process cannot fake. Activation is automatic when a gateway connector + its bot token are present (`ENABLE_CONNECTOR_RUNTIMES`, `CONNECTOR_RUNTIME_HOST=worker` by default). Wire it with `createWorker({ connectorRuntimes: { discord: createDiscordRuntime } })`. The seam is connector-agnostic — a second connector (Slack, …) implements only `defineConnector` + a `ConnectorRuntime` factory and reuses lease election, the heartbeat, and the admin projection unchanged.
  - **`@hogsend/engine`**: outbound actions are a separate, socket-free face — `sendConnectorAction({ connectorId, action, args })` (a standalone import, not on `ctx`) invokes registered `defineConnectorAction`s, independent of the inbound socket (a deployment with the gateway off can still send).
  - **`@hogsend/plugin-discord`**: ships `createDiscordRuntime` (the gateway runtime factory) and `discordActions` (`sendChannelMessage`, `broadcastToChannel`, `mentionMembers`, `mentionRole`, `dmMember`); register the actions via `createHogsendClient({ connectorActions: discordActions })`. The standalone `discord-worker` entry remains as an advanced escape hatch (`CONNECTOR_RUNTIME_HOST=standalone`).

  Additive and opt-in. The remaining engine-line packages are version-only bumps to keep the engine release line uniform (the scaffold pins `^ENGINE_VERSION`).

### Patch Changes

- Updated dependencies [9a87335]
  - @hogsend/cli@0.25.0

## 0.24.0

### Minor Changes

- a637866: feat: AI agent integration — recent-events history read, AI SDK journeys, and Eve durable churn-save

  - **`@hogsend/core` / `@hogsend/engine`**: add `ctx.history.events({ userId, limit?, within? })` — a generic newest-first read of a user's recent events (with `RecentEventsOptions` / `RecentEvent` types), the foundation for assembling agent context bundles.
  - **`@hogsend/engine`**: the webhook-source route now resolves a source's auth secret from `process.env[auth.envKey]` when the engine's validated env doesn't declare that key, so a consumer-defined `signature`/`match` webhook source can bring its own secret. Behavior is unchanged for engine presets and stays fail-closed (an unset `signature` secret is still a 401) — this fixes BYO signature sources (e.g. an Eve HITL callback) that previously could not resolve their secret.
  - **`create-hogsend`**: a freshly scaffolded app now ships a working Tier-1 AI onboarding journey (`src/agents/` + `ctx.history.events()`-backed user context) and gains `ai` + `@ai-sdk/anthropic`; new docs cover the three AI SDK integration tiers (inline, tools, and Eve durable HITL).

  The remaining engine-line packages are version-only bumps to keep the engine release line uniform (the scaffold pins `^ENGINE_VERSION`).

### Patch Changes

- Updated dependencies [a637866]
  - @hogsend/cli@0.24.0

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
  - @hogsend/cli@0.23.1

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
  - @hogsend/cli@0.23.0

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

- Updated dependencies [4a742dd]
- Updated dependencies [4a742dd]
  - @hogsend/cli@0.22.0

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

- Updated dependencies [6fe64f6]
  - @hogsend/cli@0.21.1

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

### Patch Changes

- Updated dependencies [ccc89ed]
  - @hogsend/cli@0.21.0

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

### Patch Changes

- Updated dependencies [e44d400]
- Updated dependencies [9710ced]
  - @hogsend/cli@0.20.0

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

### Patch Changes

- Updated dependencies [bbc37e7]
  - @hogsend/cli@0.19.0

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

### Patch Changes

- Updated dependencies [6434a65]
  - @hogsend/cli@0.18.0

## 0.17.1

### Patch Changes

- e459fb5: Fix the Studio password-reset link landing on the login card instead of the reset form. The engine's bare `/studio` → `/studio/` redirect dropped the query string, losing better-auth's `?token=…`; the redirect now preserves it, and the Studio's reset redirect targets `/studio/` directly so the link skips the hop entirely. (The full engine line rides together per release discipline.)
- Updated dependencies [e459fb5]
  - @hogsend/cli@0.17.1

## 0.17.0

### Minor Changes

- a3e15c4: Keep the engine version line uniform for the Studio crimzon design-system release — all engine-line packages move to the same minor together, and the scaffold republishes with the matching `ENGINE_VERSION` pins.

### Patch Changes

- Updated dependencies [a3e15c4]
  - @hogsend/cli@0.17.0

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

### Patch Changes

- Updated dependencies [5fdd9fa]
  - @hogsend/cli@0.16.0

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

### Patch Changes

- Updated dependencies [ee3b670]
  - @hogsend/cli@0.15.0

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

### Patch Changes

- Updated dependencies [b644a01]
  - @hogsend/cli@0.14.0

## 0.13.2

### Patch Changes

- f6ae542: Claim the bare `hogsend` npm name: a new alias package whose bin forwards to `@hogsend/cli`, so `npx hogsend` / `pnpm dlx hogsend upgrade` work without the scope. `@hogsend/cli` now exports `./bin` (and `./package.json`) to support it.
- Updated dependencies [f6ae542]
  - @hogsend/cli@0.13.2
