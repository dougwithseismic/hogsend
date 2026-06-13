# create-hogsend

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
