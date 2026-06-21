# Connecting Discord

Operator runbook + architecture reference for the Discord connector on a
deployed `create-hogsend` app. Audience: instance operators / consultants
running a published-engine consumer (the dogfood at `https://t.hogsend.com` is
the worked example throughout), and engine contributors.

The connector does two things:

1. The **`/link` + `/verify` identity loop** — a member runs `/link` in your
   server, gets a code emailed, and (optionally) the bot grants a "verified"
   role. This stitches their Discord snowflake to their email contact, in your
   DB and in PostHog. This is pure HTTP interactions — it needs no socket.
2. **Optional inbound ingestion** — real messages / reactions / joins / presence
   in your server arrive over the Gateway socket and land as `discord.*` events
   in `user_events`. This needs a long-lived socket.

If you only want `/link`, you do not need the worker runtime or the bot token at
all (the role grant aside). If you also want inbound ingestion, you run the
worker runtime described in [Wiring the worker runtime](#wiring-the-worker-runtime).

---

## Architecture (runtime era)

The Gateway socket runs **inline inside the Hatchet worker** — there is no
separate Discord service, and no shared ingress secret on the default path.

```
real Discord activity
  → discord.js Gateway socket  (INLINE in the Hatchet worker, leader replica only)
  → in-process: connector.transform(dispatch)  →  ingestEvent(...)
  → user_events row + contacts (discord_id key + properties.discord metadata)
```

The pieces:

- **One socket, one replica.** A Discord bot token permits exactly one live
  Gateway session. The worker elects a single leader via a **Redis leader
  lease** (`hogsend:connector-runtime:discord:leader`, `SET … NX PX`, 30s TTL,
  renewed every 10s). Only the leader opens the socket; losers idle and re-race,
  so scaling the worker to N replicas never opens a second session. Failover is
  automatic within the TTL. See `packages/engine/src/lib/leader-lease.ts` and
  `packages/engine/src/connectors/runtime.ts`.
- **In-process dispatch.** The leader hands each raw Gateway dispatch straight to
  the connector's `transform`, then `ingestEvent` — the exact pair the legacy
  HTTP ingress route ran, minus the network hop. No HTTP, no shared secret.
- **Readiness is the heartbeat.** The leader writes a TTL'd Redis key
  `hogsend:connector-runtime:discord:heartbeat` (30s TTL, refreshed every 10s),
  read by `getConnectorHeartbeat("discord")`. The admin `connect-info.workerOnline`
  flag and Studio's "Worker Online" both reflect this key. Because only the
  lease-holder writes it, a fresh key means *this deployment's elected leader
  owns the socket* — a stray process can no longer light the dashboard green.
- **Outbound is socket-free.** Bot-REST actions (send a channel message, DM a
  member, mention a role) go through `sendConnectorAction()` +
  `@hogsend/plugin-discord`'s `discordActions`. They need only the bot token and
  are independent of the inbound runtime — a deploy with the gateway off can
  still send.

### Legacy (standalone) path — not used by default

The standalone `discord-worker.ts` entry, the HTTP ingress route
(`POST /v1/connectors/discord/ingress`), and `CONNECTOR_INGRESS_SECRET` are the
**old** path, retained for `CONNECTOR_RUNTIME_HOST=standalone` only. On the
default `CONNECTOR_RUNTIME_HOST=worker` deploy they are **inert**:

- `CONNECTOR_INGRESS_SECRET` is **not used** — do not set it for a worker-hosted
  deploy. It does not gate readiness.
- `connect-info.ingressSecretConfigured` is a **stale** field — it keys on the
  unset `CONNECTOR_INGRESS_SECRET` and will report `false` on a perfectly
  healthy worker-hosted deploy. **Do not use it as a readiness signal.** The
  readiness signal is `workerOnline` (the heartbeat).

The local laptop E2E playbook in [`discord-e2e.md`](./discord-e2e.md) still
documents the standalone leg (it predates the runtime) — use this file for a
deployed instance.

---

## Prerequisites

| Requirement | Why |
|---|---|
| **Public HTTPS `API_PUBLIC_URL`** (e.g. `https://t.hogsend.com`) | Discord PINGs the interactions endpoint synchronously to validate it, and OAuth redirects land on it. Must NOT be loopback. |
| **Shared `REDIS_URL`** on both `api` and `worker` services | The leader lease and the heartbeat live in Redis. If the worker can't reach the same Redis the API reads, "Worker Online" never goes green even with a healthy socket. |
| **Admin key** (`ADMIN_API_KEY`) | The `hogsend connect discord` CLI and Studio authenticate the admin connector routes with it. |
| Discord account that can create/own an application and a server (guild) | Portal config + a server to install the bot into. |

For inbound ingestion you additionally need `DISCORD_BOT_TOKEN` on the **worker**
service (see [Wiring the worker runtime](#wiring-the-worker-runtime)).

---

## Step 1 — Discord Developer Portal

Go to <https://discord.com/developers/applications>, **select your existing
application** (or create one). Do the steps in this order — the intents must be
on **before** the worker gets the token, or the socket login crash-loops.

1. **Bot tab → toggle the three Privileged Gateway Intents FIRST:**
   - **SERVER MEMBERS INTENT**
   - **MESSAGE CONTENT INTENT**
   - **PRESENCE INTENT**

   If any is off, `discord.js` `login()` rejects with a **disallowed-intents**
   error and the worker's runtime fails to start (it releases the lease and
   surfaces the error). Toggle all three before copying the token.

2. **Bot tab → Reset Token → copy the BOT TOKEN.** This is `DISCORD_BOT_TOKEN`.
   It is shown once — copy it now. Resetting it invalidates any prior copy
   (see [Token rotation](#token-rotation)).

3. **OAuth2 tab → copy the CLIENT ID and CLIENT SECRET.** The Client ID equals
   the General Information **Application ID**. Reset the secret to reveal it.
   These are `DISCORD_APPLICATION_ID` and `DISCORD_CLIENT_SECRET`.

4. **General Information tab → copy the PUBLIC KEY.** This is
   `DISCORD_PUBLIC_KEY` — it verifies the interactions-PING signature.

5. **OAuth2 → Redirects → add this exact redirect** (for `t.hogsend.com`):

   ```
   https://t.hogsend.com/v1/connectors/discord/oauth/callback
   ```

6. **Interactions Endpoint URL** — set it to:

   ```
   https://t.hogsend.com/v1/connectors/discord/interactions
   ```

   `hogsend connect discord` sets this for you (via `PATCH /applications/@me`)
   once the consumer mounts the `/wire` route (Step 3). If your consumer does
   NOT mount `/wire`, paste it here by hand. **Either way the API must already
   be live behind the public URL when this is saved** — Discord PINGs it
   synchronously and the save fails if it can't reach a signed PONG.

The four values map to env / stored credential like this:

| Portal value | Env var | Stored derived field |
|---|---|---|
| Bot Token | `DISCORD_BOT_TOKEN` | `discordBotToken` |
| Application ID / Client ID | `DISCORD_APPLICATION_ID` | `discordAppId` |
| Client Secret | `DISCORD_CLIENT_SECRET` | `discordClientSecret` |
| Public Key | `DISCORD_PUBLIC_KEY` | `discordPublicKey` |

You can configure these two ways — they are not mutually exclusive:

- **Env-only**: set `DISCORD_APPLICATION_ID`, `DISCORD_CLIENT_SECRET`,
  `DISCORD_PUBLIC_KEY` on the API service; the dogfood's `buildDiscordConnector`
  registers the connector from them and `seedDiscordDerived` seeds `discordAppId`
  into the derived credential at boot (so the install/member-link URLs work).
  Set the Interactions Endpoint URL yourself in the portal.
- **CLI**: run `hogsend connect discord` to paste the four values and have the
  server store them + auto-wire the interactions endpoint (Step 3).

---

## Step 2 — `hogsend connect discord`

Run against your DEPLOYED instance (not loopback — Discord must reach the
interactions endpoint to wire it):

```bash
hogsend connect discord --url https://t.hogsend.com
```

The CLI (`packages/cli/src/lib/connect-discord-flow.ts`):

1. `GET /v1/admin/connectors/discord/connect-info` — reads the redirect/
   interactions URLs + readiness flags (this route is **engine-shipped**, mounts
   automatically).
2. Prompts you to paste the four portal values.
3. `PUT /v1/admin/connectors/discord/secrets` — stores them in the encrypted
   derived credential.
4. `POST /v1/admin/connectors/discord/wire` — `PATCH /applications/@me` to set
   the interactions endpoint URL on the Discord app.
5. Opens the server-minted one-click bot-install URL and polls for the guild id.

> **Consumer-mount requirement.** Steps 3 and 4 hit `/secrets` and `/wire`,
> which are **NOT shipped by the engine** (provider-neutral boundary — the
> engine carries no Discord-secrets code). Your consumer app must mount them via
> `createApp(client, { routes })`. Until it does, the CLI **404s at the storage
> step**. See [Consumer routes spec](#consumer-routes-spec) for the exact
> implementation. The dogfood mounts both.

`--status` reads the current state without prompting or writing. Note its
`ingress secret` line is the stale field — ignore it; trust `Worker Online` in
Studio for inbound readiness.

---

## Consumer routes spec

The dogfood mounts two admin routes that back the CLI's `/secrets` + `/wire`
calls. They live in the consumer because the engine ships no Discord-secrets
code. The shipped implementation is `hogsend-dogfood/src/discord-admin-routes.ts`
(`registerDiscordAdminRoutes`), mounted in `src/index.ts` via
`createApp(client, { routes: registerDiscordAdminRoutes })`. Full reference:
[Consumer routes spec](./connect-discord-consumer-routes.md).

**Auth.** `requireAdmin` is **not** exported from `@hogsend/engine`, so the
consumer guards these routes itself. The shipped guard mirrors the engine's
`requireAdmin` exactly: an `Authorization: Bearer <key>` header is checked
against env `ADMIN_API_KEY` first, then against the hashed `api_keys` table
(`sha256` hex, rejecting revoked/expired rows); with no Bearer header it falls
back to a Better-Auth session. The CLI sends
`Authorization: Bearer <ADMIN_API_KEY>`, so the env-key branch is the CLI path;
Studio uses the session branch.

**Engine helpers available** (all published at `@hogsend/engine@0.24.0`, so this
is unblocked by the unpublished worker-runtime work):

- `saveDerivedCredential(db, "discord", payload)` / `getDerivedCredential(db, "discord")`
  — encrypted derived-credential store (full-payload overwrite; **read-merge-write
  is the caller's job**).
- `patchApplication({ botToken, interactionsEndpointUrl })` from
  `@hogsend/plugin-discord` — `PATCH https://discord.com/api/.../applications/@me`.

### `PUT /v1/admin/connectors/discord/secrets`

Stores the four pasted Discord values into the derived credential.

- **Body** (the CLI's exact wire shape — it sends `appId`; the shipped handler
  also accepts `applicationId`):

  ```json
  { "appId": "...", "publicKey": "...", "botToken": "...", "clientSecret": "..." }
  ```

- **Behaviour**: read-merge-write — `getDerivedCredential(db, "discord")`, spread
  the existing fields, overlay the four (`discordAppId`, `discordPublicKey`,
  `discordBotToken`, `discordClientSecret`), `saveDerivedCredential`. Merging
  preserves a previously-captured `discordGuildId`.
- **Secret hygiene**: NEVER log the body or any token. Return `{ ok: true }`.

```ts
app.put("/v1/admin/connectors/discord/secrets", requireAdmin, async (c) => {
  const { db } = c.get("container");
  const body = (await c.req.json()) as Record<string, unknown>;
  const appId = readField(body, "applicationId", "appId"); // CLI sends appId
  // …read publicKey/botToken/clientSecret, 400 if any blank…
  const current = (await getDerivedCredential(db, "discord")) ?? {};
  await saveDerivedCredential(db, "discord", {
    ...current,
    discordAppId: appId,
    discordPublicKey: publicKey,
    discordClientSecret: clientSecret,
    discordBotToken: botToken,
  });
  return c.json({ ok: true }, 200);
});
```

### `POST /v1/admin/connectors/discord/wire`

Wires the interactions endpoint onto the Discord app.

- **Resolve the bot token** from the just-stored derived credential
  (`discordBotToken`), falling back to env `DISCORD_BOT_TOKEN`.
- **Build the interactions URL**: `${API_PUBLIC_URL}/v1/connectors/discord/interactions`.
- **Refuse on loopback**: if `API_PUBLIC_URL` is `localhost` / `127.0.0.1` /
  `0.0.0.0` / `*.localhost`, return `409 { error: "api_public_url_unreachable" }`
  — Discord cannot PING localhost to validate the endpoint. (The CLI maps this
  409 to its `api_public_url_unreachable` verdict.)
- Call `patchApplication({ botToken, interactionsEndpointUrl })`.
- **Secret hygiene**: status-only logging. NEVER echo the Discord response body —
  it can carry the token / app config.

```ts
app.post("/v1/admin/connectors/discord/wire", requireAdmin, async (c) => {
  const { db, env } = c.get("container");
  const apiPublicUrl = env.API_PUBLIC_URL.replace(/\/+$/, "");
  if (isLoopbackPublicUrl(apiPublicUrl)) {
    return c.json({ error: "api_public_url_unreachable" }, 409);
  }
  const derived = await getDerivedCredential(db, "discord");
  const botToken = derived?.discordBotToken ?? process.env.DISCORD_BOT_TOKEN;
  if (!botToken) return c.json({ error: "bot_token_missing" }, 409);
  await patchApplication({
    botToken,
    interactionsEndpointUrl: `${apiPublicUrl}/v1/connectors/discord/interactions`,
  });
  return c.json({ ok: true }, 200);
});
```

Mount in `src/index.ts` (the shipped wiring):

```ts
import { registerDiscordAdminRoutes } from "./discord-admin-routes.js";

const app = createApp(client, {
  webhookSources,
  routes: registerDiscordAdminRoutes,
});
```

---

## Wiring the worker runtime

This is what turns on **inbound ingestion** (the `/link` loop needs none of it).

On the **worker** service set:

```ini
DISCORD_BOT_TOKEN=<the bot token from the portal>
REDIS_URL=<the SAME Redis the API uses>        # load-bearing for lease + heartbeat
```

Then pass the Discord runtime factory to `createWorker` in `src/worker.ts`:

```ts
import { createWorker } from "@hogsend/engine";
import { createDiscordRuntime } from "@hogsend/plugin-discord/gateway";

const worker = createWorker({
  container: client,
  journeys,
  buckets,
  extraWorkflows,
  connectorRuntimes: { discord: createDiscordRuntime },
});
```

How it engages (see `packages/engine/src/worker.ts`):

- The runtime starts only when **all** hold: `ENABLE_CONNECTOR_RUNTIMES=true`
  (default), `CONNECTOR_RUNTIME_HOST=worker` (default), a `discord` factory is
  passed, AND the Discord connector is registered as a `gateway`-transport
  connector.
- `createDiscordRuntime` returns `null` when `DISCORD_BOT_TOKEN` is unset — the
  engine then skips Discord cleanly (no lease held, dashboard stays truthfully
  Offline). So forgetting the token on the worker is a silent no-op, not a crash.
- `discord.js` is imported dynamically inside the socket's `start()`. If you
  enable the runtime without the optional `discord.js` peer installed, it fails
  loudly at start, not at module load.

To explicitly DISABLE the inline runtime (e.g. you run the standalone worker
instead), set `ENABLE_CONNECTOR_RUNTIMES=false` (the enum env means a literal
`"false"` actually disables it).

---

## Registering slash commands

`/link` and `/verify` must be registered with Discord once. The dogfood ships a
script (`apps/api/scripts/register-discord-commands.ts` in the engine repo;
mirror it in your consumer). It needs `DISCORD_APPLICATION_ID` +
`DISCORD_BOT_TOKEN` in env, and optionally `DISCORD_GUILD_ID`:

```bash
pnpm --filter @hogsend/api discord:register-commands
# equivalently: tsx --env-file=.env scripts/register-discord-commands.ts
```

- **With `DISCORD_GUILD_ID`** → guild-scoped registration, **instant** (best for
  a single community server).
- **Without it** → global registration; propagation can take up to ~1h.

The PUT replaces the full command set (idempotent). `/link` takes no options (it
opens a private modal for the email); `/verify` takes a required string `code`.

---

## Verifying the connection

Read the admin projection (or Studio `/integrations` → Discord card):

```bash
curl -s "https://t.hogsend.com/v1/admin/connectors/discord/connect-info" \
  -H "Authorization: Bearer ${ADMIN_API_KEY}" | jq .
```

What to trust:

| Field | Meaning |
|---|---|
| **`workerOnline`** | **The readiness signal.** `true` ⇒ a fresh heartbeat key is present ⇒ a leader replica owns the socket. This is "Worker Online" in Studio. |
| `workerLastSeenAt` | ISO timestamp of the last heartbeat write. |
| `guildId` / `botInstalled` | Set once the bot is installed in a server (from the live heartbeat metadata, or the derived credential). |
| `credentialStored` | A derived `discord` credential exists. |
| `installUrl` | Server-minted one-click bot-install URL (null until secrets stored). |
| ~~`ingressSecretConfigured`~~ | **STALE — ignore.** Keys on the unused `CONNECTOR_INGRESS_SECRET`; reports `false` on a healthy worker-hosted deploy. |

To prove the end-to-end loop, in a channel the bot can see: post a message
(`discord.message_sent`), add a reaction (`discord.reaction_added`), have someone
join (`discord.member_joined`), or come online (`discord.presence_active`). Then
query `user_events` for `event like 'discord.%'` and `contacts` for a non-null
`discord_id` with `properties->'discord'` metadata (query with your own DB
client — this runbook runs no DB queries for you).

---

## Token rotation

The bot token is stored in several places. Rotating it (e.g. after a leak)
means resetting it in the portal and updating **every** copy — a stale copy
crash-loops the socket or breaks role grants / outbound actions.

1. **Portal → Bot tab → Reset Token.** This is MFA-gated. Resetting
   immediately invalidates the old token. Copy the new one once.
2. Update the new token in **every** place it lives:
   - **worker** service env `DISCORD_BOT_TOKEN` (the inline socket login).
   - **api** service env `DISCORD_BOT_TOKEN` (role grant on `/link`; outbound
     actions if the API ever sends).
   - your **local `.env`** (for `discord:register-commands` and local runs).
   - the **derived credential** — re-run `hogsend connect discord` (paste the
     new token), which overwrites `discordBotToken` via `/secrets`. The `/wire`
     route also resolves the bot token, preferring the derived value.
3. Redeploy. The worker's leader picks up the new token on restart; the socket
   reconnects. Confirm `workerOnline: true` returns.

Order matters only in that the old token dies the instant you reset it — expect
a brief socket outage between reset and redeploy.

---

## Troubleshooting

| Symptom | Cause | Fix |
|---|---|---|
| **`Disallowed intents` / worker socket crash-loops on start** | One of the three privileged intents is off in the portal | Bot tab → enable SERVER MEMBERS + MESSAGE CONTENT + PRESENCE, then redeploy the worker. The runtime releases the lease on a failed start, so another replica (or a fixed redeploy) re-races cleanly. |
| **`workerOnline` / "Worker Online" stays `false`** | No bot token on the worker, no Redis on the worker, or the leader lease can't be held | Check the worker has `DISCORD_BOT_TOKEN` AND `REDIS_URL` pointing at the **same** Redis the API reads. `createDiscordRuntime` returns `null` (silent no-op) with no token; the heartbeat lives in Redis, so a worker that can't reach it never lights green even with a working socket. |
| **Interactions endpoint won't save in the portal / `/wire` 400s** | The API wasn't live behind the public URL when Discord PINGed it, OR `API_PUBLIC_URL` is loopback | Boot the API behind the public HTTPS URL first; `/wire` refuses loopback with `409 api_public_url_unreachable`. A successful save proves env-only signature verification (`DISCORD_PUBLIC_KEY`) works. |
| **CLI 404s at the `/secrets` step** | The consumer hasn't mounted `/secrets` + `/wire` | Mount both via `createApp({ routes })` — see [Consumer routes spec](#consumer-routes-spec). |
| **Bot is green but events arrive duplicated** | A stray second Gateway session — usually a standalone `discord-worker` still running, or a second deploy holding its own token | One token = one session. Ensure only the worker-hosted runtime is active: stop any standalone worker, set `CONNECTOR_RUNTIME_HOST=worker`, and confirm only one replica holds the lease. The lease prevents two replicas of the same deploy from doubling up, but it cannot stop a *different* process using the same token. |
| **`/link` succeeds but no "verified" role granted** | Bot token / `DISCORD_GUILD_ID` / `DISCORD_VERIFIED_ROLE_ID` unset on the API, or the bot lacks Manage Roles / its role is below the target | The grant is best-effort and non-fatal (the link still succeeds). Set the three env vars on the API and ensure the bot's role outranks the verified role. |

---

## Reference

- Architecture: `packages/engine/src/connectors/runtime.ts`,
  `packages/engine/src/lib/leader-lease.ts`,
  `packages/engine/src/lib/connector-heartbeat.ts`.
- Admin projection: `packages/engine/src/routes/admin/connectors.ts`.
- CLI flow: `packages/cli/src/lib/connect-discord-flow.ts`.
- Plugin (connector, actions, connect helpers, gateway runtime):
  `packages/plugin-discord/src/` — `createDiscordConnector`, `discordActions`,
  `patchApplication`, `@hogsend/plugin-discord/gateway` → `createDiscordRuntime`.
- Dogfood consumer wiring: `hogsend-dogfood/src/discord.ts` (`buildDiscordConnector`,
  `setDiscordDb`, `seedDiscordDerived`), `hogsend-dogfood/src/index.ts`,
  `hogsend-dogfood/src/worker.ts`.
- Local laptop (standalone) E2E playbook: [`discord-e2e.md`](./discord-e2e.md).
```
