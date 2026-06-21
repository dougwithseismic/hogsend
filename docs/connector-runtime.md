# Connector runtime — inline gateway sockets

The inbound runtime that holds a long-lived socket to a chat platform (Discord
today, Slack tomorrow). It runs **inline inside the Hatchet worker** — no
separate service, no shared ingress secret — gated by a Redis **leader lease**
so exactly one replica ever holds a given bot's socket. A platform dispatch
arriving over that socket runs the connector's own `transform` then
`ingestEvent` **in process**, the same pair the legacy HTTP ingress route runs,
minus the network hop.

This doc is the architecture reference + operator runbook for the runtime, plus
the consumer-routes spec for the two Discord admin routes a create-hogsend app
must mount to make `hogsend connect discord` work. Audience: instance
operators/consultants deploying a create-hogsend app, and engine contributors.

Source of truth:
`packages/engine/src/connectors/runtime.ts`,
`packages/engine/src/lib/connector-heartbeat.ts`,
`packages/engine/src/lib/leader-lease.ts`,
`packages/engine/src/worker.ts`.

---

## The model

```
real platform activity (a Discord message, reaction, join, presence)
  → discord.js Gateway socket   (held INLINE in the worker by the lease-holder)
  → connector.transform(payload, { db, logger, transport: "gateway" })
  → ingestEvent({ db, registry, hatchet, logger, event, analytics })
  → user_events row + contacts (discord_id key + properties.discord) + journey routing
```

The socket lives in the process every consumer already runs — the **Hatchet
worker** — not a hand-wired standalone service per consumer. The engine owns
everything platform-neutral: lease election, the in-process
dispatch→transform→ingest sink, the heartbeat, and shutdown ordering. A platform
plugin contributes only a runtime factory and a `defineConnector`.

### Why a leader lease

One bot token permits exactly one live Gateway session. With N replicated
workers, you need exactly one of them holding the socket at a time, with
automatic failover when that replica dies. That is a distributed-leader problem,
solved by `packages/engine/src/lib/leader-lease.ts`:

- **Acquire** — `SET key token PX ttl NX` (atomic acquire-if-absent with an
  expiry). Only the call that set the key wins; everyone else idles and re-races.
- **Renew** — a Lua compare-then-`PEXPIRE`: extend the expiry **only if** the
  stored value still equals the caller's unique fencing token.
- **Release** — a Lua compare-then-`DEL`: delete **only if** still owned.

The compare on the per-process `token` (a `randomUUID`) is the fence: a replica
that LOST the lease (expired, taken over) can neither renew nor release it, so it
can never stomp the new holder. Everything is best-effort against Redis faults —
acquire/renew return `false` on error, so the fail-safe is always "no lease ⇒ no
socket", never "two sockets".

Lease key: `hogsend:connector-runtime:<connectorId>:leader`
(e.g. `hogsend:connector-runtime:discord:leader`).

### Lease timings (constants in `runtime.ts`)

| Constant | Value | Meaning |
| --- | --- | --- |
| `LEASE_TTL_MS` | `30_000` | The lease expiry written on acquire/renew. |
| `RENEW_MS` | `10_000` | The leader re-renews every 10 s (well inside the TTL). |
| `ELECT_MS` | `5_000` | A non-leader re-races for the lease every 5 s. |

**Bounded failover**: if the leader dies ungracefully, its lease expires within
`LEASE_TTL_MS` (≤ 30 s), a waiting replica wins the next 5 s election tick and
opens the socket. There is no two-holder window — the old holder's renew already
fails the moment its token no longer matches.

### The controller loop (per connector)

`startController` runs one timer loop per connector:

1. Not leading → mint a token, `acquireLeaderLease`. On a win: start the
   heartbeat, fold in `runtime.getMetadata()`, then `await runtime.start()`
   (open the socket).
2. Leading → `renewLeaderLease`. If renew returns `false` (lost the lease):
   **demote** — stop the heartbeat FIRST (immediate "down"), then stop the
   socket — and re-enter the race.
3. A fatal `start()` (bad token / disallowed intents) → log, stop the heartbeat,
   **release the lease** so another replica or a fixed redeploy can try, and
   re-race.

