# Studio Auth Recovery — Implementation Spec

Status: implemented
Owner: engine + cli + studio
Branch: `feat/studio-auth-recovery`

> **Model:** CLI-first + boot-time env bootstrap, with public sign-up disabled.
> This document was originally specced around a web **setup token** that gated a
> first-admin create form. That model was **retired** before merge in favor of
> the model below — there is now **no setup token and no web create-admin form**.
> The setup-token history is preserved at the end under "Superseded design" for
> context.

## Why

The Studio admin login had two unsafe gaps and one missing self-service path:

1. **First-run land-grab.** `GET /v1/auth/status` returns `needsSetup: true`
   whenever the `user` table is empty. The Studio used to show a "create admin"
   form that POSTed straight to `POST /api/auth/sign-up/email`. The only gate was
   "block sign-up once **any** user exists." Until that first user existed, **any
   anonymous network visitor who reached the instance first claimed the admin
   account.** On a fresh deploy (Railway, a public URL) this was a race the
   operator could lose.

2. **No recovery path.** If the admin forgot the password (or the operator
   inherited an instance), there was no supported way to reset it — no "forgot
   password" flow and no shell/management command. The only workarounds were raw
   SQL password writes (wrong hash, plaintext risk) or deleting the user row
   (re-opening the land-grab).

3. **No self-service email reset.** `emailAndPassword` was enabled with no
   `sendResetPassword`, so better-auth's `/request-password-reset` endpoint
   hard-errored (`RESET_PASSWORD_DISABLED`).

This is closed with the industry-standard split: **public sign-up is disabled**,
the first admin is created **only from the server** (a shell-gated CLI primitive,
PostHog/GitLab/Rails-style, **or** a boot-time env bootstrap, Supabase-style),
and a **self-service email reset** (better-auth's built-in reset flow, wired to
the engine mailer) is the convenience recovery path.

## The cardinal invariant

> **After this pivot there is NO unauthenticated network path that creates ANY
> user/admin.**

Public sign-up is disabled at the auth layer (`disableSignUp`), so the
now-ungated `POST /api/auth/sign-up/email` rejects with `400
EMAIL_PASSWORD_SIGN_UP_DISABLED` for everyone — and because
`auth.api.signUpEmail` dispatches through that same endpoint handler, the
in-process server API is blocked too. Admins are minted ONLY by:

- the **CLI** (`hogsend studio admin create`), DB-direct, gated by holding
  `DATABASE_URL` + `BETTER_AUTH_SECRET`; and
- the **env bootstrap** (`STUDIO_ADMIN_EMAIL`), boot-time and in-network.

Login (`sign-in/email`) and reset (`request-password-reset` / `reset-password`)
stay fully enabled — `disableSignUp` gates only sign-up.

## Threat model

| Threat | Before | After |
| --- | --- | --- |
| Anonymous visitor claims first admin on a fresh deploy | Open race | **No create endpoint exists.** Public sign-up is disabled; the first admin is minted only by the CLI or the in-network env bootstrap. |
| Operator locked out, forgot password | No path | CLI `hogsend studio admin reset` (DB + secret + shell) and/or self-service email reset. |
| Attacker calls an admin-create/reset HTTP endpoint | n/a | **Doesn't exist.** Create/reset is CLI-only; `POST /sign-up/email` 400s for everyone; the only network write is better-auth's own rate-limited, email-delivered reset. |
| Password stored with wrong/weak hashing or in plaintext | Risk if hand-rolled | **Only** better-auth's server API touches passwords (scrypt via `ctx.password.hash` + the internal adapter). No raw SQL password writes anywhere. |
| Reset token reuse / long-lived token | n/a | Single-use (deleted on consume), short TTL (15 min), constant-time compare (better-auth internal). |
| Secrets leaking to logs | n/a | Passwords are NEVER logged. The ONE intended exception: an **auto-generated** env-bootstrap password is printed once to the server log ("save this, shown once"). An explicitly-set `STUDIO_ADMIN_PASSWORD` is never logged; reset tokens are never logged. |

### Non-negotiables (acceptance gates, not preferences)

1. **No network-exposed unauthenticated admin create/reset.** Create is CLI-only
   (gated by `DATABASE_URL` + `BETTER_AUTH_SECRET` + shell) or the in-network env
   bootstrap. Public sign-up is disabled. The web reset is better-auth's own
   email-delivered flow.
