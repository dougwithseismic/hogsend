# Docs Auth Unification — Execution Plan

Give `hogsend.com` (apps/docs) the **same real customer auth** the course already has
(`course.hogsend.com`, apps/course) so the docs live-demo visitor is a first-class
identified contact, docs + course share **one login** across `*.hogsend.com`, and the
"fired by a visitor" attribution bug (plus a silent phantom-twin contact fork) is cured at
the root. Decisions locked with Doug 2026-07-07: **full shared SSO**, **gate the demo behind
sign-in**, **no throwaway stopgap**, **collect a first name at sign-in**.

Full background + verified root cause: memory `project_docs-auth-unification`.

**SSO mechanism (lean, decided during build):** NOT a shared package (course's next.config has
no `transpilePackages` + uses fumadocs `output: standalone`; extracting a raw-TS `better-auth`
package would force risky build changes onto the LIVE course auth). Instead docs runs its **own**
better-auth instance pointed at the **same user DB** (`DATABASE_URL` = course Postgres) + the
**same `BETTER_AUTH_SECRET`** + cookie `Domain=.hogsend.com` + mutual `trustedOrigins`. Same DB +
secret + cookie domain ⇒ sessions are shared across subdomains ⇒ true SSO, course untouched.
Config is ~duplicated from course; extracting to a shared package is a clean follow-up.

Status legend: `[ ]` todo · `[~]` built-to-seam (demoable in-repo, needs a human seam) · `[x]` done

---

## Phase 1 — Docs auth (own instance, shared session DB)

- [~] **1.0 Course cross-subdomain cookie (the one required course touch).** Add the same
  env-gated `advanced.crossSubDomainCookies` (`AUTH_COOKIE_DOMAIN` → `.hogsend.com`) +
  sibling `trustedOrigins` to `apps/course/lib/auth.ts`. Required for bidirectional SSO
  (course sets a host-only cookie today, which docs can't read). Env-gated so local course is
  unaffected. Seam: deploy course + docs together with the cookie-domain change (existing
  course sessions may need one re-login). Built together with 1.1–1.3 in one commit.
- [~] **1.1 Docs env plumbing.** `apps/docs/lib/env.ts` (fail-closed, build-safe placeholders like
  course): `BETTER_AUTH_SECRET`, `BETTER_AUTH_URL`, `DATABASE_URL` (= course user DB),
  `HOGSEND_INGEST_URL`, `HOGSEND_INGEST_KEY`, `HOGSEND_FEED_TOKEN_SECRET`, optional
  `GITHUB_CLIENT_ID/SECRET`, `AUTH_COOKIE_DOMAIN`, `COURSE_URL`/`RESEND_API_KEY`/`COURSE_FROM_EMAIL`.
- [~] **1.2 Docs DB client + better-auth schema.** `apps/docs/lib/db/schema.ts` = the 4 better-auth
  tables (identical DDL to course — same shared physical tables) + `lib/db/index.ts` (lazy postgres-js
  drizzle, dev global cache). Docs never migrates these (course owns them) — seam note in the doc.
- [~] **1.3 Docs better-auth instance.** `apps/docs/lib/auth.ts` (emailOTP 6-digit + magicLink +
  deleteUser + `signed_up` hook, mirroring course) with **cross-subdomain cookie** (`AUTH_COOKIE_DOMAIN`
  → `.hogsend.com`) + `trustedOrigins` [docs, course] + `lib/email.ts` (Resend senders) +
  `lib/events.ts` (`emitSignedUp`/`emitAccountDeleted` → dogfood ingest, EMAIL-keyed) +
  `app/api/auth/[...all]/route.ts`. Verify: docs typecheck/build; the auth handler mounts.
- [~] **1.4 Docs ingest bridge.** `apps/docs/lib/ingest.ts` (`forwardToIngest` + `foldContactIdentity`
  carrying `contactProperties.firstName` + `mintFeedToken`) + `app/api/hogsend-token/route.ts`
  (session → fold + mint userToken). Seam: live mint hits the dogfood engine `/v1/course/feed-token`.
- [~] **1.5 Docs sign-in UI.** `apps/docs/lib/auth-client.ts` + a `/sign-in` page reusing the course
  `SignInForm` shape (OTP + magic-link + optional GitHub) **plus a first-name field** (OTP/magic users
  have no name), persisted via `authClient.updateUser({ name })` post-sign-in. Verify the page renders.

## Phase 2 — Gate + identify the live demo

- [~] **2.1 DocsHogsendProvider (identified).** Mirror `CourseHogsendProvider`: fetch `/api/hogsend-token`,
  construct `HogsendProvider` with `{ userId, userToken }` (or anon when signed out). Seam: identified
  round-trip needs the dogfood engine + secrets.
- [~] **2.2 Session-gated demo.** `in-app-demo-live` (+ `in-app-demo-body`) require a real session;
  signed-out → "Log in to try it live" → `SignInForm`; signed-in → the fire buttons. Replace the old
  `signedUp`/`hs-demo-email` localStorage bool. Verify the gate renders both states.
- [~] **2.3 Identified captures + durable name.** Demo captures carry `userId` (identified, fork-safe
  after the fold); the fold persists the first name onto the contact; the greeting reads the session name.

## Phase 3 — Fix the attribution label (dogfood repo, separate commit)

- [ ] **3.1 `nameOf` reads the durable contact name** in `hogsend-dogfood/src/journeys/docs-inapp-demo.ts`
  so `link.clicked`'s Discord-mirror line shows the real person, not "a visitor". Now trivial: identified
  contact carries a name.

## Phase 4 — Follow-up engine hardening (separate engine release)

- [ ] **4.1 Thread `contactId` provenance through `pushLinkClickEvent`** / the non-email click branch
  (`click.ts:286`, `tracking-events.ts:234`) so any anon personal-link click folds into the resolved
  subject instead of minting a phantom `external_id` twin (`contacts.ts:219` never checks `anonymous_id`).
  Non-blocking; own engine semver release + changeset.

---

## Human seam asks (running list — filled as the loop hits seams)

- **[Phase 1] Provision docs Railway service env + deploy course & docs together.** Set on the
  docs service: `BETTER_AUTH_SECRET` (EXACT same value as course), `DATABASE_URL` (the course's
  user Postgres — a Railway private ref to the same DB), `BETTER_AUTH_URL=https://hogsend.com`,
  `AUTH_COOKIE_DOMAIN=.hogsend.com`, `AUTH_SIBLING_ORIGIN=https://course.hogsend.com`,
  `RESEND_API_KEY` (+ optional `DOCS_FROM_EMAIL`), `HOGSEND_INGEST_URL`, `HOGSEND_INGEST_KEY`,
  `HOGSEND_FEED_TOKEN_SECRET` (same as course), optional `GITHUB_CLIENT_ID/SECRET`. Set on the
  **course** service (new): `AUTH_COOKIE_DOMAIN=.hogsend.com`, `AUTH_SIBLING_ORIGIN=https://hogsend.com`.
  Deploy course + docs together; existing course sessions may need one re-login when the cookie
  goes domain-scoped. Then confirm SSO both directions (log in on one, be identified on the other)
  and that a real OTP/magic-link email arrives.
