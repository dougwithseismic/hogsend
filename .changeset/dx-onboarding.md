---
"@hogsend/engine": minor
"@hogsend/cli": minor
"@hogsend/db": minor
"@hogsend/core": minor
"@hogsend/client": minor
"@hogsend/email": minor
"@hogsend/plugin-posthog": minor
"@hogsend/plugin-resend": minor
"@hogsend/plugin-postmark": minor
"@hogsend/studio": minor
"create-hogsend": minor
---

feat: zero-to-verified-domain onboarding — create --domain, hogsend dev, domain verification, provider-neutral test mode, agent skills

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
