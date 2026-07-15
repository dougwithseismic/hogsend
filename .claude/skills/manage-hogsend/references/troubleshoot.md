# Troubleshooting

## Health check

API exposes `GET /v1/health` returning:
```json
{"status": "healthy", "version": "0.0.1", "uptime": 123.4, "timestamp": "..."}
```

Via CLI: `./hogsend status`

## Common issues

### API crash-loops on startup

**Symptom:** API service keeps restarting on Railway.

**Causes:**
1. Missing `DATABASE_URL` — Postgres not provisioned or not linked
2. Missing `BETTER_AUTH_SECRET` — must be at least 32 chars
3. Missing `RESEND_API_KEY` — required at startup
4. Invalid `HATCHET_CLIENT_TOKEN` — can't connect to Hatchet engine

**Fix:** Check env vars via `mcp__railway__list_variables` or Railway dashboard.

### Worker crash-loops

**Symptom:** Worker service keeps restarting.

**Causes:**
1. Missing `HATCHET_CLIENT_TOKEN` — worker can't connect to Hatchet
2. Wrong `railwayConfigFile` — must be `railway.worker.toml` (not `railway.toml`)
3. Hatchet-Lite not running — worker depends on it

**Fix:**
- Verify `railwayConfigFile` is set to `railway.worker.toml`
- Check Hatchet-Lite service is healthy
- Verify `HATCHET_CLIENT_TOKEN` is set and valid

### Worker has healthcheck failures

**Symptom:** Worker shows as "unhealthy" on Railway.

**Cause:** Worker uses the API's `railway.toml` which has `healthcheckPath = "/v1/health"`. Workers don't serve HTTP.

**Fix:** Set `railwayConfigFile` to `railway.worker.toml` on the worker service instance.

### Journeys not loading

**Symptom:** "Journey registry loaded: 0 journeys" in logs.

**Cause:** `ENABLED_JOURNEYS` is set to a non-existent journey ID.

**Fix:** Check the value of `ENABLED_JOURNEYS`. Use `*` for all, or valid IDs like `activation-welcome,test-onboarding`.

### Hatchet token chicken-and-egg

**Symptom:** Can't set `HATCHET_CLIENT_TOKEN` because Hatchet isn't running, but Hatchet needs to be running to generate a token.

**Resolution:**
1. Deploy Hatchet-Lite first (it starts independently)
2. Wait for it to be healthy
3. Open its public URL, login with `admin@example.com` / `Admin123!!`
4. Go to Settings > API Tokens > Generate token
5. Set the token on API + Worker services
6. Services auto-redeploy and connect

## Viewing logs

Via MCP:
```
mcp__railway__get_logs projectId="<id>" serviceId="<svc-id>"
```

Via CLI:
```bash
./hogsend status
```
