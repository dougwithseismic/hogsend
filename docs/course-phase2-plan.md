# Phase 2 implementation + deploy plan — `apps/course`

*Generated from the `course-phase2-design` workflow. Companion:
[`course-phase2-prd.md`](./course-phase2-prd.md).*

## Decisions (resolved)
- **DB: dedicated Railway Postgres** in the existing "Hogsend" Railway project.
  Rationale: the course is an always-on standalone Node server doing a session lookup on
  every gated request — Neon scale-to-zero cold starts penalize exactly this;
  co-located Railway PG gives private-network (`postgres.railway.internal`) sub-ms
  latency, one vendor, and matches the API/dogfood deploy model. Its own DB, NOT the
  engine/dogfood DB.
- **Driver:** `postgres` (postgres-js) + `drizzle-orm` + `drizzle-kit` (dev), mirroring
  dogfood. postgres-js is required so the Better Auth handler traces `drizzle-orm` +
  `postgres` into the Next standalone `node_modules`.
- **Magic-link email: send DIRECTLY from `apps/course` via Resend.** NOT through the
  dogfood engine mailer — its `prepareTrackedHtml` rewrites every `<a href>` through the
  click tracker (would corrupt the single-use token URL), its preference/list
  suppression could deny an unsubscribed contact a sign-in link, and it couples login
  uptime to the dogfood. Auth mail stays sovereign; analytics events still go to the
  dogfood.

## Build steps (ordered)
1. Install deps in apps/course: `pnpm --filter @hogsend/course add better-auth drizzle-orm postgres resend` and `pnpm --filter @hogsend/course add -D drizzle-kit @better-auth/cli @types/node`. (Use `pnpm add @latest`; do not hand-edit versions. Import the Drizzle adapter from the built-in subpath `better-auth/adapters/drizzle` — NOT `@better-auth/drizzle-adapter`.)
2. DB client + schema: create `lib/db/index.ts` (`postgres(process.env.DATABASE_URL)` + `drizzle(client, { schema })`) and `lib/db/schema.ts` (6 tables, below). VERIFY-THEN-AUTHOR: run `npx @better-auth/cli@latest generate --config apps/course/lib/auth.ts` to emit the exact 1.6.x core-table columns, diff against the hand-authored 4 core tables, then keep one hand-authored `schema.ts` (core 4 + the 2 app tables) as source of truth.
3. Server auth: create `lib/auth.ts` — `betterAuth({ basePath:"/api/auth", baseURL: env.BETTER_AUTH_URL, secret: env.BETTER_AUTH_SECRET, trustedOrigins:[env.BETTER_AUTH_URL], database: drizzleAdapter(db,{provider:"pg",schema}), emailAndPassword:{enabled:false}, socialProviders:{ github:{clientId,clientSecret} }, account:{ accountLinking:{ enabled:true } }, session:{ expiresIn:60*60*24*30, updateAge:60*60*24, cookieCache:{ enabled:true, maxAge:5*60 } }, databaseHooks:{ user:{ create:{ after: emit course.signed_up } } }, plugins:[ magicLink({ expiresIn:60*15, disableSignUp:false, sendMagicLink: ({email,url}) => sendMagicLinkEmail(email,url) }), nextCookies() ] })`. `nextCookies()` MUST be LAST. Do NOT add github to `trustedProviders`.
4. Client auth: create `lib/auth-client.ts` — `createAuthClient({ plugins:[magicLinkClient()] })` (same-origin default, no `NEXT_PUBLIC_*` needed). Export `signIn/signOut/useSession`.
5. Route handler: create `app/api/auth/[...all]/route.ts` — `export const { GET, POST } = toNextJsHandler(auth)`.
6. Magic-link email: create `lib/email.ts` — `sendMagicLinkEmail(to,url)` via Resend; soft-skip when `RESEND_API_KEY` unset; crimzon HTML string; NEVER log url/token.
7. Gating helper: create `lib/gating.ts` — `freeLessonParams()` (first-lesson slug arrays per course), `isFreeLesson(slugs)`, `getSession()`, `ensureEnrollment(user, courseSlug)`, `recordLessonProgress(...)`, and `safeNext(next)` (accept only relative `/learn/...` paths; reject absolute, `//`, backslash). Build the public set from `COURSES` × `meta.json pages[0]` (same sort the overview page uses).
8. Events: create `lib/events.ts` wrapping `forwardToIngest` for the 4 emits (call sites below). Guard with `ingestConfigured()`; wrap in try/catch; never block the DB write or page render.
9. UI: create `app/(auth)/sign-in/page.tsx` (server, reads async `searchParams.next`, validates via `safeNext`), `components/auth/sign-in-form.tsx` (`"use client"`: magic-link + GitHub, "check your inbox" state), `components/auth/lesson-gate.tsx` (DS wall), `components/auth/user-menu.tsx` (sign-out in learn nav). DS-only, dark crimzon.
10. Gate the lesson page: edit `app/learn/[[...slug]]/page.tsx` — after `notFound`, `const free = isFreeLesson(params.slug ?? [])`; if `!free` { `const session = await getSession()`; if `!session` return `<LessonGate page={page} />`; else `ensureEnrollment` + `recordLessonProgress` then render }. Change `generateStaticParams` to return `freeLessonParams()`. In `generateMetadata`, add `robots:{index:false,follow:false}` for gated (non-free) lessons; keep free lessons indexable.
11. Migrations: create `drizzle.config.ts` (`schema:"./lib/db/schema.ts", out:"./drizzle", dialect:"postgresql", dbCredentials:{url:DATABASE_URL}`), run `pnpm --filter @hogsend/course exec drizzle-kit generate`, COMMIT `apps/course/drizzle/`. Create `scripts/migrate.mjs` (programmatic `migrate()` from `drizzle-orm/postgres-js/migrator`, `migrationsFolder: new URL("../drizzle", import.meta.url).pathname`, `postgres(DATABASE_URL,{max:1})`, then `sql.end()`).
12. Add package.json scripts: `db:generate`, `db:migrate`, `db:push`.
13. Verify: `pnpm --filter @hogsend/course check-types` and `pnpm --filter @hogsend/course build` green. Local smoke against a local Postgres.

