# @hogsend/plugin-discord

Discord integration for Hogsend — both faces of one platform:

- **Inbound** — a `transport: "gateway"` connector (`discordConnector`) that
  turns raw Discord Gateway dispatches (messages, reactions, joins, presence)
  into `IngestEvent`s. The socket itself lives in a separate long-lived worker
  (`@hogsend/plugin-discord/gateway`) that POSTs each dispatch to the connector
  ingress (`POST /v1/connectors/discord/ingress`) so all transform logic stays
  server-side.
- **Outbound** — a `defineDestination` (`discordDestination`) that posts a
  message per lifecycle event to a Discord channel (incoming webhook preferred,
  bot-REST as the alt).

Same `meta.id = "discord"` on both so they read as one integration.

## Install

```bash
pnpm add @hogsend/plugin-discord
# the Gateway worker needs discord.js (an optional peer):
pnpm add discord.js
```

`discord.js` is an **optional peer** — only the `/gateway` subpath imports it.
The engine API process imports `discordConnector` / `discordDestination` /
connect helpers from the main entry and never loads a WebSocket client.

## Wiring (consumer)

```ts
import {
  createDiscordConnector,
  discordDestination,
} from "@hogsend/plugin-discord";
import { resolveOrCreateContact, saveDerivedCredential } from "@hogsend/engine";

const discord = createDiscordConnector({
  applicationId: env.DISCORD_APPLICATION_ID,
  clientSecret: env.DISCORD_CLIENT_SECRET,
  publicKeyHex: env.DISCORD_PUBLIC_KEY,
  redirectUri: `${env.API_PUBLIC_URL}/v1/connectors/discord/oauth/callback`,
  verifyState: (state) => /* verify the CSRF state you minted */,
  saveDerived: (patch) => saveDerivedCredential(db, "discord", patch),
  resolveContact: (patch) => resolveOrCreateContact({ db, ...patch }).then(() => {}),
  studioIntegrationsUrl: `${env.STUDIO_URL}/integrations`,
});

const client = createHogsendClient({
  connectors: [discord],
  destinations: [discordDestination],
});
```

## Gateway worker

A separate Railway service (mirrors `railway.worker.toml`):

```ts
import { createDiscordGatewayWorker } from "@hogsend/plugin-discord/gateway";

const worker = createDiscordGatewayWorker({
  botToken: process.env.DISCORD_BOT_TOKEN!,
  apiPublicUrl: process.env.API_PUBLIC_URL!,
  ingressSecret: process.env.CONNECTOR_INGRESS_SECRET!,
});
process.on("SIGTERM", () => void worker.stop());
process.on("SIGINT", () => void worker.stop());
await worker.start();
```

> The live socket connect loop is `TODO(discord-gateway)` — `start()` throws
> until wired so a misconfigured worker is never silently dead. The
> dispatch→ingress forwarding path (`postToIngress`) is real and correct.

## Secrets & rotation

Discord app secrets are held in **two places**:

1. Encrypted in `provider_credentials` (kind `derived`, providerId `discord`)
   for the API-side connect helpers — written by `hogsend connect discord`.
2. Plain env on the deployed Gateway worker (`DISCORD_BOT_TOKEN`) so it can log
   in without a DB round-trip at boot.

**Rotation runbook** — rotate the bot token in the Discord Developer Portal,
then:

1. Re-run `hogsend connect discord` (re-paste the new token) to update the
   encrypted derived store, **and**
2. Update `DISCORD_BOT_TOKEN` on the Gateway worker service and redeploy it.

Both copies point at the same token; updating only one leaves them drifted.

## Required intents

Toggle ON in the Developer Portal (Bot → Privileged Gateway Intents):
`SERVER MEMBERS`, `PRESENCE`, and `MESSAGE CONTENT`. Without them the Gateway
connection is rejected and message text is empty (`hasContent` reports it).
