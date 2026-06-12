# Env & secrets

Your scaffold ships a `.env.example` documenting every variable Hogsend reads.
The engine validates env at startup (`@t3-oss/env-core`), so the three
**required** vars must be present before the app will boot — otherwise the api
crashes and its `/v1/health` healthcheck never goes green.

This page is the prod-deploy view of that file: what's required, what's
optional, and which service needs each.

## Required at boot

These three are hard-required everywhere (local and prod). Set them on **both**
the api and worker services in Railway.

```bash
# Postgres connection string (TimescaleDB in prod).
DATABASE_URL=postgresql://user:pass@host:5432/dbname

# Better Auth signing secret — MINIMUM 32 characters. Generate a real random
# value (the local bootstrap/setup flow mints one for you; never reuse the
# placeholder from .env.example).
BETTER_AUTH_SECRET=<random, >=32 chars>

# Resend API key — required for any email send.
RESEND_API_KEY=re_...
```

If any of these is missing or invalid, env validation throws at startup. On the
api that means the healthcheck never passes; on the worker it means the process
exits and Railway restart-loops it.

## Core operational vars

Not "secrets," but you'll want to set these explicitly in prod:

```bash
NODE_ENV=production            # disables /docs + /openapi.json
PORT=3002                      # api HTTP port (Railway may inject its own)
LOG_LEVEL=info

REDIS_URL=redis://host:6379    # PostHog property cache

# Public base URL of the deployed api — used to build unsubscribe + tracking
# links inside outgoing emails, and as the tracking domain for click/open
# rewriting. Set this to your real api domain or links will point at localhost.
API_PUBLIC_URL=https://api.yourapp.com
BETTER_AUTH_URL=https://api.yourapp.com

# Default From address for sends.
RESEND_FROM_EMAIL=noreply@yourapp.com

# Which journeys load. "*" = all, or a comma-separated list of journey IDs.
ENABLED_JOURNEYS=*
```

## Hatchet (worker + api)

Both processes talk to your Hatchet-Lite service. Mint the token from the
Hatchet dashboard and set these on the api AND the worker:

```bash
HATCHET_CLIENT_TOKEN=<token minted from the Hatchet dashboard>
HATCHET_CLIENT_HOST_PORT=hatchet-host:7077
HATCHET_CLIENT_TLS_STRATEGY=none   # or tls, per your Hatchet deployment
```

(Locally these point at the docker-compose Hatchet-Lite: `localhost:7077`,
dashboard at `http://localhost:8888`, login `admin@example.com` / `Admin123!!`.)

## Optional

All commented-out in `.env.example` — add only what you use:

```bash
# PostHog event capture + person property WRITES (no-op if unset).
POSTHOG_API_KEY=phc_...
POSTHOG_HOST=https://us.i.posthog.com

# PostHog person property READS (timezone resolution, property conditions).
# The phc_ key is write-only by PostHog's design — reads need a PERSONAL API
# key scoped person:read. Without it reads soft-fail to contact properties.
POSTHOG_PERSONAL_API_KEY=...
# Project id for the private API — discovered automatically when unset.
# POSTHOG_PROJECT_ID=12345
# Private API host — derived (eu.i.posthog.com → eu.posthog.com) when unset.
# POSTHOG_PRIVATE_HOST=https://us.posthog.com

# Verify incoming PostHog webhooks (POST /v1/webhooks/posthog).
POSTHOG_WEBHOOK_SECRET=...

# Verify Resend bounce/complaint webhooks.
RESEND_WEBHOOK_SECRET=whsec_...

# Required for the /v1/admin/* routes + CLI access. Without it, admin reads
# (stats, contacts, journeys via the CLI) are unavailable in prod.
ADMIN_API_KEY=...
```

Notes:

- **PostHog is fully optional.** Without `POSTHOG_API_KEY`, person-property
  fetches and event captures are no-ops — journeys still run.
- **Two PostHog credentials, by PostHog's design.** The `phc_` project key is
  public (it ships in browser bundles) so PostHog makes it WRITE-only: capture
  and `$set` person writes work, reads never will. Person READS (per-user
  timezone resolution) need `POSTHOG_PERSONAL_API_KEY` — a personal API key
  scoped `person:read`, created in PostHog → Settings → Personal API keys.
  `hogsend doctor` warns when capture is configured without it.
- **Webhook secrets are per-source.** Only set the secret for a webhook source
  you've actually registered (see the consumer's `src/webhook-sources`).
- **`ADMIN_API_KEY` gates `/v1/admin/*`.** Set it in prod if you want to drive
  the deployed instance with the `hogsend` CLI (`stats`, `contacts`,
  `journeys`). `hogsend doctor` hits the unauthenticated `/v1/health` and needs
  no key. See the hogsend-cli skill for how the CLI resolves the key.

## Service-by-service checklist

| Var | api | worker |
|-----|-----|--------|
| `DATABASE_URL` | required | required |
| `BETTER_AUTH_SECRET` | required | required |
| `RESEND_API_KEY` | required | required |
| `REDIS_URL` | yes | yes |
| `API_PUBLIC_URL` / `BETTER_AUTH_URL` | yes | — |
| `HATCHET_CLIENT_TOKEN` / `_HOST_PORT` / `_TLS_STRATEGY` | yes | yes |
| `ENABLED_JOURNEYS` | yes | yes |
| `POSTHOG_*` (optional) | if used | if used |
| `*_WEBHOOK_SECRET` (optional) | if used | — |
| `ADMIN_API_KEY` (optional) | if used | — |

Set the shared/required vars on both services; the worker doesn't serve HTTP so
it doesn't need the public-URL or webhook/admin vars.