### In-process ingest (no HTTP hop)

The engine injects an `ingest(dispatchType, data)` sink into the factory. It
reconstructs the EXACT envelope the HTTP ingress route receives (`{ __t, d }`),
calls `connector.transform(...)` then `ingestEvent(...)` — so the connector's
transform is byte-identical whether a dispatch arrived over HTTP or in-process.
Because the in-process path holds the container, it passes `client.analytics`
into `ingestEvent` (the HTTP route omits it), so a Discord-keyed contact merge
also stitches the analytics person.

---

## `createWorker({ connectorRuntimes })`

The runtime is wired through the worker factory. From the consumer's
`src/worker.ts`:

```ts
import { createWorker } from "@hogsend/engine";
import { createDiscordRuntime } from "@hogsend/plugin-discord";

const worker = createWorker({
  container,
  journeys,
  connectorRuntimes: { discord: createDiscordRuntime },
});
```

`connectorRuntimes` is `Record<string, ConnectorRuntimeFactory>`, keyed by
connector id. The worker boots the inline runtimes when **all** of:

- `ENABLE_CONNECTOR_RUNTIMES === "true"` (default), **and**
- `CONNECTOR_RUNTIME_HOST === "worker"` (default), **and**
- `connectorRuntimes` is non-empty.

It then calls `startConnectorRuntimes`, which iterates every registered
**gateway**-transport connector (`connectorRegistry.getByTransport("gateway")`)
that has a supplied factory and starts a controller for it. The runtimes start
AFTER the worker heartbeat and BEFORE the blocking `_worker.start()` (anything
after that call is dead code until shutdown).

### The `ConnectorRuntimeFactory` interface

A platform plugin supplies a factory matching this contract
(`packages/engine/src/connectors/runtime.ts`):

```ts
type ConnectorRuntimeFactory = (deps: ConnectorRuntimeDeps) => ConnectorRuntime | null;

interface ConnectorRuntime {
  start(): Promise<void>;        // open the socket; reject loudly on bad token/intents
  stop(): Promise<void>;         // close the socket + clear timers (awaited on demotion/shutdown)
  getMetadata(): Record<string, unknown>;  // platform metadata folded into the heartbeat (e.g. { intents })
}

interface ConnectorRuntimeDeps {
  ingest(dispatchType: string, data: unknown): Promise<{ ok: boolean; status: number }>;
  onMetadata(patch: Record<string, unknown>): void;  // fold a late-observed field (e.g. guildId) into the live heartbeat
  logger: Logger;
}
```

**A factory returns `null` when it is not configured to run here.**
`createDiscordRuntime` returns `null` when `DISCORD_BOT_TOKEN` is unset (it reads
its own platform env — the engine never reads `DISCORD_BOT_TOKEN`, keeping the
boundary provider-neutral). When the factory returns `null` the engine skips the
connector cleanly: no lease held, no heartbeat written, dashboard stays
truthfully Offline. `discord.js` is dynamically imported only inside the
worker's `start()`, so enabling the runtime without the optional peer dep fails
loudly at start, not at module load.

The Discord runtime also folds the guild id (observed at `GUILD_CREATE`) into the
heartbeat via `onMetadata({ guildId })`, and reports `{ intents }` from
`getMetadata()`.

### Shutdown ordering

`worker.stop()` (SIGTERM/SIGINT) deletes the worker heartbeat, then calls the
runtimes' `stop()` — which releases every lease and **deletes the heartbeats
BEFORE stopping the sockets** — all before the Redis connection is torn down.
Heartbeat-first means the dashboard reads "Offline" the instant a replica begins
a graceful exit, rather than waiting out the TTL.

---

## Environment switches

| Variable | Default | Meaning |
| --- | --- | --- |
| `ENABLE_CONNECTOR_RUNTIMES` | `true` | Master on/off. A `z.enum(["true","false"])` (NOT `z.coerce.boolean`, so an explicit `"false"` actually disables it). Set `false` to keep the socket off entirely. |
| `CONNECTOR_RUNTIME_HOST` | `worker` | Which already-deployed process hosts the inline runtime. `worker` (default, the committed home); `standalone` defers to the advanced `discord-worker` hatch; `api` is reserved (host it yourself via `startConnectorRuntimes`). |
| `DISCORD_BOT_TOKEN` | _unset_ | Read by `createDiscordRuntime`. Absent ⇒ the factory returns `null` ⇒ Discord runtime is skipped. Must also have the SERVER MEMBERS / MESSAGE CONTENT / PRESENCE privileged intents enabled in the Discord portal, or `login()` rejects with a disallowed-intents error. |

