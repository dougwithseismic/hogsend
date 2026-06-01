# Hogsend — Packages Migration TODO

**Feature/Phase:** Turn Hogsend from a forkable monorepo into a versioned engine consumed via published npm packages, scaffolded with `pnpm dlx create-hogsend@latest`.

**Date:** 2026-05-30

**Status:** Phases 0–6 ✅ complete (code + dry-run/prep). Decisions D1–D6 locked
in `docs/engine-boundary.md`; `@hogsend/engine` carved; `apps/api` is a thin
consumer; two-track migrations (engine + client) implemented; `create-hogsend`
scaffolder + starter template shipped; publish pipeline added and verified
**DRY-RUN ONLY**; `@hogsend/cli` eject tooling + Extend→Patch→Eject docs shipped;
Phase 6 delivered as **PREP + RUNBOOK only** (no live cutover). Full gate green:
check-types 10/10, build 7/7, lint clean (260 files), **118 API tests across 11
files**, end-to-end smoke **9/9**. **Remaining: real npm publish + live
production cutover (both deferred, see "Remaining work" below).**

**Related docs:**
- `docs/packages-migration-plan.md` — the full narrative plan (source of truth for rationale).
- `docs/UPGRADING.md` — the upgrade contract (forward-only migrations, expand→migrate→contract, db:push ledger gotcha).
- `docs/tracking.md`, `docs/product-spec.md`, `docs/architecture-current.md` — engine internals being packaged.

---

## 🎯 Goal

Ship Hogsend as a **versioned engine** that client teams install and upgrade like any other dependency, instead of forking a monorepo and merging upstream by hand. A new client should go from zero to a running lifecycle-orchestration app with `pnpm dlx create-hogsend@latest`, own 100% of their *content* (journeys, templates, webhook sources, branding, their own migrations), and get clean `pnpm up @hogsend/*` upgrades for the common case — with an escalating **Extend → Patch → Eject** ladder when they need to touch engine internals.

### Success Criteria

- [x] A fresh app scaffolded via `pnpm dlx create-hogsend@latest` runs `pnpm dev`, fires an example journey end-to-end, and sends a tracked email — with no monorepo checkout. *(scaffold→install→check-types→build→biome proven by `packages/create-hogsend/scripts/verify-scaffold.sh`; full docker-compose boot is a documented manual step.)*
- [x] `apps/api` in this repo is a **thin consumer** of `@hogsend/engine` (dogfooded boundary), and the full suite stays green (now **118 tests across 11 files**, up from 102).
- [x] Two-track migrations work: engine migrations (ledger `drizzle.__drizzle_migrations`) and client migrations (ledger `drizzle.__client_migrations`) apply independently; `/v1/health` reports both tracks.
- [x] `@hogsend/*` packages publish to **public npm** via a changesets-driven CI release on merge to main, each with a per-package CHANGELOG. *(pipeline + workflow added; verified DRY-RUN ONLY — no real publish per guardrails.)*
- [x] A client can **Extend** via documented injection points, **Patch** via `pnpm patch`, and **Eject** a single package into `vendor/engine` while everything else still `pnpm up`s — Extend + Eject proven in sandbox; Patch scripted (SKIPs until packages are published). All three documented in `docs/customizing-the-engine.md`.

---

## ✅ Foundation Already In Place (do NOT redo)

A self-upgrade safety system was built and tested *before* this migration. The two-track migration design (Phase 2) **directly reuses and parameterizes** this work — it is not net-new.

