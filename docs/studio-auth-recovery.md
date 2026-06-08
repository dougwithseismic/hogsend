# Studio Auth Recovery — Implementation Spec

Status: proposed
Owner: engine + cli + studio
Branch: `feat/studio-auth-recovery`

## Why

The Studio admin login has two unsafe gaps and one missing self-service path:

1. **First-run land-grab.** `GET /v1/auth/status` returns `needsSetup: true`
   whenever the `user` table is empty. The Studio then shows a "create admin"
   form that POSTs straight to `POST /api/auth/sign-up/email`. The only gate
   (`packages/engine/src/app.ts`) is "block sign-up once **any** user exists."
   Until that first user exists, **any anonymous network visitor who reaches the
   instance first claims the admin account.** On a fresh deploy (Railway, a
   public URL) this is a race the operator can lose.

2. **No recovery path.** If the admin forgets the password (or the operator
   inherits an instance), there is no supported way to reset it. There is no
   "forgot password" flow, and no shell/management command. The only workarounds
   are raw SQL password writes (wrong hash, plaintext risk) or deleting the user
   row (re-opens the land-grab).

3. **No self-service email reset.** `emailAndPassword` is enabled with no
   `sendResetPassword`, so better-auth's `/request-password-reset` endpoint
   hard-errors (`RESET_PASSWORD_DISABLED`, see
   `node_modules/better-auth/dist/api/routes/password.mjs:42`).

This spec closes all three with the industry-standard split: **a shell-gated CLI
primitive** (PostHog/GitLab/Rails-style management command), **a setup token**
that closes the first-run land-grab (Supabase-style env/log gating), and a
**self-service email reset** (better-auth's built-in reset flow, wired to the
engine mailer).

## Threat model (read first — security is the point)

