# Migration Plan: Engine-as-Packages + `create-hogsend`

> Status: **proposal / not yet started.** This document is the plan to turn
> Hogsend from a single forkable monorepo into a versioned **engine** that
> clients consume via packages, scaffolded with `pnpm dlx create-hogsend@latest`.
> Nothing here is built yet. Review and adjust before Phase 1.

## 1. Goal & the core tension

We want both, and they pull apart:

- **Clean upgrades** — a client on an old version can adopt a new one without a
  painful `git merge`. → points to *engine as versioned packages* (`pnpm up`).
- **Everything editable, including engine internals** (routes, ingestion, auth).
  → points to *owning the source* (a fork).

The reconciliation (what Next.js, Expo, Medusa all do) is an **escalating
editability ladder** on top of a packaged engine:

| Need | Mechanism | Upgrade cost |
| --- | --- | --- |
| Add journeys, templates, sources, routes | **Extend** via public APIs in your own app code | none — `pnpm up` |
| Tweak a few lines of engine behaviour | **Patch** (`pnpm patch @hogsend/engine`) | patch re-applies; conflicts surface loudly |
| Rewrite engine internals | **Eject** that package into your repo | you maintain a fork *of that package only*; everything else still `pnpm up` |

Result: the 95% who only extend get `pnpm up` upgrades; the few who go deep pay
the fork cost **only for the parts they actually changed**.

## 2. Target architecture

```
┌─ Published to npm (the "engine") ──────────────────────────────┐
│  @hogsend/core        types, registry, conditions, durations    │
│  @hogsend/db          schema + ENGINE migrations + migrator      │
│  @hogsend/email       React Email render helpers                 │
│  @hogsend/plugin-*    posthog / resend integrations              │
│  @hogsend/engine      NEW — createApp, createContainer,          │
│                       createWorker, defineJourney,               │
│                       defineWebhookSource, ingestion, tracking,  │
│                       built-in routes, registries                │
│  create-hogsend       NEW — the scaffolder (pnpm dlx)            │
└─────────────────────────────────────────────────────────────────┘
                              │  consumed by
                              ▼
┌─ The client's repo (scaffolded, 100% theirs) ──────────────────┐
│  src/index.ts        thin: createApp(...) + serve               │
│  src/worker.ts       thin: createWorker(...)                     │
│  src/journeys/*      THEIR journeys (examples copied in)         │
│  src/email/*         THEIR templates                            │
│  src/webhook-sources/* THEIR sources                            │
│  src/routes/*        THEIR extra routes (optional)              │
│  migrations/         THEIR migrations (separate track)          │
│  hogsend.config.ts   branding, from-address, feature flags      │
│  railway.toml, .env.example, docker-compose.yml                 │
│  package.json → "@hogsend/engine": "^1.4.0"                     │
└─────────────────────────────────────────────────────────────────┘
```

Key boundary rule: **the engine package ships the _framework_; the client repo
owns the _content_.** `defineJourney()` is engine; the welcome journey is the
client's. `defineWebhookSource()` is engine; the PostHog source is scaffolded
into the client repo as an editable example. This is what makes upgrades clean —
upstream never ships files into the client's source tree, so there is nothing to
merge.

Because the client registers their journeys/sources **in their own app code**
(not by editing a shared `index.ts`), the index-file merge-conflict problem that
exists today simply disappears.

## 3. Distribution: `create-hogsend`

Public npm. Clients never fork the monorepo; they run:

```bash
pnpm dlx create-hogsend@latest my-hogsend
cd my-hogsend && pnpm install && pnpm dev
```

`create-hogsend` scaffolds the client repo shown above:

- thin entry points wired to `@hogsend/engine`
- the built-in journeys/templates/sources copied in as editable starting points
- `hogsend.config.ts`, `.env.example`, `railway.toml`, `railway.worker.toml`
- a `drizzle.config.ts` pointed at the client migrations folder
- `docker-compose.yml` for local TimescaleDB/Redis/Hatchet
- `@hogsend/engine` pinned to the version that matches the scaffolder

Upgrades for a client become:

