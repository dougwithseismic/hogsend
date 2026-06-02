<!-- Planning doc generated from a multi-agent design pass; grounded in the repo. Not yet implemented. -->

# Hogsend Reporting API + Studio — Implementation Plan

This plan covers two features for the Hogsend engine: (A) a **Reporting API** — authenticated REST that answers "which emails went out, on which template, when, to whom, and what engagement they got" (opens, clicks, bounces, complaints; replies deferred), and (B) **Hogsend Studio** — a registry-native, local-first email-preview UI shipped in `@hogsend/cli`, optionally self-hostable. Both build on existing seams: Reporting extends the `/v1/admin/*` OpenAPIHono routers against the current schema (no migration needed for MVP); Studio is a new local CLI command that renders the consumer's `TemplateRegistry` through `@hogsend/email`'s render path — the same one `createTrackedMailer` uses.

---

## Reporting API

### Design summary

All reporting lives under the existing admin surface (`requireApiKey` + `rateLimit` + `auditMiddleware`, applied once at `routes/admin/index.ts:21-23` — do not re-add per route). Two clusters:

1. **Extend the existing `emailsRouter`** (`routes/admin/emails.ts`) — the list/detail endpoints are already the right home; add filters, resolved recipient identity, and a unified per-send `events[]`.
2. **New `reportingRouter`** mounted at `/v1/admin/reporting` (`routes/admin/reporting.ts`) — windowed per-template aggregates, time-series, per-contact messaging activity, and CSV export.

Conventions match `emails.ts`/`metrics.ts`: `createRoute()` + `OpenAPIHono<AppEnv>().openapi()`, Drizzle from `@hogsend/db`, ISO-8601 on the wire, `z.coerce.number()` for numeric query params, `z.string().datetime()` for dates, rates as fractions rounded 4 dp (`Math.round(x*10000)/10000`), pagination `{ items, total, limit, offset }`.

The spine is `email_sends` (one row per send, with `templateKey`, `*At` engagement timestamps, `status`); recipient identity beyond `toEmail` comes via LEFT JOIN to `journey_states` (`email_sends.journeyStateId → journey_states.id`, filter `deletedAt IS NULL`); per-click detail from `tracked_links ⋈ link_clicks`.

### Endpoint list

| Method + Path | Status | Purpose |
|---|---|---|
| `GET /v1/admin/emails` | extend | List/filter sends — add `contactId`, `journeyId`, `category`, `engagement`, `sort`, `order`; resolve `userId/userEmail/journeyId` |
| `GET /v1/admin/emails/{id}` | extend | Single send + unified chronological `events[]` + recipient identity |
| `GET /v1/admin/reporting/templates` | new | Per-template aggregate stats over a window |
| `GET /v1/admin/reporting/templates/{templateKey}` | new | One template's totals + daily/weekly/monthly series |
| `GET /v1/admin/reporting/contacts/{id}/activity` | new | Per-contact messaging activity (engagement-focused per-send rows) |
| `GET /v1/admin/reporting/sends/export` | new (later) | CSV export of filtered sends |

### Response shapes (key ones)

**`GET /v1/admin/emails`** — existing `emailSchema` (`emails.ts:12-30`) extended with resolved identity:
```ts
{ emails: Array<emailSchema & { userId: string|null, userEmail: string|null, journeyId: string|null }>,
  total: number, limit: number, offset: number }
```
New query params: `contactId`, `journeyId`, `category`, `engagement` (`"opened"|"clicked"|"bounced"|"complained"` → `isNotNull(emailSends.<col>At)`, not `status`, to survive status-overwrite races), `sort` (`createdAt|sentAt|openedAt|clickedAt`), `order`. Date window defaults to last 30d on `createdAt`.

