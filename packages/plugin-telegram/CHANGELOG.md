# @hogsend/plugin-telegram

## 0.31.1

### Patch Changes

- 79bb505: create-hogsend: repair the pnpm/yarn admin-create crash + onboarding UX pass.

  The scaffold's Studio-admin step (and the `studio:admin` package.json script) ran
  `node node_modules/.bin/hogsend …`, but under pnpm/yarn that bin is a POSIX shell
  shim — pointing `node` at it parsed shell as JavaScript and crashed with
  `SyntaxError: missing ) after argument list`. Both call sites now target the CLI's
  real ESM entry `node_modules/@hogsend/cli/dist/bin.js`, which resolves identically
  on npm/pnpm/yarn/bun. Plus a UX pass on the creator: a welcome banner, a
  dependency-free spinner on the silent Hatchet-token wait, and `hogsend connect
posthog` surfaced as a guided post-deploy step (shown even when PostHog is chosen
  without a pasted key).

  The rest of the `@hogsend/*` line moves with this patch to stay on a single
  engine version line (no code changes outside create-hogsend).

- Updated dependencies [79bb505]
  - @hogsend/engine@0.31.1

## 0.31.0

### Minor Changes

- 8422893: Restyle the cold-connect confirmation page + realign the scaffolder to the engine line.

  - **`@hogsend/engine`** — the engine-served cold-connect connect page (`GET /connect/<connector>`) is restyled to the Hogsend Studio "Crimzon" design language (ink surface, hairline-bordered card, Inter, eyebrow label, faint grain). New optional `ColdConnectBranding` fields — `iconSvg` (inline platform-logo SVG, shape-checked and fail-closed to the emoji badge), `eyebrow`, and `reassurance` (an "if this wasn't you, ignore this" footnote). Hardening: branding JSON embedded in the page's inline `<script>` is escaped against a `</script>` breakout, the page clears WCAG AA contrast, and it no longer pulls a third-party webfont.
  - **`@hogsend/plugin-telegram`** — the Telegram cold-connect branding now ships the real Telegram paper-plane logo + the reassurance copy, and its accent is darkened to `#1f6feb` so the white Confirm-button label clears WCAG AA.
  - **`create-hogsend`** — realigned to the engine version line. It had silently drifted to `0.22.0` on npm (8 minors behind) because it sits outside the `@hogsend/*` scope the release gate enforces uniformity on, so `create-hogsend@latest` scaffolded a stale app. `release-doctor` now asserts the scaffolder tracks the engine version so this can't recur.

  The remaining engine-line packages are version-only bumps to keep the engine release line uniform.

### Patch Changes

- Updated dependencies [8422893]
  - @hogsend/engine@0.31.0

## 0.30.0

### Minor Changes

- e5f720e: feat(plugin-discord): adopt the cold-connect link-confirm flow (drop the typed-code /verify)

  Refactors `@hogsend/plugin-discord` onto the engine `createColdConnect()` primitive so Discord linking matches Telegram: `/link <email>` → emailed one-click confirm LINK → click → the engine-served connect page binds `discord_id` + email onto one contact + client-identifies. **`/verify` and the typed-code path are removed.**

  - **`@hogsend/plugin-discord`** — `InteractionDeps` is reworked (breaking): the code-flow callbacks (`mintCode`, `sendLinkCode`, `redeemCode`, `recordVerifyAttempt`) are dropped in favour of a single consumer-supplied **`requestConfirm({ discordUserId, email }) → { ok } | { ok: false, reason }`** that mints a server-sealed cold-connect token and emails the confirm link (the token never reaches the handler). The Enter-code component/modal, the `/verify` slash command, and the `CODE_MODAL`/`ENTER_CODE_BUTTON` custom-ids are deleted; `CustomIds` is now just `{ EMAIL_MODAL }`. The mint throttle moved entirely into `mintConfirm` (Redis-INCR, fail-closed). New export: `RequestConfirmResult`.
  - **`member_link` OAuth path is preserved** — its `resolveContact` (which runs `linkContact` + role-grant + the `discord.linked` emit for the operator/known-contact web-bind) is kept and is used ONLY by the OAuth branch, not the `/link` interactions path. Both bind paths stay at parity: `/link` grants the role via the cold-connect `afterBind` + emits via the exchange's `ingestEvent`; the OAuth branch keeps doing it via `resolveContact`.
  - **`apps/api`** is the in-monorepo reference consumer: it constructs `discordColdConnect = createColdConnect({ identityKind: "discordId", platformKey: id => id, buildIngest: scalar discordId, … })`, wires `requestConfirm` to `mintConfirm` + the transactional confirm email, and mounts the routes via the array form of `CreateAppOptions.routes`. The now-orphaned `transactional/discord-link-code` template is removed.

  The remaining engine-line packages are version-only bumps to keep the engine release line uniform.

