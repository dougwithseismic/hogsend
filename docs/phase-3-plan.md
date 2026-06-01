# Phase 3 — `create-hogsend` Scaffolder — Implementation Plan

**Status:** PLAN ONLY (no implementation yet).
**Depends on:** Phase 1 (engine API, dogfooded green), Phase 2 (two-track migrations). Decisions **D1** (content scaffolded, editable) and **D6** (app-only scaffold; Railway one-click deferred).
**Source of truth:** `docs/TODO-packages-migration.md` (Phase 3 checklist), `docs/engine-boundary.md` (injection seams), `docs/UPGRADING.md` (ledger gotcha + migration contract).

---

## 0. Key constraints discovered in this codebase (read before building)

These shape every decision below — the plan is written around them, not against them.

1. **All `@hogsend/*` packages currently ship RAW `.ts`.** `packages/{core,db,email,engine}/package.json` set `"private": true` and their `exports` map points at `./src/*.ts` (e.g. `@hogsend/engine` → `"./src/index.ts"`, `"./worker": "./src/worker.ts"`). Engine/core/db have **no `build` script and no `dist/`**. They are consumed today only by being bundled into the consumer's `tsup` build via `noExternal` (`apps/api/tsup.config.ts` lists all 5 `@hogsend/*` pkgs). For tests, `apps/api/vitest.config.ts` `server.deps.inline: [/@hogsend\/engine/]` makes Vite transform the raw `.ts` and resolve the `.js`-extension relative imports back to `.ts`.
   - **Implication for the scaffolded app:** it MUST replicate both seams — a `tsup.config.ts` with `noExternal: [@hogsend/*]` for `build`, and a `vitest.config.ts` with `server.deps.inline: [/@hogsend\/engine/]` for tests. Otherwise Node's resolver chokes on `./app.js` (a `.ts` file) at runtime/test time.
   - **Implication for the Phase 3 test (this run):** we cannot do a real `npm publish`. Publishing is Phase 4 and is DRY-RUN ONLY (hard guardrail). So the scaffolder's emitted `package.json` will, for the verification run, resolve `@hogsend/*` from local `pnpm pack` tarballs (`file:` specifiers). Because the packages are `private:true` with no `files`/`dist`, `pnpm pack` on them as-is will produce tarballs containing `src/**` (the raw `.ts`) — which is exactly what the consumer bundles. We exploit that: **pack each `@hogsend/*` workspace, install the tarballs into the temp app, and prove install + typecheck + build.** This is the documented, repo-honest substitute for a published registry.
   - **Do NOT** flip the packages to `"private": false` or add real `dist` builds here — that is Phase 4 publish-pipeline work and out of scope. We only need tarballs that carry `src/**`.

2. **The current engine version line is `0.0.1`** (`packages/engine/package.json` `version`, also `API_VERSION = "0.0.1"` in `packages/engine/src/env.ts`). `create-hogsend` PINS this exact line into the emitted `package.json` (D1/Phase-3 requirement: "create-hogsend pins the engine version it emits"). The pin string lives in ONE place in the CLI (a `ENGINE_VERSION` constant) so Phase 4 can bump it from changesets.

3. **Content the scaffold must carry (D1).** Per `docs/engine-boundary.md` the CONTENT files are: `src/index.ts`, `src/worker.ts`, `src/journeys/*` (+ `journeys/index.ts`, `journeys/constants/*`), `src/webhook-sources/*` (+ `webhook-sources/index.ts`), `src/workflows/*` (+ `workflows/index.ts`). The dogfood `apps/api/src` is the canonical reference for the shape of these files. The template will carry a SMALL curated subset (one example journey, one example webhook source, one example workflow), NOT all 10 journeys — the scaffold is a starter, not a clone.

4. **Env contract** is fixed by `packages/engine/src/env.ts` (t3-env). Required at boot: `DATABASE_URL`, `BETTER_AUTH_SECRET`, `RESEND_API_KEY`. Optional: Hatchet/PostHog/Redis/etc. `.env.example` must mirror this exactly. Ports: API 3002, Timescale 5434, Redis 6380, Hatchet gRPC 7077 / dashboard 8888 (from `docker-compose.yml`).

5. **Two-track migrations (Phase 2)** mean the client owns `migrations/` with ledger `drizzle.__client_migrations`, and the engine track (`@hogsend/db` migrations, ledger `drizzle.__drizzle_migrations`) applies first. The scaffold's `drizzle.config.ts` points `out` at the CLIENT `./migrations` dir and `schema` at the client's own schema entry. Railway preDeploy runs **engine migrate then client migrate** in that order. (If Phase 2 landed `migrateEngine()` / `migrateClient(folder)` wrappers in `@hogsend/db`, the scaffold's package scripts call those; this plan references them by name and degrades gracefully if Phase 2's exact wrapper names differ — see Step 4.)

---

