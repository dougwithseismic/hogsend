# @hogsend/cli

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

### Patch Changes

- Updated dependencies [39db4fa]
  - @hogsend/engine@0.11.0
  - @hogsend/db@0.11.0

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

## 0.2.3

### Patch Changes

- cd86e13: Refresh the `hogsend-authoring-buckets` skill (SKILL.md + all reference files) for the bucket lifecycle API: typed `bucket.entered` / `bucket.left` refs, colocated `bucket.on("enter" | "leave" | "dwell")` reactions, `dwell` over the existing population, and `count`/`has`/`members`/`membersIterator` access. The `BucketId` union + `bucketEntered`/`bucketLeft` helpers are marked deprecated. Republishes so `hogsend skills add` / `hogsend upgrade` pull the updated content.

## 0.2.2

### Patch Changes

- f4e604e: Ship a new `hogsend-extending` skill: how to extend a Hogsend app beyond
  journeys/emails/buckets — swap the email or analytics provider behind its
  engine-owned contract (`EmailProvider` / `PostHogService`), wire an outbound
  integration (Slack, a CRM, Stripe) as plain code called from a journey, and when
  to publish a `@hogsend/plugin-*` package. The new skill also rides the
  `create-hogsend` template (synced from `packages/cli/skills/`), so fresh
  scaffolds ship it.

## 0.2.1

### Patch Changes

- 0db58c6: Refresh the bundled agent skills (`hogsend-authoring-journeys`) to teach `ctx.waitForEvent`, and to fill in the previously-undocumented `ctx.sleepUntil`/`ctx.when` primitives and the `"exited"` journey state.

## 0.2.0

### Minor Changes

- 8a6aa5f: Ship Claude Code agent skills with scaffolded apps, plus a one-step engine + skills upgrade path.

  - **Exhaustive skill set** (8 skills) authored once in `packages/cli/skills/` — the single source `@hogsend/cli` ships and `hogsend skills add` installs: `hogsend-cli`, `hogsend-authoring-journeys`, `hogsend-authoring-emails` (incl. tracking + unsubscribe), `hogsend-authoring-buckets`, `hogsend-conditions`, `hogsend-webhooks-and-workflows`, `hogsend-database`, `hogsend-deploy`. Each is a lean `SKILL.md` with progressive-disclosure `references/`.
  - **`create-hogsend`** now prompts to include skills (default yes; `--skills` / `--no-skills`) and emits committed `.claude/skills/` + a tailored `CLAUDE.md` (app-name + engine-version substituted) that routes agents to the right skill. Skills are build-copied into the template by a new `sync-skills` prebuild, so the scaffold and the CLI never drift.
  - **`hogsend upgrade`** — new CLI command that bumps every `@hogsend/*` dependency to latest (or `--to`) and refreshes the vendored skills in one step. A provenance stamp + a `hogsend doctor` nudge surface when installed skills fall behind the latest CLI.
  - `hogsend skills add` gains `--all` and documents `--force` as the post-upgrade refresh.

## 0.1.0

### Minor Changes

- a80d952: Consolidated, interactive `hogsend` CLI. Replaces the prior eject-only tool with a full operator + agent surface: `doctor`, `journeys`, `contacts`, `stats`, `events`, `setup`, `skills`, `eject`, and `patch`. Human runs get `@clack/prompts` interactive flows; every command supports `--json` for agent/automation use. Data commands wrap the engine's `/v1/admin/*` routes over HTTP (`--url` / `HOGSEND_API_URL` / `.env`, `--admin-key` / `ADMIN_API_KEY`). `skills add` installs the bundled `hogsend-cli` Claude skill into a project.