```bash
pnpm up @hogsend/engine @hogsend/core @hogsend/db   # or a `hogsend upgrade` helper
pnpm db:migrate                                       # applies new ENGINE migrations
# read CHANGELOG for breaking notes / required backfills
```

No git merge. The boot guard + `/v1/health` (already built) confirm the engine
schema caught up.

## 4. The hard part: two-track migrations

Today there is **one** migration journal in `@hogsend/db`. Once the engine ships
migrations *in a package* and clients add *their own* tables, we need two
independent tracks so an engine upgrade never collides with a client's custom
column.

**Design — two ledgers in the same database:**

| Track | Migrations live in | Ledger table | Owned by |
| --- | --- | --- | --- |
| **engine** | `@hogsend/db` package (`drizzle/`) | `drizzle.__drizzle_migrations` | upstream, versioned with the package |
| **client** | client repo (`migrations/`) | `drizzle.__client_migrations` | the client |

Drizzle's `migrate()` already accepts `migrationsTable` / `migrationsSchema`, so
the migrator runs **engine first, then client**, each against its own ledger:

```ts
await migrate(db, { migrationsFolder: enginePath });                       // engine track
await migrate(db, { migrationsFolder: clientPath,
                    migrationsTable: "__client_migrations" });             // client track
```

`getSchemaVersion()` (already built) gets parameterized by *(journal source,
ledger table)* and is called once per track. The boot guard asserts the **engine
track** matches the installed `@hogsend/engine` version's bundled migrations
(the client track is the client's own concern, optionally guarded). `/v1/health`
reports both:

```jsonc
"schema": {
  "engine": { "required": "0012", "applied": "0012", "inSync": true },
  "client": { "required": "0003", "applied": "0003", "inSync": true }
}
```

This **reuses everything we just built** — the count-based `getSchemaVersion`,
the hardened migrator (advisory lock, timeouts), the boot guard, the health
block — just parameterized per track. The expand→contract rules in
`UPGRADING.md` still apply to engine migrations; clients follow the same rules
for their own track.

Open sub-question: clients who *alter engine tables* (not just add their own)
create cross-track coupling. Recommended guidance: alter engine tables only via
additive client migrations, and re-verify after each engine upgrade. Document as
a known sharp edge.

## 5. Editing internals — the escalation ladder, concretely

1. **Extend (preferred).** The engine exposes injection points so most
   "internal" changes are additive, not edits:
   - `createApp({ routes, middleware, onError })` — mount custom routes /
     middleware, override the error handler.
   - `createContainer({ overrides })` — swap `emailService`, `posthog`, etc.
   - `defineJourney` / `defineWebhookSource` — already the extension API.
   - Document every injection point as the supported surface.
2. **Patch.** `pnpm patch @hogsend/engine` → edit in `node_modules` → `pnpm patch-commit`. The diff is re-applied on install and **fails loudly** when an
   upgrade changes the patched code — a built-in conflict signal. Good for
   surgical fixes while waiting for an upstream change.
3. **Eject.** A documented `hogsend eject @hogsend/engine` that copies the
   package source into `vendor/engine` and rewrites the dependency to a
   `workspace:`/`file:` link. That package stops auto-upgrading; the client
   merges upstream for it manually. Everything else still `pnpm up`. This is the
   honest "I need to own the engine" path — scoped to one package.

## 6. Versioning & release

- **changesets** in the monorepo: every engine change adds a changeset; release
  bumps versions + generates per-package `CHANGELOG.md`.
- **CI release workflow**: on merge to `main` (or a release branch), changesets
  publishes `@hogsend/*` to npm and tags the version.
- **Engine migrations are versioned _with_ the package** — `@hogsend/engine@1.4.0`
  bundles exactly engine migrations `0000..N`. `pnpm up` brings new migrations;
  `db:migrate` applies them on the engine track; the boot guard enforces it.
- **`create-hogsend` pins** the engine version it scaffolds, and its own version
  tracks the engine line so `create-hogsend@1.4` yields a `@hogsend/engine@^1.4`
  app.
- **Semver discipline**: breaking engine API or non-expand/contract schema
  changes = major. The CHANGELOG flags ⚠️ breaking + required backfills.
- **Codemods** (optional, later): ship `jscodeshift` codemods for breaking API
  renames so clients run `npx @hogsend/codemod vX` instead of hand-editing.

## 7. Client upgrade flow (the end state)

```bash
# 1. Back up the DB (Railway snapshot / pg_dump) — still the only rollback.
# 2. Bump the engine.
pnpm up @hogsend/engine@1.4.0 @hogsend/core@1.4.0 @hogsend/db@1.4.0
# 3. Read CHANGELOG for ⚠️ breaking notes + required backfills.
# 4. Deploy → Railway preDeploy runs db:migrate (engine track, then client) →
#    boot guard verifies the engine track is in sync.
# 5. Confirm GET /v1/health → schema.engine.inSync === true.
# 6. If a release notes a backfill, trigger the Hatchet backfill job.
```

If a client has **patched** the engine: pnpm warns when the patch no longer
applies → they refresh the patch. If they've **ejected** a package: they merge
upstream for that one package; the rest still bumps via `pnpm up`.

## 8. Phased plan

Each phase is independently shippable and verifiable.

| Phase | Work | Risk | Verify |
| --- | --- | --- | --- |
| **0 — Prep** | Add changesets; lock the engine/app boundary list; this doc | low | builds unchanged |
| **1 — Carve `@hogsend/engine`** | Move engine code out of `apps/api/src` into a new package exposing `createApp`/`createContainer`/`createWorker` + framework re-exports. `apps/api` becomes a thin consumer (dogfood the boundary _in-repo_ before publishing). | **high** (large mechanical move, many import rewrites) | `pnpm build`, `pnpm check-types`, full test suite green |
| **2 — Two-track migrations** | Parameterize migrator + `getSchemaVersion` + boot guard + `/v1/health` by track; engine track in `@hogsend/db`, add client track concept | med | extend `migration-system.test.ts` to cover both tracks |
| **3 — `create-hogsend`** | Scaffolder package + client starter templates (entry points, example journeys/templates/sources, config, railway, drizzle, compose) | med | `pnpm dlx` a fresh app, `pnpm dev`, journeys fire end-to-end |
| **4 — Publish pipeline** | changesets release CI → npm; version pinning in create-hogsend | med | dry-run publish; install from npm into a clean dir |
| **5 — Eject/patch tooling + docs** | Document extend→patch→eject; optional `hogsend eject` command | low | eject a package in a sandbox, confirm it builds + rest still upgrades |
| **6 — Dogfood** | Move the reference deployment (hogsend.com) onto the consumer model | med | production parity check |

Recommended cut line for a first usable release: **Phases 1–4** (a client can
`create-hogsend`, deploy, and upgrade via `pnpm up`). Phases 5–6 harden it.

## 9. Decisions to lock before Phase 1

1. **Built-in journeys/sources**: scaffolded into the client repo (editable) —
   _recommended_ — vs. shipped in a `@hogsend/journeys` package. Confirm.
2. **Engine API surface**: which injection points (`routes`, `middleware`,
   container `overrides`) are committed public API for v1.
3. **Auth ownership**: better-auth config in the client app (engine provides the
   setup helper). Confirm.
4. **Client-migration ledger**: `drizzle.__client_migrations` in the same DB —
   confirm vs. a separate schema.
5. **Engine package granularity**: one `@hogsend/engine` vs. splitting
   HTTP/worker/journey-framework into separate packages. Recommend start with one,
   split later if needed.
6. **`create-hogsend` scope for v1**: app-only, or also offer a Railway
   one-click template that wraps it.

## 10. What carries over from the work already done

- Hardened migrator (advisory lock, `lock_timeout`/`statement_timeout`) →
  becomes the engine-track migrator, reused for the client track.
- `getSchemaVersion()` (count-based) → parameterized per track.
- Boot guard + `/v1/health` schema block → per-track.
- `UPGRADING.md` (expand→contract, backups, `db:push` gotcha) → still the
  contract; gains a two-track section.
- `runBatchedBackfill` + backfill job template → unchanged; clients use it for
  their own track.
- CI migration gates → extended to test both tracks and a fresh `create-hogsend`
  install.