| Threat | Today | After this work |
| --- | --- | --- |
| Anonymous visitor claims first admin on a fresh deploy | Open race | Rejected without the setup token (printed only to the server log / set via env). |
| Operator locked out, forgot password | No path | CLI `hogsend studio admin reset` (DB + secret + shell access) and/or self-service email reset. |
| Attacker calls an admin-create/reset HTTP endpoint | n/a (doesn't exist) | **Still doesn't exist.** Recovery create/reset is CLI-only. The only network endpoints are the setup-token-gated first-admin create and better-auth's own rate-limited, email-delivered reset. |
| Password stored with wrong/weak hashing or in plaintext | Risk if hand-rolled | **Only** better-auth's server API touches passwords (scrypt via `ctx.context.password.hash`). No raw SQL password writes anywhere. |
| Reset token reuse / long-lived token | n/a | Single-use (deleted on consume), short TTL (15 min), constant-time compare (better-auth internal). |
| Secrets leaking to logs | n/a | Passwords are NEVER logged. The setup token is printed to the server log on first boot **by design** (operator-only surface); user reset tokens are never logged. |

### Non-negotiables (these are acceptance gates, not preferences)

1. **No network-exposed unauthenticated admin create/reset.** Arbitrary
   create/reset is CLI-only, gated by `DATABASE_URL` + `BETTER_AUTH_SECRET` +
   shell access. The web first-admin create is gated by the setup token; the web
   reset is better-auth's own email-delivered flow.
2. **Passwords only via better-auth's server API** (scrypt). Never raw SQL
   password writes; never plaintext at rest.
3. **Never persist a secret to stdout.** Printing the setup token to the server
   log on first boot is acceptable and intended; logging user passwords or reset
   token secrets is forbidden.
4. **Reset tokens:** single-use, short TTL, constant-time compare.
5. **The web setup form must not let an anonymous visitor claim the first admin
   without the setup token.** The check lives **server-side** in the engine, not
   the client.

### Industry reference (we match these norms)

- **PostHog / GitLab / Rails** — admin recovery via a shell/management command
  (`rails runner`, `gitlab-rake`, Django `createsuperuser`). Our CLI is that
  shell-gated primitive.
- **Supabase self-hosted** — dashboard gated by env credentials; admin user ops
  go through `service_role`; user-facing reset is an emailed link. Our setup
  token closes the first-run land-grab; our email reset is the self-service path.

---

## Current state (investigation findings)

- **Auth config** — `packages/engine/src/lib/auth.ts` `createAuth({ db, secret,
  baseURL, trustedOrigins })`. `emailAndPassword.enabled = true`,
  `minPasswordLength: 8`, `maxPasswordLength: 128`. Plugins: `organization`
  only. **No `sendResetPassword`, no admin plugin.** Mounted at `/api/auth`.
- **Status + first-admin gate** — both live in `packages/engine/src/app.ts`:
  - `GET /v1/auth/status` → `{ needsSetup: existing.length === 0 }` (counts
    `user` rows; public).
  - `app.use("/api/auth/sign-up/*", …)` → 403 once any user exists. This is the
    **only** first-admin gate, and it is Hono-layer (not better-auth).
  - `app.on(["POST","GET"], "/api/auth/*", …)` → forwards to
    `container.auth.handler(c.req.raw)`.
- **Studio** — `auth-gate.tsx` probes `/v1/auth/status`; on `needsSetup` renders
  `<AuthScreen mode="setup">` which calls `signUp.email(...)`; else `signIn`.
  `auth-client.ts` exposes `signIn`/`signUp`/`signOut`/`useSession` from
  `better-auth/react`. `api.ts` has `getAuthStatus()` and a thin fetch wrapper.
- **CLI** — `packages/cli`. Command framework: `Command { name, summary, usage,
  run(ctx) }` in `commands/types.ts`; registry in `commands/index.ts`; router in
  `bin.ts` (`hogsend <cmd>`). Subcommand dispatch is each command's own job
  (`parseArgs` on `ctx.argv`; see `studio.ts`). **Every existing command is
  HTTP-only — none imports `@hogsend/engine` or `@hogsend/db`.** `bin` →
  `dist/bin.js`. `tsup` bundles only `src/*` (no `noExternal`); runtime deps are
  `@clack/prompts` + `picocolors`. clack provides a masked `password` prompt.
  `lib/config.ts` already resolves `.env` + `process.env`.
- **Email** — `container.ts` builds `emailService` via `createTrackedMailer(...)`
  (`lib/mailer.ts`). The engine owns render → preferences → tracking →
  `email_sends` → `provider.send`. Concrete templates live in the **consumer's**
  `src/emails/` — the engine ships none. `sendEmail()` (`lib/email.ts`) is the
  journey entry point and resolves the singleton mailer.
- **better-auth 1.6.11** (engine and studio both pinned to it). Relevant API
  (`node_modules/better-auth/dist/api/routes/password.mjs`):
  - `emailAndPassword.sendResetPassword({ user, url, token }, request)` — the
    callback that delivers the reset link. **Without it, reset is disabled.**
  - `emailAndPassword.resetPasswordTokenExpiresIn` (seconds, default 3600).
  - `emailAndPassword.onPasswordReset({ user }, request)` — post-reset hook.
  - `emailAndPassword.revokeSessionsOnPasswordReset` — kill sessions on reset.
  - Token stored as a verification value `reset-password:<token>`, TTL-checked,
    **deleted on consume** (single-use), with a timing-attack mitigation for
    unknown emails. Reset endpoint hashes with `ctx.context.password.hash`.
  - `auth.$context` (Promise) resolves to `{ password: { hash, verify },
    internalAdapter: { findUserByEmail, findUserById, updatePassword,
    findAccounts, createAccount, … } }` — the supported headless surface.
  - `auth.api.signUpEmail({ body })` — public sign-up, scrypt-hashes. Calling it
    directly **bypasses the Hono-layer closed-signup gate** (correct for the CLI,
    which IS the trusted shell).
  - The admin plugin's `createUser`/`setUserPassword` are guarded by
    `adminMiddleware` (require an admin **session**) → **not** suitable for a
    headless CLI. We do **not** add the admin plugin for this.

---

## Deliverables

Three slices, three commits. Each must leave `pnpm check-types` green.

- **Slice 1 — CLI `hogsend studio admin`** (commit `feat(cli): …`)
- **Slice 2 — Setup-token gate on web first-admin** (commit `feat(engine): …`,
  studio form change folded in)
- **Slice 3 — Self-service email reset** (commit `feat(engine): …` + studio UI)

Order: Slice 1 is independent and the safety net; ship it first. Slice 2 closes
the land-grab. Slice 3 is the convenience path on top.

---

## Slice 1 — CLI: `hogsend studio admin create | reset | list`

The shell-gated recovery primitive. Gated by `DATABASE_URL` +
`BETTER_AUTH_SECRET` (i.e. whoever can reach the DB and read the app secret).
No HTTP, no running API required — it constructs its own better-auth instance
against the DB and uses better-auth's server API so hashing is identical to the
running app.

### Command surface

Nested under the existing `studio` command via subcommand dispatch (the `studio`
command already owns `ctx.argv`; route the first positional):

```
hogsend studio admin create [--email <e>] [--name <n>] [--password <p>] [--json]
hogsend studio admin reset  [--email <e>] [--password <p>] [--json]
hogsend studio admin list   [--json]
```

- `create` — create a new admin user (the first admin, or an additional one).
  - `--email` (required; prompted if omitted, TTY only).
  - `--name` (optional; defaults to the email local-part).
  - `--password` (optional; **prefer the masked prompt** — see Security). If the
    user already exists, fail with a clear message and point at `reset`.
- `reset` — set the password for an existing admin.
  - `--email` (required; if exactly one user exists and `--email` omitted in a
    TTY, offer it as the default).
  - `--password` (optional; masked prompt preferred).
  - Errors if no matching user exists (point at `create`).
- `list` — print existing admins (`id`, `email`, `name`, `createdAt`). No
  secrets. Useful to confirm whether the land-grab already happened. `--json`
  emits an array.

`hogsend studio admin --help` and `hogsend studio admin <sub> --help` print
usage. Unknown subcommand → usage + exit 1.

### Gating + env resolution

- Resolve `DATABASE_URL` and `BETTER_AUTH_SECRET` from `process.env` first, then
  the cwd `.env` (reuse `loadDotEnv` from `lib/config.ts` — already exists and is
  forgiving). Optionally honor `--database-url` / a `--env-file <path>` flag for
  non-cwd runs.
- If either is missing → fail fast with an actionable message naming both vars.
  Do **not** fall back to HTTP. This is the gate: you must hold the DB URL and
  the app secret.
- `BETTER_AUTH_URL` / `API_PUBLIC_URL` are not required for create/reset/list
  (no email, no redirect URL). Default `baseURL` to `BETTER_AUTH_URL` if present,
  else `http://localhost:3002` (only used by better-auth for cookie/URL config,
  irrelevant to these server calls).

### How it constructs and uses the auth instance

Do **not** call `createHogsendClient` (it boots Hatchet, the email provider
registry, destinations, PostHog, etc. — heavy and irrelevant). Construct a
minimal instance directly:

```ts
import { createDatabase } from "@hogsend/db";
import { createAuth } from "@hogsend/engine";

const { db, client } = createDatabase({ url: databaseUrl });
const auth = createAuth({ db, secret, baseURL });
// ...do work...
await client.end(); // close the pg pool so the CLI exits cleanly
```

- **create** → `await auth.api.signUpEmail({ body: { email, name, password } })`.
  This is better-auth's public sign-up; it scrypt-hashes via the same code path
  the app uses, and writes the `user` + `account` rows. It bypasses the
  Hono-layer closed-signup gate (which only exists on the HTTP app), which is
  exactly what we want for the trusted CLI. Catch `APIError`/duplicate-email and
  re-message: "user already exists — use `hogsend studio admin reset`".
- **reset** → resolve the context and use the internal adapter:

  ```ts
  const ctx = await auth.$context;
  const found = await ctx.internalAdapter.findUserByEmail(email, {
    includeAccounts: true,
  });
  if (!found) fail("no admin with that email — use `studio admin create`");
  const hashed = await ctx.password.hash(newPassword); // scrypt, same as app
  const hasCredential = found.accounts?.some(
    (a) => a.providerId === "credential",
  );
  if (hasCredential) {
    await ctx.internalAdapter.updatePassword(found.user.id, hashed);
  } else {
    await ctx.internalAdapter.createAccount({
      userId: found.user.id,
      providerId: "credential",
      accountId: found.user.id,
      password: hashed,
    });
  }
  ```

  This mirrors better-auth's own `resetPassword` route
  (`password.mjs:151-158`) exactly — correct hashing, correct credential-account
  handling. Optionally also revoke existing sessions
  (`ctx.internalAdapter.deleteSessions(found.user.id)`) so an old leaked session
  cannot survive a recovery reset.

- **list** → plain Drizzle read against `@hogsend/db`'s `user` table
  (`db.select({ id, email, name, createdAt }).from(user)`). No password/hash
  columns selected, ever.

### Packaging decision (load-bearing)

The CLI is published and currently has **zero** workspace runtime deps. Pulling
`@hogsend/engine` (Hatchet, Resend, PostHog, Hono, …) and `@hogsend/db` into its
runtime would bloat the published tarball massively.

**Decision:** keep the published CLI lean. Two acceptable implementations,
pick one in the PR:

- **(A) Preferred — narrow import surface.** Add `@hogsend/engine` and
  `@hogsend/db` as deps but import only `createAuth` (engine) and
  `createDatabase` + `user` (db). With `tsup` `noExternal: ["@hogsend/engine",
  "@hogsend/db"]` the bundler tree-shakes to just the auth + drizzle path. Verify
  the bundled `dist/bin.js` size and that it does not transitively pull Hatchet
  at module-eval time (move any eager Hatchet init behind lazy access if the tree
  shake leaks it). This keeps one source of truth for `createAuth`.
- **(B) Fallback — engine-side helper module.** Add a tiny engine entry
  `@hogsend/engine/admin-recovery` exporting `createAdminRecovery({ databaseUrl,
  secret })` → `{ create, reset, list, close }`, written so its module graph
  touches only `better-auth` + `@hogsend/db` (no Hatchet/Resend/PostHog). The CLI
  depends on that single narrow entry. This guarantees the heavy graph never
  loads regardless of tree-shaking.

Either way: **the CLI never re-implements hashing** and never issues raw SQL
password writes.

### Files

- `packages/cli/src/commands/studio.ts` — add `admin` subcommand routing (or a
  new `packages/cli/src/commands/studio-admin.ts` imported by `studio.ts`).
- `packages/cli/src/lib/admin-recovery.ts` (new) — the create/reset/list logic +
  env gating + `auth`/`db` construction + pool teardown.
- `packages/cli/package.json` — add deps per the packaging decision; bump nothing
  else.
- `packages/cli/tsup.config.ts` — add `noExternal` if going with (A).
- Update root `hogsend studio --help` and the `studio admin` usage block.

---

## Slice 2 — Harden web first-admin with a SETUP TOKEN

Close the land-grab: the first-admin create must present a setup token the
operator controls. The check is **server-side in the engine**, not the client.

### Token lifecycle

- **Source of truth:** `STUDIO_SETUP_TOKEN` env var (operator-supplied) takes
  precedence. If unset and `needsSetup` is true at boot, the engine
  **auto-generates** a token (e.g. `crypto.randomBytes(24).toString("base64url")`)
  and prints it **once to the server log** at `warn`/`info`:

  ```
  [studio] First-admin setup required. Setup token: <token>
  [studio] Provide it in the Studio "create admin" form (or set STUDIO_SETUP_TOKEN).
  ```

  Printing to the server log is the intended operator-only surface (Supabase-/
  GitLab-style). It is **never** returned by any HTTP endpoint and **never** sent
  to a client.
- Add `STUDIO_SETUP_TOKEN: z.string().optional()` to `packages/engine/src/env.ts`.
- The auto-generated value must be **stable for the process lifetime** so the
  printed token keeps working until used. Hold it in a module singleton computed
  lazily on first need (mirror the engine's `createSingleton` pattern). It does
  not need to survive restarts — a restart prints a fresh token, which is fine
  (and means a restart invalidates a previously-printed-but-unused token).
- Once a user exists (`needsSetup` false), the token is irrelevant: the existing
  closed-signup 403 already blocks everything. No token is generated or printed
  when an admin already exists.

### Server-side gate (the load-bearing change)

In `packages/engine/src/app.ts`, replace the current sign-up middleware so the
first-admin create requires the token:

```ts
app.use("/api/auth/sign-up/*", async (c, next) => {
  if (c.req.method !== "POST") return next();
  const { db } = c.get("container");
  const existing = await db.select({ id: user.id }).from(user).limit(1);
  if (existing.length > 0) {
    return c.json(
      { error: "Sign-ups are closed. An admin already exists." },
      403,
    );
  }
  // needsSetup === true: require the setup token.
  const presented = c.req.header("x-hogsend-setup-token");
  const expected = resolveSetupToken(c.get("container")); // env || generated
  if (!presented || !timingSafeEqualStr(presented, expected)) {
    return c.json(
      { error: "Setup token required or invalid." },
      403,
    );
  }
  return next();
});
```

- **Compare in constant time** (`crypto.timingSafeEqual` on equal-length
  buffers; guard length first to avoid throwing, and compare a fixed dummy when
  lengths differ to keep timing flat).
- Read the token from a request **header** (`x-hogsend-setup-token`), not the
  JSON body — keeps it out of better-auth's body schema and out of any body
  logging. (Alternatively a one-off `POST /v1/auth/setup` engine route that
  validates the token then delegates to `auth.api.signUpEmail`; the header-on-
  sign-up approach is smaller and reuses the existing better-auth endpoint.)
- This runs **before** `auth.handler`, so an anonymous visitor without the token
  never reaches sign-up. The gate is in the engine; the client cannot bypass it.
- Do **not** add a way to read the token over HTTP. `GET /v1/auth/status` stays
  `{ needsSetup }` only — it must not leak whether/what the token is.

### Studio form change

In `auth-forms.tsx`, when `mode === "setup"`, add a **Setup token** input and
send it as the `x-hogsend-setup-token` header on the create call.

- `signUp.email(...)` accepts `fetchOptions.headers`, so:
  `signUp.email({ name, email, password }, { headers: { "x-hogsend-setup-token":
  token } })`. (Confirm the 1.6.11 client signature; if per-call headers aren't
  threaded, fall back to a direct `api.post("/api/auth/sign-up/email", { json,
  headers })` via the studio `api.ts` wrapper, then refresh the session.)
- Copy on the setup card: "Paste the setup token printed in your server log on
  first boot (or the `STUDIO_SETUP_TOKEN` you configured)."
- Surface the 403 "Setup token required or invalid." message inline.

### Files

- `packages/engine/src/env.ts` — add `STUDIO_SETUP_TOKEN`.
- `packages/engine/src/lib/setup-token.ts` (new) — `resolveSetupToken()`
  (env-or-generate, singleton), constant-time compare helper, and the first-boot
  log line. Called from `app.ts` and once at boot when `needsSetup` is true.
- `packages/engine/src/app.ts` — token gate in the sign-up middleware; trigger
  the first-boot log.
- `packages/studio/src/components/auth/auth-forms.tsx` — setup-token field +
  header on create.
- `packages/studio/src/lib/api.ts` / `auth-client.ts` — only if a direct POST
  fallback is needed to thread the header.

---

## Slice 3 — Self-service email reset

Wire better-auth's built-in reset flow to the engine mailer, plus the Studio UI.
This is the convenience path; the CLI (Slice 1) remains the guaranteed recovery.

### Engine: enable + deliver the reset

In `createAuth` (`lib/auth.ts`), extend `emailAndPassword`:

```ts
emailAndPassword: {
  enabled: true,
  minPasswordLength: 8,
  maxPasswordLength: 128,
  resetPasswordTokenExpiresIn: 60 * 15,   // 15 min — short TTL
  revokeSessionsOnPasswordReset: true,    // a reset kills old sessions
  sendResetPassword: async ({ user, url, token }) => {
    await sendResetPasswordEmail({ to: user.email, url });
  },
},
```

- **TTL:** 15 minutes (overrides better-auth's 3600s default). Token is
  single-use (better-auth deletes the verification value on consume) and
  compared internally; we inherit those guarantees — do not re-implement them.
- `revokeSessionsOnPasswordReset: true` so a recovered account can't be ridden by
  a stale session.
- `sendResetPassword` must be **injectable** so tests can assert it fires without
  sending. Thread it through `createAuth` opts (e.g. a `sendResetPassword?:`
  param defaulting to the engine mailer call) so `createHogsendClient` wires the
  real mailer and tests inject a spy. `createAuth` is called from `container.ts`;
  pass the mailer-backed sender there.

### Engine: the built-in reset email (self-contained — no consumer wiring)

The engine ships **no** business templates today (they live in the consumer's
`src/emails/`). A reset email that required a consumer template would break the
"works out of the box" guarantee. **Recommendation: the engine owns a minimal,
self-contained reset email** so reset works on a bare instance with zero consumer
wiring.

- Add `packages/engine/src/lib/reset-email.ts` exporting `sendResetPasswordEmail
  ({ to, url })`. It builds a tiny inline HTML + plaintext body (no React Email
  dependency, no template registry lookup) and sends via the resolved provider —
  use `emailService.sendRaw({ to, subject, html, text, from })` (the mailer's
  raw path bypasses template resolution and the preference/suppression check,
  which is correct: a password reset is strictly transactional and must not be
  suppressed by marketing opt-out). Resolve `from` from
  `EMAIL_FROM ?? RESEND_FROM_EMAIL` (already the mailer default).
- Body: one sentence + the `url` as a button and as a raw link, plus "this link
  expires in 15 minutes and can be used once; if you didn't request this, ignore
  it." No tracking pixel, no unsubscribe footer (transactional).
- **Never log the `url` or `token`.** If `RESEND_API_KEY` (or the active
  provider) is unconfigured, `sendResetPassword` should log a clear **warning**
  ("password reset requested but no email provider configured — use `hogsend
  studio admin reset`") and resolve without throwing, so the endpoint still
  returns better-auth's neutral "if this email exists…" response (no user
  enumeration) and the operator is steered to the CLI.

### Studio UI

- `auth-client.ts` — the better-auth React client exposes `requestPasswordReset`
  and `resetPassword` (proxied from the server endpoints; 1.6.11). Re-export
  them: `export const { signIn, signUp, signOut, useSession,
  requestPasswordReset, resetPassword } = authClient;`.
- `auth-forms.tsx`:
  - Add a **"Forgot password?"** link under the login form → a `forgot` mode that
    collects an email and calls `requestPasswordReset({ email, redirectTo:
    "<studio>/reset-password" })`. Always show the neutral "If that email exists,
    check your inbox" message (no enumeration).
  - Add a **reset** view (its own route/mode) that reads `?token=` from the URL
    (better-auth's callback redirects to `redirectTo?token=…`), collects the new
    password, and calls `resetPassword({ newPassword, token })`. On success →
    back to login with a success toast.
- `AuthGate` already routes setup/login; thread the new `forgot`/`reset` modes
  through `AuthScreen` (extend `FormMode`).

### Files

- `packages/engine/src/lib/auth.ts` — reset config + injectable sender.
- `packages/engine/src/lib/reset-email.ts` (new) — built-in reset email.
- `packages/engine/src/container.ts` — wire the mailer-backed sender into
  `createAuth`.
- `packages/engine/src/env.ts` — none required (reuses `EMAIL_FROM` /
  `API_PUBLIC_URL`); confirm `API_PUBLIC_URL` is the redirect base.
- `packages/studio/src/lib/auth-client.ts` — export reset methods.
- `packages/studio/src/components/auth/auth-forms.tsx` — forgot + reset views.

---

## Security section (consolidated)

- **First-run land-grab** — closed by the setup token. Auto-generated on first
  boot when `needsSetup` is true, printed only to the server log, overridable via
  `STUDIO_SETUP_TOKEN`. The gate is server-side in the engine sign-up
  middleware, constant-time compared, read from a header (not the body). No HTTP
  endpoint ever reveals the token. A restart rotates the auto token (invalidating
  an unused printed one). For the strongest posture, operators set
  `STUDIO_SETUP_TOKEN` in their deploy env so the window is deterministic.
- **No network-exposed reset/create** — arbitrary admin create/reset is CLI-only,
  gated by `DATABASE_URL` + `BETTER_AUTH_SECRET` + shell access. The only network
  write paths are (a) the setup-token-gated first-admin create and (b)
  better-auth's own reset flow (rate-limited, email-delivered, single-use,
  TTL-bounded, no user enumeration).
- **Password handling** — every password write goes through better-auth's server
  API (`auth.api.signUpEmail`, `ctx.password.hash` + `internalAdapter`,
  better-auth's `resetPassword`). Scrypt, identical to the running app. **No raw
  SQL password writes. No plaintext at rest. No password ever logged.**
- **Token handling** — reset tokens: 15-min TTL, single-use (deleted on
  consume), constant-time compare (better-auth internal). Setup token:
  constant-time compare, header-only, log-only disclosure, process-lifetime
  stable. The CLI prefers a **masked** password prompt over `--password` to keep
  secrets out of shell history; when `--password` is used, document the history
  risk in `--help`.
- **No user enumeration** — `requestPasswordReset` returns the same neutral
  response whether or not the email exists (better-auth already does this; our
  `sendResetPassword` must not break it by throwing on unknown users — it never
  sees them).
- **Session hygiene** — `revokeSessionsOnPasswordReset: true`; the CLI reset
  optionally revokes sessions too.

---

## Test plan (per phase)

A migrated test DB exists at `postgresql://test:test@localhost:5434/test`. Run
suites with that as `DATABASE_URL`. Do **not** edit `vitest.config.ts`. If the DB
is absent, report `infra-error`.

### Slice 1 — CLI admin

- `admin create` against an empty `user` table creates a user; a subsequent
  `signIn.email` (or `auth.api.signInEmail`) with that password succeeds →
  proves correct hashing end-to-end.
- `admin create` for an existing email fails with the "use reset" message.
- `admin reset` for an existing user changes the password: old password fails
  sign-in, new password succeeds. The stored hash is scrypt (starts with the
  better-auth hash shape), never plaintext.
- `admin reset` for a missing email fails with the "use create" message.
- `admin list` prints users with **no** hash/password columns; `--json` shape is
  an array of `{ id, email, name, createdAt }`.
- Missing `DATABASE_URL` or `BETTER_AUTH_SECRET` → fast, clear failure; no HTTP
  attempted; no partial writes.
- Masked prompt: no password echoed to stdout (manual TTY check noted in PR).
- Bundle check: `dist/bin.js` does not eagerly load Hatchet/Resend at import
  (smoke: `node -e "import('./dist/bin.js')"` with no Hatchet env succeeds).

### Slice 2 — setup token

- Fresh DB (`needsSetup` true): `POST /api/auth/sign-up/email` **without** the
  header → 403 "Setup token required or invalid." (anonymous visitor blocked).
- Same with a **wrong** token → 403.
- With the correct token (env-set in the test) → 200, user created, subsequent
  status `needsSetup: false`.
- Once a user exists: sign-up with **any** token → 403 "Sign-ups are closed."
- `GET /v1/auth/status` returns only `{ needsSetup }` and never the token.
- First-boot log emits the token exactly once when `needsSetup` is true and
  `STUDIO_SETUP_TOKEN` is unset; emits nothing when a user already exists.
- Constant-time compare: unit test the helper with equal/unequal lengths (no
  throw, correct boolean).
- Extend `apps/api/src/__tests__/admin-auth.test.ts` (it already drives
  `/v1/auth/status` and sign-up) with the token cases.

### Slice 3 — email reset

- With `sendResetPassword` injected as a spy: `POST /api/auth/request-password-
  reset` for a known email → 200 neutral message, spy called once with a `url`
  containing a token and the user.
- Unknown email → 200 neutral message, spy **not** called (no enumeration, no
  throw).
- `POST /api/auth/reset-password` with the captured token + new password →
  success; sign-in with the new password works; the old password fails;
  sessions were revoked.
- Token **reuse** (second `reset-password` with the same token) → 400
  INVALID_TOKEN (single-use).
- Token **expiry**: with `resetPasswordTokenExpiresIn` lowered in a test config,
  an expired token → 400 INVALID_TOKEN.
- No-provider path: with no email provider configured, request → 200 neutral
  message, a warning logged (pointing at the CLI), no throw, **no token/url in
  the log**.
- Reset email body assertions (render the built-in template): contains the URL,
  the 15-min/single-use notice; no tracking pixel; no unsubscribe footer.

### Cross-cutting

- `pnpm check-types` green after each slice (hard gate).
- `pnpm biome check --write` on every touched file (2-space, double quotes,
  semicolons, 80 cols).
- ESM `.js` import extensions in engine/api/cli.

---

## Out of scope / follow-ups

- Admin plugin + RBAC roles (multi-admin, role management). This spec stays
  single-tenant/single-admin-trust; the admin plugin's session-guarded endpoints
  are deliberately not added.
- Rotating/persisting the auto-generated setup token across restarts (current
  behavior: a restart rotates it — acceptable, arguably safer).
- 2FA / passkeys for Studio login.
- Rate-limiting tuning for `request-password-reset` beyond better-auth defaults.