## Full file list (apps/course)
**Create:**
- `lib/db/index.ts` — postgres-js + drizzle client
- `lib/db/schema.ts` — 6 tables
- `lib/auth.ts` — Better Auth server (magicLink + github, open sign-up, cookieCache, databaseHooks, nextCookies last)
- `lib/auth-client.ts` — createAuthClient + magicLinkClient
- `lib/email.ts` — sendMagicLinkEmail via Resend
- `lib/gating.ts` — free-lesson logic, getSession, ensureEnrollment, recordLessonProgress, safeNext
- `lib/events.ts` — course.* emit helpers over lib/ingest.ts
- `app/api/auth/[...all]/route.ts` — toNextJsHandler(auth)
- `app/(auth)/sign-in/page.tsx` — DS sign-in (reads ?next=)
- `components/auth/sign-in-form.tsx` — "use client" magic-link + GitHub form
- `components/auth/lesson-gate.tsx` — DS gated-lesson wall
- `components/auth/user-menu.tsx` — session-aware sign-out for learn nav
- `drizzle.config.ts` — drizzle-kit config
- `drizzle/` — generated + committed SQL migrations
- `scripts/migrate.mjs` — programmatic migrator for the Railway pre-deploy step
- `proxy.ts` — OPTIONAL Next 16 optimistic redirect on `/learn/:path*` via `getSessionCookie` (NOT the security boundary; skip if not wanted)

**Modify:**
- `app/learn/[[...slug]]/page.tsx` — gate non-free lessons, `generateStaticParams → freeLessonParams()`, noindex gated in `generateMetadata`, progress/enroll emits
- `package.json` — add deps + db scripts
- `Dockerfile.course` — COPY migrate.mjs + drizzle/ into runner stage
- `railway.course.toml` — add `[deploy] preDeployCommand`
- `app/learn` layout/nav — mount `user-menu.tsx` (do NOT add a session read to the layout — that would make the whole `/learn` subtree dynamic and kill first-lesson SSG)

