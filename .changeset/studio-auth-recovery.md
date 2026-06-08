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

feat: secure Studio auth recovery — CLI primitive, first-run setup token, self-service reset

Closes the first-run land-grab on the Studio admin and adds two recovery paths,
modelled on how PostHog/GitLab/Rails (shell management commands) and Supabase
(env-gated dashboard + email reset) ship admin recovery. No network-exposed
unauthenticated admin create/reset is introduced.

Engine (`@hogsend/engine`):

- **First-admin setup token** (`lib/setup-token.ts`, new exports
  `resolveSetupToken`, `logSetupTokenOnFirstBoot`, `resetSetupToken`,
  `timingSafeEqualStr`). The `POST /api/auth/sign-up/*` route now requires a
  setup token on the very first user create — read from the
  `x-hogsend-setup-token` header (kept out of better-auth's body schema) and
  compared in constant time. The token is operator-supplied via
  `STUDIO_SETUP_TOKEN`, else auto-generated and printed ONCE to the server log on
  first boot; it is never returned over HTTP. Once any user exists, sign-up is
  closed outright (403). `GET /v1/auth/status` returns only `{ needsSetup }`.
- **Self-service password reset** (`lib/reset-email.ts`, new export
  `sendResetPasswordEmail`; `lib/auth.ts` new `SendResetPasswordFn`). Wires
  better-auth's `request-password-reset`/`reset-password` to the engine mailer
  with a dependency-free, self-contained reset email (no consumer template
  required). Tokens are single-use, 15-minute TTL, constant-time compared
  (better-auth internals); a reset revokes existing sessions. Delivery failures
  resolve silently to preserve better-auth's neutral, no-enumeration response and
  never log the reset URL/token.
- New env: `STUDIO_SETUP_TOKEN`, `BETTER_AUTH_TRUSTED_ORIGINS` (so a remotely
  served Studio origin can reach the auth endpoints).

CLI (`@hogsend/cli`):

- **`hogsend studio admin <create|reset|list>`** — a shell-gated recovery
  primitive (no HTTP, no running API). Gated by holding `DATABASE_URL` +
  `BETTER_AUTH_SECRET`. Every password write goes through better-auth's server
  API (scrypt) — never raw SQL, never plaintext at rest, never logged. `list`
  selects only non-secret columns.

Studio (`@hogsend/studio`): the create-admin form requires the setup token; a
"Forgot password?" flow requests a reset link and a reset card consumes the
`?token=` from the link (stripped from the URL bar after capture).

The rest of the engine-line packages bump in lockstep to keep the version line
uniform (release-doctor invariant); they carry no functional change here.