**`GET /v1/admin/emails/{id}`** — existing `{ email, trackedLinks[], journeyContext }` plus a flat, ascending `events[]`:
```ts
events: Array<{ type: "queued"|"sent"|"delivered"|"opened"|"clicked"|"bounced"|"complained"|"failed",
  timestamp: string, url?: string, ipAddress?: string|null, userAgent?: string|null }>
```
Assembled with **no new tables**: one entry per non-null `*At` column on `email_sends` (`createdAt→queued`, `sentAt→sent`, etc.), plus one `clicked` entry per `link_clicks` row (every click, with URL/IP/UA) from the existing `fetchTrackedLinksWithClicks` helper (`emails.ts:152-186`). MVP uses first-open-only marker; richer per-open detail (query `user_events WHERE properties->>'emailSendId' = :id`) is documented as opt-in.

**`GET /v1/admin/reporting/templates`** — windowed successor to `GET /v1/admin/metrics/emails`:
```ts
{ window: { from, to }, channel: "email",
  templates: Array<{ templateKey: string|null, sent, delivered, opened, clicked, bounced, complained, failed,
    deliveryRate, openRate, clickRate, clickToDeliveryRate: number }> }
```
Counts via `count(*) filter (where ...)` (`metrics.ts:444-448`), `GROUP BY templateKey`, `gte/lte(createdAt)`. Uses `bouncedAt`/`complainedAt IS NOT NULL` rather than `status='bounced'`. **Correctness fix carried from the audit:** compute `openRate` over `delivered` only if `delivered > 0`, else over `sent`, and document the denominator used — otherwise it silently reads 0 whenever Resend delivered-webhooks aren't firing. `clickToDeliveryRate` (clicked/delivered) is the pixel-block-robust headline metric. `includeUntemplated=true` surfaces null `templateKey` as a `(none)` bucket.

**`GET /v1/admin/reporting/templates/{templateKey}`** — `{ templateKey, channel, totals, series[] }` where `series` is `GROUP BY date_trunc(:granularity, createdAt)` (reuse `TRUNC_SQL` map + `date_trunc(...)::text` from `metrics.ts:23-28, 488-502`). 404 if the template never sent.

**`GET /v1/admin/reporting/contacts/{id}/activity`** — resolve `id` via `resolveContact({ db, id })` (`timeline.ts:62`; accepts externalId/uuid/email), then per-send engagement rows:
```ts
{ contact: { externalId, email: string|null },
  sends: Array<{ id, templateKey, journeyId, subject, status, sentAt, deliveredAt, openedAt, clickedAt,
    bouncedAt, complainedAt, clickCount: number }>,
  total, limit, offset }
```
`email_sends INNER JOIN journey_states ON journeyStateId WHERE journey_states.userId = externalId AND deletedAt IS NULL`, with a fallback `OR email_sends.toEmail = contact.email` (when non-null) to capture journeyless sends. Optional `LEFT JOIN tracked_links` aggregate for `clickCount`.

### DB tables / joins

| Endpoint | Primary | Joins |
|---|---|---|
| emails list/export | `email_sends` | LEFT JOIN `journey_states` (userId/userEmail/journeyId, `deletedAt IS NULL`) |
| email detail | `email_sends` | `tracked_links ⋈ link_clicks` (existing helper), LEFT JOIN `journey_states`, optional `user_events` on `properties->>'emailSendId'` |
| template agg | `email_sends` `GROUP BY templateKey` | optional INNER JOIN `journey_states` for `journeyId` |
| template series | `email_sends` `GROUP BY date_trunc(...)` | — |
| contact activity | `email_sends INNER JOIN journey_states` (userId) + `OR toEmail` fallback | optional `tracked_links` agg |

All join keys are real and indexed: `email_sends_journey_state_id_idx`, `templateKey`, `toEmail`, `status`, `createdAt` (schema lines 27-39). `journey_states.userId` is the only send→contact path.

### Required schema migrations

**MVP requires NONE** — endpoints 1–5 read existing columns (`templateKey`, `*At`, `status` are all persisted today). The following are explicit, ranked, and all **nullable / non-breaking** (`cd packages/db && pnpm db:generate` then `db:migrate` per CLAUDE.md):

