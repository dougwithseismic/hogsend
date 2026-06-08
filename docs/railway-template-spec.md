# Railway template spec (maintainer)

The canonical variable layout for the published Hogsend Railway template
(`https://railway.com/deploy/sYUYH8`). The goal: a fresh deploy comes up working
with **one** manual step (mint a Hatchet token), and **zero** of the maintainer's
own secrets leak into it.

> The Railway CLI can *deploy from* a template but **cannot publish or edit one** —
> that is a dashboard / GraphQL action. This file is the spec you apply when you
> (re)publish the template from a project environment.

## Topology (6 services)

| Service | Source | Role |
|---|---|---|
| `hogsend-api` | repo, `railway.toml` | HTTP API, ingestion, auth, `/v1/health` |
| `hogsend-worker` | repo, `railway.worker.toml` | Hatchet worker (durable tasks) |
| `Postgres` | `timescale/timescaledb:latest-pg18` | primary database |
| `Redis` | `redis:8` | PostHog property cache |
| `hatchet-lite` | `ghcr.io/hatchet-dev/hatchet/hatchet-lite:latest` | workflow engine |
| Hatchet Postgres | `postgres-ssl:16` | Hatchet's own metadata DB |

> The dogfood project also runs `hogsend-docs`. **Do not include it in the
> template** — it is hogsend.com itself, not part of a deployer's stack.

## What can and can't be one-click

Every variable can self-resolve in the template **except `HATCHET_CLIENT_TOKEN`**.
A self-hosted Hatchet mints its client token *after* the server boots, so no
template mechanism can pre-fill a working value — even Hatchet's own official
Railway template (`railway.com/deploy/hatchet-lite`) leaves this as a manual
"dashboard → Settings → API Tokens → Create" step. So the deploy story is:

1. Click deploy → fill `RESEND_API_KEY` + `RESEND_FROM_EMAIL` (the only required
   inputs).
2. After hatchet-lite is up, mint a token and set `HATCHET_CLIENT_TOKEN` on the
   api + worker, redeploy. (One-time.)

Everything else — DB/Redis wiring, auth secret, public URLs — is automatic.

## Variable spec: `hogsend-api` and `hogsend-worker`

Set on **both** services (they share the env contract). Values use Railway
reference / generated-secret syntax so they resolve at deploy time.

| Variable | Template value | Notes |
|---|---|---|
| `DATABASE_URL` | `${{Postgres.DATABASE_URL}}` | reference to the Timescale service |
| `REDIS_URL` | `${{Redis.REDIS_URL}}` | reference to the Redis service |
| `BETTER_AUTH_SECRET` | `${{secret(48)}}` | Railway generates a fresh secret (>=32 chars) |
| `HATCHET_CLIENT_HOST_PORT` | `${{hatchet-lite.RAILWAY_PRIVATE_DOMAIN}}:7077` | internal gRPC |
| `HATCHET_CLIENT_TLS_STRATEGY` | `none` | internal traffic, no TLS |
| `HATCHET_CLIENT_TOKEN` | *(empty — required user input)* | mint post-deploy; see above |
| `RESEND_API_KEY` | *(empty — required user input)* | from resend.com → API Keys |
| `RESEND_FROM_EMAIL` | *(empty — required user input)* | a verified Resend sender |
| `NODE_ENV` | `production` | disables `/docs` + `/openapi.json` |
| `PORT` | `3002` | Railway may inject its own |
| `LOG_LEVEL` | `info` | |
| `ENABLED_JOURNEYS` | `*` | load all journeys |
| `ADMIN_API_KEY` | `${{secret(32)}}` | optional; gates `/v1/admin/*` + CLI |

API-only (the worker has no public HTTP port, so it doesn't need these):

| Variable | Template value |
|---|---|
| `API_PUBLIC_URL` | `https://${{RAILWAY_PUBLIC_DOMAIN}}` |
| `BETTER_AUTH_URL` | `https://${{RAILWAY_PUBLIC_DOMAIN}}` |

`RAILWAY_PUBLIC_DOMAIN` resolves once the api service has a generated/attached
domain — the template should generate one for the api on deploy.

## Variable spec: `hatchet-lite`

Mirrors the working stack (these are already set correctly in production):
`SERVER_GRPC_PORT=7077`, `SERVER_GRPC_BIND_ADDRESS=0.0.0.0`,
`SERVER_GRPC_INSECURE=t`, `SERVER_GRPC_BROADCAST_ADDRESS=${{RAILWAY_PRIVATE_DOMAIN}}:7077`,
`SERVER_DEFAULT_ENGINE_VERSION=V1`, `SERVER_MSGQUEUE_KIND=postgres`,
`SERVER_AUTH_COOKIE_INSECURE=t`, `SERVER_AUTH_SET_EMAIL_VERIFIED=t`,
`SERVER_URL` / `SERVER_AUTH_COOKIE_DOMAIN` from its public domain,
`DATABASE_URL` referencing the Hatchet Postgres. Needs a volume for its data.

## (Re)publishing the template

1. Pick the environment to publish from. Apply the spec above to that
   environment's services (do **not** mutate the live `production` services unless
   you intend to). The script below stamps the parameterized values.
2. In the Railway dashboard: project → **Settings → Publish/Update Template** (or
   the template's own edit page). Confirm each service's variables show the
   reference/`secret()` forms, that `RESEND_*` + `HATCHET_CLIENT_TOKEN` are marked
   as user input, and that `hogsend-docs` is excluded.
3. Deploy the template once from an incognito window and walk the two-step flow to
   verify it comes up green after the token is set.

### Stamp the parameterized vars (CLI)

Run against the environment you'll publish from — pass its name as `$ENV`.
Service names in `${{...}}` references are case-sensitive; match them exactly.

```bash
ENV=template   # the environment you publish the template from — NOT production
for svc in hogsend-api hogsend-worker; do
  railway variables --service "$svc" --environment "$ENV" --skip-deploys \
    --set 'DATABASE_URL=${{Postgres.DATABASE_URL}}' \
    --set 'REDIS_URL=${{Redis.REDIS_URL}}' \
    --set 'BETTER_AUTH_SECRET=${{secret(48)}}' \
    --set 'HATCHET_CLIENT_HOST_PORT=${{hatchet-lite.RAILWAY_PRIVATE_DOMAIN}}:7077' \
    --set 'HATCHET_CLIENT_TLS_STRATEGY=none' \
    --set 'ADMIN_API_KEY=${{secret(32)}}' \
    --set 'NODE_ENV=production' \
    --set 'PORT=3002' \
    --set 'LOG_LEVEL=info' \
    --set 'ENABLED_JOURNEYS=*'
done
# api-only public URLs
railway variables --service hogsend-api --environment "$ENV" --skip-deploys \
  --set 'API_PUBLIC_URL=https://${{RAILWAY_PUBLIC_DOMAIN}}' \
  --set 'BETTER_AUTH_URL=https://${{RAILWAY_PUBLIC_DOMAIN}}'
```

Leave `RESEND_API_KEY`, `RESEND_FROM_EMAIL`, and `HATCHET_CLIENT_TOKEN` unset so
the template surfaces them as inputs (and so no real key is baked in).