### Patch Changes

- Updated dependencies [e5f720e]
  - @hogsend/engine@0.30.0

## 0.29.0

### Minor Changes

- bbfd270: feat(engine): createColdConnect() — a reusable cold-connect primitive (generalizes the Telegram email-link flow)

  Extracts the Telegram cold-connect flow (`/link <email>` → emailed confirm link → click → server-sealed bind → client-side `posthog.identify`) into a channel-agnostic engine primitive so Discord, Telegram, and future connectors share one mechanism.

  - **`@hogsend/engine`**: new `createColdConnect({ connectorId, identityKind, platformKey, linkedEvent, identifyPropKey, buildIngest, branding, ttlSeconds?, throttle?, afterBind? })` → `{ mintConfirm, confirmUrl, routes }`. The factory owns the sealed-token store (Redis, `connectorId` sealed in the value), the connect page, and the `peek → ingestEvent → consume` exchange. Security invariants baked in: the bind runs only on a human POST (never a GET prefetch); the exchange body is `{tok}`-only (ids come solely from the sealed token — no graft); single-use peek-then-consume (a webhook/retry can't burn the link), and the token is consumed even if `afterBind` throws (at-least-once, idempotent-required); a fail-closed Redis-INCR mint throttle; cross-connector token isolation (basePath + idempotency key + a `binding.connectorId === connectorId` assert, 410 on mismatch). The exchange uses `ingestEvent` (folds the platform key + email onto one contact and routes the welcome journey) and returns the canonical `contactKey`, which the page hands to `posthog.identify` — keyed to the server-proven id, never a client-supplied one.
  - **`CreateAppOptions.routes`** now accepts a single fn **or an array** of route fns, so a consumer can mount `[existingRoutes, coldConnect.routes]` without clobbering.
  - **`@hogsend/plugin-telegram`**: refactored onto the primitive (`telegramColdConnect = createColdConnect(...)`); the bespoke `telegram-connect.ts` page/exchange and the confirm-token family in `link.ts` are removed (the `/start` deep-link path stays). The connect basePath is unchanged (`/connect/telegram`), so confirmation emails in flight keep resolving.
  - **`apps/docs`**: the marketing PostHog init now sets `cross_subdomain_cookie: true` so a **consented** visitor's distinct_id is written to a `.hogsend.com` cookie — letting a cold-connect connect page (served off the API host) read their existing id and fold prior browsing into the proven identity. Pre-consent behaviour (memory-only, no cookie) is unchanged.

  The remaining engine-line packages are version-only bumps to keep the engine release line uniform.

### Patch Changes

- Updated dependencies [bbfd270]
  - @hogsend/engine@0.29.0

## 0.28.0

### Minor Changes

- ed06b92: feat(connectors): @hogsend/plugin-telegram + live-only journey_states unique index

  Adds `@hogsend/plugin-telegram` — an inbound webhook connector (messages, `/start`
  deep-link, `/link` email-confirm cold connect) with journey-callable
  `sendMessage`/`dm` actions and Redis-token linking (peek-then-consume so a Telegram
  webhook retry can't burn a link mid-flight).

  Engine: `uq_user_journey_active` is now a PARTIAL unique index scoped to live rows
  (`status IN ('active','waiting')`) so an `unlimited` journey can complete more than
  once per user — the old full `(user_id, journey_id, status)` index threw `23505` on
  the second completion. Ships migration `0029`. `contacts.properties.telegram` now
  deep-merges (mirrors `discord`).

  All engine-line packages are bumped uniformly to keep the version line and the
  scaffold's caret pins consistent.

### Patch Changes

- Updated dependencies [ed06b92]
  - @hogsend/engine@0.28.0
