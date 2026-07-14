# create-hogsend

Scaffold a [Hogsend](https://hogsend.com) lifecycle orchestration app that
consumes the versioned `@hogsend/engine` package.

```bash
pnpm dlx create-hogsend my-app
# or: npm create hogsend my-app
```

## What it does

1. Copies the starter template (`template/`) into `./my-app`, renaming dotfiles
   (`gitignore` → `.gitignore`, `env.example` → `.env.example`, `node-version`
   → `.node-version`, `_package.json` → `package.json`) and substituting the
   `{{APP_NAME}}` / `{{ENGINE_VERSION}}` tokens.
2. `git init` + an initial commit (`--no-git` to skip).
3. Installs dependencies with the chosen package manager (`--no-install` to
   skip).

The emitted app pins all `@hogsend/*` packages to a single engine version line —
the `@hogsend/engine` line current at publish time, recorded as `ENGINE_VERSION`
in `src/template-manifest.ts`.

## CLI options

```
create-hogsend <app-name> [options]

  -y, --yes                  Accept all defaults, no prompts (install + setup)
  --pm <pnpm|npm|yarn|bun>   Package manager (default: pnpm)
  --domain <domain>          Sending domain — writes EMAIL_FROM/EMAIL_DOMAIN
  --admin-email <email>      First Studio admin — writes STUDIO_ADMIN_EMAIL;
                             the API mints the admin on first boot
  --admin-password <pw>      Admin password (min 8; requires --admin-email);
                             omit it: generated + printed once at first boot
  --posthog                  Using PostHog, no key yet (intent only)
  --posthog-key <phc_...>    PostHog project key — writes active env values
  --posthog-host <url>       PostHog host (requires --posthog-key)
  --no-posthog               Skip the events-source prompt
  --setup / --no-setup       Run / skip local setup (Docker, .env, migrate)
  --no-install               Skip dependency install
  --no-git                   Skip git init + initial commit
  --skills / --no-skills     Include (default) or skip Claude Code skills
  --use-tarballs <dir>       TEST-ONLY: resolve @hogsend/* from local tarballs
  -h, --help                 Show help
```

Non-TTY runs (CI, agents) never prompt: pass everything via flags. The full
headless path is documented in the scaffolded app's `CLAUDE.md` ("Zero to
running") and the `hogsend-cli` skill's `setup-local` reference.

## How the scaffolded app consumes the engine

All `@hogsend/*` packages ship **raw `.ts`** (no `dist`). The scaffold therefore
carries the two seams that make raw-`.ts` consumption work:

- `tsup.config.ts` with `noExternal: ["@hogsend/*"]` — bundles (inlines) the
  engine source at `pnpm build`, since Node's resolver cannot run the raw `.ts`
  + `.js`-extension imports directly.
- `vitest.config.ts` with `server.deps.inline: [/@hogsend\/engine/]` — lets
  Vite transform the raw `.ts` for tests.

## Local verification (no registry — Phase 3)

The `@hogsend/*` packages are not published yet, so the verification harness
resolves them from local `pnpm pack` / `npm pack` tarballs via `file:`
specifiers (the `--use-tarballs` flag), NOT from a registry.

```bash
pnpm --filter create-hogsend verify
# = packages/create-hogsend/scripts/verify-scaffold.sh
```

The harness:

1. Builds the CLI and asserts `dist/index.js` has the `#!/usr/bin/env node`
   shebang.
2. Packs every `@hogsend/*` workspace into a `/tmp` tarball dir and asserts each
   tarball carries `package/src/**` (the raw `.ts` the consumer bundles).
3. Scaffolds `my-app` into a clean `/tmp` dir with `--use-tarballs`, asserting
   filesystem completeness, token substitution, and no `{{token}}` /
   `workspace:` residue.
4. `pnpm install` + `pnpm check-types` + `pnpm build` (asserts `dist/index.js`
   and `dist/worker.js`) + `biome check` in the scaffolded app.
5. Removes all `/tmp` dirs — nothing is left in the repo.

`check-types` against the engine's real `.ts` types (resolved from the tarball)
is the strongest correctness signal.

### Full end-to-end boot (manual)

Booting the scaffolded app fully — `docker compose up`, `pnpm db:migrate`, fire
`test.signup`, watch the journey complete + tracked email — needs live
Timescale/Redis/Hatchet and a Hatchet token, so it is a documented MANUAL step
(see the scaffolded app's `README.md` → "Verify the pipeline"). The monorepo's
own `apps/api` smoke test already proves this exact pipeline against the engine.

## Releasing (Phase 4 — DRY-RUN ONLY here)

`ENGINE_VERSION` must stay in lockstep with `@hogsend/engine`'s version.
Changesets bumps both. Publishing is out of scope for Phase 3.