1. **(Phase 2, recommended) `bounceType` + `bounceReason` on `email_sends`** — `packages/db/src/schema/email-sends.ts`:
   ```ts
   bounceType:   text("bounce_type"),    // 'hard' | 'soft' | 'transient' | null
   bounceReason: text("bounce_reason"),
   ```
   Populate in `lib/mailer.ts` `handleBounce` from the Resend webhook bounce subtype. Hard vs soft is currently unstored.

2. **(Phase 2, recommended) Denormalize `userId` + `userEmail` onto `email_sends`** — captures journeyless sends (which have no contact linkage today) and turns endpoints 1/5 into single-table queries:
   ```ts
   userId:    text("user_id"),    // nullable, set at send time
   userEmail: text("user_email"),
   // + index("email_sends_user_id_idx").on(table.userId)
   ```
   Write in `lib/tracked.ts` `sendTrackedEmail` where `journeyStateId` is set. One-time backfill: `UPDATE email_sends SET user_id = js.user_id FROM journey_states js WHERE email_sends.journey_state_id = js.id`.

3. **(Optional) `templateKey` on `sendRaw`/`sendBatch`/no-db paths** — code-only (no migration); pass a `templateKey` or `"raw"` sentinel so those rows aren't invisible to per-template reporting. Otherwise rely on `includeUntemplated=true`.

4. **(Optional) sort indexes** `email_sends_opened_at_idx`, `email_sends_clicked_at_idx` if endpoint-1 sorting on those becomes hot.

5. **(Phase 3, gated) `email_replies` table** — only if replies are taken in scope (see below).

### Replies verdict

**Not capturable today; not in the MVP deliverable.** Confirmed by audit: no replies table, no inbound route, and Resend's *outbound* webhook never emits replies (`replyTo` is set on outbound only, `tracked.ts:156`). Capturing replies is an **ingestion feature, not a reporting one**, and is transport-gated. To do it later: (1) an inbound transport — preferably **Resend Inbound** via the existing `defineWebhookSource()` pattern (`POST /v1/webhooks/inbound-email`), with an IMAP-poller-on-Hatchet-cron fallback; (2) a new `email_replies` table keyed to `email_sends` via `In-Reply-To`/`References` → `resendId` match (fallback: `(fromEmail, toEmail)` recency); (3) add `repliedAt`/`replies[]` to endpoints 2–5 and `replyRate = replied/delivered` to endpoint 3. **Ship opens/clicks/bounces/complaints first; treat replies as a separate follow-up project.**

### MVP vs later

- **MVP (no migration):** endpoint 1 (extended filters + identity), endpoint 2 (unified `events[]`), endpoint 3 (windowed per-template with corrected `openRate` + `clickToDeliveryRate`). These three cover the owner's question end-to-end: list → drill into one send → roll up by template.
- **Phase 2:** endpoint 4 (series), endpoint 5 (contact activity + `toEmail` fallback); schema #1 (bounceType/Reason) + #2 (denormalize userId/userEmail).
- **Phase 3 (gated):** endpoint 6 (CSV export); Resend webhook signature verification + `toEmail` fallback match for rows lacking `resendId` (audit-flagged — distorts all rates); replies; per-send unsubscribe attribution (`email_preferences.lastEmailSendId`); multi-tenant `organizationId` scoping across all queries.

### File touch-points

- Extend `packages/engine/src/routes/admin/emails.ts` (endpoints 1–2).
- New `packages/engine/src/routes/admin/reporting.ts`, mounted in `packages/engine/src/routes/admin/index.ts` via `adminRouter.route("/reporting", reportingRouter)` (endpoints 3–6).
- Schema: `packages/db/src/schema/email-sends.ts` (Phase 2 columns); new `packages/db/src/schema/email-replies.ts` (Phase 3 only).
- Write-path: `packages/engine/src/lib/tracked.ts` (denormalized identity, raw templateKey), `packages/engine/src/lib/mailer.ts` (bounceType in `handleBounce`).
- Reuse patterns: `packages/engine/src/routes/admin/metrics.ts` (filtered counts, `date_trunc`, rate rounding), `timeline.ts` (`resolveContact`), `lib/tracking-events.ts` (the canonical `email_sends → journey_states` identity resolution).

