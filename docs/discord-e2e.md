# Discord connector — local end-to-end runbook

Verify the inbound Discord connector locally: a real message / reaction / join in
a real Discord server arrives over the Gateway socket, is forwarded to the
engine's ingress, and lands as an `IngestEvent` in `user_events` (plus a
`contacts.properties.discord` metadata object).

This is a reusable playbook. Tunnel URLs, tokens, ids, and ports are
per-session — never hardcode values from a prior run.

`apps/api` is the in-repo consumer (workspace deps, no npm publish) and is the
local E2E target. Everything below runs on your laptop against a cloudflared
quick tunnel and one real Discord application.

---

## What the chain proves

```
real Discord activity
  → discord.js Gateway socket (apps/api discord-worker, its OWN process)
  → POST ${API_PUBLIC_URL}/v1/connectors/discord/ingress   (x-hogsend-ingress-secret)
  → connector.transform(...)  →  ingestEvent(...)
  → user_events row + contacts (discord_id key + properties.discord metadata)
```

The four mapped dispatches and the event name each becomes:

| Discord activity        | dispatch              | ingest event              |
| ----------------------- | --------------------- | ------------------------- |
| message in a channel    | `MESSAGE_CREATE`      | `discord.message_sent`    |
| reaction added          | `MESSAGE_REACTION_ADD`| `discord.reaction_added`  |
| member joins the server | `GUILD_MEMBER_ADD`    | `discord.member_joined`   |
| member comes online     | `PRESENCE_UPDATE`     | `discord.presence_active` |

---

## Two legs, two fidelities

The connector has two independent inbound legs. Pick what you need.

### Leg A — Gateway → ingress (the core E2E; works today, env-only)

A real message lands as an `IngestEvent`. Needs **only env** — no `hogsend
connect discord`, no derived credential, no consumer routes:

- API process registers the connector from `DISCORD_APPLICATION_ID` +
  `DISCORD_CLIENT_SECRET` + `DISCORD_PUBLIC_KEY` (see `apps/api/src/discord.ts`
  `buildDiscordConnector` — returns `undefined`, registering nothing, when any
  of the three is unset).
- The ingress route (`POST /v1/connectors/discord/ingress`) authenticates on
  `CONNECTOR_INGRESS_SECRET` and runs the connector's `transform` — it reads no
  stored credential.
- The standalone gateway worker logs in with `DISCORD_BOT_TOKEN` and forwards
  every mapped dispatch to the ingress.

This is the leg the rest of this runbook drives end-to-end.

### Leg B — OAuth: interactions PING, one-click install, member-link

All three work env-only. The interactions PING/PONG handshake verifies the
signature with `DISCORD_PUBLIC_KEY`, so pasting the Interactions Endpoint URL in
the portal validates. The **one-click install URL** and the **member-link URL**
are server-minted from `discordAppId` stored in the **derived credential**
(`provider_credentials`, `kind="derived"`), and `apps/api` seeds that row from
env at boot:

- `apps/api/src/discord.ts` `seedDiscordDerived(db)` read-merge-writes
  `derived.discordAppId` from `DISCORD_APPLICATION_ID`, and
  `apps/api/src/index.ts` calls it whenever a Discord connector was built.
- So `GET /v1/admin/connectors/discord/connect-info` returns a non-null
  `installUrl`, and `POST /v1/admin/connectors/discord/member-link-url` returns
  `200` — both are engine-shipped routes that mount automatically.
- The OAuth callback (`GET|POST /v1/connectors/discord/oauth/callback`) handles
  both install and member-link.

> **One residual CLI-only capability.** The CLI `wire` route's server-side
> `PATCH /applications/@me` — which auto-sets the Interactions Endpoint URL for
> you — is the only piece `apps/api` does not mount. On an env-only deploy you
> set the Interactions Endpoint URL yourself in the portal (Step 3). Everything
> else in Leg B — install URL, member-link URL, OAuth callback — is reachable
> env-only.

---

## Prerequisites

