# @hogsend/cli

## 0.1.0

### Minor Changes

- a80d952: Consolidated, interactive `hogsend` CLI. Replaces the prior eject-only tool with a full operator + agent surface: `doctor`, `journeys`, `contacts`, `stats`, `events`, `setup`, `skills`, `eject`, and `patch`. Human runs get `@clack/prompts` interactive flows; every command supports `--json` for agent/automation use. Data commands wrap the engine's `/v1/admin/*` routes over HTTP (`--url` / `HOGSEND_API_URL` / `.env`, `--admin-key` / `ADMIN_API_KEY`). `skills add` installs the bundled `hogsend-cli` Claude skill into a project.
