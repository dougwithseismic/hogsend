# @hogsend/plugin-postmark

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

### Patch Changes

- Updated dependencies [b84092d]
  - @hogsend/core@0.12.0

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
  - @hogsend/core@0.11.0

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

### Patch Changes

- Updated dependencies [4153964]
  - @hogsend/core@0.10.0
