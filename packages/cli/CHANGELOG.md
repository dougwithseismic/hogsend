# @hogsend/cli

## 0.2.1

### Patch Changes

- 0db58c6: Refresh the bundled agent skills (`hogsend-authoring-journeys`) to teach `ctx.waitForEvent`, and to fill in the previously-undocumented `ctx.sleepUntil`/`ctx.when` primitives and the `"exited"` journey state.

## 0.2.0

### Minor Changes

- 8a6aa5f: Ship Claude Code agent skills with scaffolded apps, plus a one-step engine + skills upgrade path.

  - **Exhaustive skill set** (8 skills) authored once in `packages/cli/skills/` — the single source `@hogsend/cli` ships and `hogsend skills add` installs: `hogsend-cli`, `hogsend-authoring-journeys`, `hogsend-authoring-emails` (incl. tracking + unsubscribe), `hogsend-authoring-buckets`, `hogsend-conditions`, `hogsend-webhooks-and-workflows`, `hogsend-database`, `hogsend-deploy`. Each is a lean `SKILL.md` with progressive-disclosure `references/`.
  - **`create-hogsend`** now prompts to include skills (default yes; `--skills` / `--no-skills`) and emits committed `.claude/skills/` + a tailored `CLAUDE.md` (app-name + engine-version substituted) that routes agents to the right skill. Skills are build-copied into the template by a new `sync-skills` prebuild, so the scaffold and the CLI never drift.
  - **`hogsend upgrade`** — new CLI command that bumps every `@hogsend/*` dependency to latest (or `--to`) and refreshes the vendored skills in one step. A provenance stamp + a `hogsend doctor` nudge surface when installed skills fall behind the latest CLI.
  - `hogsend skills add` gains `--all` and documents `--force` as the post-upgrade refresh.

## 0.1.0

### Minor Changes

- a80d952: Consolidated, interactive `hogsend` CLI. Replaces the prior eject-only tool with a full operator + agent surface: `doctor`, `journeys`, `contacts`, `stats`, `events`, `setup`, `skills`, `eject`, and `patch`. Human runs get `@clack/prompts` interactive flows; every command supports `--json` for agent/automation use. Data commands wrap the engine's `/v1/admin/*` routes over HTTP (`--url` / `HOGSEND_API_URL` / `.env`, `--admin-key` / `ADMIN_API_KEY`). `skills add` installs the bundled `hogsend-cli` Claude skill into a project.
