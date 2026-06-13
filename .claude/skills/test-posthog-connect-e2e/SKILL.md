---
name: test-posthog-connect-e2e
description: Use when you need to verify Hogsend's one-click `hogsend connect posthog` flow locally end-to-end — pick the integration test for CI/regression, the Claude-in-Chrome OAuth handshake to prove real consent, or the cloudflared tunnel for a real PostHog event verified by the engine (snapshot+restore required).
---

# Test `hogsend connect posthog` end-to-end (locally)

The connect flow derives everything from one OAuth grant: keyless connect-info, a server-minted webhook secret persisted to the `kind="derived"` store, the `phc_` (project `api_token`) grabbed off the project read, the provisioned PostHog→Hogsend hog-function destination, and inbound webhook verification against the stored secret. This skill verifies that chain at three escalating fidelities.

This is a reusable playbook. Tunnel URLs, secrets, project ids, and ports are per-session — never hardcode the values from any prior run.

## The chain under test

1. `GET /v1/admin/analytics/connect-info` — keyless: reports `privateHost` (region), `analyticsConfigured`, `webhookSecretConfigured`, `scopeGap`. No `phc_` needed.
2. OAuth handshake — PKCE S256 public client, loopback callback on `127.0.0.1:{8423,8424,8425}/callback`, code exchange stores a real `pha_` token via `PUT /v1/admin/provider-credentials/posthog`.
3. `POST /v1/admin/analytics/provision-loop` — reads the project (grabs `phc_` + project id), mints+persists a 64-hex webhook secret, creates/repoints the hog-function destination at `API_PUBLIC_URL/v1/webhooks/posthog`.
4. Inbound `POST /v1/webhooks/posthog` — the source resolves the minted secret from the `kind="derived"` store (env `POSTHOG_WEBHOOK_SECRET` unset) and verifies the `x-posthog-webhook-secret` header. Correct → 200, wrong → 401.

## When to use which level

- **Level 1** — CI/regression and fast iteration. No browser, no real PostHog, no mutation. Run this first and on every change.
- **Level 2** — confirm the REAL OAuth consent + code exchange works against live PostHog. No provisioning, zero PostHog mutation.
- **Level 3** — only when you must see a real PostHog event delivered and verified by the engine. Mutates a real PostHog destination, so SNAPSHOT + RESTORE is mandatory.

---

## Level 1 — Integration test (no browser, PostHog stubbed)

Runs the real engine (`createApp` / `createHogsendClient`) against the real docker TimescaleDB, with PostHog stubbed at the `fetch` boundary and Hatchet mocked via `overrides: { hatchet }`. Proves the engine logic without any network or browser.

Committed examples to copy: `apps/api/src/__tests__/analytics-admin.test.ts` (provision-loop mint+persist + `phc_` grab, connect-info `scopeGap`) and `apps/api/src/__tests__/posthog-webhook-secret-store.test.ts` (inbound verification against the stored derived secret). For a *narrated, watchable* run, write a throwaway `*.test.ts` that walks the whole flow with `console.log` — but do NOT commit it: it shares the single `posthog` `providerCredentials` row with those tests, so a committed copy causes order-dependent failures in the full suite. Keep it local and run it in isolation.

What it proves: keyless connect-info → mint+persist webhook secret → grab the `phc_` (project `api_token`) → connect-info `scopeGap` → inbound verification against the stored derived secret (correct 200, wrong 401).

How it works:
- Boots a fresh-instance env at the top of the file (`delete process.env.POSTHOG_API_KEY` etc., set `API_PUBLIC_URL` to a non-loopback host) BEFORE importing `@hogsend/engine`.
- `createHogsendClient({ overrides: { hatchet: mockHatchet } })` + `createApp(container, { webhookSources })`.
- Drives the flow with `app.request(...)` — no HTTP server.
- Stubs `globalThis.fetch`: `GET /api/projects/` returns `{ id, api_token: "phc_…" }`; `POST /hog_functions/` captures the minted secret + url.
- `beforeAll` backs up and deletes the real `posthog` `providerCredentials` row; `afterAll` restores it and cleans up. Always preserve this backup/restore so a real local credential survives the test.