## 1. Package layout: `packages/create-hogsend`

Create a new workspace `packages/create-hogsend` (it is a tool, lives in the monorepo, published in Phase 4).

```
packages/create-hogsend/
  package.json
  tsconfig.json
  README.md                      # documents the pnpm-pack/file: tarball test strategy
  src/
    index.ts                     # CLI bin entry (the whole scaffolder; dependency-light)
    prompts.ts                   # arg parsing + minimal interactive prompts
    copy.ts                      # recursive template copy + token replacement
    template-manifest.ts         # ENGINE_VERSION constant + dotfile rename map
  template/                      # the client starter (shipped verbatim, minus token swaps)
    ... (see Section 2)
```

### 1.1 `packages/create-hogsend/package.json`

- `"name": "create-hogsend"` (NOT scoped — `pnpm dlx create-hogsend` / `npm create hogsend` convention requires the bare name).
- `"version": "0.0.1"` (tracks the engine line; same constant as `ENGINE_VERSION`).
- `"type": "module"`, `"engines": { "node": ">=22" }`.
- `"bin": { "create-hogsend": "./dist/index.js" }`.
- `"files": ["dist", "template"]` — the `template/` dir ships in the tarball (it is data, not compiled). **This package, unlike the others, DOES build to `dist`** because a CLI must run as plain JS via `pnpm dlx`. Use `tsup` (entry `src/index.ts`, format esm, target node22, `shims` off, `banner` with `#!/usr/bin/env node`).
- Add the shebang via tsup `banner: { js: "#!/usr/bin/env node" }` OR keep `src/index.ts` starting with `#!/usr/bin/env node` and let tsup preserve it; verify the built `dist/index.js` is executable (`chmod +x` in a `build` post-step is unnecessary — `pnpm dlx`/npm sets the bit from the `bin` field, but add `"prepublishOnly"` note only in Phase 4).
- Dependency-light. Allowed runtime deps (add via `pnpm --filter create-hogsend add <pkg>@latest`, never hand-edit ranges):
  - `prompts@latest` (tiny, well-maintained) for interactive prompts — OR implement with `node:readline/promises` to keep ZERO runtime deps. **Decision: use `node:readline/promises` + `node:util parseArgs` to keep runtime deps at zero.** This is the smallest, most auditable choice and matches "keep it small and dependency-light (e.g. a single bin script)."
  - No `commander`, no `chalk` (use raw ANSI escape constants in a 6-line helper if color is wanted; optional).
- devDeps: `tsup`, `@types/node`, `@repo/typescript-config` (via `pnpm --filter create-hogsend add -D ...`).
- Scripts: `"build": "tsup"`, `"check-types": "tsc --noEmit"`, `"lint": "biome check ."`.

### 1.2 `tsup.config.ts` (or inline in package.json `tsup` key)

```ts
import { defineConfig } from "tsup";
export default defineConfig({
  entry: ["src/index.ts"],
  format: ["esm"],
  target: "node22",
  outDir: "dist",
  clean: true,
  banner: { js: "#!/usr/bin/env node" },
});
```

Note: `template/**` is NOT bundled — it is copied at runtime via `node:fs`. The CLI resolves the template dir relative to its own location: `fileURLToPath(new URL("../template", import.meta.url))` from `dist/index.js`, so `template/` must sit as a sibling of `dist/` in the published tarball (hence `files: ["dist","template"]`).

---

## 2. The client starter template (`packages/create-hogsend/template/`)

Authored as real files. Files that must not be interpreted by the monorepo's own tooling (so they don't get linted/typechecked as part of the repo, and so npm doesn't drop dotfiles) use renamed sources that the copier renames on emit (Section 3.3). Specifically: `gitignore` → `.gitignore`, `npmrc` → `.npmrc`, `env.example` → `.env.example`, `node-version` → `.node-version`, `_package.json` → `package.json` (the leading-underscore `package.json` trick prevents the monorepo's pnpm from treating `template/` as a workspace and prevents npm from stripping it on pack).

### 2.1 `template/_package.json` (emitted as `package.json`)

Mirror `apps/api/package.json` but as a standalone (non-workspace) app:

