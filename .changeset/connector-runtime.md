---
"@hogsend/engine": minor
"@hogsend/plugin-discord": minor
"@hogsend/core": minor
"@hogsend/db": minor
"@hogsend/email": minor
"@hogsend/plugin-posthog": minor
"@hogsend/plugin-resend": minor
"@hogsend/plugin-postmark": minor
"@hogsend/studio": minor
"@hogsend/cli": minor
"@hogsend/client": minor
"hogsend": minor
---

feat(engine): the connector runtime — a worker-hosted, leader-leased inbound gateway socket plus a journey-callable outbound action API.

- **`@hogsend/engine`**: gateway-transport connectors (Discord) now run their long-lived socket **inline inside the Hatchet worker** — no separate service, no `CONNECTOR_INGRESS_SECRET`. A Redis leader lease guarantees exactly one replica holds the socket per bot token, with bounded automatic failover; dispatches feed `transform`→`ingest` in-process, and only the lease-holder writes the (now connector-neutral) liveness heartbeat Studio reads, so "Worker Online / Bot Installed" reflects OWNED liveness a stray process cannot fake. Activation is automatic when a gateway connector + its bot token are present (`ENABLE_CONNECTOR_RUNTIMES`, `CONNECTOR_RUNTIME_HOST=worker` by default). Wire it with `createWorker({ connectorRuntimes: { discord: createDiscordRuntime } })`. The seam is connector-agnostic — a second connector (Slack, …) implements only `defineConnector` + a `ConnectorRuntime` factory and reuses lease election, the heartbeat, and the admin projection unchanged.
- **`@hogsend/engine`**: outbound actions are a separate, socket-free face — `sendConnectorAction({ connectorId, action, args })` (a standalone import, not on `ctx`) invokes registered `defineConnectorAction`s, independent of the inbound socket (a deployment with the gateway off can still send).
- **`@hogsend/plugin-discord`**: ships `createDiscordRuntime` (the gateway runtime factory) and `discordActions` (`sendChannelMessage`, `broadcastToChannel`, `mentionMembers`, `mentionRole`, `dmMember`); register the actions via `createHogsendClient({ connectorActions: discordActions })`. The standalone `discord-worker` entry remains as an advanced escape hatch (`CONNECTOR_RUNTIME_HOST=standalone`).

Additive and opt-in. The remaining engine-line packages are version-only bumps to keep the engine release line uniform (the scaffold pins `^ENGINE_VERSION`).
