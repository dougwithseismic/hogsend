# Hogsend Cloud — Operator Runbook

How to spin up a managed Hogsend instance for someone, what happens under the
hood, and how to fix it when it doesn't. Companion to [GO-LIVE.md](GO-LIVE.md)
(launch gate) and the PRDs in `prds/`.

## The shape of the thing

- **Control plane** — `apps/cloud`: the Next.js dashboard + provisioning worker.
  Owns the cloud DB (orgs, environments, stacks, cells, plans, audit).
- **Cell** — shared infrastructure in one region: one TimescaleDB cluster
  (database-per-tenant) + one Hatchet-Lite engine (namespace-per-tenant) on
  Railway. Registered as a row in `cells`; ops kill-switch is `accepting`.
- **Stack** — one customer instance: its own Railway project with three
  services (`production-api`, `production-worker`, `production-redis`), a
  tenant database on the cell's cluster, and a minted Hatchet token. Runs the
  public default image (`ghcr.io/dougwithseismic/hogsend-default:<version>`)
  until the customer ships their own code with `hogsend publish`.

## What a customer does (self-serve)

1. Sign up at the dashboard (email + one-time code).
2. Create an organization → pick region (US today) → plan.
3. Provisioning runs automatically (~2–4 min). The environment page shows the
   step progression; the stack lands in `running` with a health strip.
4. Paste provider keys (Resend/Postmark, PostHog, optionally Twilio) on
   **Setup → Providers** — validated live, then synced into the instance env.
5. Their instance is live at `https://production-api-<hash>.up.railway.app`
   (`GET /v1/health` is the proof), running the default Hogsend engine.
6. Optionally: `pnpm dlx create-hogsend@latest`, write journeys, then
   `hogsend login` + `hogsend publish` to ship their own code to the instance.

## Spinning one up FOR someone (operator-assisted)

Same path, driven by you:

1. Sign up with their email (they receive the code — or use your own operator
   account and invite them as owner afterwards from **Settings → Members**).
2. Create the org, pick region/plan, watch the environment page until healthy.
3. Paste their provider keys if they've handed them over; otherwise leave the
   Setup page for them.
4. Hand over: dashboard URL, their instance URL, and the getting-started docs.
   They add themselves via the invite email; demote/remove your seat after.

Verify before handover:

```bash
curl -s https://<their-instance>/v1/health | jq '.status, .components'
# expect "healthy", database/redis/worker all "up"
```

## Operator prerequisites (control-plane env)

All validated at boot by `apps/cloud/src/env.ts`. The load-bearing set:

| Var | What |
|---|---|
| `CLOUD_DATABASE_URL` | control-plane Postgres |
| `CLOUD_AUTH_SECRET`, `CLOUD_PUBLIC_URL` | auth + absolute URLs |
| `CLOUD_ENCRYPTION_SECRET` | AES-256-GCM for provider keys + cell DSNs. Losing it orphans every stored secret |
| `CLOUD_SUBSTRATE` | `railway` (or `fake` for dev) |
| `CLOUD_RAILWAY_TOKEN`, `CLOUD_RAILWAY_WORKSPACE_ID` | workspace token the provisioner creates projects with |
| `CLOUD_HATCHET_CLIENT_TOKEN`, `CLOUD_HATCHET_CLIENT_HOST_PORT` | the CONTROL PLANE's own Hatchet (provision pipeline tasks), not a cell's |
| `CLOUD_HATCHET_ADMIN_EMAIL` / `_PASSWORD` | admin on each cell's Hatchet-Lite, used to mint tenant tokens |
| `CLOUD_DEFAULT_ENGINE_VERSION` | which `hogsend-default:<tag>` new stacks boot. Manual bump per release, deliberately |
| `CLOUD_IMAGE_REGISTRY` | `ghcr.io/dougwithseismic` |
| `CLOUD_RESEND_API_KEY`, `CLOUD_RESEND_FROM` | OTP/invite email. Unset → codes print to server log (dev only) |
| `CLOUD_BILLING` | `stripe` / `fake` / `disabled` |
| `CLOUD_STRIPE_SECRET_KEY`, `CLOUD_STRIPE_PRICE_SELF_SERVE`, `CLOUD_STRIPE_PRICE_DEDICATED`, `CLOUD_STRIPE_WEBHOOK_SECRET` | live prices exist under lookup keys `hogsend_cloud_self_serve` / `hogsend_cloud_dedicated`; webhook secret is minted when the endpoint is created against the deployed URL |