- `"name": "{{APP_NAME}}"` (token replaced by the CLI), `"version": "0.0.0"`, `"private": true`, `"type": "module"`.
- Scripts (copied/adapted from `apps/api` + db scripts):
  - `"dev": "tsx watch --env-file=.env src/index.ts"`
  - `"worker:dev": "tsx watch --env-file=.env src/worker.ts"`
  - `"build": "tsup"`
  - `"start": "node dist/index.js"`
  - `"worker": "node dist/worker.js"`
  - `"check-types": "tsc --noEmit"`
  - `"test": "vitest run"`, `"test:watch": "vitest"`
  - `"db:generate": "drizzle-kit generate"` (client track — see drizzle.config below)
  - `"db:migrate": "hogsend-migrate"` — **see Step 4 for the exact migrate command.** The scaffold must run engine-then-client. Concretely the script is either:
    - `"db:migrate:engine": "<call @hogsend/db engine migrate>"` and `"db:migrate:client": "<call @hogsend/db client migrate ./migrations>"` and `"db:migrate": "pnpm db:migrate:engine && pnpm db:migrate:client"`, OR
    - a one-line `tsx scripts/migrate.ts` in the template that imports the Phase-2 wrappers from `@hogsend/db` (`migrateEngine`, `migrateClient`) and runs them in order. **Decision: emit `template/scripts/migrate.ts`** (Section 2.9) so the scaffold is self-contained and does not depend on the exact CLI surface of `@hogsend/db`.
  - `"db:push": "drizzle-kit push"` (dev-only; README warns about the ledger gotcha per `docs/UPGRADING.md`).
- `"dependencies"` — PINNED to the engine line via `ENGINE_VERSION` token `{{ENGINE_VERSION}}` (e.g. `"0.0.1"` → emitted as `"^0.0.1"` / exact, decided in Step 5):
  - `@hogsend/engine`, `@hogsend/core`, `@hogsend/db`, `@hogsend/email`, `@hogsend/plugin-posthog`, `@hogsend/plugin-resend` — all `"{{ENGINE_VERSION}}"`.
  - runtime npm deps that the engine expects to resolve from the consumer's `node_modules` (engine is bundled via noExternal but its EXTERNAL deps must exist in the consumer): copy the non-`@hogsend` deps from `packages/engine/package.json` `dependencies` (`@hatchet-dev/typescript-sdk`, `@hono/node-server`, `@hono/zod-openapi`, `@scalar/hono-api-reference`, `@t3-oss/env-core`, `better-auth`, `drizzle-orm`, `hono`, `ioredis`, `papaparse`, `resend`, `winston`, `zod`) — same version ranges. Plus `react`/`react-dom` for `@hogsend/email` templates (see `apps/api` carries `react`), and `postgres` (from `@hogsend/db` deps).
  - **Why duplicate engine's externals:** because tsup `noExternal` inlines `@hogsend/*` source but leaves their npm deps external, the consumer's bundle references e.g. `hono` at runtime, so it must be installed in the consumer. This is the same reason `apps/api/package.json` lists all of them.
- `"devDependencies"`: `tsup`, `tsx`, `vitest`, `drizzle-kit`, `@biomejs/biome`, `@types/node`, `@types/papaparse`, `@types/react`, `typescript`. (Self-contained — no `@repo/typescript-config`; the scaffold ships its own `tsconfig.json`, Section 2.7.)
- `"packageManager"` / `"engines": { "node": ">=22" }`.

### 2.2 `template/src/index.ts` (CONTENT — thin HTTP entry)

Near-verbatim copy of `apps/api/src/index.ts` (the boot-guard version). It imports `createApp`, `createContainer`, `getPostHog`, `getRedisIfConnected`, `getSchemaVersion` from `@hogsend/engine`; `{ journeys }` from `./journeys/index.js`; `{ webhookSources }` from `./webhook-sources/index.js`. Keeps the schema boot guard + graceful shutdown verbatim. No tokens needed.

### 2.3 `template/src/worker.ts` (CONTENT — thin worker entry)

Verbatim copy of `apps/api/src/worker.ts`: `createContainer({ journeys })` + `createWorker({ container, journeys })`, SIGTERM/SIGINT shutdown, `await worker.start()` last. If the example workflow (Section 2.6) needs registering, pass `workflows` into `createWorker` — but per current `apps/api/src/worker.ts` it does NOT pass extra workflows (sendEmailTask is auto-registered by the engine). Keep parity: the example backfill workflow is exported from `workflows/index.ts` and only wired if a journey/route uses it. Document in README how to add it to `createWorker({ ..., workflows })`.

### 2.4 `template/src/journeys/` (CONTENT — example journeys)

- `template/src/journeys/welcome.ts` — a single, well-commented example journey using `defineJourney` from `@hogsend/engine`, `days()/hours()` from `@hogsend/core` (re-exported via engine), and `Events`/`Templates` constants. Model it on `apps/api/src/journeys/activation-welcome.ts` but trimmed to ~1 email send + 1 sleep + 1 conditional, with inline comments pointing at "add your own journey here." It should reference `sendEmail()` from `@hogsend/engine` and one email template from `@hogsend/email`.
- `template/src/journeys/test-onboarding.ts` — copy `apps/api/src/journeys/test-onboarding.ts` VERBATIM. **Rationale:** this is the journey the smoke/e2e path exercises (`test.signup` → completion). Including it lets the scaffolded app reuse the exact end-to-end proof if a full boot is attempted, and gives the user a trivially-testable journey.
- `template/src/journeys/index.ts` — the `journeys` aggregation array, modeled on `apps/api/src/journeys/index.ts` but listing only `[welcome, testOnboarding]`. Typed `DefinedJourney[]` imported from `@hogsend/engine`. Comment: "Edit freely — this is your content."
- `template/src/journeys/constants/index.ts` — copy the constants module shape from `apps/api/src/journeys/constants/` (the `Events`/`Templates` `as const` objects), trimmed to the events/templates the two example journeys use (`TEST_SIGNUP`, `JOURNEY_*`, plus whatever `welcome.ts` emits). Confirm exact contents by reading `apps/api/src/journeys/constants/` at implementation time.

