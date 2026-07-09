# @hogsend/js

## 0.40.0

### Minor Changes

- 4ebdcb9: Campaigns grow up into schedulable, code-first broadcasts.
  - **`sendAt` scheduling** — `POST /v1/campaigns` accepts a future ISO instant; the campaign is created `scheduled` and delivered by a punctual Hatchet scheduled run, with the reaper cron promoting any due-but-unfired row as backstop. A `sendAt` more than 60s in the past is rejected.
  - **`defineCampaign()`** — a broadcast as a committed file. The worker's boot reconciler upserts each definition (keyed `campaign-def:<id>`): future `sendAt` schedules, edits to a still-`scheduled` campaign sync on redeploy (moving `sendAt` re-schedules), a stale `sendAt` at first deploy is marked `expired` (never a surprise blast, grace window `CAMPAIGN_DEFINE_GRACE_MS` default 1h), and a `sent` campaign is retired — redeploys no-op. Wire via `createHogsendClient({ campaigns })`.
  - **Cancel** — `POST /v1/campaigns/{id}/cancel` cancels a `scheduled`/`queued`/`sending` campaign. A mid-send cancel stops at the next chunk boundary; completion uses a CAS so a cancel racing the final chunk is never overwritten. New statuses: `scheduled`, `canceled`, `expired` (db migration 0036 adds `scheduled_at`/`canceled_at`).
  - **List** — `GET /v1/campaigns?status=&limit=&offset=` (newest first, `hasMore`).
  - **Studio** — new Campaigns view (admin routes `GET/POST /v1/admin/campaigns...`): statuses, counts, scheduled-for, cancel.
  - **SDK** — `hs.campaigns.send({ sendAt, idempotencyKey })` (the key was previously accepted by the route but dropped by the SDK), `hs.campaigns.list()`, `hs.campaigns.cancel(id)`.
  - **CLI** — `hogsend campaigns send --at <iso> --idempotency-key <k>`, `campaigns list --status`, `campaigns cancel <id>`.
  - **Fixes** — the route/reaper enqueued sends with `.run()` (which waits for the whole blast to finish inside the request / cron timeout); now `runNoWait()`. The keyed create's `ON CONFLICT` now carries the partial-index predicate (`WHERE idempotency_key IS NOT NULL`) — without it Postgres rejected the insert (42P10).

### Patch Changes

- ee4518f: Give the engine's Better Auth its own cookie namespace so the Studio stops fighting a sibling web app's SSO cookie.

  The engine's Better Auth (the Studio, e.g. `t.hogsend.com`) used Better Auth's default cookie name (`__Secure-better-auth.session_token`) with no prefix. A sibling web app on the shared parent domain can set a cross-subdomain SSO cookie of that SAME default name (e.g. `crossSubDomainCookies: { domain: ".hogsend.com" }`), which the browser also delivers to the Studio host. The engine reads it under the shared name, looks the token up in its OWN database — a different DB — finds nothing, and `get-session` returns null, so the Studio bounces back to login in a loop even though the user "has a session" on the sibling app.

  The engine now sets `advanced.cookiePrefix`, so its session cookie is `__Secure-hogsend.session_token` (dev/http: `hogsend.session_token`) and no longer collides. The prefix is configurable via a new optional env `AUTH_COOKIE_PREFIX` (default `"hogsend"`), plumbed `env.ts → container.ts → createAuth`. This is server-config-only — no client, middleware, or literal cookie-name changes: every consumer resolves the session through `auth.api.getSession(...)`, which derives the prefixed name from the same options.

  Any sibling web app that intentionally shares a cross-subdomain cookie keeps Better Auth's default prefix, so its own single-sign-on is fully preserved; the two cookies simply no longer share a name.

  Note: renaming the cookie logs existing Studio sessions out ONCE (they must sign in again to mint a cookie under the new name). There is no database migration — session rows are untouched, and the old cookie lingers ignored until it expires. CLI-created and `STUDIO_ADMIN_*` bootstrap admins are unaffected. `AUTH_COOKIE_PREFIX` does not need to be set on any deploy; the `"hogsend"` default is authoritative.

## 0.39.0

### Minor Changes

