# Environment Variables Reference

## Required for API

| Variable | Description |
|----------|-------------|
| `DATABASE_URL` | PostgreSQL connection (reference managed Postgres) |
| `BETTER_AUTH_SECRET` | Auth secret, minimum 32 chars (generate 64-char random) |
| `RESEND_API_KEY` | Client's Resend API key |

## Required for Worker

| Variable | Description |
|----------|-------------|
| `DATABASE_URL` | Same Postgres as API |
| `RESEND_API_KEY` | Same as API |
| `HATCHET_CLIENT_TOKEN` | Generated from Hatchet dashboard |

## Optional (both services)

| Variable | Default | Description |
|----------|---------|-------------|
| `NODE_ENV` | `development` | Set to `production` on Railway |
| `PORT` | `3002` | HTTP port (API only) |
| `LOG_LEVEL` | `info` | Logging verbosity |
| `REDIS_URL` | `redis://localhost:6379` | Reference managed Redis |
| `BETTER_AUTH_URL` | `http://localhost:3002` | Public API URL |
| `RESEND_FROM_EMAIL` | `noreply@hogsend.com` | Sender email |
| `HATCHET_CLIENT_TOKEN` | - | Hatchet API token |
| `POSTHOG_WEBHOOK_SECRET` | - | PostHog webhook verification |
| `ENABLED_JOURNEYS` | `*` | Comma-separated journey IDs or `*` for all |

## Managing via CLI

```bash
cd cli && ./hogsend journeys          # View/update enabled journeys
cd cli && ./hogsend deploy            # Redeploy after changes
```

## Managing via Railway MCP

```
mcp__railway__list_variables projectId="<id>" serviceId="<svc-id>"
mcp__railway__set_variables projectId="<id>" serviceId="<svc-id>" variables={"KEY": "value"}
```