2. **Passwords only via better-auth's server API** (scrypt). Never raw SQL
   password writes; never plaintext at rest.
3. **Never persist a secret to stdout** — except the auto-generated bootstrap
   password, printed once by design (operator-only surface). An explicit
   `STUDIO_ADMIN_PASSWORD` and all reset tokens are never logged.
4. **Reset tokens:** single-use, short TTL, constant-time compare.
5. **Public sign-up stays disabled.** The check lives server-side in
   better-auth, so no client can re-open it.

### Industry reference (we match these norms)

- **PostHog / GitLab / Rails** — admin create/recovery via a shell/management
  command (`rails runner`, `gitlab-rake`, Django `createsuperuser`). Our CLI is
  that shell-gated primitive.
- **Supabase self-hosted** — first admin provisioned from the environment /
  service role, not a public form; user-facing reset is an emailed link. Our env
  bootstrap is the provisioning path; our email reset is the self-service path.

---

## Final model (as shipped)

### 1. Public sign-up disabled

`packages/engine/src/lib/auth.ts` — `disableSignUp: true` in the
`emailAndPassword` block of `betterAuth({...})`. In better-auth 1.6.11 the
`disableSignUp` check lives INSIDE the sign-up endpoint handler (not an HTTP-only
middleware), so it blocks BOTH `POST /api/auth/sign-up/email` (→ 400
`EMAIL_PASSWORD_SIGN_UP_DISABLED`) AND the in-process `auth.api.signUpEmail`.
Login and reset endpoints are untouched.

The IP-keyed sign-up rate-limit and the `app.on(["POST","GET"],
"/api/auth/*", …)` better-auth handler mount stay as belt-and-suspenders.

### 2. Shared admin-create primitive (`createAdminUser`)

`packages/engine/src/lib/create-admin.ts`, exported via the narrow
`@hogsend/engine/create-admin` subpath (module graph touches only better-auth +
`@hogsend/db` — NOT env.ts/Hatchet/Resend). It mints via better-auth's INTERNAL
ADAPTER (scrypt-identical to the running app, and NOT subject to
`disableSignUp`):

1. `const ctx = await auth.$context;`
2. guard `ctx.internalAdapter.findUserByEmail(email)` → throw
   `AdminAlreadyExistsError` (points at `reset`) if present;
3. `const hashed = await ctx.password.hash(password);`
4. `ctx.internalAdapter.createUser({ email, name, emailVerified: true })`
   (operator-minted ⇒ `emailVerified: true`; better-auth lowercases the email);
5. `ctx.internalAdapter.createAccount({ userId, providerId: "credential",
   accountId, password: hashed })`.

This single helper backs BOTH consumers below, so there is exactly one
scrypt-correct implementation.

### 3. CLI: `hogsend studio admin create | reset | list`

`packages/cli/src/commands/studio-admin.ts` + `packages/cli/src/lib/admin-recovery.ts`.
Gated by `DATABASE_URL` + `BETTER_AUTH_SECRET` (whoever can reach the DB and read
the app secret). No HTTP, no running API — it constructs its own better-auth
instance against the DB.

- `create` → the shared `createAdminUser` (internal adapter; NOT
  `auth.api.signUpEmail`, which `disableSignUp` now blocks).