## DB schema (Postgres; all PK/FK are TEXT — Better Auth ids are generated strings)
- `user(id text PK, name text NOT NULL, email text NOT NULL UNIQUE, email_verified boolean NOT NULL DEFAULT false, image text, created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now())`
- `session(id text PK, user_id text NOT NULL REFERENCES user(id) ON DELETE CASCADE, token text NOT NULL UNIQUE, expires_at timestamptz NOT NULL, ip_address text, user_agent text, created_at, updated_at)`
- `account(id text PK, user_id text NOT NULL REFERENCES user(id) ON DELETE CASCADE, account_id text NOT NULL, provider_id text NOT NULL, access_token text, refresh_token text, access_token_expires_at timestamptz, refresh_token_expires_at timestamptz, scope text, id_token text, password text, created_at, updated_at)`
- `verification(id text PK, identifier text NOT NULL, value text NOT NULL, expires_at timestamptz NOT NULL, created_at, updated_at)` — magic-link writes tokens here; it adds NO table.
- `enrollment(id text PK, user_id text NOT NULL REFERENCES user(id) ON DELETE CASCADE, course_slug text NOT NULL, enrolled_at timestamptz NOT NULL DEFAULT now(), completed_at timestamptz, UNIQUE(user_id, course_slug))`
- `lesson_progress(id text PK, user_id text NOT NULL REFERENCES user(id) ON DELETE CASCADE, course_slug text NOT NULL, lesson_slug text NOT NULL, completed_at timestamptz NOT NULL DEFAULT now(), UNIQUE(user_id, course_slug, lesson_slug))` + index `(user_id, course_slug)`.

Table names SINGULAR (Better Auth defaults) so the Drizzle adapter resolves with no
remapping. The UNIQUE constraints make enroll/progress idempotent via
`onConflictDoNothing().returning()` (emit the event only when a row was actually
inserted).

## Migration approach
- `drizzle-kit generate` produces versioned SQL in `apps/course/drizzle/`; COMMIT it
  (the standalone runner has no drizzle-kit and Next does not trace the SQL or the
  migrate script). Better Auth does not run migrations.
- Apply at deploy via a Railway `preDeployCommand` running the bundled
  `scripts/migrate.mjs` (runtime migrator needs only `drizzle-orm` + `postgres` + the
  SQL files). `drizzle-orm`/`postgres` are traced into the standalone via the auth
  handler; the SQL folder + migrate script must be COPYed into the runner stage
  explicitly.
- Local dev: `db:push` is fine.

## Env vars
**Build-time** (Docker ARG in Dockerfile.course + Railway var; `NEXT_PUBLIC_*` only —
inlined into client bundle):
- `NEXT_PUBLIC_HOGSEND_API_URL`, `NEXT_PUBLIC_HOGSEND_PUBLISHABLE_KEY`,
  `NEXT_PUBLIC_POSTHOG_KEY` (all already declared as ARGs).
- The auth client defaults to same-origin, so NO `NEXT_PUBLIC_BETTER_AUTH_URL` is
  required (avoids a new build ARG).

**Runtime** (Railway service var only — NEVER an ARG; would leak into layers + force
rebuild on rotation):
- `DATABASE_URL` = `${{<course-db>.DATABASE_URL}}` (private ref to the dedicated course Postgres)
- `BETTER_AUTH_SECRET` (`openssl rand -base64 32`)
- `BETTER_AUTH_URL` = `https://course.hogsend.com` (no trailing slash)
- `GITHUB_CLIENT_ID`, `GITHUB_CLIENT_SECRET`
- `RESEND_API_KEY`, `COURSE_FROM_EMAIL` (e.g. `Hogsend Courses <courses@hogsend.com>`, on a Resend-verified domain)
- `HOGSEND_INGEST_URL`, `HOGSEND_INGEST_KEY` (already read by lib/ingest.ts)
- Auto (do not set): `PORT` (Railway-injected), `NODE_ENV=production` + `HOSTNAME=0.0.0.0` (baked into Dockerfile.course).

