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

Full setup and the four event mappings live in the
[Discord integration docs](https://hogsend.com/docs/integrations/discord).

## Inbound events

The server-side connector transform emits these into `ingestEvent()` (stored in
`user_events` + upserts a contact). Bot/webhook/system messages and
offline/absent presence are dropped; each event carries a deterministic
`idempotencyKey` so redelivery dedupes.

| Discord dispatch       | Hogsend event              |
| ---------------------- | -------------------------- |
| `MESSAGE_CREATE`       | `discord.message_sent`     |
| `MESSAGE_REACTION_ADD` | `discord.reaction_added`   |
| `GUILD_MEMBER_ADD`     | `discord.member_joined`    |
| `PRESENCE_UPDATE`      | `discord.presence_active`  |

## Identity

`contacts.discord_id` is a 4th contact identity Kind
(`external | email | anonymous | discord`) — the raw snowflake is the indexed
merge key (partial unique index). The connector also writes
`contacts.properties.discord` (deep-merged one level, non-clobbering): `id` and
`last_seen` always, plus conditional `username`, `global_name`, `avatar`,
`joined_at`, and `roles`. `null` is never written.

`last_seen` is DERIVED first-party (the max of observed event timestamps —
Discord has no last-seen field). Presence is collapsed to "active" (offline and
absent are dropped), so presence is not a last-seen feed.

## The `/link` identity loop

`/link` (no options) opens an email modal. A valid address mails a 6-digit code
via a transactional template; an "Enter code" button then opens a code modal
that redeems it and resolves the contact (the button is the mandatory bridge —
Discord forbids returning a modal from a modal submit). Every step is ephemeral;
no message body echoes the email or code. `/verify <code>` is the typed
fallback.

Codes are single-use (atomic claim), have a 15-min TTL, are bound to the
invoking Discord user (constant-time compare), and are hashed at rest. Throttles:
5 mints/user + 3 mints/email per 15-min window (engine); an optional consumer
Redis throttle of 10 `/verify` attempts/user/15 min (fail-open). Every
interaction is ed25519-verified (native `node:crypto`, fail-closed) with a ±300s
timestamp replay window.

## Routes

The engine mounts these under `/v1/connectors/discord`:

| Route                                       | Purpose                                          | Auth                                                          |
| ------------------------------------------- | ------------------------------------------------ | ------------------------------------------------------------ |
| `POST /v1/connectors/discord/ingress`       | Gateway worker posts raw dispatches              | `x-hogsend-ingress-secret` header (= `CONNECTOR_INGRESS_SECRET`, ≥32 chars, fail-closed) |
| `POST /v1/connectors/discord/interactions`  | Discord HTTP interactions (slash/modal/button)   | ed25519 signature + ±300s replay window                      |
| `GET\|POST /v1/connectors/discord/oauth/callback` | OAuth install + member-link (not wired in apps/api) | signed CSRF `state`, engine-verified                         |

`/v1/connectors/*` is per-IP rate-limited (60/min) EXCEPT `/ingress` and
`/interactions` (exempt — gated by the ingress secret and ed25519+replay).

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

All callbacks below are required (only `recordVerifyAttempt` is optional). The
consumer injects the engine helpers so the plugin never reaches into the engine
itself — see `apps/api/src/discord.ts` for the full reference wiring.

```ts
import {
  createLinkCode,
  getDerivedCredential,
  getEmailService,
  redeemLinkCode,
  resolveOrCreateContact,
  saveDerivedCredential,
} from "@hogsend/engine";
import {
  createDiscordConnector,
  discordDestination,
} from "@hogsend/plugin-discord";

const base = env.API_PUBLIC_URL.replace(/\/$/, "");

const discord = createDiscordConnector({
  applicationId: env.DISCORD_APPLICATION_ID,
  clientSecret: env.DISCORD_CLIENT_SECRET,
  publicKeyHex: env.DISCORD_PUBLIC_KEY,
  redirectUri: `${base}/v1/connectors/discord/oauth/callback`,
  // Studio's SPA is mounted at /studio, so its integrations page lives at
  // /studio/integrations (NOT /integrations, which 404s at the API root).
  studioIntegrationsUrl: `${base}/studio/integrations`,
  // Read-merge-write — the derived store is a full-payload OVERWRITE.
  saveDerived: async (patch) => {
    const current = (await getDerivedCredential(db, "discord")) ?? {};
    await saveDerivedCredential(db, "discord", { ...current, ...patch });
  },
  // Route the snowflake through the `discord` identity Kind; `email` is the
  // engine-verified address the link was issued for (never the OAuth email).
  resolveContact: async (patch) => {
    await resolveOrCreateContact({
      db,
      discordId: patch.discordId,
      email: patch.email,
      contactProperties: patch.contactProperties,
    });
  },
  // Mint a single-use code — the anti-email-bomb throttle runs FIRST inside
  // createLinkCode; over-cap returns { ok: false } with no mint.
  mintCode: async ({ discordUserId, email }) => {
    const r = await createLinkCode({
      db,
      connectorId: "discord",
      platformUserId: discordUserId,
      email,
    });
    return r.ok ? { ok: true, code: r.code } : { ok: false, reason: "throttled" };
  },
  // TRANSACTIONAL send — skipPreferenceCheck so a code is NEVER dropped by an
  // unsubscribe or frequency cap.
  sendLinkCode: async ({ email, code }) => {
    await getEmailService().send({
      template: "transactional/discord-link-code",
      props: { code },
      to: email,
      userId: email,
      userEmail: email,
      subject: "Your Discord verification code",
      category: "transactional",
      skipPreferenceCheck: true,
    });
  },
  // Redeem — single-use (atomic claim), TTL-enforced, identity-bound.
  redeemCode: ({ discordUserId, code }) =>
    redeemLinkCode({
      db,
      connectorId: "discord",
      platformUserId: discordUserId,
      code,
    }),
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

`start()` dynamically imports `discord.js`, logs in with the bot token, and
forwards every raw Gateway dispatch to the ingress via `forwardDispatch`
(`{ __t, d }` wrapping over `postToIngress`). It fails loudly: `login()` rejects
(and the rejection propagates out of `start()`) on a bad token or a requested
privileged intent that is not toggled in the portal, so a misconfigured worker
is never silently dead. discord.js owns heartbeat / RESUME / reconnect /
sharding.

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
Under 10k users / 100 guilds these three are a self-serve portal toggle (no
Discord review). Each self-hosted deploy runs its own Discord app (single
tenant).

## Caveats

- The bot must be a guild member to receive a channel's events.
- Presence is not last-seen (offline/absent dropped; `last_seen` is derived).
- The one-click install + OAuth member-link (`hogsend connect discord`) is NOT
  wired in `apps/api` yet — the consumer-mounted `secrets`/`wire` admin routes
  are unmounted, so that CLI 404s today. Use the env-only inbound path
  (Gateway → ingress) and the modal `/link` for identity.
- First npm publish of this package is MANUAL — CI cannot create a brand-new
  `@hogsend/*` package.
