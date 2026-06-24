# Railway: two services from one repo

Your scaffolded app ships TWO Railway config files at the repo root. Deploy them
as **two separate Railway services pointed at the same GitHub repo** — they
share the codebase but run different processes with different config.

| Service | Config file | Process | Healthcheck | Migrations |
|---------|-------------|---------|-------------|------------|
| api    | `railway.toml`        | HTTP API (`pnpm start`)  | `/v1/health` | runs `db:migrate` (pre-deploy) |
| worker | `railway.worker.toml` | Hatchet worker (`pnpm worker`) | none (no HTTP port) | never |

Both are driven by `git push` — pushing to your deploy branch triggers a build
for whichever services watch the changed paths.

## The api service (`railway.toml`)

```toml
[build]
buildCommand = "pnpm build"
watchPatterns = ["src/**", "migrations/**", "package.json", "pnpm-lock.yaml", "railway.toml"]

[deploy]
# Two-track migrate: engine track first, then this repo's client track.
# scripts/migrate.ts runs both in order and skips an empty client track
# gracefully. Engine MUST succeed before the API boots (boot guard in
# src/index.ts hard-requires the engine schema).
preDeployCommand = "pnpm db:migrate"
startCommand = "pnpm start"
healthcheckPath = "/v1/health"
healthcheckTimeout = 120
restartPolicyType = "ON_FAILURE"
restartPolicyMaxRetries = 3
```

Key points:

- **`preDeployCommand = "pnpm db:migrate"`** runs BEFORE the new container takes
  traffic. It is two-track: the engine schema migrates first (the api's boot
  guard in `src/index.ts` hard-requires it), then your client track. An empty
  client track is skipped gracefully, so this works whether or not you've added
  your own migrations under `src/schema`.
- **`healthcheckPath = "/v1/health"`** — Railway holds traffic until this route
  returns healthy. The route reports component status (database, redis) and the
  two-track schema state, which is exactly what `hogsend doctor` reads.
  `healthcheckTimeout = 120` gives migrations + boot time to settle.
- **Restart policy** retries on failure up to 3 times.

When this service is healthy, point your public domain (e.g.
`api.yourapp.com` via a CNAME) at it.

## The worker service (`railway.worker.toml`)

```toml
[build]
buildCommand = "pnpm build"
watchPatterns = ["src/**", "package.json", "pnpm-lock.yaml", "railway.worker.toml"]

[deploy]
# No healthcheck — the worker has no HTTP port. Migrations are owned by the API
# service's preDeployCommand; the worker just executes Hatchet tasks.
startCommand = "pnpm worker"
restartPolicyType = "ON_FAILURE"
restartPolicyMaxRetries = 5
```

Key points:

- **No `healthcheckPath`** — the worker is a long-running process with no HTTP
  port, so there's nothing to probe. Don't add one; a healthcheck that can never
  pass would keep the deploy from going green.
- **No `preDeployCommand`** — migrations are owned solely by the api service.
  The worker just connects to Hatchet and executes tasks (`sendEmailTask`,
  `importContactsTask`, `checkAlertsTask`, plus your enabled journey tasks and
  any `extraWorkflows`).
- **`startCommand = "pnpm worker"`** runs the production worker entry
  (`src/worker.ts` → `createWorker({ container, journeys })`).
- **It scales independently** of the api — add worker replicas to process more
  Hatchet tasks in parallel without touching the api.

### Pointing Railway at the worker config

A Railway service builds from a single config file. To make the second service
use `railway.worker.toml` instead of the default `railway.toml`, set the service
config-file path in the Railway dashboard (Service → Settings → Config-as-code /
Railway config file) to `railway.worker.toml`.

## Hatchet-Lite

Hatchet orchestrates durable task execution (email sends, journey runs,
background jobs). The api process pushes events to it; the worker process
executes the tasks it routes.

- **Locally** it runs via `docker-compose.yml` (started by `pnpm bootstrap` or
  `hogsend setup`): dashboard on `:8888`, gRPC on `:7077`, with its own
  Postgres 15. Default dashboard login: `admin@example.com` / `Admin123!!`.
- **In production** Hatchet-Lite is its own Railway service (the
  `ghcr.io/hatchet-dev/hatchet/hatchet-lite:v0.84.0` image). Both the api and the
  worker connect to it via `HATCHET_CLIENT_TOKEN` + `HATCHET_CLIENT_HOST_PORT`
  (and `HATCHET_CLIENT_TLS_STRATEGY`). Mint the token from the Hatchet
  dashboard.

See `references/env-and-secrets.md` for the exact Hatchet env keys and which
services need them.

## Deploy → verify loop

1. Set the required secrets on **both** services first (see
   `references/env-and-secrets.md`). The api won't pass its healthcheck without
   `DATABASE_URL` / `BETTER_AUTH_SECRET` / `RESEND_API_KEY`.
2. Push to your deploy branch. Railway builds the api (runs `pnpm db:migrate`
   pre-deploy) and the worker.
3. Verify the live api with the CLI:

   ```bash
   hogsend doctor --url https://api.yourapp.com --json
   ```

   Expect an `ok` verdict with `database`/`redis` up and the engine + client
   schema in sync. A `migration_pending` verdict means the pre-deploy migrate
   didn't catch up — re-check the api's pre-deploy logs. `unreachable` means the
   healthcheck never went green (often a missing required secret). See the
   hogsend-cli skill for the full doctor playbook.