- Docker (TimescaleDB + Redis + Hatchet-Lite).
- `cloudflared` (`brew install cloudflared`) — the API must be publicly
  reachable so Discord can PING the interactions endpoint and the worker can
  reach ingress. (Already at `/opt/homebrew/bin/cloudflared` on this machine.)
- A Discord account that can create an application and a server (guild) you own.
- Node 22, `pnpm` deps installed (`pnpm install` at the repo root).

Local infra host ports (from `docker-compose.yml`): Postgres **5434**, Redis
**6380**, Hatchet-Lite gRPC **7077**, dashboard **8888**. If you ran
`pnpm bootstrap`, it may have remapped busy host ports — read the actual values
out of the generated `apps/api/.env` rather than assuming these.

---

## Step 0 — Discord Developer Portal (one-time)

https://discord.com/developers/applications → **New Application**.

Collect these four values (they map 1:1 to `apps/api/.env.discord.example`):

- **Bot** tab → **Reset Token** → `DISCORD_BOT_TOKEN`.
  On the same tab, enable the three **Privileged Gateway Intents**:
  **SERVER MEMBERS**, **MESSAGE CONTENT**, **PRESENCE**. If any is off,
  `login()` rejects with a disallowed-intents error and the worker exits.
- **OAuth2** tab → **Client ID** (= the General Information **Application ID**)
  → `DISCORD_APPLICATION_ID`.
- **OAuth2** tab → **Client Secret** (Reset Secret to reveal) →
  `DISCORD_CLIENT_SECRET`.
- **General Information** tab → **Public Key** → `DISCORD_PUBLIC_KEY`.

You will paste the two URLs below into the portal AFTER the tunnel is up
(Step 3) — they depend on the tunnel URL.

---

## Step 1 — Infra up + LOCAL migrate

```bash
docker compose up -d
```

Run the engine-track migration **yourself** — the API refuses to boot when the
schema is behind:

```bash
pnpm --filter @hogsend/db db:migrate
```

> The operator runs `db:migrate`. This runbook never runs migrations, `db:push`,
> `db:studio`, or any DB query on your behalf.

---

## Step 2 — Fill apps/api/.env

Start from the two example files:

- `apps/api/.env.example` — the canonical engine contract (Postgres, Redis,
  Hatchet, `BETTER_AUTH_SECRET`, `ADMIN_API_KEY`, etc.). It already documents the
  `DISCORD_*` block + `CONNECTOR_INGRESS_SECRET` + the tunnel note.
- `apps/api/.env.discord.example` — the Discord-only vars, each annotated with
  exactly where it comes from in the portal.

Into `apps/api/.env`, set (host-process dev port regime — services on their
host-mapped ports):

```ini
DATABASE_URL=postgresql://growthhog:growthhog@localhost:5434/growthhog
REDIS_URL=redis://localhost:6380
HATCHET_CLIENT_HOST_PORT=localhost:7077
HATCHET_CLIENT_TLS_STRATEGY=none
HATCHET_CLIENT_TOKEN=<from the hatchet-lite dashboard at http://localhost:8888>
BETTER_AUTH_SECRET=<pnpm gen:secret>
ADMIN_API_KEY=<any-admin-key>            # only needed for Leg B / admin routes

# Discord (Leg A — env-only inbound):
DISCORD_BOT_TOKEN=<Bot tab -> Reset Token>
DISCORD_APPLICATION_ID=<OAuth2 -> Client ID>
DISCORD_CLIENT_SECRET=<OAuth2 -> Client Secret>
DISCORD_PUBLIC_KEY=<General Information -> Public Key>
CONNECTOR_INGRESS_SECRET=<openssl rand -base64 32>   # >=32 chars, fail-closed

# API_PUBLIC_URL is set in Step 3 once the tunnel URL is known.
```

`CONNECTOR_INGRESS_SECRET` is read by BOTH the API (ingress route) and the
gateway worker (forward header). They must be the SAME value.

---

## Step 3 — Start the tunnel and set API_PUBLIC_URL

Start a public quick tunnel to the API port (3002). Two ways:

**Manual:**

```bash
cloudflared tunnel --config /dev/null --protocol http2 --url http://localhost:3002
```