There is no `connectorRuntimes` plumbing cost for a deploy that configures
nothing: no gateway connector, no factory, or a factory that declines all no-op
cleanly.

---

## Heartbeat + readiness

`packages/engine/src/lib/connector-heartbeat.ts` is the connector-neutral
liveness signal. Only the lease-holder writes it, so a fresh key means "this
deployment's elected leader owns the socket" — liveness is **owned**, not merely
observed. A stray process can no longer light the dashboard green.

- **Key**: `hogsend:connector-runtime:<connectorId>:heartbeat`
  (e.g. `hogsend:connector-runtime:discord:heartbeat`).
- **Write cadence**: once immediately on lease win, then every `REFRESH_MS`
  (**10 s**) with a `TTL_SECONDS` (**30 s**) expiry. An ungraceful death or a
  lost lease reads back as "down" within the TTL.
- **Payload**: `{ lastSeenAt: <ISO>, metadata?: { guildId?, intents?, … } }`.
  `metadata` is an opaque platform blob the runtime folds in; a `setMetadata`
  patch is read-merge-write and flushed immediately so Studio reflects a
  late-observed field (the guild id at `GUILD_CREATE`) without waiting for the
  next refresh tick.
- **Read**: `getConnectorHeartbeat(connectorId)` → `{ alive, lastSeenAt?,
  metadata? }`. Resolves `{ alive: false }` when the key is missing or Redis is
  unreachable. Everything is best-effort: a missing/unreachable Redis never
  crashes the runtime.

### What `workerOnline` really means

The admin `connect-info` projection
(`GET /v1/admin/connectors/discord/connect-info`) sets `workerOnline:
heartbeat.alive` and `workerLastSeenAt` from this heartbeat. The
`GET /v1/admin/connectors` catalog exposes the same as `gateway.workerHealthy`
+ `gateway.workerLastSeenAt`.

**`workerOnline` means: a lease-holder for this connector's socket exists right
now.** It is NOT "the worker service is up" in general — a worker can be running
and healthy while `workerOnline` is `false` because it is a lease LOSER (another
replica holds the socket), or because the connector is not configured to run
(no bot token ⇒ factory returned `null`). It is the answer to "is the bot's
Gateway socket live somewhere in this deployment", which is exactly the
operationally useful question.

### Legacy heartbeat fallback (one minor)

For `connectorId === "discord"` only, `getConnectorHeartbeat` falls back to the
legacy standalone-worker key `hogsend:discord-gateway:heartbeat` (written by the
old `discord-worker.ts` hatch) and normalizes its `{ lastSeenAt, guildId?,
intents? }` shape into the connector-neutral one. This keeps a mid-rollout
deploy — where the old standalone worker is still the writer — showing green
until the inline runtime takes over. It is a READ-only fallback, slated for
removal.

---

## Connector-agnostic generality

Nothing in the runtime, the lease, or the heartbeat is Discord-specific. Adding a
second gateway connector (e.g. Slack) is a plugin-only change with **zero engine
edits**:

1. `defineConnector({ meta: { id: "slack", transport: "gateway", … }, transform })`
   in `@hogsend/plugin-slack` — `transform` maps a Slack dispatch to an
   `IngestEvent`.
2. A `ConnectorRuntimeFactory` (`createSlackRuntime`) that opens the Slack
   socket and forwards dispatches to `deps.ingest(...)`, returning `null` when
   its own platform env (e.g. `SLACK_APP_TOKEN`) is unset.
3. The consumer registers the connector
   (`createHogsendClient({ connectors })`) and passes the factory
   (`createWorker({ connectorRuntimes: { discord: …, slack: createSlackRuntime } })`).

