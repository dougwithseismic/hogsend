# Manage Hogsend Deployments

## Architecture

Each Hogsend deployment on Railway consists of these services:

| Service | Type | Config |
|---------|------|--------|
| Postgres | Managed database | App data (journey states, events, emails) |
| Redis | Managed database | Caching, queues |
| Hatchet Postgres | Managed database | Hatchet's internal state |
| Hatchet-Lite | Docker image | Workflow engine dashboard + gRPC |
| hogsend-api | GitHub repo | HTTP API, uses `railway.toml` |
| hogsend-worker | GitHub repo | Hatchet worker, uses `railway.worker.toml` |

## Key constraints

- The worker service must NOT have a healthcheck (it doesn't serve HTTP)
- The worker uses `railway.worker.toml` — set via `railwayConfigFile` on the service instance
- Hatchet needs its own Postgres instance separate from the app database
- `HATCHET_CLIENT_TOKEN` must be generated from the Hatchet dashboard after it boots (chicken-and-egg)
- `ENABLED_JOURNEYS` controls which journey definitions are loaded (comma-separated IDs or `*`)

## CLI tool

The Go CLI at `cli/` handles most operations. Build with `cd cli && make build`.

Commands: `hogsend init`, `hogsend setup`, `hogsend status`, `hogsend deploy`, `hogsend journeys`, `hogsend destroy`

## Railway template

Deploy button: https://railway.com/deploy/sYUYH8?referralCode=dougie

Read the reference docs for step-by-step procedures.
