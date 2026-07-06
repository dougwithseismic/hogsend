# @hogsend/react

## 0.38.1

### Patch Changes

- 1bd79ff: Fix: multi-step `once` journeys silently stalling after their first durable wait.

  On an eviction-capable Hatchet engine (hatchet-lite >= v0.80.0) every `ctx.sleep` / `ctx.waitForEvent` evicts the durable task and **replays the journey `fn` from the top** on resume. The enrollment guards (`entryLimit`, email-preference, `trigger.where`, `enabled` / admin-disable, active-state) ran at the top of `fn` **before** the replay-recovery lookup by `hatchetRunId`. So on every resume they re-ran against live state — and for `entryLimit: "once"` the entry-limit guard found the row the first entry had created and returned `skipped: already_entered_once`, short-circuiting **before** recovery and `run()`. The journey never advanced past its first wait: it was stranded in `waiting`, and every email / step after the first sleep was silently dropped (no error, no `journey:failed` — nothing sweeps a stuck `waiting` row). Multi-step `once` journeys (welcome series, conversion nudges) therefore stopped completing whenever a worker redeploy or eviction landed in a wait window; short / `unlimited` journeys were unaffected.

  The recovery lookup now runs **first**: a resume recovered by `hatchetRunId` reuses its enrollment and bypasses the entry-eligibility guards (a resume is not an entry), while those guards run only on the genuinely-new-enrollment path. The same guards that also affected `once_per_period` (wait shorter than the period) and unsubscribe-during-a-wait are fixed by the same reorder. Sends inside `run` still re-check subscription (`ctx.guard.isSubscribed()`), and the tracked mailer enforces suppression at send time, so bypassing the entry-time preference gate on a resume never emails an unsubscriber. Exactly-once is preserved: a recovered resume keeps the same `stateId` / run-anchored idempotency keys, so a replayed pre-wait send dedups via the existing unique-index backstop. Covered by a new regression test that evicts a `once` journey at its first sleep, replays from the top, and asserts it resumes and completes with no duplicate send.

- Updated dependencies [1bd79ff]
  - @hogsend/js@0.38.1

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
- Updated dependencies [27ca9ea]
- Updated dependencies [b7a4a2d]
  - @hogsend/js@0.38.0

## 0.37.3

### Patch Changes

- f9f9b2f: Fix the feed item's swipe-to-archive affordance colliding with tall, dynamic-height rows (e.g. an in-app survey's NPS option grid). The archive button is now pinned to the row's top-right — aligned with the always-short title — instead of the vertical center, so it no longer lands on top of a survey's answer row. The "Archive" swipe label is hidden unless the row is actually being swiped, and the swipe gesture is guarded against firing on a plain hover (a stale pointer origin previously set a false `data-swiping`, which leaked the label through the hover-tinted track).
- Updated dependencies [a1faed0]
  - @hogsend/js@0.37.3

## 0.37.2

### Patch Changes

- 19ba821: `@hogsend/react`: clean feed-notification truncation + a reveal animation. Long titles and bodies now clamp to a token-driven N-line ellipsis (`--hs-feed-item-title-lines` / `--hs-feed-item-body-lines`, default 2) instead of being ragged-clipped mid-line with shaved descenders; the inline survey block is left untouched. New feed items also fade + lift in as they mount (`--hs-feed-item-enter-ms`), gated behind `prefers-reduced-motion` and kept clear of the swipe-to-archive exit animation.
- Updated dependencies [19ba821]
  - @hogsend/js@0.37.2

## 0.37.1

### Patch Changes

- a9b12de: `@hogsend/react`: responsive in-app feed + survey card. The feed now sets its own type baseline so notification items don't balloon to a large host font-size, bodies are sized and muted for readability, and the `scale`/`nps` survey scale flows as a single shrink-to-fit row instead of wrapping into a ragged grid in narrow feeds (including the 380px bell popover).
- Updated dependencies [a9b12de]
  - @hogsend/js@0.37.1