## `course.*` event call sites (all email-identified, best-effort, idempotent)
- `course.signed_up` — in `databaseHooks.user.create.after`. Idempotency key `course-signed-up-${user.id}`. Covers both magic-link and GitHub.
- `course.enrolled` — in `ensureEnrollment` when a NEW enrollment row is inserted (also an optional `/api/enroll` for the overview "Start the course" button; both idempotent → one event). Key `course-enrolled-${userId}-${courseSlug}`.
- `course.lesson_completed` — in `recordLessonProgress` when a NEW `lesson_progress` row is inserted (explicit "Mark complete" action preferred for determinism). Key `course-lesson-completed-${userId}-${courseSlug}-${lessonSlug}`.
- `course.completed` — same handler, after the progress insert: if completed-lesson count for `(userId,courseSlug)` equals the course's total lesson count AND `enrollment.completed_at` is null, set it and emit. Key `course-completed-${userId}-${courseSlug}`.

> **CRITICAL identity rule:** NEVER pass `session.user.id` as the ingest top-level
> `userId` — that arm is the Hogsend external_id contact key; a Better Auth id there
> mints a phantom external_id twin (the documented identity-resolution lockout).
> Identify by EMAIL; carry the auth id only as `contactProperties.courseUserId`.

## Deploy runbook (Railway + Cloudflare)
**Prereqs the USER must supply** (assistant cannot): Cloudflare API token (Zone:DNS Edit
+ Zone:Read on hogsend.com), a GitHub OAuth App (callback EXACTLY
`https://course.hogsend.com/api/auth/callback/github`; a second app for
`http://localhost:3006/...` dev), a Resend-verified sending domain + key, and the
dogfood `HOGSEND_INGEST_URL`/`HOGSEND_INGEST_KEY`.

1. Preflight: `railway whoami`, `railway status --json` (project Hogsend / production); `railway link --project Hogsend` if needed.
2. Provision the course's OWN Postgres: `railway add --database postgres --service course-db`. VERIFY the created name via `railway service list --json` (project already has an API Postgres — names are case-sensitive).
3. Create the app service from the repo: `railway add --service hogsend-course --repo dougwithseismic/hogsend`; `railway service link hogsend-course`.
4. Point the service at its config file (else Railway falls back to root /Dockerfile and builds the API). Set `railwayConfigFile = "railway.course.toml"` (GraphQL `serviceInstanceUpdate` or dashboard Settings → Config-as-code — exactly how hogsend-docs → railway.docs.toml is wired).
5. Land the Phase-2 DB code BEFORE first deploy: commit `apps/course/drizzle/`, `scripts/migrate.mjs`, the Dockerfile.course runner COPYs, and the `railway.course.toml` `preDeployCommand = "node apps/course/scripts/migrate.mjs"`.
6. Set build vars (ARGs): `NEXT_PUBLIC_HOGSEND_API_URL`, `NEXT_PUBLIC_HOGSEND_PUBLISHABLE_KEY`, `NEXT_PUBLIC_POSTHOG_KEY`.
7. Set runtime vars (use `--stdin` for secrets): `DATABASE_URL='${{course-db.DATABASE_URL}}'`, `BETTER_AUTH_SECRET`, `BETTER_AUTH_URL`, `GITHUB_CLIENT_ID`/`SECRET`, `RESEND_API_KEY`, `COURSE_FROM_EMAIL`, `HOGSEND_INGEST_URL`/`KEY`.
8. First deploy: push/merge to main (auto-deploy) or `railway up --service hogsend-course --detach`. Watch `railway logs` — preDeploy migration creates all 6 tables; confirm `/` healthcheck.
9. Attach domain + capture BOTH records: `railway domain course.hogsend.com --service hogsend-course --json` returns a CNAME (routing) AND a TXT (ownership). Both mandatory — a CNAME alone leaves it unverified (404).
10. Resolve zone: `curl -H "Authorization: Bearer $CLOUDFLARE_API_TOKEN" 'https://api.cloudflare.com/client/v4/zones?name=hogsend.com'` → ZONE_ID.
11. Create DNS via the **Cloudflare REST API — NOT wrangler**. VERIFIED: wrangler has no `dns` command; it only creates DNS implicitly via Worker Custom Domains (targets a Worker, not a Railway origin). CNAME (`proxied:true`) `course → <railway-cname-target>`; TXT (`proxied:false`) `<railway-txt-host> → <railway-txt-value>`. Dashboard is the fallback if no token.
12. SSL + verify: set the hogsend.com zone SSL/TLS mode to Full (NOT Full Strict) for the proxied record (mirror api.hogsend.com); `dig +short course.hogsend.com CNAME`; re-run `railway domain ... --json` until verified; `curl -I https://course.hogsend.com` (expect 200).
13. Finalize OAuth + smoke test: GitHub callback exactly `https://course.hogsend.com/api/auth/callback/github`, `BETTER_AUTH_URL` exact. Verify: public `/`, `/[course]`, first lesson render anon + indexable; a deeper lesson shows the wall; magic-link + GitHub sign-ins both return to the requested lesson; a `course.signed_up`/`course.enrolled` reaches the dogfood.

