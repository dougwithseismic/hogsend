# Releasing Hogsend

How Hogsend versions are cut, what a version *number means*, and the rule that
**engine migrations ship versioned with the package**. This is the producer-side
contract; [UPGRADING.md](./UPGRADING.md) is the consumer-side one (how a client
applies a release safely). For the committed public API surface that governs
major bumps, see [engine-boundary.md](./engine-boundary.md).

> **Releases happen only in CI.** Locally you may *dry-run* (`pnpm pack`,
> `pnpm -r publish --dry-run`) but you must **never** `npm publish` by hand or
> `git push` a tag. The real publish runs in `.github/workflows/release.yml`.

---

## 1. What publishes, and what stays private

| Package | Publishes? | Notes |
| --- | --- | --- |
| `@hogsend/core` | ✅ public | types, schemas, conditions, durations, registry |
| `@hogsend/db` | ✅ public | schema + **engine migrations** (`drizzle/`) + migrator |
| `@hogsend/email` | ✅ public | React Email templates (`emails/`) |
| `@hogsend/plugin-posthog` | ✅ public | PostHog integration |
| `@hogsend/plugin-resend` | ✅ public | Resend `EmailProvider` (delivery + webhook parse/verify) |
| `@hogsend/engine` | ✅ public | the framework: `createApp`/`createHogsendClient`/`createWorker`/`defineJourney`/`defineWebhookSource` |
| `create-hogsend` | ✅ public | the `pnpm dlx` scaffolder |
| `@hogsend/api` (`apps/api`) | ❌ private | the in-repo dogfood consumer |
| `growthhog` (repo root) | ❌ private | the monorepo itself |
| `@repo/typescript-config` | ❌ private | build-time-only shared tsconfig; a **devDependency** of packages, never a runtime dep — it must never appear under any published package's `dependencies` |

`changeset publish` skips every package with `"private": true`, so the three
private workspaces above are never published even if they accumulate changesets.

Each publishable package declares `"publishConfig": { "access": "public" }` and a
`"files"` allowlist. The most load-bearing allowlist is **`@hogsend/db`**, whose
`files` includes `drizzle` — see §4.

---

## 2. The two-phase changesets flow

1. **Author a changeset** alongside the change:

   ```bash
   pnpm changeset        # pick packages + bump level, write a summary
   ```

   Commit the generated `.changeset/*.md` with the PR.

2. **Merge to `main`.** The release workflow's `changesets/action` sees the
   accumulated changesets and opens/updates a **"Version Packages" PR** that runs
   `pnpm changeset version` — it bumps versions, writes/updates each package's
   `CHANGELOG.md`, and deletes the consumed changeset files.

3. **Merge the "Version Packages" PR.** Now there are no changesets left and the
   versions are already bumped, so the action runs `publish` → `pnpm release`
   (`pnpm build && changeset publish`), which publishes the public packages to
   npm and pushes git tags (`@hogsend/engine@1.4.0`, …).

Nothing in this two-phase flow runs locally during normal development; you only
ever run `pnpm changeset` to author the intent.

---

## 3. Semver discipline

Decide the bump level by the **largest** of these that applies:

- **major** —
  - a breaking change to the engine public API surface
    (`packages/engine/src/index.ts`: `createApp`, `createHogsendClient`,
    `createWorker`, `defineJourney`, `defineWebhookSource`, and the types they
    export — see [engine-boundary.md](./engine-boundary.md)); **or**
  - a **destructive / non-expand-contract** schema migration (drop/rename a
    column or table, tighten a constraint over existing data) — anything that
    violates the expand→migrate→contract discipline in
    [UPGRADING.md §2](./UPGRADING.md).
- **minor** —
  - additive public API (a new injection point, a new optional option, a new
    export that doesn't change existing signatures); **or**
  - an **additive (expand)** migration (new nullable column, new table, new
    index) — a new migration file is **at minimum a minor** engine-line bump.
- **patch** — a bug fix with no API change and no new migration.

Every **breaking** changeset must flag `⚠️ breaking` in its summary and list any
**required backfills** in the body — clients read this from the `CHANGELOG` per
[UPGRADING.md](./UPGRADING.md) before upgrading.

### The engine line moves in lockstep

`.changeset/config.json` declares a **linked** group:

```jsonc
"linked": [["@hogsend/engine", "@hogsend/db", "@hogsend/core"]]
```

A `linked` group shares the **highest** bump of that release **only when its
members are changed together** — so changesets touching the schema/boot-guard
trio bump them to the same version, while a release that touches none of them
leaves them untouched. We use `linked` rather than `fixed` (which would force a
bump on every release even when a package is unchanged) to avoid churning
version numbers and CHANGELOGs for packages that didn't move.

Why tie these three:

- `@hogsend/engine`'s boot guard (`apps/api/src/index.ts` →
  `getSchemaVersion` from `@hogsend/engine`) asserts the database ledger matches
  the migrations bundled in `@hogsend/db`. Shipping engine `1.4` against db `1.2`
  would let the guard and the schema drift apart.
- `@hogsend/core` carries the shared types both consume.