## 0.37.0

### Minor Changes

- f21fb2b: In-app component kit — survey/rating primitive, preference center, swipe-to-archive, BYO toast, and a notification-badge fix.
  - **Survey / rating primitive** — a surface-neutral `<Survey>` email component and an in-app survey feed block (`SurveyBlockView`) plus `sendSurvey()`. Answers ride the existing event spine (no new write path) and are readable from journeys via `ctx.waitForEvent`. New read-only `GET /v1/admin/reporting/breakdown` aggregates any event by a property value (count, average, optional NPS).
  - **`<PreferenceCenter>`** — per-category × per-channel notification preferences over `usePreferences`, bundleable into `<FeedPopover>` as a tab. New read-only `GET /v1/lists` catalog.
  - **Swipe-to-archive** — brought into `@hogsend/react` as a first-class affordance (pointer/touch swipe + an accessible archive button, wired to the existing `markAsArchived`).
  - **Toast** — polished default skin and first-class custom rendering (`renderToast`).
  - **Notification bell badge** — fixed `box-sizing` so the unread count renders as a solid, pinned circle under any host CSS reset.

### Patch Changes

- Updated dependencies [f21fb2b]
  - @hogsend/js@0.37.0

## 0.36.1

### Patch Changes

- 3853800: fix(engine): provenance-pin engine-internal re-ingests so a contact's own canonical key never mints a phantom identified twin

  A server-side re-ingest keyed by `userId = <a contact's canonical key>` (which for an anonymous — or email+anon — contact IS its `anonymous_id`) was resolved through the value path, which only matches `external_id`, so it minted a second "identified" contact `{ external_id: <anonId> }`. That phantom twin then tripped the in-app feed's `collidesWithIdentified` guard, 403-ing the visitor out of their OWN feed (`anonymousId is not addressable`). The most direct trigger was the feed's own mark-read / mark-all re-ingests.

  Fix: engine-internal re-emit sites now carry the subject's unforgeable contact row id (`contactId`) and the resolver pins to that exact row (`resolveByContactId`, `FOR UPDATE`, follows merge-aliases to the survivor) — never value-resolving, never minting. The public `/v1/events`/`/v1/feed` routes cannot supply `contactId` (schemas omit it, handlers build the resolve literally, and it's mutually exclusive with the publishable clamp), so the anti-impersonation boundary is unchanged and `collidesWithIdentified` stays strict. Threaded through `ingestEvent` + the feed mark/clear re-ingests; genuine external identities (no `contactId`) take the unchanged value path.

- Updated dependencies [3853800]
  - @hogsend/js@0.36.1

## 0.36.0

### Minor Changes

- 02dab59: Client-side layer: `@hogsend/js` (zero-dependency browser core — identity, capture, preferences, in-app feed, banners, toasts, reactive store) and `@hogsend/react` (provider, hooks, and the `NotificationBell`/`FeedPopover`/`NotificationFeed`/`Banner`/`Toast` components with a `--hs-*` themed override surface), plus the engine pieces that power them:
  - Publishable-key (`pk_`) browser-ingest auth (`requirePublishableOrIngest`, per-key origin allowlist, `allowed_origins` migration, reflective CORS, `GET /v1/lists/preferences`).
  - The in-app feed backend: `feed_items` table, `sendFeedItem()` + `send-feed` workflow, recipient-scoped `/v1/feed/*` routes with SSE fan-out.
  - `sendBanner()` on the feed primitive, and the server-side `generateUserToken` mint helper for identified browser sessions.

  Every client interaction is a first-party `inapp.*`/`banner.*` event through the ingest spine, so it can trigger a journey and fan to PostHog. `@hogsend/js` and `@hogsend/react` ride the engine version line but are opt-in (not `create-hogsend` scaffold defaults).

### Patch Changes

- Updated dependencies [02dab59]
  - @hogsend/js@0.36.0