- `reset` → `ctx.password.hash` + `updatePassword`/`createAccount` (mirrors
  better-auth's own `resetPassword`); optionally revokes sessions.
- `list` → plain Drizzle read of non-secret columns only.

**Env resolution** is flags then `process.env` ONLY — there is **no cwd `.env`
read** (consistent with `db:migrate`). The missing-var error tells the operator
to run with env loaded (`dotenvx run -- …`, `railway run …`, or the scaffold's
`pnpm studio:admin`).

### 4. Env bootstrap (`bootstrapAdminFromEnv`)

`packages/engine/src/lib/bootstrap-admin.ts`, called from `apps/api/src/index.ts`
AFTER the schema-check boot guard (it needs `client.db` + `client.auth`). Runs in
the **API** process, not the worker (the worker has no HTTP and shouldn't race
the API on first-admin creation).

Contract (all must hold to mint):

- `STUDIO_ADMIN_EMAIL` is set (unset ⇒ no-op; CLI is then the only path);
- the `user` table has ZERO rows (the same `db.select({ id: user.id })
  .from(user).limit(1)` zero-check the old `/v1/auth/status` used).

Password:

- `STUDIO_ADMIN_PASSWORD` if set — used verbatim, NEVER logged;
- else auto-generate `randomBytes(18).toString("base64url")` (≥ 16 chars) and
  PRINT IT ONCE to the server log, clearly labelled "save this, shown once"
  (the single allowed secret-logging exception). The operator rotates it
  immediately via the retained self-service forgot/reset flow.

Idempotent (only mints on 0 users) and concurrency-safe: two replicas booting on
a fresh DB could both pass the zero-check; the `user.email` unique constraint
makes the loser's `createUser` throw — caught as `AdminAlreadyExistsError` (or a
duplicate-key message) and treated as "already created" (no-op, no log of the
loser's generated password).

Env vars (`packages/engine/src/env.ts`):

- `STUDIO_ADMIN_EMAIL: z.string().email().optional()`
- `STUDIO_ADMIN_PASSWORD: z.string().min(8).optional()`

### 5. Studio (web) — login + forgot + reset only

`packages/studio/src/components/auth/`:

- `auth-forms.tsx` — the setup-mode form is removed; `CredentialsCard` collapses
  to `mode: "login"`; `FormMode` is `"login" | "forgot" | "reset"`. The `signUp`
  import is gone. `ForgotCard` + `ResetCard` + `AuthScreen` routing are retained.
- `auth-gate.tsx` — the `needsSetup` branch renders a **read-only info card** (no
  inputs) that says: "No admin exists yet. Create the first admin from your
  server: run `hogsend studio admin create`, or set `STUDIO_ADMIN_EMAIL` (+
  optional `STUDIO_ADMIN_PASSWORD`) and restart. Then reload." It offers a
  Reload/refetch button and NO way to create a user over the network.
- `auth-client.ts` — the `signUp` export is removed; `signIn`, `signOut`,
  `useSession`, `requestPasswordReset`, `resetPassword` remain.
- `api.ts` — `getAuthStatus()` + `AuthStatus { needsSetup }` are KEPT (the gate
  uses `needsSetup` to choose info-screen vs login).

### 6. Self-service email reset (retained from the original Slice 3)

`createAuth` (`lib/auth.ts`) wires `sendResetPassword` to the engine mailer with
a 15-min single-use token, constant-time compared (better-auth internals), and
`revokeSessionsOnPasswordReset: true`. The engine ships a dependency-free,
self-contained reset email (`lib/reset-email.ts`) so reset works on a bare
instance with zero consumer wiring; a missing provider degrades to a logged
warning (no enumeration, never logs the URL/token), steering the operator to the
CLI `reset`.

---

## What was removed (setup-token teardown)

Every site of the old setup-token / web first-admin gate was removed or
repurposed:

- `packages/engine/src/lib/setup-token.ts` — DELETED (`resolveSetupToken`,
  `logSetupTokenOnFirstBoot`, `resetSetupToken`, `timingSafeEqualStr`, latches).
- `packages/engine/src/app.ts` — the closed-signup + first-run land-grab token
  gate on `POST /api/auth/sign-up/*` REMOVED, along with the setup-token import
  and the `logSetupTokenOnFirstBoot` call from `GET /v1/auth/status` (the route
  and `needsSetup` payload are KEPT for the Studio info screen). The IP sign-up
  rate-limit and the better-auth handler mount are KEPT.
- `packages/engine/src/index.ts` — the setup-token barrel re-exports REMOVED.
- `packages/engine/src/env.ts` — `STUDIO_SETUP_TOKEN` REMOVED.
- `packages/studio/...` — the setup-mode form, the `x-hogsend-setup-token`
  header, and the `signUp` export REMOVED.
- Tests — the setup-token suite was replaced with sign-up-disabled +
  env-bootstrap assertions; the new invariant asserted is that `POST
  /api/auth/sign-up/email` 400s (`EMAIL_PASSWORD_SIGN_UP_DISABLED`) for ANYONE.

---

## Scaffold + docs wiring

- `packages/create-hogsend/template/env.example` — `STUDIO_ADMIN_EMAIL` /
  `STUDIO_ADMIN_PASSWORD` (commented) with a "first-admin bootstrap (or use
  `hogsend studio admin create`)" note. No `STUDIO_SETUP_TOKEN` line.
- `packages/create-hogsend/template/_package.json` — a `studio:admin` script:
  `node --env-file=.env node_modules/.bin/hogsend studio admin create` (loads
  `.env` the same way `dev` does).
