# @hogsend/cli

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

## 0.2.3

### Patch Changes

- cd86e13: Refresh the `hogsend-authoring-buckets` skill (SKILL.md + all reference files) for the bucket lifecycle API: typed `bucket.entered` / `bucket.left` refs, colocated `bucket.on("enter" | "leave" | "dwell")` reactions, `dwell` over the existing population, and `count`/`has`/`members`/`membersIterator` access. The `BucketId` union + `bucketEntered`/`bucketLeft` helpers are marked deprecated. Republishes so `hogsend skills add` / `hogsend upgrade` pull the updated content.

## 0.2.2

### Patch Changes

- f4e604e: Ship a new `hogsend-extending` skill: how to extend a Hogsend app beyond
  journeys/emails/buckets — swap the email or analytics provider behind its
  engine-owned contract (`EmailProvider` / `PostHogService`), wire an outbound
  integration (Slack, a CRM, Stripe) as plain code called from a journey, and when
  to publish a `@hogsend/plugin-*` package. The new skill also rides the
  `create-hogsend` template (synced from `packages/cli/skills/`), so fresh
  scaffolds ship it.

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