### 2.5 `template/src/webhook-sources/` (CONTENT)

- `template/src/webhook-sources/posthog.ts` — copy `apps/api/src/webhook-sources/posthog.ts` verbatim (it is already a clean, generic example using `defineWebhookSource`).
- `template/src/webhook-sources/index.ts` — `export const webhookSources: DefinedWebhookSource[] = [posthogSource];` (verbatim from `apps/api`).

### 2.6 `template/src/workflows/` (CONTENT — example workflow + backfill)

- `template/src/workflows/index.ts` — `export { sendEmailTask } from "@hogsend/engine";` and `export { backfillExampleTask } from "./backfill-example.js";` (mirrors `apps/api/src/workflows/index.ts`).
- `template/src/workflows/backfill-example.ts` — copy `apps/api/src/workflows/backfill-example.ts` (the Hatchet backfill task template using `runBatchedBackfill` from `@hogsend/engine`). Read it at implementation time and copy verbatim; it is the documented backfill example and pairs with `docs/UPGRADING.md` rule 4.

### 2.7 `template/tsconfig.json`

Self-contained (cannot extend `@repo/typescript-config` outside the monorepo). Base it on the resolved config that `apps/api/tsconfig.json` produces. Key fields: `"target": "ES2022"`, `"module": "ESNext"`, `"moduleResolution": "Bundler"` (so `.js`-extension relative imports resolve against `.ts` — matches how the engine ships raw `.ts`), `"strict": true`, `"esModuleInterop": true`, `"skipLibCheck": true`, `"types": ["node"]`, `"verbatimModuleSyntax": true`, `"noEmit": true`, `"jsx": "react-jsx"` (for `@hogsend/email` `.tsx` templates), `"lib": ["ES2023"]`. `"include": ["src/**/*", "scripts/**/*", "*.config.ts", "drizzle.config.ts"]`. Read `packages/typescript-config/*.json` at implementation time to copy the exact base values rather than guessing.

### 2.8 `template/tsup.config.ts`

Copy `apps/api/tsup.config.ts` verbatim — entry `["src/index.ts","src/worker.ts"]`, esm, node22, `noExternal: ["@hogsend/core","@hogsend/db","@hogsend/email","@hogsend/plugin-posthog","@hogsend/plugin-resend"]`. **Add `"@hogsend/engine"` to `noExternal`** — `apps/api` doesn't list engine there because... verify: `apps/api/tsup.config.ts` does NOT include `@hogsend/engine` in noExternal, yet `apps/api build` works. That is because in the monorepo `@hogsend/engine` resolves to raw `.ts` and tsup follows it transitively from the noExternal entry... Actually tsup only inlines packages explicitly in `noExternal`. Confirm at implementation: if `apps/api build` currently bundles engine, replicate exactly; if engine is left external in `apps/api` and that still builds, replicate exactly. **Action item: read the produced `apps/api/dist/index.js` (or run `pnpm --filter @hogsend/api build` and grep) to confirm whether `@hogsend/engine` source is inlined; set the template's `noExternal` to match the proven-working `apps/api` config exactly.** Do not diverge from what is known-green.

### 2.9 `template/scripts/migrate.ts` (engine-then-client migrate)

Self-contained migrate runner the `db:migrate` script calls:

```ts
// Runs the ENGINE migration track first, then the CLIENT track.
// Engine ledger: drizzle.__drizzle_migrations (owned by @hogsend/db).
// Client ledger: drizzle.__client_migrations (owned by this repo, ./migrations).
import { migrateEngine, migrateClient } from "@hogsend/db";
// (exact names per Phase 2; fall back to the parameterized migrate() if wrappers differ)

const url = process.env.DATABASE_URL;
if (!url) throw new Error("DATABASE_URL required");
await migrateEngine({ url });               // engine track
await migrateClient({ url, folder: "./migrations" }); // client track
console.log("migrations applied (engine + client)");
```

**Implementation note:** Read `packages/db/src/migrate.ts` / `packages/db/src/index.ts` exports at implementation time to use the exact Phase-2 wrapper signatures. If Phase 2 exposed `migrate({ folder, table, schema })` instead of `migrateEngine/migrateClient`, call it twice with the right `(folder, table)` per track. The template must compile against whatever `@hogsend/db` actually exports.

