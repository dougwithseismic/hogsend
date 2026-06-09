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

feat: secure Studio auth — close public sign-up, CLI-first + env-bootstrap first admin, self-service reset

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