Run it:

```bash
# committed coverage (part of the suite)
cd apps/api && pnpm exec vitest run posthog-webhook-secret-store analytics-admin

# a throwaway narrated walkthrough — run in ISOLATION (never commit it)
cd apps/api && pnpm exec vitest run <your-throwaway-file> --disableConsoleIntercept
```

`--disableConsoleIntercept` surfaces the `console.log` narration (vitest swallows it otherwise). Requires the docker DB up (`docker compose up -d`).

---

## Level 2 — Real OAuth handshake via Claude-in-Chrome

Proves the real consent screen + real code exchange against live PostHog. No provisioning (`--no-provision`), so zero PostHog mutation. Claude drives Chrome to click "Authorize".

### 1. Boot a local engine from THIS branch on a free port

Use the binary entrypoint, NOT the library entry:

- CLI dispatcher: `packages/cli/src/bin.ts` — the real `hogsend` command.
- `packages/cli/src/index.ts` is the programmatic/library entry (exports only). Running it via tsx silently no-ops.

Pick a free port (e.g. `PORT=3055`). Copy `apps/api/.env` to a temp env, then override:
- `PORT=<free port>`
- `SKIP_SCHEMA_CHECK=true` (skip the boot schema guard for a throwaway engine)

```bash
cp apps/api/.env /tmp/connect-e2e.env
# append/override in /tmp/connect-e2e.env:
#   PORT=3055
#   SKIP_SCHEMA_CHECK=true
cd apps/api && env $(grep -v '^#' /tmp/connect-e2e.env | xargs) pnpm dev
```

Run the engine in the background; tail its log — the `POST /v1/webhooks/posthog status:200` line is the inbound proof at Level 3.

### 2. Scope-set gotcha (read BEFORE running the CLI)

The live CIMD doc at `hogsend.com/.well-known/hogsend-posthog-client.json` only authorizes the scopes listed in its `scope` field. If THIS branch requests MORE scopes than the live doc lists, PostHog rejects consent.

`POSTHOG_SCOPES` lives in `packages/cli/src/lib/oauth.ts`. To test a real handshake before the broader doc is deployed, temporarily edit `POSTHOG_SCOPES` down to the set the live doc currently lists, run the handshake, then revert:

```bash
git checkout packages/cli/src/lib/oauth.ts
```

Always `git checkout` it after — never commit the narrowed set.

### 3. Run the real CLI in `--no-browser` mode

```bash
cd packages/cli && env ADMIN_API_KEY=<instance admin key> \
  pnpm exec tsx src/bin.ts connect posthog \
  --url http://localhost:3055 \
  --posthog-host https://eu.posthog.com \
  --no-provision \
  --no-browser
```

- The admin key resolves from `ADMIN_API_KEY` (or `HOGSEND_ADMIN_KEY`, or `--admin-key`). Use the SAME key the local engine validates.
- `--posthog-host` picks the region to authorize against (the instance reports `privateHost: null` when keyless).
- `--no-browser` makes the CLI print the authorize URL and block on the `127.0.0.1` loopback waiting for the callback (5 min timeout).

Capture the printed authorize URL.

### 4. Drive Chrome to authorize