`email` and the two `plugin-*` packages stay **independent** — they carry no
migrations and no boot-guard contract, so they version on their own cadence.
`"updateInternalDependencies": "patch"` keeps each package's recorded internal
dependency range fresh when a dependency bumps.

---

## 4. Engine migrations ship versioned with the package

`@hogsend/db@X.Y.Z` bundles exactly engine migrations `0000..N` in its `drizzle/`
folder. That folder **travels in the published tarball** via the `files`
allowlist (`["src", "drizzle", "README.md"]`) because the migrator reads SQL from
disk at runtime:

- `packages/db/src/migrate.ts` resolves `new URL("../drizzle", import.meta.url)`
  and `existsSync`-guards it — if the folder is missing the migrator
  `process.exit`s, so **every consumer would crash at boot** if `drizzle/` were
  omitted from the tarball.
- `packages/db/src/version.ts` inlines `../drizzle/meta/_journal.json` to compute
  the required schema version count.

Consequences for releasing:

- **Adding a migration file ⇒ at minimum a minor bump of the engine line**
  (`@hogsend/db` + `@hogsend/engine` + `@hogsend/core` via the linked group).
- **A destructive migration ⇒ major.**
- The boot guard enforces that a deployed client actually applied the bundled
  migrations after `pnpm up` (`/v1/health` reports `schema.engine.inSync`).

Clients own their **own** migration track
(`drizzle.__client_migrations`) separately — engine releases never touch it. See
the two-track design in [packages-migration-plan.md §4](./packages-migration-plan.md).

---

## 5. `create-hogsend` pins the engine line

`create-hogsend`'s own version tracks the engine line, and the app it scaffolds
depends on `@hogsend/engine: ^X.Y` (caret on the engine line). So
`create-hogsend@1.4` produces a `@hogsend/engine@^1.4` app, and a client upgrades
within that major with `pnpm up`. Because internal `@hogsend/*` deps use the
`workspace:^` protocol, changesets rewrites them to caret ranges
(`^1.4.0`) at publish time — consumers get caret, not pinned-exact, ranges.

---

## 6. Publish model: raw `.ts`, bundled by the consumer

The publishable packages ship **raw TypeScript source** (`exports`/`main`/`types`
point at `./src/*.ts`), not a compiled `dist/`. Consumers bundle them via tsup
`noExternal` (the scaffolded `create-hogsend` app and the in-repo `apps/api` both
do this). That is why:

- `pnpm pack` tarballs contain `.ts`, not `.js`.
- `files` must include `src/` (and `drizzle/` for db, `emails/` for email) so the
  source actually travels.
- No new build step is required for `core`/`db`/`engine` to be publishable.

This is locked by [packages-migration-plan.md §10](./packages-migration-plan.md).
If a future consumer needs prebuilt JS, that's a separate change to `exports` +
`tsup`, out of scope for the current model.

---

## 7. Local dry-run verification (never publish by hand)

Before relying on a release, verify locally **without publishing**:

```bash
# Inspect a tarball's contents (db MUST contain drizzle/*.sql + meta/_journal.json):
pnpm --filter @hogsend/db pack --pack-destination /tmp/hogsend-pack
tar -tzf /tmp/hogsend-pack/hogsend-db-0.0.1.tgz | grep drizzle

# Resolve the whole-repo publish without sending anything to the registry:
pnpm -r publish --dry-run --no-git-checks
```

The dry run lists the seven `@hogsend/*` (+ `create-hogsend`) as "would publish"
and excludes the private workspaces. **Clean up any `*.tgz` afterward** so
`git status` stays clean.

If you want to exercise an actual install-from-registry flow without touching the
public registry, stand up a local **Verdaccio** registry and publish to it — this
is the only supported way to test a real `pnpm dlx create-hogsend` against
published packages locally. Do not stand it up as part of routine work; the CI
release workflow's first real run is the canonical end-to-end check.

---

## 8. Publishing auth

**Today: a repo secret `NPM_TOKEN`** (an npm token with publish rights to the
public packages). `release.yml` mirrors it into `NODE_AUTH_TOKEN` so
`changeset publish` authenticates.

> A **new** package's first publish must be done by a maintainer with *create*
> rights in the scope — a granular token usually can't create a package, and a
> Trusted Publisher can't be configured until the package exists. See the
> `release` skill (`.claude/skills/release/`) for that procedure, plus how to
> verify a publish actually landed (CI green does not guarantee it).

**Target: Trusted Publishing (OIDC), tokenless.** OIDC mints a short-lived,
workflow-scoped token at publish time (no stored secret) and attaches provenance
for free. `release.yml` already has `id-token: write` and upgrades npm to ≥ 11.5.1.
Migration is in progress across the public packages.

To finish the migration and drop the token:

1. Add a Trusted Publisher to each remaining public package (npmjs.com → package →
   Settings → Trusted Publisher → GitHub Actions).
2. Delete the `NPM_TOKEN` secret and remove the `NPM_TOKEN`/`NODE_AUTH_TOKEN` env
   lines from `release.yml`.

npm docs: <https://docs.npmjs.com/trusted-publishers/>