- `--config /dev/null` is REQUIRED — `~/.cloudflared/config.yml` exists on this
  machine, and without this flag the quick tunnel inherits its catch-all ingress
  and 404s everything (tell: a 404 with `server: cloudflare` and no app headers).
- `--protocol http2` is more stable than the default QUIC for trycloudflare.

Capture the printed `https://<random>.trycloudflare.com`.

**Or the optional helper** (starts the tunnel and prints the portal URLs for
you — needs no token, writes nothing):

```bash
scripts/discord-tunnel.sh                # tunnel to localhost:3002
# PORT=3055 scripts/discord-tunnel.sh    # a different local port
```

Now set the tunnel URL in `apps/api/.env` BEFORE booting the API (every
connect/redirect/interactions/ingress URL derives from it; it must NOT be
loopback):

```ini
API_PUBLIC_URL=https://<random>.trycloudflare.com
```

Back in the portal, add (parameterized by your tunnel URL `${TUNNEL}`):

- **OAuth2 → Redirects** → `${TUNNEL}/v1/connectors/discord/oauth/callback`
- **Interactions Endpoint URL** → `${TUNNEL}/v1/connectors/discord/interactions`

Discord PINGs the interactions endpoint **synchronously when you click Save** —
the API (Step 4) must already be running behind the tunnel, or the save fails.
A successful save is the proof that env-only interaction-signature verification
(via `DISCORD_PUBLIC_KEY`) works.

---

## Step 4 — Boot the API

```bash
pnpm --filter @hogsend/api dev
# or: cd apps/api && pnpm dev
```

On boot you should see the connector registered (it is silent when configured;
it is only skipped when the three Discord app vars are unset). Confirm the public
URL resolves and the connect-info projection is sane:

```bash
curl -s "${TUNNEL}/v1/health" | jq .
curl -s "${TUNNEL}/v1/admin/connectors/discord/connect-info" \
  -H "Authorization: Bearer ${ADMIN_API_KEY}" | jq .
```

`connect-info` should report `ingressSecretConfigured: true` and
`apiPublicUrlReachable: true`. `installUrl` is **non-null** — `apps/api` seeds
`derived.discordAppId` from `DISCORD_APPLICATION_ID` at boot
(`seedDiscordDerived`), so the install URL and the member-link URL both work
env-only (Leg B). `credentialStored: false` is still expected for Leg A: it
tracks the full secrets bundle, not the seeded app id.

Now save the Interactions Endpoint URL in the portal (Step 3) — with the API up
behind the tunnel, the validation PING returns a signed PONG and Discord accepts
it.

---

## Step 5 — Start the Discord gateway worker

A SEPARATE long-lived process (not the API, not the Hatchet worker). It opens
the discord.js socket and forwards mapped dispatches to ingress.

```bash
pnpm --filter @hogsend/api discord:dev
# production-style:  pnpm --filter @hogsend/api discord:worker  (after pnpm --filter @hogsend/api build)
```

It fails loudly if `DISCORD_BOT_TOKEN` or `CONNECTOR_INGRESS_SECRET` is missing.
On a healthy connect you'll see:

```
discord gateway worker connected
```

If you instead see a disallowed-intents rejection, go back to the Bot tab and
toggle on SERVER MEMBERS / MESSAGE CONTENT / PRESENCE.

**Invite the bot to your server** so it can see events. Two options: open the
server-minted one-click install URL from
`GET /v1/admin/connectors/discord/connect-info` (`installUrl`, non-null env-only
— see Leg B), or build a minimal invite by hand and open it in a browser
(replace `<APP_ID>`):

```
https://discord.com/oauth2/authorize?client_id=<APP_ID>&scope=bot&permissions=0
```

Pick your test server and authorize. The bot only needs to be a member of a
channel to receive `MESSAGE_CREATE` / reactions there.

---

## Step 6 — Trigger a real event and verify

In your Discord server, in a channel the bot can see, do any of:

- **post a message** → `discord.message_sent`
- **add a reaction** to a message → `discord.reaction_added`
- **have someone join** the server → `discord.member_joined`
- **come online** (presence) → `discord.presence_active`

Watch the chain light up:

1. **Gateway worker log** — the forward is silent on success; a non-2xx prints
   `discord ingress forward non-2xx (<status>) for <DISPATCH>`. A 401 here means
   the worker's `CONNECTOR_INGRESS_SECRET` doesn't match the API's.
2. **API log** — `POST /v1/connectors/discord/ingress` returns 200 and
   `ingestEvent` runs.
3. **Database** (read it with YOUR OWN client — this runbook does not query the
   DB for you):

   ```sql
   -- the inbound event landed
   select event, user_id, event_properties, created_at
     from user_events
    where event like 'discord.%'
    order by created_at desc
    limit 5;

   -- discord_id is the resolution KEY; properties->'discord' is the metadata object
   select discord_id, email, properties->'discord' as discord_meta, updated_at
     from contacts
    where discord_id is not null
    order by updated_at desc
    limit 5;
   ```

   `properties->'discord'` (e.g. `{ id, username, last_seen, ... }`) is the
   metadata-object proof. Because the engine deep-merges the `discord` sub-object
   (one level), a later reaction-only event that carries just `last_seen` will
   NOT clobber a `username` captured by an earlier message — confirm by posting a
   message, then reacting, then re-reading the row.

4. **Studio** (optional) — open `/integrations`; the Discord card reflects
   registered connector + (once installed) guild id / member counts via the
   admin connectors catalog.

---

## Teardown

- Stop the gateway worker (Ctrl-C in its terminal).
- Stop the API. If it shares the tunnel's port, kill ONLY the listener so you
  don't drop the tunnel:

  ```bash
  lsof -ti tcp:3002 -sTCP:LISTEN | xargs kill
  ```

- Stop the cloudflared tunnel process (Ctrl-C).
- Optionally remove the local Discord vars from `apps/api/.env`.
- In the Discord portal you can remove the bot from the server and/or delete the
  application when done.

---

## Leg B env-only: install URL + member-link + the one CLI-only piece

On an env-only deploy, `apps/api` seeds `derived.discordAppId` from
`DISCORD_APPLICATION_ID` at boot (`seedDiscordDerived` in
`apps/api/src/discord.ts`, called from `apps/api/src/index.ts` whenever a Discord
connector was built). That is the value that gates the install and member-link
URLs, so both are reachable without the CLI:

1. **Open the one-click install URL.** `connect-info.installUrl` is non-null:

   ```bash
   curl -s "${TUNNEL}/v1/admin/connectors/discord/connect-info" \
     -H "Authorization: Bearer ${ADMIN_API_KEY}" | jq -r .installUrl
   ```

   Open it in a browser to invite the bot; the install callback then captures the
   guild id.

2. **Mint a member-link URL** to attach a `discord_id` to a specific contact:

   ```bash
   curl -s -X POST "${TUNNEL}/v1/admin/connectors/discord/member-link-url" \
     -H "Authorization: Bearer ${ADMIN_API_KEY}" \
     -H "Content-Type: application/json" \
     -d '{"contactId":"<contact-id>","email":"<contact-email>"}' | jq -r .url
   ```

   The user authorizes (`scope=identify email guilds.members.read`) and the
   `GET|POST /v1/connectors/discord/oauth/callback` route attaches `discord_id`
   to the bound contact. Anti-graft: the email comes from the signed state, never
   from the OAuth-reported Discord email.

**The one residual CLI-only capability** is the `wire` route's server-side
`PATCH /applications/@me` that auto-sets the Interactions Endpoint URL for you.
`apps/api` does not mount it (the `secrets` / `wire` admin routes are
consumer-mounted and not added here), so on an env-only deploy you set the
Interactions Endpoint URL **in the portal** (Step 3). To drive that auto-wiring,
a consumer would mount the `secrets` / `wire` routes via
`createApp(client, { routes })` (`DerivedCredentialPayload` already carries the
optional Discord fields — `packages/engine/src/lib/provider-credentials.ts`),
then run:

```bash
cd packages/cli && env ADMIN_API_KEY=<admin-key> \
  pnpm exec tsx src/bin.ts connect discord --url ${TUNNEL}
```