Load the browser tools, then:
- Navigate to the printed authorize URL.
- The PostHog consent page renders (sign in first if prompted — use the operator's PostHog account; the dogfood login is on EU cloud).
- Click "Authorize". PostHog redirects to `http://127.0.0.1:<port>/callback?code=…&state=…`.
- The CLI's loopback receiver catches the code, exchanges it at the token endpoint, and stores a REAL token via `PUT /v1/admin/provider-credentials/posthog`. The CLI prints `connected_no_provision`.

### 5. Verify the stored credential (meta only)

```bash
curl -s http://localhost:3055/v1/admin/provider-credentials/posthog \
  -H "Authorization: Bearer <admin key>" | jq
```

Returns meta only — never the token: `{ providerId, scopes, scopedTeams, expiresAt }`. Real PostHog returns a ~7-day `pha_` access token and the real team id in `scopedTeams`. A populated `expiresAt` ~7 days out and a non-empty `scopedTeams` is the pass.

---

## Level 3 — Real provision + real inbound via cloudflared tunnel

Mutates a real PostHog destination. SNAPSHOT + RESTORE is mandatory. Do this only when you must see a real PostHog event verified by the engine.

### SAFETY FIRST — snapshot the existing destination

The provisioner adopts the PostHog→Hogsend destination by URL PATH (`…/v1/webhooks/posthog`). Provisioning from a local engine REPOINTS any existing live destination at your tunnel and ROTATES its secret. Before provisioning:

1. Open the destination's config page in PostHog (Data pipelines → the Hogsend hog-function → Configuration).
2. RECORD its Webhook URL.
3. RECORD the `x-posthog-webhook-secret` header value (it is a non-secret input — visible in the UI).

That URL + secret is your restore snapshot. Write it down before touching anything.

### 1. Start a public tunnel to the local engine

```bash
cloudflared tunnel --config /dev/null --protocol http2 --url http://localhost:3055
```

- `--config /dev/null` is REQUIRED if `~/.cloudflared/config.yml` exists — otherwise the quick tunnel inherits that config's catch-all ingress and 404s everything. The tell: a 404 with `server: cloudflare` and no app headers.
- `--protocol http2` is more stable than the default QUIC for trycloudflare quick tunnels.

Capture the printed `https://<random>.trycloudflare.com` URL.

### 2. Reboot the engine bound to the tunnel

The engine resolves the provisioning region from its OWN env, not the CLI flag. Stop the engine and restart with:
- `API_PUBLIC_URL=<tunnel url>`
- `POSTHOG_PRIVATE_HOST=https://eu.posthog.com` (or `https://us.posthog.com`)

Keep `SKIP_SCHEMA_CHECK=true` and the same `PORT`.

NEVER kill the engine with `lsof -ti tcp:3055 | xargs kill` — cloudflared holds a client connection to the port, so that kills the tunnel too. Target only the engine listener:

```bash
lsof -ti tcp:3055 -sTCP:LISTEN | xargs kill
```

### 3. Provision against the tunnel

Uses the stored token from Level 2 — no re-consent:

```bash
cd packages/cli && env ADMIN_API_KEY=<admin key> \
  pnpm exec tsx src/bin.ts connect posthog \
  --url http://localhost:3055 \
  --provision-only
```

This grabs the real `phc_`, mints+persists a fresh secret, and repoints the destination at the tunnel. The CLI prints `created` (new) or `no (existing function adopted)`.

### 4. Trigger a real inbound event

In PostHog: open the destination → Configuration → "Start testing" → "Test function".

GOTCHA: the destination filters `$is_identified = true`; the canned example event is NOT identified, so it is SKIPPED. Either:
- Edit the test event JSON to add `$is_identified: true`, OR
- Remove the filter chip in the form UNSAVED (it reverts via "Clear changes" — it never persists), then run.

A successful run shows "Success" in PostHog AND a `POST /v1/webhooks/posthog status:200` line in the engine log. That 200 proves the engine resolved the just-minted secret from the `kind="derived"` store and verified a real PostHog delivery — no env secret, no redeploy.

### 5. RESTORE (mandatory)

In the destination config:
- Set the Webhook URL back to the recorded snapshot URL.
- Set the `x-posthog-webhook-secret` back to the recorded snapshot value.
- Ensure the `$is_identified` filter is present (if you removed the chip, "Clear changes" reverts it; confirm it is there).
- Save.

Verify the saved fields match the snapshot exactly.

### 6. Teardown

- Stop the engine listener: `lsof -ti tcp:3055 -sTCP:LISTEN | xargs kill`.
- Stop the cloudflared tunnel process.
- Optionally delete the local OAuth credential:

```bash
curl -s -X DELETE http://localhost:3055/v1/admin/provider-credentials/posthog \
  -H "Authorization: Bearer <admin key>"
```

- The user can revoke the app in PostHog → Settings → Authorized applications.
- Remove `/tmp/connect-e2e.env`. Confirm `packages/cli/src/lib/oauth.ts` is reverted (`git status`).