### 2.10 `template/drizzle.config.ts` (CLIENT track)

Modeled on `packages/db/drizzle.config.ts` but pointed at the CLIENT track:

```ts
import { defineConfig } from "drizzle-kit";
export default defineConfig({
  out: "./migrations",                 // CLIENT migration dir (track owned here)
  schema: "./src/schema/index.ts",     // client's own added tables (see 2.11)
  dialect: "postgresql",
  migrations: { table: "__client_migrations", schema: "drizzle" }, // D4 client ledger
  dbCredentials: { url: process.env.DATABASE_URL! },
});
```

Confirm `drizzle-kit`'s `migrations.table`/`migrations.schema` config keys at implementation time (drizzle-kit version `^0.31.10`); they set which ledger `db:generate`/`db:push` reference. The CLIENT generate must NOT touch the engine's `__drizzle_migrations`.

### 2.11 `template/src/schema/index.ts` + `template/migrations/`

- `template/src/schema/index.ts` — a minimal CLIENT schema file with ONE example table (e.g. `clientNotes` or commented-out stub) so `db:generate` has a schema target and the seed migration is non-empty. Comment: "Add your own tables here. Engine tables live in @hogsend/db and migrate on the engine track."
- `template/migrations/0000_init.sql` — the SEED EXAMPLE client migration (one `CREATE TABLE` matching the example schema table), plus the drizzle `meta/_journal.json` + `meta/0000_snapshot.json` that `drizzle-kit generate` would have produced. **Decision: generate these for real at implementation time** by running `drizzle-kit generate` once against the template's drizzle.config in a scratch dir, then copy the output into `template/migrations/`. Do NOT hand-author the journal/snapshot. If generating is impractical, ship an empty `template/migrations/` with a `README.md` stub explaining `pnpm db:generate`, and have the verification step run `db:generate` to populate it — but the TODO says "empty migrations/ with one seed example", so prefer the real generated seed.

### 2.12 Config + ops files

- `template/biome.json` — copy repo `biome.json` verbatim (self-contained; the `vcs.useIgnoreFile` is fine).
- `template/vitest.config.ts` — copy `apps/api/vitest.config.ts` verbatim **including `server.deps.inline: [/@hogsend\/engine/]`** (mandatory — see Constraint 1) and the injected test env block. This makes the scaffold's tests run against the raw-`.ts` engine exactly like the dogfood.
- `template/env.example` (→ `.env.example`) — mirror EVERY key in `packages/engine/src/env.ts` with local-dev defaults: `DATABASE_URL=postgresql://growthhog:growthhog@localhost:5434/growthhog`, `REDIS_URL=redis://localhost:6380`, `BETTER_AUTH_SECRET=` (note: min 32 chars; provide a placeholder + comment), `RESEND_API_KEY=`, `HATCHET_CLIENT_TOKEN=` (comment: copy from Hatchet dashboard at localhost:8888), `PORT=3002`, `API_PUBLIC_URL=http://localhost:3002`, `ENABLED_JOURNEYS=*`, and the optional PostHog/webhook-secret keys commented. Match types (URLs, emails) so the t3-env validation passes.
- `template/docker-compose.yml` — copy repo `docker-compose.yml` verbatim (Timescale 5434, Redis 6380, Hatchet-Lite 8888/7077, hatchet-postgres). It is already client-agnostic.
- `template/node-version` (→ `.node-version`) — `22`.
- `template/gitignore` (→ `.gitignore`) — `node_modules`, `dist`, `.env`, `logs`, `.turbo`, `*.tsbuildinfo`.
- `template/npmrc` (→ `.npmrc`) — optional; only if needed to pin the package manager. Likely omit.

### 2.13 `template/railway.toml` + `template/railway.worker.toml`

Adapt the repo configs to a STANDALONE app (no `--filter @hogsend/api`):

`railway.toml`:
```toml
[build]
buildCommand = "pnpm build"
watchPatterns = ["src/**", "migrations/**", "package.json", "pnpm-lock.yaml", "railway.toml"]

[deploy]
preDeployCommand = "pnpm db:migrate"   # engine-then-client via scripts/migrate.ts
startCommand = "pnpm start"
healthcheckPath = "/v1/health"
healthcheckTimeout = 120
restartPolicyType = "ON_FAILURE"
restartPolicyMaxRetries = 3
```

`railway.worker.toml`:
```toml
[build]
buildCommand = "pnpm build"
watchPatterns = ["src/**", "package.json", "pnpm-lock.yaml", "railway.worker.toml"]

[deploy]
startCommand = "pnpm worker"
restartPolicyType = "ON_FAILURE"
restartPolicyMaxRetries = 5
```

The key change from the repo's versions: `pnpm db:migrate` now runs engine-then-client (Section 2.9), satisfying the Phase-3 "engine-then-client preDeploy migrate" requirement.

