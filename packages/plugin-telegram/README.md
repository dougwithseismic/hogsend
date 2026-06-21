# @hogsend/plugin-telegram

Telegram connector for Hogsend — inbound activity (messages, `/start` deep-link
linking) → `IngestEvent`, plus journey-callable outbound actions
(`sendMessage`, `dm`) over the Bot API.

- **Transport:** `webhook` (Telegram delivers updates over HTTPS; no socket).
  Served at `POST /v1/webhooks/telegram`.
- **Identity (minimal path):** the contact's canonical key is
  `telegram:<userId>` (the external key); platform metadata lives under
  `contacts.properties.telegram`. No engine schema change.
- **Linking:** a one-tap `https://t.me/<bot>?start=<token>` deep link binds the
  Telegram account to an email. The token is a short, single-use, TTL'd Redis
  nonce (Telegram caps the `start` param at 64 chars, so the binding is stored
  server-side, not in the link).

## Wire it up

```ts
import { telegramConnector, telegramActions } from "@hogsend/plugin-telegram";

const client = createHogsendClient({
  connectors: [telegramConnector],
  connectorActions: telegramActions,
});
```

Set `TELEGRAM_BOT_TOKEN` (from BotFather) and `TELEGRAM_WEBHOOK_SECRET` (an
arbitrary secret echoed back by Telegram's `setWebhook(secret_token=…)` and
checked by the engine route), then register the webhook:

```
https://api.telegram.org/bot<TOKEN>/setWebhook?url=<PUBLIC_URL>/v1/webhooks/telegram&secret_token=<TELEGRAM_WEBHOOK_SECRET>
```

## Send from a journey

```ts
import { sendConnectorAction } from "@hogsend/engine";

await sendConnectorAction({
  connectorId: "telegram",
  action: "sendMessage",
  args: { chatId: user.properties.chatId, text: "Welcome 👋" },
});
```