The engine then reuses verbatim: the lease keyed by `slack`
(`hogsend:connector-runtime:slack:leader`), the heartbeat key
(`hogsend:connector-runtime:slack:heartbeat`), and the admin catalog projection
(any gateway-transport connector shows up in `GET /v1/admin/connectors` with its
`gateway` block). The plugin writes a connector + a factory and touches no engine
code.

---

## Outbound actions

Outbound (the runtime can SEND, not just receive) is fully independent of the
inbound socket. A deployment with the gateway off — or one that is a lease loser
("Worker Offline" for that replica) — can still send, because Discord actions are
bot-REST and need only the bot token, no socket.

- **`sendConnectorAction({ connectorId, action, args })`**
  (`packages/engine/src/lib/connector-actions.ts`) — the standalone, socket-free
  counterpart to `sendEmail()`. Single-object-in, result-out, NOT on
  `JourneyContext` (features are standalone imports). It resolves the action
  from the registry and runs it with a `resolveContact(ref)` helper that matches
  a contact by email / external id / discord snowflake. Throws when the action
  isn't registered — wire actions via
  `createHogsendClient({ connectorActions })`.

- **`discordActions`** (from `@hogsend/plugin-discord`) — the array of every
  Discord outbound action, passed to
  `createHogsendClient({ connectorActions: discordActions })`. The actions:

  | Action | Args type | Sends |
  | --- | --- | --- |
  | `sendChannelMessage` | `SendChannelMessageArgs` | one message to a channel |
  | `broadcastToChannel` | `BroadcastToChannelArgs` | a broadcast message to a channel |
  | `mentionMembers` | `MentionMembersArgs` | a message that @-mentions members |
  | `mentionRole` | `MentionRoleArgs` | a message that @-mentions a role |
  | `dmMember` | `DmMemberArgs` → `DmResult` | a direct message to a member |

  Invoke from a journey/workflow:

  ```ts
  import { sendConnectorAction } from "@hogsend/engine";

  await sendConnectorAction({
    connectorId: "discord",
    action: "sendChannelMessage",
    args: { channelId: "…", content: "…" },
  });
  ```

---

## Deprecation: the standalone ingress path

Before the inline runtime, a SEPARATE standalone gateway worker forwarded each
dispatch over HTTP to `POST /v1/connectors/discord/ingress`, authenticated by a
shared `CONNECTOR_INGRESS_SECRET`. **In the default path (`CONNECTOR_RUNTIME_HOST=worker`)
that hop no longer exists** — transform→ingest runs in process.

| Thing | Status |
| --- | --- |
| `CONNECTOR_INGRESS_SECRET` (env) | **Legacy.** Only used by the standalone hatch (`CONNECTOR_RUNTIME_HOST=standalone`). The default worker-hosted runtime ignores it. Still fail-closed (the ingress route 401s when unset) for the standalone path. |
| `POST /v1/connectors/:id/ingress` (route) | **Legacy.** The HTTP ingress hop. Not used by the default inline runtime. Kept for the standalone host mode. |
| `connect-info.ingressSecretConfigured` (admin field) | **Stale as a readiness signal.** It keys on `CONNECTOR_INGRESS_SECRET`, which is unset in the default path — so it reports `false` even on a fully healthy worker-hosted deploy. **Advisory only; do not gate readiness on it.** Use `workerOnline` instead. Slated for rename. |

For worker-hosted readiness, the signal to watch is `workerOnline` (the
connector heartbeat), NOT `ingressSecretConfigured`.

---

## Operator runbook

### Default (recommended) deploy — worker-hosted inline runtime

1. **Set the bot env** on the worker service:
   - `DISCORD_BOT_TOKEN` — Discord portal → Bot tab → Reset Token. Enable the
     three privileged gateway intents (SERVER MEMBERS, MESSAGE CONTENT,
     PRESENCE) or `login()` rejects.
   - `DISCORD_APPLICATION_ID`, `DISCORD_PUBLIC_KEY`, `DISCORD_CLIENT_SECRET` —
     for the connector registration + the HTTP interactions/OAuth legs (these
     live on the API service; the bot token lives on the worker).
   - Leave `ENABLE_CONNECTOR_RUNTIMES` and `CONNECTOR_RUNTIME_HOST` at their
     defaults (`true` / `worker`). You do **not** need `CONNECTOR_INGRESS_SECRET`.