### 2.14 `template/README.md` (the scaffolded app's README)

Sections: (1) Prereqs (Node 22, pnpm, Docker). (2) Quickstart: `cp .env.example .env` → fill `BETTER_AUTH_SECRET`/`RESEND_API_KEY`/`HATCHET_CLIENT_TOKEN` → `docker compose up -d` → `pnpm db:migrate` → `pnpm dev` (+ `pnpm worker:dev` in a second terminal). (3) Dev loop. (4) Adding a journey (create `src/journeys/x.ts` with `defineJourney`, add to `src/journeys/index.ts`) — mirrors CLAUDE.md guidance. (5) Adding a webhook source. (6) Migrations: two tracks explained (engine = `@hogsend/db`, client = `./migrations`), `pnpm db:generate` for client schema changes, the `db:push` ledger gotcha (link the upgrade contract). (7) Upgrading: `pnpm up @hogsend/*`, then `pnpm db:migrate`, then check `/v1/health` reports both tracks `inSync`. (8) Health: `GET /v1/health`.

---

## 3. The CLI (`packages/create-hogsend/src/index.ts`)

Single, dependency-light bin script. Flow:

### 3.1 Arg parsing (`src/prompts.ts`)
Use `node:util` `parseArgs`:
- Positional: app name (e.g. `pnpm dlx create-hogsend my-app`).
- Flags: `--pm <pnpm|npm|yarn|bun>` (default `pnpm`), `--no-install`, `--no-git`, `--use-tarballs <dir>` (TEST-ONLY: rewrite `@hogsend/*` deps to `file:<dir>/<pkg>.tgz`; documented as the local-resolution path used in CI/verification before Phase 4 publishing).
- If app name missing and TTY → prompt via `node:readline/promises`: "Project name:" and "Package manager:". If non-TTY and missing → error with usage.

### 3.2 Target dir
Resolve `path.resolve(process.cwd(), appName)`. Refuse if it exists and is non-empty (error). Create it.

### 3.3 Copy template (`src/copy.ts`)
Recursive `fs` copy from the package's `template/` dir into the target. During copy:
- Rename map: `gitignore`→`.gitignore`, `npmrc`→`.npmrc`, `env.example`→`.env.example`, `node-version`→`.node-version`, `_package.json`→`package.json`.
- Token replacement (only in `package.json` and `README.md`): `{{APP_NAME}}` → app name, `{{ENGINE_VERSION}}` → `ENGINE_VERSION` constant. Do a literal string replace; the tokens are unique enough.
- If `--use-tarballs <dir>` is set: after writing `package.json`, replace each `@hogsend/<pkg>: "{{ENGINE_VERSION}}"` value with `"file:<absDir>/hogsend-<pkg>-<ver>.tgz"` (and `file:<absDir>/create-hogsend-...` is irrelevant). This is the mechanism the verification step uses.

### 3.4 git init (`--no-git` to skip)
`git init`, write `.gitignore` (already copied), `git add -A`, `git commit -m "chore: scaffold hogsend app"` (NO co-author, per guardrails). Wrap in try/catch — git absence must not fail the scaffold.

