# create-hogsend

## 0.0.2

### Patch Changes

- 3aeeda0: Interactive scaffolding via `@clack/prompts` — prompts for project name, package
  manager, install, and git, with spinners — plus a guided "Next steps" note so a
  freshly scaffolded app tells you exactly what to run (docker compose, `.env` +
  the Hatchet token, `db:migrate`, `dev`, `worker:dev`, and your first journey).
  The flag-driven non-interactive path (`--pm`, `--no-install`, `--no-git`) is
  unchanged for CI.
