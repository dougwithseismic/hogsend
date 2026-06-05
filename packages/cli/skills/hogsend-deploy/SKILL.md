---
name: hogsend-deploy
description: Use when deploying or configuring production infra for YOUR scaffolded Hogsend app — Railway two services (api via railway.toml with /v1/health + pre-deploy db:migrate; worker via railway.worker.toml, no healthcheck), Hatchet-Lite, required vs optional env, and upgrading the engine + refreshing vendored skills. This is for shipping your own app, NOT the maintainer's package-release process.
license: MIT
metadata:
  author: withSeismic
  version: "1.0.0"
---

# Hogsend Deploy

This skill helps you ship and operate YOUR scaffolded Hogsend app in
production: standing up the two Railway services that ship in your repo, wiring
the env Hogsend needs at boot, pointing at a Hatchet-Lite engine, and keeping
your `@hogsend/*` deps + vendored agent skills on the latest line.

This is the **consumer** deploy guide — for shipping the app you scaffolded with
`create-hogsend`. It is NOT the maintainer's npm release / version-line process
(that lives in the separate `release` skill).

> These are side-effecting production operations — provisioning services,
> writing secrets, running migrations against a real database, bumping deps.
> Run each step deliberately and confirm intent before executing.

## Key concepts

- **Two services, one repo.** Your scaffold ships `railway.toml` (the HTTP
  **api**) and `railway.worker.toml` (the Hatchet **worker**). Same codebase,
  two Railway services with different config files.
- **api owns migrations + healthcheck.** The api's `preDeployCommand` runs
  `pnpm db:migrate` (two-track: engine then client) before boot; it exposes
  `/v1/health`. The worker has no HTTP port, no healthcheck, and never migrates.
- **Hatchet-Lite is your orchestration engine.** The worker connects to it over
  gRPC with `HATCHET_CLIENT_TOKEN` + `HATCHET_CLIENT_HOST_PORT`. Locally it runs
  via `docker-compose.yml`; in prod it's its own service.
- **Three required env vars, the rest optional.** `DATABASE_URL`,
  `BETTER_AUTH_SECRET`, `RESEND_API_KEY` are hard-required at boot; PostHog,
  webhook secrets, and the admin key are opt-in.
- **Upgrades move code + agent guidance together.** `hogsend upgrade` bumps
  `@hogsend/*` AND refreshes the vendored `.claude/skills`; `hogsend doctor`
  nudges you when those skills fall behind.

## Task playbooks — load the matching reference

- **Stand up / configure the two Railway services (api + worker), healthcheck,
  pre-deploy migrate, Hatchet-Lite** → `references/railway-two-services.md`
- **Decide which env vars are required vs optional and where each comes from** →
  `references/env-and-secrets.md`
- **Bump the engine after a release + refresh vendored skills (`hogsend upgrade`
  / `--skills-only` / `skills add --all --force`, the `doctor` staleness nudge)**
  → `references/upgrade-engine.md`

## Golden rules

1. Migrate exactly once per deploy: only the **api** service runs
   `db:migrate` (its `preDeployCommand`). Never add a migrate step to the worker.
2. Set the three required secrets BEFORE the first deploy — the app hard-fails
   at boot without them, and the api healthcheck will never go green.
3. After a deploy, verify with `hogsend doctor --url <prod> --json` and expect
   an `ok` verdict with the schema in sync (see the hogsend-cli skill).
4. After an engine bump, refresh the vendored skills in the same step so the
   agent guidance matches the code you're now running.