### 3.5 install (`--no-install` to skip)
Run `<pm> install` in the target dir via `child_process.spawn` inheriting stdio. On failure, print a clear message and continue (don't delete the scaffold).

### 3.6 Final output
Print next steps (cd, edit .env, docker compose up, db:migrate, dev).

### 3.7 `ENGINE_VERSION` constant (`src/template-manifest.ts`)
`export const ENGINE_VERSION = "0.0.1";` — single source of truth for the pin. Phase 4 changesets bumps this in lockstep with `packages/engine/package.json`. Add a `check-types`-adjacent note (comment) that this must equal the engine package version.

---

## 4. Migrate-command wiring detail (engine-then-client)

The template's `db:migrate` MUST run engine track then client track. Resolution order at IMPLEMENTATION time (read `packages/db/src/index.ts` + `migrate.ts` first):
1. If Phase 2 exported `migrateEngine` / `migrateClient` from `@hogsend/db` → `template/scripts/migrate.ts` calls them in order (Section 2.9).
2. Else if Phase 2 exported a parameterized `migrate({ migrationsFolder, migrationsTable, migrationsSchema, url })` → call twice: first engine (`getBundledMigrations()` folder, `__drizzle_migrations`), then client (`./migrations`, `__client_migrations`).
3. Else (Phase 2's exact shape unknown to this planner) → the template ships `scripts/migrate.ts` written against the documented Phase-2 contract and a TODO comment; the verification step (Section 5) will surface any mismatch as a typecheck error to fix during implementation.

The engine boot guard (`template/src/index.ts`, carried verbatim from `apps/api`) keys off `getSchemaVersion(container.db)` which per Phase 2 reports the ENGINE track — the client track does not gate boot (D4/Phase-2 policy: client owns its track).

---

## 5. TEST / VERIFICATION (this run) — scaffold → install → typecheck → build, OUTSIDE the monorepo

**Hard rules honored:** no npm publish (tarballs only), no temp dirs left in the repo (use `/tmp`), no mutation of the shared dev DB.

Implement as a script `packages/create-hogsend/scripts/verify-scaffold.sh` (and document the manual steps in the package README). Exact steps and assertions:

1. **Build the CLI:** `pnpm --filter create-hogsend build` → assert `packages/create-hogsend/dist/index.js` exists and starts with the shebang.
2. **Pack all engine packages to a scratch tarball dir** (NOT in repo): `TARBALLS=$(mktemp -d /tmp/hogsend-tarballs.XXXXXX)`. For each of `@hogsend/core`, `@hogsend/db`, `@hogsend/email`, `@hogsend/plugin-posthog`, `@hogsend/plugin-resend`, `@hogsend/engine`: `pnpm --filter <pkg> pack --pack-destination "$TARBALLS"`.
   - **Assertion:** each `.tgz` contains `package/src/**` (raw `.ts`). Verify with `tar -tzf <tgz> | grep -q 'package/src/index'`. This proves Constraint 1's "tarball carries src" assumption. If a package's `private:true` blocks `pnpm pack`, fall back to `npm pack` (it packs `private` pkgs) — document whichever works.
3. **Scaffold into a clean temp dir outside the repo:** `APPDIR=$(mktemp -d /tmp/hogsend-app.XXXXXX)/my-app`. Run the built CLI directly: `node packages/create-hogsend/dist/index.js my-app --pm pnpm --no-install --no-git --use-tarballs "$TARBALLS"` with `cwd` = `$(dirname "$APPDIR")`.
   - **Assertions (filesystem):** `$APPDIR/package.json`, `src/index.ts`, `src/worker.ts`, `src/journeys/index.ts`, `src/journeys/welcome.ts`, `src/journeys/test-onboarding.ts`, `src/webhook-sources/posthog.ts`, `src/workflows/index.ts`, `drizzle.config.ts`, `migrations/0000_*.sql`, `docker-compose.yml`, `railway.toml`, `railway.worker.toml`, `.env.example`, `.node-version`, `.gitignore`, `biome.json`, `vitest.config.ts`, `tsconfig.json`, `tsup.config.ts`, `README.md` all exist.
   - **Assertion (tokens):** `grep -q '"name": "my-app"' package.json`; `grep -q 'file:.*hogsend-engine' package.json`; NO `{{` token remains anywhere (`! grep -rq '{{' "$APPDIR"`).
   - **Assertion (no monorepo leakage):** `! grep -q 'workspace:' "$APPDIR/package.json"` (deps must be tarball `file:` specifiers, never `workspace:`).
4. **Install in the temp app:** `cd "$APPDIR" && pnpm install --ignore-workspace` (the `--ignore-workspace` / running outside the repo guarantees pnpm does NOT treat it as part of the monorepo). Assert exit 0 and that `node_modules/@hogsend/engine/src/index.ts` exists (raw `.ts` from the tarball).
5. **Typecheck the scaffolded app:** `pnpm check-types` → assert exit 0. This is the strongest correctness signal: it compiles the thin entries + example content against the engine's real `.ts` types resolved from the tarball, and surfaces any migrate-wrapper name mismatch (Section 4) or env/type drift.
6. **Build the scaffolded app:** `pnpm build` → assert exit 0 and `dist/index.js` + `dist/worker.js` exist. This proves tsup `noExternal` correctly inlines the `@hogsend/*` raw `.ts` for a real consumer.
7. **Lint the scaffolded app (optional but cheap):** `pnpm exec biome check .` → assert exit 0 (proves the emitted content is Biome-clean: 2-space, double quotes, semicolons, 80-col).
8. **Cleanup:** `rm -rf "$TARBALLS" "$(dirname "$APPDIR")"`. Guarantee no `/tmp` or repo residue.

**Full end-to-end boot (deferred / documented manual check):** Booting the scaffolded app fully (docker compose up, `pnpm db:migrate`, fire `test.signup`, assert journey completes + tracked email) requires live Timescale/Redis/Hatchet and a Hatchet token. The repo's own `apps/api smoke` already proves this exact pipeline against the engine. For Phase 3 we PROVE install + typecheck + build of the scaffold (steps 4–6) and DOCUMENT the remaining manual boot check in `packages/create-hogsend/README.md` and `template/README.md`:
   - Manual: `cd my-app && cp .env.example .env` (fill secrets + `HATCHET_CLIENT_TOKEN` from localhost:8888) → `docker compose up -d` → `pnpm db:migrate` → `pnpm dev` & `pnpm worker:dev` → `curl -XPOST localhost:3002/v1/ingest -d '{"event":"test.signup",...}'` → poll `journeyStates` / `GET /v1/health` shows both tracks `inSync:true`.

**Regression gate (monorepo, must stay green):** After adding `packages/create-hogsend`, run from repo root: `pnpm check-types`, `pnpm build`, `pnpm lint`, and `pnpm --filter @hogsend/api test` (the 102-test suite must remain green — the new package must not perturb the workspace). Add an entry so Turbo's `build`/`check-types` include the new package.

---

## 6. Files to create (exhaustive)

CLI package:
- `packages/create-hogsend/package.json`, `tsconfig.json`, `tsup.config.ts` (or inline), `README.md`
- `packages/create-hogsend/src/index.ts`, `src/prompts.ts`, `src/copy.ts`, `src/template-manifest.ts`
- `packages/create-hogsend/scripts/verify-scaffold.sh`

Template (under `packages/create-hogsend/template/`):
- `_package.json`, `tsconfig.json`, `tsup.config.ts`, `vitest.config.ts`, `biome.json`, `drizzle.config.ts`
- `docker-compose.yml`, `railway.toml`, `railway.worker.toml`
- `env.example`, `node-version`, `gitignore`, (`npmrc` optional), `README.md`
- `src/index.ts`, `src/worker.ts`
- `src/journeys/index.ts`, `src/journeys/welcome.ts`, `src/journeys/test-onboarding.ts`, `src/journeys/constants/index.ts`
- `src/webhook-sources/index.ts`, `src/webhook-sources/posthog.ts`
- `src/workflows/index.ts`, `src/workflows/backfill-example.ts`
- `src/schema/index.ts`
- `scripts/migrate.ts`
- `migrations/0000_init.sql` + `migrations/meta/_journal.json` + `migrations/meta/0000_snapshot.json` (generated, not hand-authored)

---

## 7. Verification checklist (mirrors TODO Phase-3 Verify/Success)

- [ ] `node dist/index.js` (built CLI) scaffolds a fresh app into a clean dir OUTSIDE the monorepo (`/tmp`), with all expected files and no `{{token}}` / `workspace:` residue. *(maps to TODO "produces a fresh app in a clean dir outside the monorepo")*
- [ ] `@hogsend/*` resolve from local `pnpm pack` tarballs via `file:` (documented substitute for the not-yet-published registry). *(maps to "against a local registry / pnpm pack tarballs")*
- [ ] In the scaffolded app: `pnpm install` succeeds; `pnpm check-types` passes; `pnpm build` passes (dist/index.js + dist/worker.js). *(the achievable subset of "pnpm install … pnpm dev … end-to-end")*
- [ ] Full end-to-end boot (docker + migrate + journey fires + tracked email + `/v1/health` both tracks `inSync`) is DOCUMENTED as a manual step in both READMEs, leveraging the already-green `apps/api smoke` as proof the underlying pipeline works. *(remaining manual boot check, per the task's allowance)*
- [ ] `create-hogsend` pins the engine version it emits (single `ENGINE_VERSION` constant; emitted `package.json` carries `0.0.1` line for all `@hogsend/*`).
- [ ] No temp dirs left in the repo; tarball + app dirs are under `/tmp` and cleaned up.
- [ ] Monorepo gate stays green: `pnpm check-types`, `pnpm build`, `pnpm lint`, `pnpm --filter @hogsend/api test` (102 tests).
- [ ] Conventional Commit for the work (e.g. `feat(create-hogsend): app scaffolder + starter template`). No AI/co-author trailer.

---

## 8. Risks / open items to resolve during implementation

- **Phase 2 migrate API shape.** `template/scripts/migrate.ts` is written against `migrateEngine`/`migrateClient`; if Phase 2 shipped different names, adjust (Section 4). Typecheck (step 5) catches it.
- **`pnpm pack` on `private:true`.** If pnpm refuses to pack private packages, use `npm pack`; document which works. (Packages have no `files` field, so the default — everything tracked — yields `src/**`, which is what we need.)
- **tsup `noExternal` for `@hogsend/engine`.** Must match the proven-green `apps/api/tsup.config.ts` exactly; verify whether engine is inlined there before setting the template (Section 2.8).
- **drizzle-kit client-ledger config keys.** Confirm `migrations.table`/`migrations.schema` are the correct drizzle-kit `^0.31.10` keys so the client `db:generate` targets `__client_migrations`, never the engine ledger (Section 2.10).
- **Constants surface.** Trim `journeys/constants` to exactly the events/templates the two example journeys use; read `apps/api/src/journeys/constants/` at implementation time.
- **`react`/`react-dom` + `@types/react`** needed for `@hogsend/email` `.tsx` templates to typecheck/build in the standalone app; confirm the email package's peer deps are satisfied.
- **Not in scope (Phase 4):** flipping packages to public, real `dist` builds, registry publish, changesets release. Phase 3 is tarball-based only.
