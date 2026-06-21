# @hogsend/plugin-discord

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
