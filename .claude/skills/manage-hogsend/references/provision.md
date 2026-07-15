# Provisioning a New Client

## Using the CLI (recommended)

```bash
cd cli && make build
./hogsend init
```

The wizard handles everything: Railway project creation, service provisioning, env var setup.

## Using Railway MCP tools (manual)

If you need to provision programmatically without the CLI:

### Step 1: Create the Railway project

```
mcp__railway__create_project name="hogsend-<client-slug>"
```

### Step 2: Add databases

```
# App Postgres
mcp__railway__create_service projectId="<id>" name="postgres" type="database" image="postgres"

# Redis
mcp__railway__create_service projectId="<id>" name="redis" type="database" image="redis"

# Hatchet Postgres (separate from app DB)
mcp__railway__create_service projectId="<id>" name="hatchet-postgres" type="database" image="postgres"
```

### Step 3: Deploy Hatchet-Lite

```
mcp__railway__create_service projectId="<id>" name="hatchet-lite" image="ghcr.io/hatchet-dev/hatchet/hatchet-lite:v0.84.0"
```

Set Hatchet env vars:
```
mcp__railway__set_variables projectId="<id>" serviceId="<hatchet-svc-id>" variables={
  "DATABASE_URL": "${{hatchet-postgres.DATABASE_URL}}",
  "SERVER_URL": "https://${{RAILWAY_PUBLIC_DOMAIN}}",
  "SERVER_GRPC_BIND_ADDRESS": "0.0.0.0",
  "SERVER_GRPC_PORT": "7077",
  "SERVER_GRPC_INSECURE": "true",
  "SERVER_AUTH_SET_EMAIL_VERIFIED": "true",
  "SERVER_DEFAULT_ENGINE_VERSION": "V1"
}
```

### Step 4: Deploy API + Worker from GitHub

```
mcp__railway__create_service projectId="<id>" name="hogsend-api" source="<github-repo>"
mcp__railway__create_service projectId="<id>" name="hogsend-worker" source="<github-repo>"
```

Set `railwayConfigFile` on each:
- API: `railway.toml`
- Worker: `railway.worker.toml`

### Step 5: Set env vars

API service needs:
- `DATABASE_URL` — reference Postgres
- `REDIS_URL` — reference Redis
- `BETTER_AUTH_SECRET` — 64-char random string
- `BETTER_AUTH_URL` — `https://<api-domain>`
- `RESEND_API_KEY` — client's Resend key
- `RESEND_FROM_EMAIL` — client's from address
- `ENABLED_JOURNEYS` — `*` or comma-separated
- `NODE_ENV` — `production`

Worker service needs the same vars (except BETTER_AUTH).

### Step 6: Hatchet token (after Hatchet boots)

1. Wait for Hatchet-Lite to deploy and become healthy
2. Open the Hatchet dashboard URL
3. Login with `admin@example.com` / `Admin123!!`
4. Go to Settings > API Tokens > Generate
5. Set `HATCHET_CLIENT_TOKEN` on API and Worker services
6. Both services will auto-redeploy

### Step 7: Verify

```
mcp__railway__get_logs projectId="<id>" serviceId="<api-svc-id>"
```

Check for "Journey registry loaded: N journeys" in the logs. Hit the health endpoint to confirm.