- aa3eedc: Boot-validate config ids — fail loud on unresolved references instead of silently mis-behaving.
  - `ANALYTICS_PROVIDER`: throw at boot when the env-selected id resolves to no registered provider (symmetric with `EMAIL_PROVIDER`); the raw `process.env` read distinguishes an explicit request from the zod default, so a no-analytics deploy still boots.
  - `ENABLED_JOURNEYS`: throw at boot on an id that matches no journey, with a did-you-mean. Bucket-reaction journey ids are accepted; validation is skipped when no top-level journeys are injected.
  - `JourneyRegistry.register()`: throw on a duplicate journey id instead of silently overwriting (which also double-routed the trigger).
  - Template `category`: boot-validate every template's category against the email-list namespace. Unknown → throw; an opt-IN list (`defaultOptIn:false`) excluded via `ENABLED_LISTS` → throw (excluding it un-gates consent at send time — CAN-SPAM/GDPR); an opt-OUT list excluded → warn; reserved built-ins and registered lists → ok.
  - `POST /v1/emails`: reject an unknown `category` (the request-time twin of the template-category guard — a caller-supplied category overrides the template's).

- b3bb1f6: Fail the build on unregistered journey email template keys.

  `sendEmail`'s `template` is now typed against the registered-key union
  (`TemplateName`) instead of `string`, so a journey referencing an email template
  that was never registered is a compile error at every send site. As a runtime
  backstop, `@hogsend/email`'s `getTemplate` / `getTemplateDefinition` /
  `getPreviewText` throw a loud, actionable error naming the bad key and the
  registered ones (an own-property check, so inherited `Object.prototype` keys
  can't slip through). Fixes the class of bug where a journey could point at a
  template that doesn't exist and only fail when a real send ran.

## 0.38.2

### Patch Changes

- e059b87: Harden long-running journeys against two narrow strand windows (both distinct from the recovery-first fix in the previous release).
  - **Durable-wait resumes survive a redeploy's slot saturation.** The journey task now sets `scheduleTimeout: "15m"` (the SDK default is ~5m). When a durable-wait resume is re-queued during a deploy and every worker slot is momentarily busy, the tighter default could cancel the resume in the queue and strand the enrollment in `waiting`; 15m gives it head-room to land on a freed slot. This adds no replay path — it is pure queue head-room.
  - **A transient DB error while resolving the enrollee's timezone no longer strands the row.** The pre-`run()` timezone lookup fetches the contact row and PostHog person props concurrently; the PostHog leg already swallowed errors but the contact read did not, so a blip there rejected out of the task _before_ the try/catch and left the just-inserted `active` row unhandled. The contact read now falls through to the client-default timezone, mirroring the PostHog leg.

  Journey `retries` are intentionally left at `0`: a retry replays `run()` from the top, and the tracked mailer / connector delivery is "missed > doubled" (it re-drives a `queued` row and voids the idempotency key of a failed send), so enabling retries would re-deliver any message whose `provider.send()` had already gone out before its durable status flip committed. Making sends provider-idempotent is a prerequisite and is tracked separately.

## 0.38.1

### Patch Changes

- 1bd79ff: Fix: multi-step `once` journeys silently stalling after their first durable wait.

  On an eviction-capable Hatchet engine (hatchet-lite >= v0.80.0) every `ctx.sleep` / `ctx.waitForEvent` evicts the durable task and **replays the journey `fn` from the top** on resume. The enrollment guards (`entryLimit`, email-preference, `trigger.where`, `enabled` / admin-disable, active-state) ran at the top of `fn` **before** the replay-recovery lookup by `hatchetRunId`. So on every resume they re-ran against live state — and for `entryLimit: "once"` the entry-limit guard found the row the first entry had created and returned `skipped: already_entered_once`, short-circuiting **before** recovery and `run()`. The journey never advanced past its first wait: it was stranded in `waiting`, and every email / step after the first sleep was silently dropped (no error, no `journey:failed` — nothing sweeps a stuck `waiting` row). Multi-step `once` journeys (welcome series, conversion nudges) therefore stopped completing whenever a worker redeploy or eviction landed in a wait window; short / `unlimited` journeys were unaffected.

  The recovery lookup now runs **first**: a resume recovered by `hatchetRunId` reuses its enrollment and bypasses the entry-eligibility guards (a resume is not an entry), while those guards run only on the genuinely-new-enrollment path. The same guards that also affected `once_per_period` (wait shorter than the period) and unsubscribe-during-a-wait are fixed by the same reorder. Sends inside `run` still re-check subscription (`ctx.guard.isSubscribed()`), and the tracked mailer enforces suppression at send time, so bypassing the entry-time preference gate on a resume never emails an unsubscriber. Exactly-once is preserved: a recovered resume keeps the same `stateId` / run-anchored idempotency keys, so a replayed pre-wait send dedups via the existing unique-index backstop. Covered by a new regression test that evicts a `once` journey at its first sleep, replays from the top, and asserts it resumes and completes with no duplicate send.

## 0.38.0

### Minor Changes

- b7a4a2d: Bulk suppression-list import + migration importer CLI.

  **Engine — `POST /v1/admin/suppressions/import`** (+ `GET /v1/admin/suppressions/import/{jobId}`): async bulk import of unsubscribes / bounces / spam complaints via a new `import-suppressions` Hatchet task (CSV or JSON, batches of 500, `import_jobs` lifecycle, errors capped at 100). Rows are `email` (required), `reason` (`unsubscribed` | `bounced` | `complained`, default `unsubscribed`), `externalId` (optional), mapped onto the existing `email_preferences` semantics — no schema change: `unsubscribed` → `unsubscribed_all`, `bounced` → `suppressed` + `bounce_count = GREATEST(bounce_count, 1)` (idempotent re-runs) + bounce timestamps, `complained` → `suppressed` with the bounce count untouched. Writes go through the single `upsertEmailPreference` choke point, which gains an `emitOutbound` opt-out (default `true`; the import passes `false`) so a historical import does not fan out per-row `contact.unsubscribed` outbound events.

  **Behavior change — `POST /v1/admin/contacts/import` no longer awaits the task run.** The route previously `await`ed `importContactsTask.run(...)` to completion before returning its 202, defeating the async job + status-poll contract on large imports. Both import routes now enqueue with `runNoWait()` fire-and-forget: the 202 means "queued", and a failed enqueue marks the job row `failed` (with the error recorded) so status pollers get a terminal state. Both routes also cap `data` at 4MB — the Hatchet gRPC message ceiling a bigger payload could never clear anyway.

  **Send-time suppression gate aggregates per address.** `checkSuppression` now reads every `email_preferences` row for the recipient address (the PK is `(user_id, email)`, so a suppression imported before the contact existed lives on a different row than later interactive writes) — any suppressed / unsubscribed-all signal on any row blocks the send, and category maps merge with explicit false winning.

  **CLI — new `hogsend import` command** (`@hogsend/cli`): migrates contacts _and_ suppression state into a running instance over the admin API, chunking large inputs into one import job per 5,000 rows and polling each to completion. `hogsend import csv --file <path> [--suppressions]` for generic header CSVs; `hogsend import loops --csv <audience.csv> [--api-key] [--check-suppressions]` for the Loops dashboard export (typed custom properties via the Loops API; per-contact suppression lookups at 10 req/s, imported as reason `bounced` since Loops merges bounces + complaints); `hogsend import customerio --app-key <key> [--region us|eu] [--segment <id>] [--esp-suppressions]` drives the Customer.io App API async people export end-to-end and optionally imports the ESP bounce/spam-report lists. Source-platform requests are rate-limited (10 req/s) with retry-on-429 backoff. Job polling aborts with an error (naming the job id) after 10 minutes without progress instead of hanging forever; the Loops suppression check aborts on auth/terminal errors rather than silently importing zero suppressions; the Customer.io export download inflates gzipped files.

  Other engine-line packages ride along to keep the version line uniform.

### Patch Changes

- 27ca9ea: Consent-gated storage seam: `@hogsend/js` now exports its storage adapters
  (`createMemoryStorage`, `createLocalStorage`) and `HogsendProvider` accepts a
  `storage` prop forwarded to `createHogsend` — so a host app can keep the SDK
  from persisting `hs_anon_id` until the visitor grants cookie/storage consent
  (pass a memory or consent-gated adapter), matching the cookieless-until-consent
  pattern already used for PostHog. Other engine-line packages ride along to
  keep the version line uniform.

## 0.37.3

### Patch Changes

- a1faed0: Keep the engine version line uniform: bump every engine-line package (and the `create-hogsend` scaffolder) alongside the `@hogsend/react` feed-archive fix, so all `@hogsend/*` packages publish on one version and the scaffold's `^{{ENGINE_VERSION}}` caret pins stay aligned.

## 0.37.2

### Patch Changes

- 19ba821: `@hogsend/react`: clean feed-notification truncation + a reveal animation. Long titles and bodies now clamp to a token-driven N-line ellipsis (`--hs-feed-item-title-lines` / `--hs-feed-item-body-lines`, default 2) instead of being ragged-clipped mid-line with shaved descenders; the inline survey block is left untouched. New feed items also fade + lift in as they mount (`--hs-feed-item-enter-ms`), gated behind `prefers-reduced-motion` and kept clear of the swipe-to-archive exit animation.

## 0.37.1

### Patch Changes

- a9b12de: `@hogsend/react`: responsive in-app feed + survey card. The feed now sets its own type baseline so notification items don't balloon to a large host font-size, bodies are sized and muted for readability, and the `scale`/`nps` survey scale flows as a single shrink-to-fit row instead of wrapping into a ragged grid in narrow feeds (including the 380px bell popover).

## 0.37.0

### Minor Changes

- f21fb2b: In-app component kit — survey/rating primitive, preference center, swipe-to-archive, BYO toast, and a notification-badge fix.
  - **Survey / rating primitive** — a surface-neutral `<Survey>` email component and an in-app survey feed block (`SurveyBlockView`) plus `sendSurvey()`. Answers ride the existing event spine (no new write path) and are readable from journeys via `ctx.waitForEvent`. New read-only `GET /v1/admin/reporting/breakdown` aggregates any event by a property value (count, average, optional NPS).
  - **`<PreferenceCenter>`** — per-category × per-channel notification preferences over `usePreferences`, bundleable into `<FeedPopover>` as a tab. New read-only `GET /v1/lists` catalog.
  - **Swipe-to-archive** — brought into `@hogsend/react` as a first-class affordance (pointer/touch swipe + an accessible archive button, wired to the existing `markAsArchived`).
  - **Toast** — polished default skin and first-class custom rendering (`renderToast`).
  - **Notification bell badge** — fixed `box-sizing` so the unread count renders as a solid, pinned circle under any host CSS reset.

## 0.36.1

### Patch Changes

- 3853800: fix(engine): provenance-pin engine-internal re-ingests so a contact's own canonical key never mints a phantom identified twin

  A server-side re-ingest keyed by `userId = <a contact's canonical key>` (which for an anonymous — or email+anon — contact IS its `anonymous_id`) was resolved through the value path, which only matches `external_id`, so it minted a second "identified" contact `{ external_id: <anonId> }`. That phantom twin then tripped the in-app feed's `collidesWithIdentified` guard, 403-ing the visitor out of their OWN feed (`anonymousId is not addressable`). The most direct trigger was the feed's own mark-read / mark-all re-ingests.

  Fix: engine-internal re-emit sites now carry the subject's unforgeable contact row id (`contactId`) and the resolver pins to that exact row (`resolveByContactId`, `FOR UPDATE`, follows merge-aliases to the survivor) — never value-resolving, never minting. The public `/v1/events`/`/v1/feed` routes cannot supply `contactId` (schemas omit it, handlers build the resolve literally, and it's mutually exclusive with the publishable clamp), so the anti-impersonation boundary is unchanged and `collidesWithIdentified` stays strict. Threaded through `ingestEvent` + the feed mark/clear re-ingests; genuine external identities (no `contactId`) take the unchanged value path.

## 0.36.0

### Minor Changes

- 02dab59: Client-side layer: `@hogsend/js` (zero-dependency browser core — identity, capture, preferences, in-app feed, banners, toasts, reactive store) and `@hogsend/react` (provider, hooks, and the `NotificationBell`/`FeedPopover`/`NotificationFeed`/`Banner`/`Toast` components with a `--hs-*` themed override surface), plus the engine pieces that power them:
  - Publishable-key (`pk_`) browser-ingest auth (`requirePublishableOrIngest`, per-key origin allowlist, `allowed_origins` migration, reflective CORS, `GET /v1/lists/preferences`).
  - The in-app feed backend: `feed_items` table, `sendFeedItem()` + `send-feed` workflow, recipient-scoped `/v1/feed/*` routes with SSE fan-out.
  - `sendBanner()` on the feed primitive, and the server-side `generateUserToken` mint helper for identified browser sessions.

  Every client interaction is a first-party `inapp.*`/`banner.*` event through the ingest spine, so it can trigger a journey and fan to PostHog. `@hogsend/js` and `@hogsend/react` ride the engine version line but are opt-in (not `create-hogsend` scaffold defaults).