---

## Studio (CLI)

### Design summary

A **local-first, optionally-hostable email-preview UI** shipped through `@hogsend/cli` as a new **local command** (family: `setup`/`skills` — operates on `process.cwd()`, never the `/v1/admin` HTTP client). It renders the consumer app's **registry-keyed** templates through the exact `renderToHtml`/`renderToPlainText`/`getPreviewText` path `createTrackedMailer.render()` uses (`mailer.ts:140-155`), grouped by `category`, showing `defaultSubject` + computed `preview(props)`. The differentiator vs `react-email dev`: Studio observes the typed `TemplateRegistry` (the single source of truth), not file-scanned loose `.tsx`.

### Command UX

```
hogsend studio [options]
  --port <n>        Bind port (default: 3333)
  --host <addr>     Bind interface (default: 127.0.0.1; 0.0.0.0 to expose)
  --open            Open in browser once up
  --cwd <dir>       App dir to read templates from (default: process.cwd())
  --registry <path> Explicit registry module path (default: auto-discovery)
  --no-watch        Disable chokidar + WS hot reload (implied in hosted mode)
  --json            Emit template catalog as JSON and exit — no server
  -h, --help
```

Wired by adding `studioCommand: Command` to the `commands` array in `packages/cli/src/commands/index.ts`. Happy path: resolve cwd → discover registry → preflight dep check → spawn the Hono server as a **tsx subprocess in the app dir** → (watch) chokidar + WS → (open) browser. `--json` short-circuits before binding a port (still loads the registry through tsx to read subjects/preview).

**Registry discovery** (no formalized path today — commit to a convention + escape hatch, resolved in order): `--registry` flag → `hogsend.config.{json,ts}` `email.registry` → `package.json` `hogsend.studio.registry` → convention fallback (`<cwd>/src/emails/registry.ts` → `src/emails/index.ts` → `emails/registry.ts`). The module must export `templates: TemplateRegistry`. Decision: formalize `src/emails/registry.ts` exporting `templates` as canonical and document it; `--json` reports the chosen `registryPath`.

### Chosen rendering approach + why

**Thin custom Hono preview server using the app's registry + `@hogsend/email` render functions. Do NOT reuse `react-email dev`.** Rationale, grounded in how Hogsend differs:

- **Registry-keyed, not file-scanned.** `react-email dev` discovers by walking a dir for default-exporting `.tsx` (`isFileAnEmail` regex). It would surface `_components/*`, miss the typed key→props map, and show **none** of the registry metadata. Studio iterates `getTemplateNames(templates)`.
- **The product surface IS the registry metadata.** `TemplateDefinition` carries `defaultSubject`, `category`, `preview(props)`. react-email has no concept of these (its preview text comes from a `<Preview>` element, props from a `PreviewProps` export). Only a custom server renders the catalog grouped by category with the real subject and the computed `preview(props)` string.
- **Fidelity.** Same `renderToHtml`/`renderToPlainText` (`packages/email/src/render.ts`) the engine uses — no divergence from react-email's esbuild bundling.
- **react-email's interactive path isn't embeddable.** The standalone `@react-email/preview-server` (5.2.10) is **deprecated**; the only interactive path is a prebuilt Next app driven by undocumented internals + env vars + esbuild-on-disk. Hosting it means shipping a Next runtime just to preview email. A Hono server reuses the existing stack and can later mount into `createApp`.

We still lean on react-email's building blocks: `@react-email/render` (which `@hogsend/email` wraps) and its `<Html>/<Preview>/<Section>` authoring components. `email export` stays as an unrelated static-HTML escape hatch.

