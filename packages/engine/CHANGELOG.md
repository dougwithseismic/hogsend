# @hogsend/engine

## 0.9.0

### Minor Changes

- 7229385: feat: outbound destinations on the delivery spine (PostHog/Segment/Slack)

  Turns the durable outbound webhook spine into a fan-out engine: a new
  `kind` column on `webhook_endpoints` selects a delivery-time TRANSFORM adapter,
  so a keyed destination (PostHog, Segment, Slack, or a code-defined
  `defineDestination()`) reuses ALL the existing retry/backoff/DLQ/reaper/CAS
  machinery — only the per-vendor HTTP projection differs. The default
  `kind="webhook"` signed Standard-Webhooks POST is byte-identical to before.
  `@hogsend/client` and `@hogsend/engine` move together on this version line so
  the SDK types can never describe a server response shape the engine does not
  yet return.

  ## Consumer-visible behavioral changes (read before upgrading)

  - **BREAKING: `ctx.posthog.capture` and `ctx.identify` were REMOVED from the
    journey context.** These were single-vendor, fire-and-forget PostHog shims;
    they no longer exist on `JourneyContext` (`@hogsend/core`). Now that PostHog is
    just one outbound DESTINATION among many, the journey context exposes only
    vendor-neutral orchestration primitives (`sleep`, `sleepUntil`, `when`,
    `waitForEvent`, `checkpoint`, `trigger`, `guard`, `history`). To send the
    lifecycle catalog (`contact.*`, `email.*`, `journey.completed`, `bucket.*`) to
    PostHog/Segment/Slack/a CRM, configure an outbound destination. For a custom
    journey signal, fire `ctx.trigger()` (it joins the internal pipeline) and
    capture it where you detect it via your app's PostHog SDK. The `PostHogService`
    provider itself is unchanged and still load-bearing for the identity PULL
    (`getPersonProperties` → timezone resolution) and the opt-in
    `bucket.syncToPostHog` person-property mirror.

  - **Open/click are now PER-HIT, not first-touch.** Previously `email.opened` /
    `email.clicked` emitted exactly ONCE per send (a first-touch gate plus a
    per-send `dedupeKey` of `email.opened:<id>` / `email.clicked:<id>`). They now
    emit on EVERY open and EVERY click with NO `dedupeKey`, so every hit is a
    distinct delivery to every subscribed endpoint. This is intentional — every
    destination must receive every engagement event — and it is the right shape
    for product-analytics destinations (PostHog/Segment per-hit funnels). The
    per-delivery wire bytes for `kind="webhook"` subscribers are UNCHANGED, but a
    live subscriber to `email.opened` / `email.clicked` will now receive many
    deliveries per send instead of one. This is defensible under the documented
    at-least-once + `Webhook-Id` dedup model (each delivery still carries a unique
    `Webhook-Id`), but it is NOT a no-op for existing production endpoints
    subscribed to those two events — size your consumer + dedup accordingly. The
    row-level `emailSends.openedAt` / `clickedAt` first-touch state is unchanged.

  - **`@hogsend/client` outbound-webhook return types gained nullability** to
    model keyed destinations (which carry no signing secret). `WebhookEndpoint.secretPrefix`
    is now `string | null` (null for `kind !== "webhook"`), and
    `CreatedWebhookEndpoint` is now `WebhookEndpoint & { secret?: string }` (the
    full secret is present only for `kind="webhook"`). Under `strictNullChecks`,
    consumer code that read `endpoint.secretPrefix` as a non-null `string`, or
    `created.secret` as a guaranteed `string` on the create/rotate "store it now"
    flow, will get a TS error — narrow before use (the secret is still always
    present for `kind="webhook"` creates at runtime). This ships in lockstep with
    the engine route change that makes the server actually return those nulls.

  - **The admin `kind` enum now accepts every shipped preset.** `POST`/`PATCH
/v1/admin/webhooks` previously rejected `kind` values other than
    `"webhook"`/`"posthog"` with a 400; it now accepts any shipped preset id
    (`webhook`, `posthog`, `segment`, `slack`), derived from `PRESET_DESTINATIONS`
    so the catalog stays the single source of truth. This makes the
    admin-API / `hs.webhooks` SDK path documented in the destinations skill +
    `env.example` actually reachable for `segment`/`slack` endpoints (a `kind`
    whose transform is not registered at delivery still DLQs as a config error).

  ## What's new

  - `defineDestination()` + a `DestinationRegistry`, threaded into
    `createHogsendClient({ destinations })` and `createWorker`. Four shipped
    presets: `webhook` (default), `posthog`, `segment`, `slack`.
  - `ENABLED_DESTINATION_PRESETS` env (csv / `*` / `none`) selects which optional
    presets register; `webhook` + `posthog` are always on. Destination credentials
    are per-endpoint in `webhook_endpoints.config`, never env vars.
  - `ENABLE_POSTHOG_DESTINATION` auto-seeds one `kind="posthog"` endpoint on the
    email funnel so the full email lifecycle fans out to PostHog DURABLY.
  - A new `hogsend-authoring-destinations` skill.