- `packages/create-hogsend/template/scripts/bootstrap.ts` — an interactive,
  skippable "create your first Studio admin" step after migrations (no-op in
  CI / non-TTY and when `STUDIO_ADMIN_EMAIL` is already set), plus a next-steps
  line pointing at `pnpm studio:admin`.
- Docs — `apps/docs/content/docs/operating/studio.mdx`,
  `apps/docs/content/docs/cli/studio.mdx`,
  `apps/docs/content/docs/getting-started/configuration.mdx` updated to the new
  model (no setup token; first admin via CLI locally or env bootstrap on deploy;
  web is login + forgot/reset only) with a "Connecting the CLI" table.
- `packages/cli/skills/hogsend-cli/SKILL.md` — the `studio admin` section +
  closed-sign-up / env-bootstrap note.

---

## Force-password-change on first login (documented follow-up)

NOT shipped in this slice. better-auth 1.6.11 has no native
`mustChangePassword`/`forcePasswordChange` flag (grep over its dist returns
nothing). A DB-column approach would require a NEW engine-track migration
(`user.must_change_password`), setting it on bootstrap/CLI-minted admins, a
login-flow gate that blocks the app shell until rotation, and clearing it on
reset. The engine track GATES boot, so that is a real migration with
deploy-ordering implications — too much for this pivot.

**Posture for now:** the auto-generated bootstrap password IS the one-time
credential — printed once to the server log, with the log line + docs + Studio
info screen instructing the operator to rotate it immediately via the retained
self-service forgot/reset flow (which revokes sessions on reset). That gives the
"first password is temporary" property without a schema change. Track the hard
force-change-column work as a separate issue.

---

## Test plan (as implemented)

A migrated test DB exists at `postgresql://test:test@localhost:5434/test`. Run
suites with that as `DATABASE_URL`. Do **not** edit `vitest.config.ts`. If the DB
is absent, report `infra-error`.

- **Sign-up disabled:** `POST /api/auth/sign-up/email` → 400
  `EMAIL_PASSWORD_SIGN_UP_DISABLED` for everyone (fresh DB and after a user
  exists). `auth.api.signUpEmail` is blocked the same way.
- **CLI create:** `studio admin create` against an empty `user` table creates a
  user; a subsequent `sign-in/email` with that password succeeds (proves correct
  scrypt hashing end-to-end). A duplicate email fails with the "use reset"
  message.
- **CLI reset:** changes the password (old fails, new succeeds); sessions
  revoked unless `--no-revoke`; the stored hash is never plaintext.
- **CLI list:** prints `{ id, email, name, createdAt }` only — no hash column.
- **Env bootstrap:** on a zero-user DB with `STUDIO_ADMIN_EMAIL` set, boot mints
  the admin; with `STUDIO_ADMIN_PASSWORD` set it is used and never logged; with
  it unset a generated password is printed once. On a non-empty DB it is a no-op.
  A concurrent unique-violation is treated as already-created.
- **Email reset:** request for a known email fires `sendResetPassword` once with
  a token URL; an unknown email returns the same neutral response and does NOT
  fire (no enumeration); reset with the captured token sets the password, revokes
  sessions, and the token is single-use; a no-provider request returns neutral,
  warns (pointing at the CLI), and never logs the URL/token.
- `pnpm check-types` green; `pnpm biome check --write` on every touched file.

---

## Superseded design (setup token — for history only)

The original spec closed the land-grab with a **setup token**: a fresh deploy
would auto-generate a token (or read `STUDIO_SETUP_TOKEN`), print it once to the
server log, and require it as an `x-hogsend-setup-token` header on the first
`POST /api/auth/sign-up/*` (constant-time compared, server-side). The Studio
showed a create-admin form with a "Setup token" field; once any user existed
sign-up was closed with a 403.

**Why it was retired:** the token model still kept an unauthenticated network
create path open (the first sign-up), relying on a shared secret in a log line —
a weaker invariant than "no create endpoint exists at all." Disabling public
sign-up outright and minting the first admin only from the server (CLI or env
bootstrap) is a strictly stronger posture, removes a whole class of edge cases
(token rotation on restart, header threading through the better-auth client, the
brute-force throttle that had to sit ahead of the gate), and matches how
PostHog/GitLab/Supabase actually provision the first admin. The CLI primitive and
the self-service email reset — the genuinely valuable parts of the original spec
— are retained unchanged.
