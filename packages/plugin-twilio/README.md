# @hogsend/plugin-twilio

Twilio SMS delivery for [Hogsend](https://github.com/dougwithseismic/hogsend):
message sending and webhook parsing/verification, normalized into the
provider-neutral `SmsEvent` the engine consumes.

`createTwilioProvider` implements the `SmsProvider` contract — the contract
itself lives in `@hogsend/core` (canonical author import `@hogsend/engine`). It
is the **reference** SMS provider and is **opt-in**: with no Twilio credentials
configured, the engine's SMS service is an inert stub and `sendSms` throws.
Register it via the `TWILIO_ACCOUNT_SID`/`TWILIO_AUTH_TOKEN` env preset (plus a
sender — `SMS_FROM` or `TWILIO_MESSAGING_SERVICE_SID`), or explicitly through
`createHogsendClient({ sms: { provider } })`.

The provider is a **dumb wire** — all preference/suppression checks, rendering
(React → plain text), the `sms_sends` write, and STOP-keyword handling live in
the engine's tracked SMS sender, never here. It owns exactly:

- **A send wire** — `send({ from?, to, body }) → { id }`. Text only; the engine
  renders templates to plain text before the wire. A from-number or a
  Messaging Service SID is pinned at construction.
- **A normalized webhook source** — `verifyWebhook({ payload, headers, url })`
  validates the `X-Twilio-Signature` (HMAC-SHA1 over the public URL + sorted
  form params — the engine passes the canonical `API_PUBLIC_URL`-derived URL,
  never the proxied host) and returns a provider-neutral `SmsEvent`
  (`sms.sent | sms.delivered | sms.failed | sms.inbound`). Intermediate
  statuses and unrecognized payloads throw `WebhookHandshakeSignal` (the route
  200s them). `parseWebhook` handles unsigned payloads for trusted contexts.

## Usage

```ts
import { createTwilioProvider } from "@hogsend/plugin-twilio";
import { createHogsendClient } from "@hogsend/engine";

const client = createHogsendClient({
  sms: {
    provider: createTwilioProvider({
      accountSid: process.env.TWILIO_ACCOUNT_SID!,
      authToken: process.env.TWILIO_AUTH_TOKEN!,
      from: "+15551234567", // or messagingServiceSid: "MG…"
    }),
    templates: smsTemplates,
  },
});
```

Wire Twilio's status callback + inbound webhook to
`<API_PUBLIC_URL>/v1/webhooks/sms/twilio`.

## Note

`twilio` v6 is a CommonJS module: the client class and `validateRequest` hang
off the default export, so this package uses the default import — a named
`import { Twilio }` / `import { validateRequest }` type-checks but throws at
runtime.

See `docs/sms.md` in the Hogsend repo for the full channel guide.