### Patch Changes

- Updated dependencies [7229385]
  - @hogsend/db@0.9.0
  - @hogsend/core@0.9.0
  - @hogsend/email@0.9.0
  - @hogsend/plugin-posthog@0.9.0
  - @hogsend/plugin-resend@0.9.0

## 0.8.0

### Minor Changes

- e2e254c: feat: outbound webhooks + integration presets

  Adds a Svix-style HMAC-signed outbound webhook stream — a 12-event catalog,
  managed endpoints (`/v1/admin/webhooks` CRUD + rotate-secret + test), and
  durable delivery (per-endpoint retry/backoff, dead-letter, and a 1-minute
  reaper that re-drives due retries and recovers orphaned `sending` rows). The
  `hs.webhooks.*` client resource ships with `verifyHogsendWebhook` (svix +
  node:crypto fallback), and the CLI gains a `hogsend webhooks` command.

  Adds inbound integration presets (Clerk, Supabase `auth.users`, Stripe,
  Segment) as `defineWebhookSource` presets, enabled by env. The webhook-source
  auth contract is widened to a discriminated union with a fail-closed
  `signature` scheme (svix / Stripe `node:crypto` / generic HMAC-hex), and the
  route reads the raw body once so signatures verify against the exact bytes.

  All engine-line packages move together on the version line so the scaffold's
  caret pins keep resolving.

### Patch Changes

- Updated dependencies [e2e254c]
  - @hogsend/db@0.8.0
  - @hogsend/core@0.8.0
  - @hogsend/email@0.8.0
  - @hogsend/plugin-posthog@0.8.0
  - @hogsend/plugin-resend@0.8.0

## 0.7.0

### Minor Changes

- Front door: public data-plane API + client SDK.

  Adds the public `/v1` data plane — `contacts` (upsert/find/delete), `events`,
  `emails` (transactional), `lists`, and `campaigns` (broadcast to a list or
  bucket) — behind an API key with a new orthogonal `ingest` scope, plus the new
  `@hogsend/client` SDK. Identity gains email/anonymous keys with a real
  merge/alias resolver (anonymous→identified). Lists are code-defined over the
  existing preference store; campaigns are durable, idempotent, preference-checked
  broadcasts. The CLI moves onto the engine version line and gains write commands.

  The unauthenticated `POST /v1/ingest` is removed — use `POST /v1/events`.
  Event properties no longer merge onto the contact: `contactProperties` write to
  the contact, `eventProperties` to the event (trigger/exit conditions).

### Patch Changes

- Updated dependencies
  - @hogsend/db@0.7.0
  - @hogsend/core@0.7.0
  - @hogsend/email@0.7.0
  - @hogsend/plugin-posthog@0.7.0
  - @hogsend/plugin-resend@0.7.0

## 0.6.0

### Minor Changes