## Security checklist for the gate (bypass vector → mitigation)
- **Gated bodies prerendered into the build** → `generateStaticParams` returns ONLY first-lesson params; gated lessons are dynamic-only and read `headers()`, so never written as static `.html`/`.rsc`.
- **Direct RSC / `_next/data` payload fetch** → the authoritative `getSession()` check lives in the PAGE RSC (runs on every render incl. RSC requests) and gated pages are never static; Next 16 renders RSC and HTML identically (no ungated variant).
- **proxy/middleware treated as the lock** → `proxy.ts` is OPTIONAL and optimistic only (`getSessionCookie` is existence-only, "NOT SECURE"; a forged cookie passes it). The DB-validated `auth.api.getSession()` in the page is the boundary.
- **Layout-level guard kills SEO** → put the guard in the PAGE with a conditional session read (short-circuit on `isFreeLesson`), NOT in `app/learn/layout.tsx`.
- **Client-only gating defeated by reading the payload / disabling JS** → all gating is server-side; the MDX body renders only after the server check passes.
- **fumadocs static Orama search index leaks every body** → no search route this phase; when added, build the index from public-only pages. Never ship the default all-pages static index.
- **Open redirect via `?next=`** → `safeNext()` accepts only relative `/learn/...` paths (reject absolute, `//evil.com`, backslash); validate in the sign-in page AND in any `callbackURL`.
- **CDN caching an authed render** → gated pages read cookies/headers → dynamic + private/no-store automatically; do NOT enable Cloudflare "Cache Everything" on HTML. Public static pages stay cacheable (intended).
- **thin gated walls indexed** → `robots:{index:false,follow:false}` in `generateMetadata` for gated lessons.
- **account takeover via OAuth linking** → keep `accountLinking.enabled:true` but do NOT add github to `trustedProviders` (default links only on a VERIFIED matching email; magic-link only creates verified users, GitHub returns a verified primary email → safe convergence). Request `user:email` scope; friendly error if GitHub returns no email.
- **nextCookies not last** → login silently breaks (Set-Cookie dropped); enforce `nextCookies()` as the final plugin.

## Next 16 notes that will bite
- `params` AND `searchParams` are async — await them everywhere.
- File is `proxy.ts`, NOT `middleware.ts` (codemod `@next/codemod middleware-to-proxy`); edge runtime unsupported in proxy; prefer `getSessionCookie` existence-only.
- Run `pnpm next typegen` for PageProps/LayoutProps; Turbopack is the default builder; dev port is 3006.

## Open decisions (need the user)
1. **Cloudflare access** — needs an API token scoped Zone:DNS Edit + Zone:Read on
   hogsend.com (wrangler CANNOT create the zone CNAME/TXT — confirmed). Supply the token
   or create the two records in the dashboard.
2. **GitHub OAuth App** — who owns it; need `GITHUB_CLIENT_ID`/`SECRET`. Classic OAuth
   Apps allow ONE callback, so prod (course.hogsend.com) + dev (localhost:3006) need
   separate apps, or one GitHub App with multiple callbacks.
3. **Resend sending domain + from address** — confirm a verified sending domain in the
   Resend account behind `RESEND_API_KEY`, and the exact `COURSE_FROM_EMAIL`.
4. DB provider — Railway Postgres recommended (decisive); revisit only for Neon/branching.
5. Magic-link path — Resend-direct recommended (decisive); confirm a course-owned key.
6. Optional `proxy.ts` optimistic redirect — ship now or skip (RSC gate is the boundary
   either way; UX-only).