2. **Wire the factory** in the consumer's `src/worker.ts`:
   `createWorker({ …, connectorRuntimes: { discord: createDiscordRuntime } })`.
3. **Deploy.** On a lease win the worker logs `Connector runtime acquired lease;
   opening socket` then `Connector runtimes started`. With N worker replicas,
   exactly one opens the socket; the rest idle and stand by for failover.
4. **Verify readiness** (against the API service):
   ```bash
   curl -s "https://t.hogsend.com/v1/admin/connectors/discord/connect-info" \
     -H "Authorization: Bearer ${ADMIN_API_KEY}" | jq '{workerOnline, workerLastSeenAt}'
   ```
   `workerOnline: true` ⇒ a lease-holder owns the socket. Or read the heartbeat
   key directly: `GET hogsend:connector-runtime:discord:heartbeat` in Redis (a
   fresh value, ≤ 30 s old, means alive).
5. **Trigger a real event** (post a message in a channel the bot can see) and
   confirm a `discord.message_sent` row lands in `user_events` and a
   `discord_id`-keyed contact appears (read with YOUR OWN DB client).

### Standalone deploy (advanced hatch)

Set `CONNECTOR_RUNTIME_HOST=standalone` and run the `discord-worker` entry as a
separate process. That mode DOES use `CONNECTOR_INGRESS_SECRET` and the
`POST /v1/connectors/discord/ingress` HTTP hop — the same secret must be set on
both the API (ingress route) and the standalone worker (forward header). See
`docs/discord-e2e.md` for the full local standalone runbook.

### Disabling the runtime

Set `ENABLE_CONNECTOR_RUNTIMES=false` on the worker. The socket never opens, no
lease is held, no heartbeat is written, and `workerOnline` reads `false`.
Outbound `sendConnectorAction` still works (bot-REST, no socket).

---

## Consumer-routes spec — the `hogsend connect discord` storage routes

`hogsend connect discord` (`packages/cli/src/lib/connect-discord-flow.ts`) drives
the one-time portal-paste flow. It calls two routes the engine does **not** ship
(the engine carries no Discord secrets code — provider-neutral boundary), so they
are **consumer-mounted by design**:

- `PUT /v1/admin/connectors/discord/secrets` — stores the four pasted values.
- `POST /v1/admin/connectors/discord/wire` — PATCHes the interactions endpoint
  URL onto the Discord application.

Until a consumer mounts them, the CLI 404s at the storage step
(`PUT …/secrets`). The engine already provides every helper these handlers need
(published at `@hogsend/*@0.24.0` — independent of the unpublished runtime):
`saveDerivedCredential` / `getDerivedCredential`
(`packages/engine/src/lib/provider-credentials.ts`) and, from
`@hogsend/plugin-discord`, `patchApplication`
(`packages/plugin-discord/src/connect/patch-application.ts`).

The dogfood **ships both routes** in
`hogsend-dogfood/src/discord-admin-routes.ts`
(`registerDiscordAdminRoutes`), mounted from `src/index.ts` via
`createApp(client, { routes: registerDiscordAdminRoutes })`. The consumer-app
reference is [`connect-discord-consumer-routes.md`](./connect-discord-consumer-routes.md).

> Admin guard. The engine's `requireAdmin` middleware is internal — it is NOT
> re-exported from `@hogsend/engine` (nor is `requireApiKey` / `hashApiKey` /
> `isLoopbackPublicUrl`). `AppEnv` IS exported, so the consumer guard reads the
> container off the Hono context. The dogfood's guard mirrors the engine's
> `requireAdmin` exactly: an `Authorization: Bearer <key>` is checked against env
> `ADMIN_API_KEY` first, then against a hashed `api_keys` row
> (`sha256` hex, revoked/expired rejected); with no Bearer header it falls back
> to a Better-Auth session (the Studio cookie path). The CLI sends
> `Authorization: Bearer ${ADMIN_API_KEY}`, so the env-key branch is the live
> CLI path. Reject with `401` otherwise.

