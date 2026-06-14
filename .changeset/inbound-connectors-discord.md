---
"@hogsend/plugin-discord": minor
"@hogsend/engine": minor
"@hogsend/db": minor
"@hogsend/cli": minor
"@hogsend/studio": minor
"@hogsend/core": minor
"@hogsend/client": minor
"@hogsend/email": minor
"@hogsend/plugin-posthog": minor
"@hogsend/plugin-resend": minor
"@hogsend/plugin-postmark": minor
"hogsend": minor
---

feat(discord): inbound Gateway connector + outbound destination + in-Discord email linking

Adds `@hogsend/plugin-discord` — both faces of one integration under
`meta.id = "discord"`, plus the engine connector subsystem it rides on.

- **Inbound** — a `transport: "gateway"` connector. A separate long-lived
  Gateway worker (`@hogsend/plugin-discord/gateway`, its own process) dials
  Discord and POSTs raw dispatches to `POST /v1/connectors/discord/ingress`
  (header `x-hogsend-ingress-secret`, env `CONNECTOR_INGRESS_SECRET`, ≥32 chars,
  fail-closed). The server-side transform emits `discord.message_sent`,
  `discord.reaction_added`, `discord.member_joined`, and
  `discord.presence_active` into `ingestEvent` — stored in `user_events` and
  upserted onto a contact. Bot/webhook/system messages and offline/absent
  presence are dropped; each event carries a deterministic `idempotencyKey`.
- **Identity** — `contacts.discord_id` is a new indexed merge key (a 4th
  identity Kind, with a partial unique index; migration ships in `@hogsend/db`).
  `contacts.properties.discord` carries `id` and derived first-party `last_seen`
  always, plus observed `username`/`global_name`/`avatar`/`joined_at`/`roles`
  (deep-merged one level, non-clobbering; `null` is never written).
- **In-Discord linking** — `/link` opens an email modal; a valid address mails a
  6-digit single-use code via a transactional template (15-min TTL, bound to the
  invoking Discord user, hashed at rest, rate limited 5/user + 3/email per
  15 min). An "Enter code" button opens a code modal that redeems it and resolves
  the contact via an ephemeral Components-V2 card. `/verify <code>` is the typed
  fallback. Every interaction is ed25519-verified (native `node:crypto`) with a
  ±300s timestamp replay window. A new `connector_link_codes` table backs the
  codes.
- **Outbound** — `discordDestination` posts one Discord-markdown line per
  lifecycle event to a channel on the durable outbound spine. Wire resolution
  prefers the no-bot-token incoming webhook (`config.webhookUrl`, accepts 204),
  falling back to bot-REST (`config.channelId` + `endpoint.secret`).
- **Routes** — the engine adds `/v1/connectors/discord/{ingress,interactions,
  oauth/callback}` (per-IP rate-limited at 60/min except `/ingress` and
  `/interactions`, which are gated by the ingress secret and ed25519+replay
  respectively). `@hogsend/cli` gains a `connect discord` flow; `@hogsend/studio`
  gains a Discord integration view.

The package is consumer-mounted (the engine ships no Discord code; wire it with
`createDiscordConnector` + `createHogsendClient`, and run the Gateway worker as a
separate process). The one-click `hogsend connect discord` install / OAuth
member-link is not wired in the dogfood consumer yet (the consumer-mounted
`secrets`/`wire` admin routes are unmounted), so that CLI path 404s today — the
env-only inbound path and the modal `/link` are the live identity paths.

First npm publish of `@hogsend/plugin-discord` is MANUAL — CI cannot create a
brand-new `@hogsend/*` package.

`contacts.discord_id` (and `connector_link_codes`) are schema changes — run
`db:migrate` before deploying.