- cd86e13: Bucket lifecycle: colocated reactions + member access on `defineBucket`

  - Typed transition refs `bucket.entered` / `bucket.left` (literal-typed off the
    bucket's own id) usable directly as journey `trigger` / `exitOn` values.
  - Colocated reactions `bucket.on("enter" | "leave" | "dwell", opts?, handler)`
    that desugar to tagged durable journeys with the full `JourneyContext`.
  - `dwell` reactions driven by the reconcile cron over the existing active
    population, with a historical `dwellAnchorAt` derived during backfill so dwell
    fires for the genuinely long-dwelling population on first deploy.
  - Member access `bucket.count()` / `has()` / `members()` / `membersIterator()`.
  - Studio groups generated reactions under their bucket via `sourceBucketId`.

  Deprecates (kept for one release) the hand-maintained `BucketId` union and the
  `bucketEntered` / `bucketLeft` string helpers in favour of the typed refs. The
  scaffold drops the re-widening `DefinedBucket[]` annotation so literal ids infer.

### Patch Changes

- Updated dependencies [cd86e13]
  - @hogsend/core@0.6.0
  - @hogsend/db@0.6.0
  - @hogsend/email@0.6.0
  - @hogsend/plugin-posthog@0.6.0
  - @hogsend/plugin-resend@0.6.0

## 0.5.0

### Minor Changes

- 8e7d7a2: Add engine-owned, TTY-aware boot output. On an interactive `pnpm dev` the API and worker now print a minimal branded banner — magenta badge, `engine` + `api` versions, loaded journeys·buckets·templates, schema status, and the API/Docs/Studio/Guides links plus a next-step hint. In production, CI, and tests they instead emit a single structured `… ready` log line, so log scraping is unchanged. The previously-scattered registry/studio/server boot logs drop to `debug`, making the banner the single source of truth on startup.

  New public exports: `reportApiReady`, `reportWorkerReady`, `getEngineVersion`. The running engine version is read at runtime from the package manifest (adds a `./package.json` entry to `exports`), falling back to `"unknown"` only if that read ever fails.

- f4e604e: Relocate the capability-provider contracts to `@hogsend/core`. The `EmailProvider`
  and `PostHogService` interfaces (and their supporting types — `SendEmailOptions`,
  `BatchEmailItem`, `SendResult`, `WebhookEvent`, `WebhookEventType`,
  `WebhookHandlerMap`, `CaptureOptions`) now live in `@hogsend/core` and are
  re-exported from `@hogsend/engine` as the canonical author import. The vendor
  plugins (`@hogsend/plugin-resend`, `@hogsend/plugin-posthog`) re-export them
  unchanged, so existing imports keep working — no breaking changes. A custom email
  provider now implements `import type { EmailProvider } from "@hogsend/engine"`
  (the contract no longer lives inside the Resend package). See
  `docs/adr/0001-provider-boundary.md`.

  Also makes the injected provider/analytics instances load-bearing: a swapped
  `opts.analytics` is now honored in journey context, the bucket→PostHog sync, and
  worker shutdown (previously these bypassed it via the module singleton), and the
  built-in `send-email` task and alert notifications now deliver through the
  injected `EmailProvider` instead of constructing a raw Resend client — so a
  swapped provider takes effect everywhere. The `send-email` task no longer
  double-retries on top of the provider's own retry loop.

- cdc7743: Surface worker connectivity. The worker now publishes a TTL'd Redis heartbeat, and `GET /v1/health` reports a `components.worker` status (`up`/`down` + `lastSeenAt`) derived from it — so the API and Studio can tell whether a worker is actually connected, instead of journeys silently not firing when no worker is running. The field is informational and does **not** affect the API's own `status` (the worker is a separate service, so its absence must not fail the API healthcheck). Best-effort: a Redis-less deploy reads `worker.status: "down"` and never crashes the worker.

### Patch Changes

- Updated dependencies [f4e604e]
- Updated dependencies [f4e604e]
  - @hogsend/core@0.5.0
  - @hogsend/plugin-resend@0.5.0
  - @hogsend/plugin-posthog@0.5.0
  - @hogsend/db@0.5.0
  - @hogsend/email@0.5.0

## 0.4.0

### Minor Changes

- 0db58c6: Add `ctx.waitForEvent({ event, timeout })` — a durable journey primitive that pauses a journey until the enrolled user emits a specific event (or a timeout elapses), then resumes. The wait is user-scoped and forward-looking; an `exitOn` match (or cancellation) during the wait aborts the run cleanly via `JourneyExitedError`, marks the state `"exited"`, and cancels the in-flight Hatchet run so no post-wait side effects fire. Also hardens `exitOn` to cancel suspended `ctx.sleep`/`ctx.waitForEvent` runs instead of letting them resume after exit.

### Patch Changes

- Updated dependencies [0db58c6]
- Updated dependencies [0db58c6]
  - @hogsend/db@0.4.0
  - @hogsend/email@0.4.0
  - @hogsend/plugin-posthog@0.4.0
  - @hogsend/plugin-resend@0.4.0
  - @hogsend/core@0.4.0

## 0.3.0

### Minor Changes

- aac7394: Buckets feature-complete — fluent criteria builder, dormancy joins, and a journey-aligned `entryLimit` rename

  Rounds the Buckets primitive out to a complete dynamic-membership feature and aligns its vocabulary with journeys.

  **BREAKING (cheap now, at ~zero adoption): `reentry` → `entryLimit`.** `BucketMeta.reentry`/`reentryPeriod` are renamed to `entryLimit`/`entryPeriod` to match `defineJourney` exactly (same `"once" | "once_per_period" | "unlimited"` values). The `/v1/admin/buckets` responses use the new keys too. Rename the field in your `defineBucket` calls. Note: on a bucket, `entryLimit` throttles the emitted `bucket:entered` _event_ — membership itself is always live (it re-computes every time criteria match); the journey a bucket triggers has its own `entryLimit` for enrollment.

  - `@hogsend/core` — `defineBucket` `criteria` now accepts a fluent builder
    `(b) => b.all(b.event(X).exists(), b.event(X).within(days(7)).notExists())`
    alongside the declarative `ConditionEval` tree. It runs once at definition time
    and returns the same canonical data, so registry indexes, schema validation,
    the reconcile cron, and Studio are unaffected. The declarative form still works.
  - `@hogsend/engine` — absence-shaped buckets auto-enable the cron join path so
    lapsed-active "went dormant" buckets materialize ongoing without a config flag
    (opt out with `reconcileJoins: false`); single-event and composite absence
    joins are bounded by an exists-ever floor that excludes never-active users.
    Precise `entryLimit: "once_per_period"` — the `bucket:entered:<id>` emit is
    suppressed until `entryPeriod` has elapsed since the most-recent prior leave
    (membership + `entryCount` still advance; an undefined `entryPeriod` emits as
    before). **Boot-time backfill now actually fires** — it was previously placed
    after the blocking `worker.start()` and never ran; it is now triggered before
    the listener (fire-and-forget) so new/changed buckets seed existing matching
    contacts on deploy (silently, no `bucket:entered`), with entry-count and
    live-contact parity. Registering `kind:"manual"` throws at startup
    (`not implemented in v1`) instead of registering a silently-inert bucket.
  - `@hogsend/studio` — the bucket detail panel surfaces `maxDwell` as a
    `Time-boxed · <dwell>` badge.
  - `create-hogsend` — the scaffold's example bucket uses `entryLimit`.

  No new migration — `max_dwell_at`, `left_at`, and `criteria_hash` already exist.
  The canonical `went-dormant` example is now a lapsed-active composite (active at
  some point, but not in the last 7 days), so it excludes never-active signups.

  Hardening (from a full pre-release review): the cron join path is gated by
  `entryLimit` (no re-emit on every tick after re-dormancy); a brand-new absence
  bucket does NOT blast historically-dormant users into journeys (the cron join
  path waits for the first-time backfill to claim them silently); the safe absence
  shapes (single-event `not_exists within` and the lapsed-active composite) join
  via an exact set-based query (no per-member starvation), and other absence
  composites require an explicit `reconcileJoins: true`; backfill and cron agree on
  never-active exclusion; composite backfill is keyset-paged. Deferred to 0.3.1
  (non-gating): parallelizing the per-event candidate evaluation on the ingest hot
  path, and dedicated indexes (`user_events(event, occurred_at, user_id)` and an
  `entryLimit` cooldown index).

### Patch Changes

- Updated dependencies [aac7394]
  - @hogsend/core@0.3.0

## 0.2.0

### Minor Changes

- 31e5ed7: Add Buckets — first-class, code-defined segments with real-time membership

  `defineBucket()` introduces named membership groups as a peer primitive to
  journeys. A user joins a bucket the moment their data satisfies its criteria and
  leaves when it stops; each transition emits `bucket:entered` / `bucket:left`
  (plus per-bucket aliases `bucket:entered:<id>` / `bucket:left:<id>`) through the
  ingest pipeline, so a bucket join/leave can trigger a journey via the journey's
  `trigger.event` (Hatchet `onEvents`). Criteria reuse the existing `@hogsend/core`
  condition engine.

  - `@hogsend/core` — `BucketMeta`, `bucketMetaSchema`, and `BucketRegistry`
    (event/property indexes for candidate narrowing).
  - `@hogsend/db` — `bucket_memberships` (re-entry-safe partial unique active
    index) and `bucket_configs` tables on the engine migration track.
  - `@hogsend/engine` — `defineBucket`, real-time inclusion/exclusion evaluation
    inside the ingest pipeline (recursion-guarded, transition-only emission), an
    engine-owned cron reconciliation for time-based/absence leaves, opt-in
    fast-expiry timers, an unconditional `maxDwell` membership TTL (force-leave N
    after joining regardless of criteria; re-entry governed by `reentry`), backfill
    - criteria-change re-evaluation, admin routes (`/v1/admin/buckets`), an optional
      off-by-default PostHog person-property sync, and `buckets` / `ENABLED_BUCKETS`
      wiring on `createHogsendClient` and `createWorker`.
  - `@hogsend/studio` — an observe-only Buckets view (size, enter/leave over time,
    which journeys a bucket feeds).
  - `create-hogsend` — the scaffold template ships a `src/buckets/` example and the
    client/worker wiring.

  All changes are additive; existing journeys, the engine factories, and consumer
  types are unaffected. Consumers pick up a new engine-track migration applied by
  the standard pre-deploy `db:migrate`.

### Patch Changes

- Updated dependencies [31e5ed7]
  - @hogsend/core@0.2.0
  - @hogsend/db@0.2.0

## 0.1.1

### Patch Changes

- Updated dependencies [3601a18]
  - @hogsend/email@0.1.0
  - @hogsend/plugin-posthog@0.1.0
  - @hogsend/plugin-resend@0.1.0

## 0.1.0

### Minor Changes

- 94a0bd4: Timezone-aware scheduling, send windows, and per-recipient frequency capping.

  - **`createHogsendClient({ defaults })`** — new `defaults.timezone` (global fallback IANA tz), `defaults.sendWindow` (quiet-hours window auto-applied by `ctx.when`), and `defaults.frequencyCap` (per-recipient send cap enforced in the mailer; "transactional" exempt by default).
  - **`ctx.when(...)`** on the journey context — resolves a send instant in the recipient's timezone and snaps it inside the configured send window.
  - **Timezone resolution** — new `resolveTimezone` / `resolveTimezoneWithSource` / `setContactTimezone` (`@hogsend/engine`) with a precedence chain (explicit → PostHog person props → `contacts.timezone` cache → global default), plus explicit-tz validation.
  - **`@hogsend/core/schedule`** — new public schedule module (window/time/tz resolvers).
  - **`isFrequencyCapped`** + `FrequencyCapConfig` / `FrequencyCapWindow` exports.

  Includes additive migration `0009` (expand-only): a nullable `contacts.timezone` column and an `email_sends` frequency-cap index. **After upgrading, run `db:migrate`** — the boot guard reports `schema.engine.inSync` until applied. No backfill required (the tz column is an opportunistic cache below PostHog/properties in precedence).

### Patch Changes

- Updated dependencies [94a0bd4]
  - @hogsend/db@0.1.0
  - @hogsend/core@0.1.0