### Route 1 — `PUT /v1/admin/connectors/discord/secrets`

Stores the four Discord values into the encrypted derived-credential store.

- **Body** (the CLI sends, see `connect-discord-flow.ts`):
  `{ appId, publicKey, botToken, clientSecret }`. The shipped handler reads the
  app id from **either** `appId` or `applicationId`
  (`readField(body, "applicationId", "appId")`). Map onto
  `DerivedCredentialPayload` fields: app id `→ discordAppId`,
  `publicKey → discordPublicKey`, `botToken → discordBotToken`,
  `clientSecret → discordClientSecret`.
- **Read-merge-write.** `saveDerivedCredential` is a dumb full-payload overwrite,
  so read the existing derived credential first
  (`getDerivedCredential(db, "discord")`), spread it, then overwrite the Discord
  fields — otherwise you clobber a previously seeded `discordGuildId`.
  ```ts
  const existing = (await getDerivedCredential(db, "discord")) ?? {};
  await saveDerivedCredential(db, "discord", {
    ...existing,
    discordAppId: body.appId,
    discordPublicKey: body.publicKey,
    discordBotToken: body.botToken,
    discordClientSecret: body.clientSecret,
  });
  ```
- **Secret hygiene** — NEVER log the body or any token. Status-only logging.
- **Response**: `{ ok: true }`.

After this stores the app id, `connect-info.installUrl` becomes non-null (the
server mints the one-click install URL with a signed CSRF state) and
`credentialStored` reads `true`.

### Route 2 — `POST /v1/admin/connectors/discord/wire`

PATCHes the application's interactions endpoint URL so Discord can deliver
interaction PINGs.

- **Resolve the bot token** from the just-stored derived credential
  (`discordBotToken`) or fall back to env `DISCORD_BOT_TOKEN`.
- **Build the interactions URL**: `${API_PUBLIC_URL}/v1/connectors/discord/interactions`
  (e.g. `https://t.hogsend.com/v1/connectors/discord/interactions`).
- **Refuse on loopback.** Discord validates `interactions_endpoint_url` by
  synchronously PINGing it during the PATCH — it cannot reach `localhost`. When
  `API_PUBLIC_URL` is a loopback host, return `409` with body
  `{ error: "api_public_url_unreachable" }` (the CLI special-cases that exact
  body) and do NOT call Discord.
- **Call** `patchApplication({ botToken, interactionsEndpointUrl, applicationId? })`.
  It does `PATCH https://discord.com/api/.../applications/@me` with
  `Authorization: Bot <token>`. It already throws a status-only error on failure
  and never echoes the Discord response body (which can carry the token) — keep
  your own logging status-only too.
- **Response**: `200` on success.

### Mounting

The dogfood factors both routes into a single registrar
(`hogsend-dogfood/src/discord-admin-routes.ts`, exporting
`registerDiscordAdminRoutes`) and passes it as the `routes` callback. It mounts
**unconditionally** (not gated on the Discord env), so the CLI never 404s
regardless of how the instance is configured:

```ts
// hogsend-dogfood/src/index.ts
import { registerDiscordAdminRoutes } from "./discord-admin-routes.js";

const app = createApp(client, {
  webhookSources,
  routes: registerDiscordAdminRoutes,
});
```

The registrar uses plain `app.put` / `app.post` (NOT `.openapi(...)`), which
keeps the secret request bodies out of `/openapi.json`. The handlers read
`{ db, env, auth, logger }` off `c.get("container")`, so they share the engine's
encrypted-at-rest derived store. For projection-side conventions (reads only,
never surfaces token material) see
`packages/engine/src/routes/admin/connectors.ts`.

### Running the CLI (routes are mounted in the dogfood)

```bash
cd packages/cli && env ADMIN_API_KEY=<admin-key> \
  pnpm exec tsx src/bin.ts connect discord --url https://t.hogsend.com
```

The CLI prompts for the four portal values, `PUT`s them to `/secrets`, re-reads
`connect-info` for the server-minted install URL, `POST`s `/wire` (unless
`API_PUBLIC_URL` is loopback, in which case it defers with a "secrets stored, not
wired" verdict), then opens the install URL and captures the guild id.
