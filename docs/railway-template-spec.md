# Railway template spec (maintainer)

The canonical variable layout for the published Hogsend Railway template
(`https://railway.com/deploy/LxSCyR`). Goal: a fresh deploy comes up working with
**one** manual step (mint a Hatchet token), and **none** of the maintainer's own
secrets leak into it.

> Verified against the live template in the Railway dashboard (June 2026). The
> template was already configured to (almost) this spec — the only gap was
> `API_PUBLIC_URL`, added on both api + worker so unsubscribe + email-tracking
> links don't fall back to `http://localhost:3002`. See "What was fixed" below.

## Which template

There are two workspace templates named "Hogsend - Posthog Audience Stack":

| Template id | Deploy code | State |
|---|---|---|
| `291daa3b-9c75-4110-8cce-36697b94ce65` | **`LxSCyR`** | **canonical** — complete, all vars wired (use this everywhere) |
| (duplicate) | `sYUYH8` | incomplete duplicate — **delete it** to avoid confusion |

The Railway CLI can `deploy --template` and `templates search` but **cannot
publish or edit** a template — composition is dashboard-only. Edit `LxSCyR` via
`railway.com/workspace/templates/291daa3b-…`.

**Published (June 2026)** to the Railway marketplace with a proper description +
overview. Marketplace URL: `https://railway.com/deploy/hogsend-posthog-audience-stack`.
Docs intentionally use the **stable code** `LxSCyR` instead — the slug is derived
from the template name and would break if the template is renamed; the code link
is permanent. Both resolve to template `291daa3b`.

**Title caveat:** the marketplace card title is the frozen snapshot name
"Hogsend - Posthog Audience Stack" (the project was renamed to "Hogsend", but the
template title doesn't track project renames, and re-syncing via the published
card's "Update" would clobber the template's parameterized vars with the live
project's literal secrets — do NOT click Update). To get the title to just
"Hogsend" you'd regenerate the template (new code/slug) — deferred.

## Topology (6 services)

`hogsend-api` (repo, `railway.toml`) · `hogsend-worker` (repo, `railway.worker.toml`)
· `Postgres` (Timescale) · `Redis` · `hatchet-lite` · `Postgres-J_tJ` (Hatchet's DB).
**No `hogsend-docs`** — that's hogsend.com, not part of a deployer's stack.

## What can't be one-click

Everything self-resolves **except `HATCHET_CLIENT_TOKEN`**: a self-hosted Hatchet
mints its client token only after the server boots, so no template mechanism can
pre-fill it — even Hatchet's own official Railway template
(`railway.com/deploy/hatchet-lite`) leaves this as a manual "dashboard → Settings
→ API Tokens → Create" step. Deploy flow:

1. Click deploy → fill `RESEND_API_KEY` (the only required input besides the token).
2. Once hatchet-lite is up, mint a token, set `HATCHET_CLIENT_TOKEN` on the api,
   redeploy. (The worker references the api's value, so you set it once.)

## `hogsend-api` variables (as configured)

2 required user-inputs + 12 pre-configured:

| Variable | Value | Kind |
|---|---|---|
| `RESEND_API_KEY` | *(empty)* | required input |
| `HATCHET_CLIENT_TOKEN` | *(empty)* | required input (mint post-deploy) |
| `API_PUBLIC_URL` | `https://${{RAILWAY_PUBLIC_DOMAIN}}` | pre-configured |
| `BETTER_AUTH_URL` | `https://${{RAILWAY_PUBLIC_DOMAIN}}` | pre-configured |
| `DATABASE_URL` | `${{Postgres.DATABASE_URL}}` | reference |
| `REDIS_URL` | `${{Redis.REDIS_URL}}` | reference |
| `BETTER_AUTH_SECRET` | `${{secret(32)}}` | generated |
| `RESEND_FROM_EMAIL` | `noreply@hogsend.com` | default (deployer changes) |
| `HATCHET_CLIENT_HOST_PORT` | `hatchet-lite.railway.internal:7077` | internal |
| `HATCHET_CLIENT_API_URL` | `https://${{RAILWAY_SERVICE_HATCHET_LITE_URL}}` | reference |
| `HATCHET_CLIENT_TLS_STRATEGY` | `none` | internal |
| `NODE_ENV` | `production` | default |
| `PORT` | `3002` | default |
| `LOG_LEVEL` | `info` | default |

## `hogsend-worker` variables (as configured)

No required inputs — it references the api for everything user-supplied. 12
pre-configured: `API_PUBLIC_URL=https://${{RAILWAY_SERVICE_HOGSEND_API_URL}}`,
`RESEND_API_KEY=${{hogsend-api.RESEND_API_KEY}}`,
`HATCHET_CLIENT_TOKEN=${{hogsend-api.HATCHET_CLIENT_TOKEN}}`,
`BETTER_AUTH_SECRET=${{hogsend-api.BETTER_AUTH_SECRET}}`,
`BETTER_AUTH_URL=https://${{RAILWAY_SERVICE_HOGSEND_API_URL}}`, plus the same
`DATABASE_URL` / `REDIS_URL` / `RESEND_FROM_EMAIL` / `HATCHET_CLIENT_*` / `NODE_ENV`
as the api. Start command: `pnpm --filter @hogsend/api worker`.

`API_PUBLIC_URL` matters on the worker because email sending (and the unsubscribe +
open/click link rewriting that rides along) happens there.

## What was fixed (June 2026)

`API_PUBLIC_URL` was missing on both services, so it fell back to the `env.ts`
default `http://localhost:3002` — every email a deployed instance sent would carry
localhost unsubscribe/tracking links. Added:

- api → `API_PUBLIC_URL=https://${{RAILWAY_PUBLIC_DOMAIN}}`
- worker → `API_PUBLIC_URL=https://${{RAILWAY_SERVICE_HOGSEND_API_URL}}`

Saved to template `291daa3b` (= `LxSCyR`).

## Follow-ups

- Delete the duplicate `sYUYH8` template.
- Optional: add `LOG_LEVEL=info` to the worker for parity (currently defaults to
  `debug`); add optional `ADMIN_API_KEY=${{secret(32)}}` if you want CLI/admin
  access pre-wired.