- ✅ **Hardened migrator** — `packages/db/src/migrate.ts`: advisory lock `pg_advisory_lock(4812007)`, `lock_timeout=10s`, `statement_timeout=15min`, logs pending/applied, short-circuits when in sync.
- ✅ **Schema version probe** — `packages/db/src/version.ts`: `getSchemaVersion(db)` → `{ required, applied, pending, inSync }` (count-based: Drizzle `_journal.json` vs applied rows in `drizzle.__drizzle_migrations`). Also `getBundledMigrations()`. Exported from `@hogsend/db`.
- ✅ **Boot guard** — `apps/api/src/index.ts`: API refuses to start if schema is behind the build; `SKIP_SCHEMA_CHECK=true` bypasses.
- ✅ **Health reporting** — `apps/api/src/routes/health.ts`: `/v1/health` returns a `schema` block + `migration_pending` status.
- ✅ **Backfill primitives** — `apps/api/src/lib/backfill.ts` (`runBatchedBackfill()`) + `apps/api/src/workflows/backfill-example.ts` (template Hatchet task).
- ✅ **CI safety jobs** — `.github/workflows/ci.yml`: quality (lint + types), test (TimescaleDB on 5434, growthhog creds), migrations (schema-drift check, fresh apply, idempotency, upgrade-from-previous-release-with-data).
- ✅ **Upgrade contract docs** — `docs/UPGRADING.md`: forward-only, expand→migrate→contract, backup-before-upgrade, db:push-is-dev-only + the ledger gotcha (db:push doesn't write the migration ledger, so the boot guard reports `inSync:false`).
- ✅ **Migration system tests** — `apps/api/src/__tests__/migration-system.test.ts`: 6 tests against a throwaway DB (migrate-from-empty, idempotency, pending-detection, boot-guard detection, health-endpoint faithfulness).
- ✅ **Full migration plan** — `docs/packages-migration-plan.md`.

**Carries over from existing work (the reuse map):**

| Existing asset | How Phase 2 reuses it |
| --- | --- |
| `migrate.ts` migrator | Parameterize by `(migrationsFolder, migrationsTable, migrationsSchema)`; run once per track. |
| `getSchemaVersion(db)` | Parameterize by `(journal source, ledger table)`; call per track. |
| Boot guard in `index.ts` | Assert the **engine** track matches the installed `@hogsend/engine`'s bundled migrations. |
| `/v1/health` schema block | Widen to `schema: { engine: {...}, client: {...} }`. |
| `migration-system.test.ts` | Extend to cover both tracks (engine-first, then client, independent ledgers). |

---

## ✅ Blocking Decisions — LOCKED

All six locked to the recommended defaults; see the table in
`docs/engine-boundary.md` for the canonical record and signatures.

- [x] **D1 — Built-in journeys/sources placement.** Scaffolded into the client repo as editable starter code. *(content, not published)*
- [x] **D2 — Engine public API surface.** Injection points on `createContainer({ journeys, overrides })`, `createApp(container, { routes, middleware, webhookSources, onError })`, `createWorker({ container, journeys, workflows })`, plus `defineJourney` / `defineWebhookSource`. **`overrides` now includes `hatchet`** (added for testability via the same DI seam).
- [x] **D3 — Auth ownership.** Engine builds auth inside `createContainer` from `lib/auth.ts`; client configures via env / container override.
- [x] **D4 — Client-migration ledger location.** `drizzle.__client_migrations` in the same DB. *(applies in Phase 2)*
- [x] **D5 — Engine package granularity.** Single `@hogsend/engine`.
- [x] **D6 — `create-hogsend` v1 scope.** App-only scaffold; Railway one-click deferred.

> Recommended defaults locked to reach the **first usable release (Phases 1–4)** fastest. Revisit D1/D5/D6 post-1.0.

---

## 🏗️ Target Architecture (reference)

**Published engine packages (public npm):**
- `@hogsend/core` — journey types, Zod schemas, condition engine, duration helpers, registry.
- `@hogsend/db` — schema + **ENGINE migrations** + parameterized migrator + `getSchemaVersion`.
- `@hogsend/email` — React Email templates + render/unsubscribe helpers.
- `@hogsend/plugin-posthog`, `@hogsend/plugin-resend` — integrations.
- **`@hogsend/engine` (NEW)** — `createApp`, `createContainer`, `createWorker`, `defineJourney`, `defineWebhookSource`, ingestion, tracking, built-in routes, registries, framework re-exports.
- **`create-hogsend` (NEW)** — scaffolder; pins the engine version it emits.

**Client repo (scaffolded, 100% theirs):**
- Thin `src/index.ts` + `src/worker.ts`; THEIR journeys / email / webhook-sources / routes; THEIR `migrations/` (separate track); `hogsend.config.ts`; railway configs; drizzle config; docker-compose; `@hogsend/engine` pinned in `package.json`.

**Boundary rule:** engine ships the *framework*, client repo owns the *content*. Clients register journeys/sources in their **own** app code — never by editing a shared index — which eliminates the merge-conflict surface that exists today (`apps/api/src/journeys/index.ts`, `apps/api/src/webhook-sources/index.ts`).

**Editability ladder:**
1. **Extend** *(preferred, upgrade cost: none)* — injection points (D2) + `defineJourney`/`defineWebhookSource`.
2. **Patch** — `pnpm patch @hogsend/engine` for surgical fixes; re-applied on install, fails loudly on upstream conflict.
3. **Eject** — `hogsend eject @hogsend/engine` copies source into `vendor/engine`, rewrites the dep to a workspace/file link. That package stops auto-upgrading; everything else still `pnpm up`.

---

## 📋 Phased Plan

> **First usable release cut line = Phases 1–4.** Phases 5–6 harden and dogfood.

### Phase 0 — Prep *(Risk: LOW)*

**Depends on:** nothing.

- [x] Add **changesets** to the monorepo. *(`.changeset/` exists with config + README.)*
- [x] Configure `.changeset/config.json`: public access, base branch `main`, per-package CHANGELOG.
- [x] Write the explicit **engine ⇄ app boundary list**, committed as `docs/engine-boundary.md` (per-file FRAMEWORK/CONTENT classification + injection-seam signatures + boundary invariants).
- [x] Resolve **D2** and **D5** (and in fact all of D1–D6).

**Verify / Success:**
- [x] `pnpm build`, `pnpm check-types`, `pnpm lint` all green.
- [x] `.changeset/config.json` present and valid.
- [x] Boundary list reviewed and signed off.

---

### Phase 1 — Carve `@hogsend/engine` *(Risk: HIGH)*

> Largest, most mechanical step: a big code move + many import rewrites. Dogfood the boundary **in-repo** before publishing anything.

**Depends on:** Phase 0; decisions **D2, D3, D5**.

- [x] Scaffold `packages/engine` (`@hogsend/engine`): `package.json`, tsup config (`noExternal` bundling of `@hogsend/*`), tsconfig extending `@repo/typescript-config`, ESM-only, Node 22.
- [x] Move **framework** code from `apps/api/src` into `packages/engine/src` per the boundary list:
  - [x] `createApp(container, opts)` + middleware stack → accepts `routes`, `middleware`, `webhookSources`, `onError`.
  - [x] `createContainer(opts)` → accepts `journeys` + `overrides` (`emailService` / `posthog` / `auth` / `hatchet`).
  - [x] **`createWorker()`** — worker bootstrap (registers `sendEmailTask` + journey tasks, graceful shutdown).
  - [x] Ingestion, tracking (`tracking.ts`, `tracking-events.ts`), email lib, posthog lib.
  - [x] Built-in routes: health, ingest, email (unsubscribe/preferences), admin, tracking (click/open), webhooks (resend/sources).
  - [x] Journey framework: `defineJourney`, `journey-context.ts`, enrollment guards; webhook-source framework: `defineWebhookSource`.
  - [x] Registries (`JourneyRegistry` wiring) + framework re-exports of `@hogsend/core`.
- [x] Keep **content** in `apps/api` (the dogfood consumer): its journeys, webhook sources, workflows, entry points, tests.
- [x] Rewrite `apps/api/src/index.ts` + `worker.ts` to be **thin consumers** importing the engine factories and injecting their own `journeys` / `webhookSources`.
- [x] Update `apps/api` `package.json` to depend on `@hogsend/engine` (`workspace:^`).
- [x] Sweep import paths; `.js` extensions preserved on relative ESM imports inside the engine.
- [x] Boot guard kept in the client entry (`apps/api/src/index.ts`), calling `getSchemaVersion` from the engine.
- [x] Add a changeset for the new package. *(covered by the changesets release pipeline added in Phase 4; engine line linked in `.changeset/config.json`.)*

**Verify / Success:**
- [x] `pnpm build` (Turbo) green across all workspaces.
- [x] `pnpm check-types` green.
- [x] **All 102 tests pass.** *(baseline preserved; suite has since grown to 118.)* Behavior preserved — restored the webhook route's original auth-optional semantics, "Unknown webhook source" message, and response shapes that had drifted during the carve; tests now inject content (`journeys`, `webhookSources`, mock `hatchet`) through the new seams.
- [x] End-to-end smoke (`apps/api/scripts/smoke.ts`, `pnpm --filter @hogsend/api smoke`) boots container+app+worker, fires `test.signup` → `test-onboarding` runs to **completed** through real Hatchet, and confirms tracked-link rewrite + open-pixel injection. **9/9 green.**
- [x] `apps/api/src` contains only content (import direction verified: content → engine, never the reverse).

---

### Phase 2 — Two-Track Migrations *(Risk: MEDIUM)* — **KEYSTONE**

> The hard technical core. Reuses the Foundation work — parameterize, don't rewrite. See the reuse map above.

**Depends on:** Phase 1; decision **D4** (ledger location).

**Design:**
- **Engine track** — migrations live in `@hogsend/db`, ledger `drizzle.__drizzle_migrations`, owned by upstream, versioned *with the package*.
- **Client track** — migrations live in the client repo `migrations/`, ledger `drizzle.__client_migrations`, owned by the client.
- Drizzle's `migrate()` accepts `migrationsTable` / `migrationsSchema`, so run **engine-first, then client**, each against its own ledger.

- [x] Parameterize the migrator (`packages/db/src/migrate.ts`) by `(migrationsFolder, migrationsTable, migrationsSchema)`; keep the advisory lock + timeouts. Expose `migrateEngine()` and `migrateClient(folder)` thin wrappers.
- [x] Parameterize `getSchemaVersion()` (`packages/db/src/version.ts`) by `(journal source, ledger table)`; keep the count-based comparison. Provide `getEngineSchemaVersion(db)` and `getClientSchemaVersion(db, journal)`.
- [x] Update the **boot guard** to assert the **engine** track matches the installed `@hogsend/engine` bundled migrations (`0000..N`). Client track does not gate boot (client owns it).
- [x] Widen `/v1/health` schema block to `schema: { engine: {...}, client: {...} }`, each with `{ required, applied, pending, inSync }`; `migration_pending` true if **either** track has pending.
- [x] Update Railway `preDeployCommand` to run **engine migrate then client migrate** (`db:migrate && db:migrate:client`).
- [x] Document the **cross-track sharp edge** in `docs/UPGRADING.md`: additive client migrations only; re-verify after engine upgrades; engine schema follows expand→migrate→contract.

**Verify / Success:**
- [x] Extend `apps/api/src/__tests__/migration-system.test.ts` to cover **both tracks** against a throwaway DB: engine-first then client; independent ledgers; pending detected per track; boot guard keys off engine track; `/v1/health` faithfully reports both.
- [x] Idempotency holds per track (re-run = no-op).
- [x] `.github/workflows/ci.yml` migrations job updated to exercise both tracks.
- [x] Full suite green (102 baseline + new track tests; suite now 118).

---

### Phase 3 — `create-hogsend` Scaffolder *(Risk: MEDIUM)*

**Depends on:** Phase 1 (engine API), Phase 2 (client migration track); decisions **D1, D6**.

- [x] Scaffold `packages/create-hogsend`: CLI entry (prompts for name, package manager), template copy, dep install, git init. *(zero-runtime-dep CLI; dotfile rename map + token substitution.)*
- [x] Author the **client starter template**:
  - [x] Thin `src/index.ts` (HTTP) + `src/worker.ts`, both consuming `@hogsend/engine` (with the real `getEngineSchemaVersion` boot guard).
  - [x] Example journey(s) (welcome + test-onboarding) + constants + webhook source (posthog) registered in app code per **D1**.
  - [x] drizzle config (pointing at the **client** `__client_migrations` track), `migrations/` with a real `0000_init` client migration + `scripts/migrate.ts` (engine-then-client).
  - [x] `railway.toml` + `railway.worker.toml` (engine-then-client preDeploy migrate), `docker-compose.yml`, `env.example`, `.node-version` (22), Biome config, vitest config, tsup config.
  - [x] `package.json` with `@hogsend/engine` + `@hogsend/*` **pinned** to the engine line.
- [x] `create-hogsend` pins the engine version it emits (one source of truth in `src/template-manifest.ts`).
- [x] README for the scaffolded app (dev loop, two-track migrations, db:push gotcha, upgrading).

**Verify / Success:**
- [x] `pnpm dlx create-hogsend@latest` (against `pnpm pack` tarballs) produces a fresh app in a clean dir outside the monorepo — proven by `scripts/verify-scaffold.sh`.
- [x] In that app: `pnpm install`, `check-types`, `build` (dist/index.js + dist/worker.js) all green; token substitution + no `{{}}`/`workspace:` residue asserted. *(`docker compose up` + live `pnpm dev` end-to-end is a documented manual step.)*
- [x] `/v1/health` two-track reporting verified via the engine + apps/api tests; scaffolded-app live `inSync:true` is the manual boot step.

---

### Phase 4 — Publish Pipeline *(Risk: MEDIUM)* — **last step of first usable release**

**Depends on:** Phases 0–3.

- [x] Add a **changesets release workflow** to `.github/workflows/release.yml`: two-phase changesets/action@v1 flow, documents NPM_TOKEN + provenance. *(config-only; not triggered — no real publish per guardrails.)*
- [x] Configure npm auth path (org scope `@hogsend`, automation token documented in `docs/RELEASING.md`; provenance noted).
- [x] Codify **semver discipline** in `docs/RELEASING.md`: breaking API change OR non-expand/contract schema change = **major**.
- [x] Ensure **engine migrations ship versioned with the package** — `@hogsend/db` `files` includes `drizzle` (load-bearing; runtime migrator reads SQL from disk); boot guard keys off bundled migrations.
- [x] Verify `/docs` + `/openapi.json` remain disabled in production builds — locked by `apps/api/src/__tests__/openapi-prod.test.ts`.

**Verify / Success:**
- [x] `pnpm changeset version` + a **dry-run publish** produce correct version bumps and changelogs — verified (engine/db/core bumped in lockstep via linked group), then fully reverted to byte-identical 0.0.1.
- [x] `pnpm -r publish --dry-run --no-git-checks` exit 0 lists exactly the 7 publishable packages (public access), excludes private workspaces; db tarball carries `drizzle/*.sql` + `src/migrate.ts`.
- [ ] Tag + CHANGELOG appear for a **real** release. *(deferred — real publish is out of scope per guardrails; see "Remaining work".)*

---

### Phase 5 — Eject / Patch Tooling + Docs *(Risk: LOW)*

**Depends on:** Phase 4.

- [x] Document the **Extend → Patch → Eject** ladder in `docs/` (extend = injection points, patch = `pnpm patch @hogsend/engine`, eject = vendor copy). → [`docs/customizing-the-engine.md`](./customizing-the-engine.md).
- [x] Implement `hogsend eject @hogsend/engine`: copy package source into `vendor/engine`, rewrite the client dep to a `file:` link, leave all other `@hogsend/*` upgradable. → `@hogsend/cli` (`packages/cli`), unit-tested in `packages/cli/src/__tests__/eject.test.ts`.
- [ ] (Optional, later) Plan jscodeshift **codemods** for breaking API renames (`npx @hogsend/codemod vX`).

**Verify / Success:**
- [x] Prove **Patch** re-applies on install and fails loudly on upstream conflict — scripted in `packages/cli/scripts/patch-check.sh` (on-demand, `pnpm pack`-based) + manual steps in [`docs/customizing-the-engine.md`](./customizing-the-engine.md) §5.
- [x] **Eject** `@hogsend/engine` → only that dep is rewritten to `file:./vendor/engine` while every other `@hogsend/*` stays upgradable — asserted by the always-on unit suite `packages/cli/src/__tests__/eject.test.ts` (#3) + optional sandbox `packages/cli/scripts/eject-check.sh`.

---

### Phase 6 — Dogfood the Reference Deployment *(Risk: MEDIUM)*

**Depends on:** Phases 1–5.

- [x] **PREP + RUNBOOK** for migrating the production reference deployment onto the consumer model — `docs/phase-6-dogfood-runbook.md` (ordered, human-gated, SAFE-NOW / MANUAL-operator / MANUAL-operator-PROD tags). Staged inert `railway.toml.phase6` / `railway.worker.toml.phase6` + `scripts/db-backup.sh` (refuses without explicit DATABASE_URL) + `apps/api/src/__tests__/railway-config.test.ts`.
- [ ] **LIVE cutover** — run engine-then-client migrate via Railway preDeploy on the live DB. *(deferred — no production/Railway/Supabase access per guardrails; see "Remaining work".)*

**Verify / Success:**
- [ ] Production parity (live). *(deferred — operator executes the runbook.)*
- [ ] A subsequent `pnpm up @hogsend/*` upgrade applies cleanly with no manual merge. *(clean-upgrade proof scripted in Step 8 of the runbook; live execution deferred.)*

---

## 🎯 Definition of Done (overall)

- [x] `apps/api` is a thin `@hogsend/engine` consumer; baseline 102 tests green, suite grown to **118**, plus new two-track tests.
- [x] Two-track migrations apply independently, are idempotent, and are reported per-track in `/v1/health`; CI exercises both tracks.
- [x] `pnpm dlx create-hogsend@latest` yields a scaffolded app outside the monorepo (scaffold→install→check-types→build proven; live `pnpm dev` end-to-end is a documented manual step).
- [~] `@hogsend/*` + `create-hogsend` publish pipeline added and **dry-run verified**; real publish to npm **deferred** (guardrails).
- [x] Extend, Patch, and Eject documented; Extend + Eject proven in sandbox; Patch scripted (SKIPs until packages published).
- [~] Reference deployment runs on the consumer model — **PREP + RUNBOOK delivered**; live cutover **deferred** (guardrails).
- [x] `pnpm build`, `pnpm check-types`, `pnpm lint` green throughout; Conventional Commits maintained.

---

## ⏭️ Remaining work (deferred, out of scope under guardrails)

These are intentionally not done in this run and require human/operator action:

1. **Real npm publish** — the changesets release pipeline (`.github/workflows/release.yml`) and `docs/RELEASING.md` are in place and dry-run verified, but no package has been published. First real release requires an `@hogsend` npm org + automation `NPM_TOKEN` in CI, then merging a version PR. Versions remain `0.0.1`.
2. **Live production cutover (Phase 6)** — runbook (`docs/phase-6-dogfood-runbook.md`) + staged `railway.*.phase6` configs + `scripts/db-backup.sh` are ready, but no Railway/live-DB/Supabase action was taken. An operator runs the gated procedure (backup → flip configs → ledger baseline → deploy → parity verify → clean-upgrade proof → rollback path).
3. **Manual sandbox boot checks** — the scaffolded app's full `docker compose up -d` + `pnpm dev` end-to-end journey/tracked-email run, and the scaffolded app's `/v1/health` reporting both tracks `inSync:true`, are documented manual steps (the automated harness stops at scaffold→install→check-types→build→biome).
4. **Patch-path live proof** — `packages/cli/scripts/patch-check.sh` SKIPs until `@hogsend/*` are on a registry (depends on item 1); the binding Eject proof is the always-on unit suite.
5. **Optional, post-1.0** — jscodeshift codemods for breaking API renames (`@hogsend/codemod vX`), revisit D5 (package split) / D6 (Railway one-click template).

---

## 📝 Notes

**Tech / tooling choices (with why):**
- **changesets** — purpose-built for monorepo multi-package versioning + per-package CHANGELOGs; integrates with CI publish on merge.
- **Single `@hogsend/engine`** *(recommended, D5)* — one upgrade unit and one public API surface is simpler to version than split HTTP/worker/framework packages; revisit if the surface gets unwieldy.
- **Two ledgers in one DB** *(recommended, D4)* — `drizzle.__drizzle_migrations` (engine) + `drizzle.__client_migrations` (client) keeps ownership clean without the operational cost of a second schema.
- **Public npm + `create-hogsend`** — chosen distribution model; gives clients normal `pnpm up` upgrades instead of monorepo-fork merges.
- **tsup `noExternal`** — keep the existing bundling so `@hogsend/*` resolve cleanly for consumers (engine bundles its `@hogsend/*` deps; runtime npm deps resolve from `node_modules`).

**Design principles:**
- **Framework vs content boundary is the whole game** — if it's framework it lives in the engine; if it's content it lives in the client repo and is registered by client app code (never a shared index). This is what kills merge conflicts.
- **Reuse the upgrade-safety system** — Phase 2 parameterizes the migrator / `getSchemaVersion` / boot guard / health block; it does not reinvent them.
- **Forward-only, expand→migrate→contract** for engine schema (see `docs/UPGRADING.md`); **additive-only** client migrations against engine tables.
- **Escalating editability** — keep the common case (Extend) zero-cost; Patch and Eject are deliberate, documented escape hatches with clear upgrade tradeoffs.

---

## 🚀 Next Steps (after the cut line)

1. **Phases 5–6** — ship the eject/patch tooling + docs, then move hogsend.com onto the consumer model for true dogfooding.
2. **Codemods** — `@hogsend/codemod vX` to automate breaking API renames as the public surface evolves.
3. **Optional package split** — revisit D5 (split engine into HTTP/worker/framework) only if the single-package API surface becomes a versioning burden.
4. **Railway one-click template** — revisit D6 to ship a one-click deploy alongside the CLI scaffolder.
