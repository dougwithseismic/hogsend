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

`/link` (no options) opens an email modal. A valid address mints a server-sealed
[cold-connect](https://hogsend.com/docs) confirm token and emails a one-click
confirm LINK (no typed code) via a transactional template, then PATCHes a
button-less "check your inbox" message. There is NO `/verify` step — the
email-link click IS the bind.

Clicking the link lands the user on the engine-served connect page
(`GET /connect/discord`, mounted by the consumer's `discordColdConnect.routes`);
the page's button POST runs the exchange: `ingestEvent` folds `discord_id` +
email onto ONE contact, the consumer's `afterBind` grants the verified role, and
the page client-identifies (`posthog.identify(contactKey, { discord_id })`).
Every Discord step is ephemeral; no message body echoes the email, and the
confirm token never rides in a `custom_id`, a rendered message, or a log.

The anti-email-bomb throttle (Redis-INCR, fail-closed) lives INSIDE the engine's
cold-connect `mintConfirm`, so the plugin no longer hand-rolls a counter; an
over-cap mint returns `{ ok:false, reason:"rate_limited" }` and a Redis fault
`{ ok:false, reason:"unavailable" }` — the consumer must not email a link on
`ok:false`. Every interaction is ed25519-verified (native `node:crypto`,
fail-closed) with a ±300s timestamp replay window.

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

The `/link` flow binds via the engine's `createColdConnect()` primitive — the
consumer constructs `discordColdConnect` (so `afterBind` can hold the consumer's
`DISCORD_BOT_TOKEN` for `grantVerifiedRole`), wires `requestConfirm` to mint +
email the confirm LINK, and mounts `discordColdConnect.routes` on the app. The
plugin's only `/link` callback is `requestConfirm` (`resolveContact` remains, but
is used ONLY by the OAuth `member_link` branch). See `apps/api/src/discord.ts`
for the full reference wiring.

```ts
import {
  createColdConnect,
  getDerivedCredential,
  getEmailService,
  saveDerivedCredential,
} from "@hogsend/engine";
import {
  createDiscordConnector,
  DISCORD_PROVIDER_ID,
  discordDestination,
} from "@hogsend/plugin-discord";

const base = env.API_PUBLIC_URL.replace(/\/$/, "");

// Consumer-constructed so afterBind can hold the bot token (grantVerifiedRole).
const discordColdConnect = createColdConnect({
  connectorId: DISCORD_PROVIDER_ID,
  identityKind: "discordId", // dedicated contacts.discord_id column
  platformKey: (id) => id, // raw snowflake — no namespace prefix
  linkedEvent: "discord.linked",
  identifyPropKey: "discord_id",
  buildIngest: (binding) => ({
    // Scalar eventProperties the welcome journey branches on — contactProperties
    // never reach the Hatchet payload.
    eventProperties: { source: "discord", discordId: binding.platformUserId },
    contactProperties: { discord: { id: binding.platformUserId } },
  }),
  branding: {
    /* title / blurb / successCopy / errorCopy / badge / accentColor */
  },
  // afterBind is AT-LEAST-ONCE (idempotent-required) — a role PUT is idempotent.
  afterBind: async ({ platformUserId }) => {
    await grantVerifiedRole(platformUserId); // bot-REST PUT, consumer bot token
  },
});

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
  // OAuth `member_link` branch ONLY (the operator/web-bind path — it does NOT go
  // through cold-connect). The consumer grants the verified role + emits
  // discord.linked here too, so both bind paths stay at parity.
  resolveContact: async (patch) => {
    await client.identity.linkContact({
      discordId: patch.discordId,
      email: patch.email, // engine-verified address, never the OAuth email
      contactProperties: patch.contactProperties,
    });
  },
  // The `/link` front door: mint a cold-connect confirm token (throttle runs
  // FIRST inside mintConfirm) and, only on ok:true, email the one-click LINK. The
  // handler never sees the token — it lives only in the emailed URL. A mailer
  // throw propagates so the loop fails CLOSED.
  requestConfirm: async ({ discordUserId, email }) => {
    const minted = await discordColdConnect.mintConfirm({
      platformUserId: discordUserId,
      email,
    });
    if (!minted.ok) {
      return {
        ok: false,
        reason:
          minted.reason === "redis_unavailable" ? "unavailable" : "rate_limited",
      };
    }
    const url = discordColdConnect.confirmUrl({
      apiPublicUrl: base,
      token: minted.token,
    });
    await getEmailService().send({
      template: "transactional/magic-link",
      props: { magicLinkUrl: url, expiresIn: "15 minutes" },
      to: email,
      userId: email,
      userEmail: email,
      subject: "Confirm your Discord connection",
      category: "transactional",
      skipPreferenceCheck: true, // never dropped by unsubscribe / frequency cap
    });
    return { ok: true };
  },
});

const client = createHogsendClient({
  connectors: [discord],
  destinations: [discordDestination],
});

// Mount the connect page + exchange (GET/POST /connect/discord). Forgetting this
// means a confirm-link click 404s.
const app = createApp(client, { routes: [discordColdConnect.routes] });
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