Run the control plane: `pnpm --filter @hogsend/cloud dev` (dashboard) and the
worker (`hatchet worker dev` in `apps/cloud`, or the deployed worker service).
Migrations: `pnpm --filter @hogsend/cloud db:migrate` (the deployed service
runs this as its pre-deploy).

## Bringing up a new cell (e.g. `eu-1`)

The `us-1` recipe, learned live:

1. **Railway project** `hogsend-cell-<name>` with three services:
   - `cell-postgres` — `timescale/timescaledb:latest-pg18`, volume, superuser
     + password, TCP proxy enabled (note `host:port`).
   - `hatchet-postgres` — `postgres:15`, volume (Hatchet's own DB).
   - `hatchet-lite` — pin `v0.84.0`. Public HTTP domain + TCP proxy for gRPC.
2. **Hatchet-lite env, or it crash-loops:** `SERVER_AUTH_COOKIE_DOMAIN` =
   its public domain (mandatory), `SERVER_AUTH_COOKIE_INSECURE=false`,
   `SERVER_GRPC_BROADCAST_ADDRESS` = the gRPC TCP proxy `host:port`,
   `DATABASE_URL` → hatchet-postgres. Create the admin user
   (`CLOUD_HATCHET_ADMIN_EMAIL`/`_PASSWORD`) via its dashboard.
3. **Register the cell** — insert a `cells` row: `name`, `region`,
   `shared_cluster_dsn` (superuser DSN via the TCP proxy, encrypted with
   `encryptSecret` from `src/lib/crypto.ts`), `shared_hatchet_url` = gRPC
   `host:port`, `shared_hatchet_api_url` = `https://<hatchet-domain>` (both
   set — Railway cells always have split HTTP/gRPC addresses), `accepting`,
   `max_tenants`.
4. **Prove it** — run one provision (throwaway org) in that region and check
   the instance `/v1/health`; then drain or keep accepting.

Placement picks "an accepting cell in the org's region with headroom"; drain a
cell for maintenance by setting `accepting = false` (existing tenants
unaffected).

## What provisioning actually does (for debugging)

Pipeline steps, in order, resumable: create tenant DB on the cell cluster →
create Hatchet tenant + mint token → create Railway project + services
(api/worker/redis) with the default image → seed env (DATABASE_URL, Hatchet
vars, REDIS_URL, `HOGSEND_BOOTSTRAP_API_KEY`, migrate pre-deploy on api+worker,
worker start command `node dist/worker.js`) → deploy → record refs on the
stack → health poll.

## Troubleshooting (every entry was hit for real)

| Symptom | Cause | Fix |
|---|---|---|
| api crash-loop: "requires 0068_…, database is at (empty)" | migrate pre-deploy missing | ensure service pre-deploy `tsx scripts/migrate.ts`; redeploy |
| worker healthy but journeys never run; health `worker: down` | worker booted image default CMD (the api) | worker start command `node dist/worker.js` |
| health `redis: down` | `REDIS_URL` not seeded | `redis://<env>-redis.railway.internal:6379` |
| hatchet-lite crash-loop "cookie domain is required" | `SERVER_AUTH_COOKIE_DOMAIN` unset | set to its public domain |
| provision fails "Invalid project name" | Railway caps at 32 chars | code slices org id to 25; never lengthen the scheme |
| Railway 400 "Not Authorized" on one mutation | GraphQL doc drift (e.g. `serviceInstanceUpdate` takes TOP-LEVEL `serviceId`) | probe the doc against the live schema |
| stack stuck in `provisioning` | pipeline died mid-run | reconciler is PRD 10; today: inspect stack step log, re-drive or park to `error` |
| transient Railway 400 "Problem processing request" during bursts | rate/consistency blip | retry; steps are idempotent |
| default image tag missing on GHCR | release didn't publish or pin not bumped | release CI pushes per publish; `CLOUD_DEFAULT_ENGINE_VERSION` bump is manual |

## Suspend / destroy

- **Suspend** (abuse/non-payment): ops action on the stack → substrate
  `suspend` stops api+worker; `resume` reverses. Data untouched.
- **Destroy**: substrate `destroyStack` deletes the Railway project; the tenant
  DB on the cell and the Hatchet tenant are removed by the offboarding flow
  (PRD 12 — dashboard self-serve export+delete still to build).
