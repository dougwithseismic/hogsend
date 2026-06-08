# @hogsend/plugin-resend

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
  - @hogsend/core@0.9.0
  - @hogsend/email@0.9.0

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
  - @hogsend/core@0.8.0
  - @hogsend/email@0.8.0

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
  - @hogsend/core@0.7.0
  - @hogsend/email@0.7.0

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
  - @hogsend/email@0.6.0

## 0.5.0

### Minor Changes

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

### Patch Changes

- Updated dependencies [f4e604e]
- Updated dependencies [f4e604e]
  - @hogsend/core@0.5.0
  - @hogsend/email@0.5.0

## 0.4.0

### Minor Changes

- 0db58c6: Align the scaffold-pinned packages to the engine 0.4 line (no functional changes) so a fresh `create-hogsend` install resolves every `@hogsend/*` dependency on one compatible minor. Remember to bump `ENGINE_VERSION` in `packages/create-hogsend/src/template-manifest.ts` to match in the Version PR.

### Patch Changes

- Updated dependencies [0db58c6]
  - @hogsend/email@0.4.0

## 0.1.0

### Minor Changes

- 3601a18: Align the supporting packages to the 0.1.0 release line. A scaffolded app pins every `@hogsend/*` dependency to a single exact version token, so all published packages must share one version line. These three lagged at 0.0.1 while the engine line moved to 0.1.0, which would leave a fresh scaffold unable to resolve its dependencies.

### Patch Changes

- Updated dependencies [3601a18]
  - @hogsend/email@0.1.0