**Server endpoints (Hono shim):** `GET /` (SPA shell), `GET /api/templates` (list: `{ key, defaultSubject, category, hasPreview }`, no render), `GET /api/templates/:key` (full render: `{ key, subject, category, preview, html, text, props }`, accepts `?props=<base64-json>` later), `GET /api/templates/:key?format=html|text|preview` (raw, used by iframe `srcdoc`), `GET /__studio/ws` (hot-reload, dev only).

**Sample-props resolution** (the hard part — `preview(props)` dereferences `props.name` etc. and throws on `{}`): final props = `{ ...INJECTED_DEFAULTS, ...(definition.examples ?? {}), ...override }`, where `INJECTED_DEFAULTS` covers the engine-injected fields (`name`, `unsubscribeUrl`, `journeyName`, `eventName`, `body`) and a new optional `examples` field is added to `TemplateDefinition`. Wrap `getPreviewText` in try/catch — on throw, fall back to `defaultSubject` and show a non-fatal "preview() threw — add `examples` props" badge; HTML/text still render via JSX defaults. Tracking domain rendered as a no-op sample (`studio.local`), never `API_PUBLIC_URL`, so previews never write `tracked_links` or pollute analytics.

### Hostable mode + auth

Same server, two run modes (react-email's `dev` vs `start` split, generalized):

| | Local (`hogsend studio`) | Hosted |
|---|---|---|
| Bind | `127.0.0.1` | `--host 0.0.0.0` (explicit opt-in) |
| Watch/HMR | on | off |
| Auth | implicit loopback trust | **required** |
| Send-test | (later) allowed | disabled/allowlisted |

Two deployment shapes: **(1) standalone container** — `hogsend studio --host 0.0.0.0 --port 8080` in the app's Docker image (Railway service like `hogsend-worker`, no DB; auth via env). **(2) mounted `@hogsend/studio` Hono router** that `createApp` mounts at `/studio`, reusing Better Auth + secureHeaders/CORS and the injected `templates` registry — the natural DI seam and recommended hosted path (auth comes free). MVP ships shape (1) via CLI; design the render core as a standalone `renderCatalog(templates, opts)` so both consume it.

**Auth posture** (mirrors the project's "OpenAPI/Scalar disabled in production"): **refuse to bind a non-loopback host without auth configured.** Options: mounted-router → Better Auth session + admin role check (reuse `AppEnv` `user`/`session`); standalone → `STUDIO_BASIC_AUTH=user:pass` or front with Cloudflare Access (fits the existing stack). Disable introspection in hosted mode (no env dump, no source-path leakage). Send-test (when it lands) gated + rate-limited + recipient-allowlisted, or disabled in hosted mode. No real tracking in renders.

### Packaging constraints

The CLI runs from its own `node_modules`/dlx cache; templates, `@hogsend/email`, `react`, `react-dom`, `react-email` live in the **user's app**. Handling:

1. **Dual-React hazard** — render must run in the consumer's module-resolution context. Studio spawns the server **as a subprocess with `cwd` = app dir**; the parent CLI never imports React or the registry.
2. **No TS/JSX loader in compiled CLI** (`tsx` is only a devDep; the registry graph imports `.tsx` via `.js` extensions, which plain `node` can't resolve) — run the server through **tsx**, resolved: app-local `pnpm exec tsx` → `npx -y tsx` → clear error. tsx executes a **shipped shim** `packages/cli/studio/server.ts` (add `"studio"` to `package.json` `files`, resolve via `fileURLToPath(new URL("../studio/server.ts", import.meta.url))` accounting for `dist/bin.js` depth — same trick as `bundledSkillsDir()` in `skills.ts:45`). Config passed via env/argv.
3. **`@hogsend/email` is source-exported** (`main: src/index.ts`) — its render chains into react-email/react/react-dom, which must resolve from the app. The subprocess-in-app-dir model satisfies this. The CLI does **not** depend on `@hogsend/email`/React in its own `dependencies` (keeps the published CLI tiny).
4. **Preflight dep check** before spawning: resolve `react`, `react-dom`, `react-email`, `tsx` from the app dir. On miss: `Hogsend Studio needs react-email installed... Run: pnpm add react-email react react-dom` (+ `pnpm add -D tsx`). `--json` returns `{ ok: false, missing: [...] }`.
5. **SPA shell ships with the CLI** (skills pattern) — static SPA + thin JSON API, no Next runtime. Net new CLI deps: `hono`, `chokidar`, a tiny WS lib (or Hono's upgrade). React stays out of the CLI entirely.

### MVP vs later

- **MVP:** the full command + flags; registry auto-discovery with clear failure; preflight dep check; tsx-subprocess Hono shim in app dir; catalog from `getTemplateNames` grouped by `category` with `defaultSubject` + computed `preview`; per-template render (HTML sandboxed iframe + plain text + subject + preview text); sample-props resolution (`INJECTED_DEFAULTS` ← `examples` ← `?props=`) with resilient `preview()` try/catch; new optional `examples` field on `TemplateDefinition`; chokidar+WS hot reload; `--json`; loopback-default, `--host 0.0.0.0` refuses without auth; no real tracking domain.
- **Later:** send-test (gated/rate-limited/allowlisted); editable props panel + named `examples` variants; device-width + dark-mode toggles; spam/link-check tab; share links; mounted `@hogsend/studio` router (Better Auth admin gate); `hogsend studio export` (static HTML); diff-vs-last-commit for CI regressions.

### File touch-points

- New command: `packages/cli/src/commands/studio.ts` (`studioCommand`), registered in `packages/cli/src/commands/index.ts`.
- Shipped shim + assets: `packages/cli/studio/server.ts` + `packages/cli/studio/ui/` (add `"studio"` to `packages/cli/package.json` `files`), resolved like `bundledSkillsDir()` (`packages/cli/src/commands/skills.ts:45`).
- tsx detect/spawn: model on `spawnSync` in `packages/cli/src/commands/setup.ts`; prefer `pnpm exec tsx`.
- Render core: import `getTemplate`, `getTemplateDefinition`, `getTemplateNames`, `getPreviewText` from `@hogsend/email` (`packages/email/src/registry.ts`) + `renderToHtml`/`renderToPlainText` from `packages/email/src/render.ts` (mirrors `mailer.ts:140-155`).
- New `examples` field: `packages/email/src/types.ts` `TemplateDefinition` (lines 28-33), additive/optional.
- Config/flags reuse: `parseGlobalFlags`/`resolveConfig` in `packages/cli/src/lib/config.ts` (Studio uses `cfg` for cwd/.env only; `adminKey`/`baseUrl` unused).
- Canonical layout to formalize + document: `apps/api/src/emails/registry.ts` (export `templates`), `types.ts`, `templates.d.ts`; populate `examples` here and in the `create-hogsend` template (`packages/create-hogsend`).

---

## Recommended build order (phased checklist)

**Phase 0 — shared groundwork**
- [ ] (S) Add optional `examples` field to `TemplateDefinition` in `packages/email/src/types.ts` (additive, unblocks Studio props; no migration).
- [ ] (S) Populate `examples` on `apps/api/src/emails/*` templates + the `create-hogsend` template.

**Phase 1 — Reporting MVP (no migration; highest value, lowest risk)**
- [x] (M) Extend `GET /v1/admin/emails` — `journeyId`/`userId`/`category`/`engagement`/`sort`/`order` filters + LEFT JOIN `journey_states` for resolved `userId/journeyId`. (Shipped: identity via the live `journey_states` join; `userEmail`/`contactId` deferred to ship 2 alongside denormalization.)
- [x] (M) Extend `GET /v1/admin/emails/{id}` — unified `events[]` from `*At` columns + `tracked_links ⋈ link_clicks` + identity.
- [x] (M) Per-template email metrics with corrected `openRate` denominator + `clickToDeliveryRate` + `includeUntemplated`. (Shipped by extending the existing `GET /v1/admin/metrics/emails` route rather than a new `routes/admin/reporting.ts`.)

**Phase 2 — Studio MVP (parallelizable with Phase 1; depends only on Phase 0)**
- [ ] (S) Scaffold `studioCommand` + register; flag parsing; registry auto-discovery with clear failure.
- [ ] (S) Preflight dep check (react/react-dom/react-email/tsx) with `pnpm add` hint + `--json` structured miss.
- [ ] (M) tsx-subprocess Hono shim (`studio/server.ts`) in app cwd; `/api/templates` + `/api/templates/:key` (+ `?format`); sample-props resolution with resilient `preview()`.
- [ ] (M) Static SPA shell (catalog grouped by category; HTML iframe + text + subject + preview tabs); ship via `package.json` `files`.
- [ ] (S) chokidar + WS hot reload (local/watch mode); `--json` catalog output.
- [ ] (S) Loopback-default; `--host 0.0.0.0` refuses without `STUDIO_BASIC_AUTH`; no-op `studio.local` tracking domain in renders.

**Phase 3 — Reporting Phase 2**
- [ ] (S) `GET /reporting/templates/{templateKey}` totals + `date_trunc` series.
- [ ] (M) `GET /reporting/contacts/{id}/activity` via `resolveContact` + journey join + `toEmail` fallback.
- [ ] (S→M) Migration: `bounceType`/`bounceReason` on `email_sends` + populate in `mailer.ts handleBounce`.
- [ ] (M) Migration: denormalize `userId`/`userEmail` on `email_sends` + index + backfill UPDATE + write in `tracked.ts`.

**Phase 4 — Hardening + hosted Studio (gated)**
- [ ] (M) Resend webhook signature verification + `toEmail` fallback match for rows lacking `resendId`.
- [ ] (S) CSV export `GET /reporting/sends/export` (streamed, 50k cap).
- [ ] (L) Mounted `@hogsend/studio` Hono router with Better Auth admin gate; refactor render core to `renderCatalog(templates, opts)`.
- [ ] (M) Studio send-test (gated/rate-limited/allowlisted) + editable props panel.
- [ ] (L, gated) Replies: inbound transport (`defineWebhookSource`) + `email_replies` table + reply fields on endpoints 2–5.

---

## Open decisions for the owner

1. **Denormalize `userId`/`userEmail` onto `email_sends` (Reporting #2)?** Yes makes endpoints 1/5 single-table and captures journeyless sends; No keeps it derived via the `journey_states` join + `toEmail` fallback. Recommend **yes** (nullable + backfill, non-breaking). **Decided:** MVP ships identity derived via the live `journey_states` join (no migration); denormalization deferred to ship 2 (Phase 3, migration item below).
2. **Replies in scope at all, and via which transport?** Resend Inbound (preferred, fits `defineWebhookSource`) vs IMAP poller vs **skip entirely for now**. Recommend **skip for MVP** — it's an ingestion project, not reporting.
3. **Studio hosted path priority** — ship only the standalone-container CLI flag for now, or also build the mounted `@hogsend/studio` router (Better Auth admin gate) in the first hosted pass? Recommend **standalone first, mounted router as the documented "production hosted" follow-up**.
4. **Formalize `src/emails/registry.ts` exporting `templates` as the canonical, committed convention** (and bake into `create-hogsend`)? Studio's discovery depends on committing to this. Recommend **yes**.
5. **`includeUntemplated` default + raw-send `templateKey` backfill** — accept that `sendRaw`/`sendBatch` rows stay in a `(none)` bucket, or pass a `"raw"` sentinel through those paths so they're attributable? Recommend **sentinel** (cheap code change, no migration).
6. **Multi-tenant `organizationId` scoping** — design reporting queries with an `organizationId` predicate seam now, or defer until tenancy actually lands? Recommend **defer** (column is unused everywhere today; adding predicates later is mechanical).
