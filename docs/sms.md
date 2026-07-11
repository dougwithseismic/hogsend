# SMS channel

Hogsend's SMS channel mirrors the email architecture: a provider-neutral
`SmsProvider` contract, a dumb provider plugin (Twilio is the reference), an
engine-owned tracked sender, React-authored templates rendered to plain text, a
replay-safe `sendSms()` for journeys, delivery-status webhooks, and full
TCPA/CTIA inbound STOP/START opt-out handling. It is **opt-in**: with no provider
configured the SMS service is an inert stub and `sendSms` throws — an existing
deploy without SMS credentials is unaffected.

## Setup

Set the Twilio credentials plus a sender (a from-number OR a Messaging Service):

```bash
TWILIO_ACCOUNT_SID=ACxxxx…
TWILIO_AUTH_TOKEN=your_auth_token
SMS_FROM=+15551234567            # or TWILIO_MESSAGING_SERVICE_SID=MGxxxx…
# SMS_PROVIDER=twilio            # active provider id (default "twilio")
# HOGSEND_TEST_PHONE=+15557654321 # redirect target when HOGSEND_TEST_MODE=true
```

Wire Twilio's **status callback** and **inbound message** webhooks (on the number
or Messaging Service) to:

```
<API_PUBLIC_URL>/v1/webhooks/sms/twilio
```

The engine's Twilio env preset also attaches this URL as the per-send
`statusCallback` automatically.

## Sending from a journey

```ts
import { defineJourney, sendSms, isE164 } from "@hogsend/engine";

export const smsWelcome = defineJourney({
  meta: { id: "sms-welcome", name: "SMS — Welcome", trigger: { event: "user.created" } },
  run: async (user) => {
    const phone = user.properties.phone ? String(user.properties.phone) : null;
    if (!phone || !isE164(phone)) return; // SMS is additive — skip if no phone
    await sendSms({ to: phone, userId: user.id, template: "welcome-sms", props: { name: "Ada" } });
  },
});
```

`sendSms` is replay-safe exactly like `sendEmail`: it derives a deterministic
idempotency key from the journey boundary using the `smsSend` key kind
(`journeySmsSend:<runAnchor>:<site>:<template>`), a namespace **disjoint** from
email's `journeySend:` — so a `sendEmail("welcome")` and a `sendSms("welcome")`
under the same wait label never collide. A durable replay re-firing the same
logical send is absorbed by the unique `sms_sends.idempotencyKey` index (Layer 2)
plus Hatchet's `memo` (Layer 1).

## Templates

SMS templates are React components (same DX as email) but rendered to **plain
text** — SMS is text-only over the wire. Author them in the consumer's `src/sms/`:

```tsx
// src/sms/welcome-sms.tsx
import { Text } from "react-email";
export default function WelcomeSms({ name = "there" }) {
  return <Text>Hey {name}, welcome to Hogsend!</Text>;
}
```

Register in `src/sms/registry.ts` (`withSources` from `@hogsend/sms`), augment
`SmsTemplateRegistryMap` in `src/sms/templates.d.ts`, and pass
`sms: { templates: smsTemplates }` to `createHogsendClient` in **both**
`index.ts` and `worker.ts`.

Bodies are segment-billed (160 GSM-7 chars / 70 UCS-2 per segment); the engine
records the segment count on each `sms_sends` row via `countSmsSegments`.

## The tracked pipeline

`createTrackedSmsSender` owns the pipeline stage-for-stage with the email mailer:

1. **Idempotency short-circuit** — a terminal `sent` row is a satisfied
   duplicate; an orphaned `queued` row (crash mid-send) is reused and re-driven.
2. **Suppression** (unless `skipPreferenceCheck`), dual-track:
   - an active `sms_suppressions` row for the phone (STOP / permanent carrier
     failure) → `suppressed`;
   - the contact's `email_preferences` (when `userId` resolves): global
     `unsubscribed_all`, the `sms` channel opt-out, and the topic-category gate →
     `unsubscribed`. The email-transport `suppressed` flag is **not** consumed.
   A suppressed send writes a `failed` row **without** consuming the idempotency
   key, so a later retry after re-subscribe can still send.
3. **Frequency cap** — a separate `isSmsFrequencyCapped` over `sms_sends` (email
   and SMS budgets never consume each other).
4. **STOP footer** — `Reply STOP to opt out` is appended to non-transactional
   bodies unless disabled (`sms.stopFooter: false`) or already present.
5. **Test mode** — `HOGSEND_TEST_MODE=true` redirects to `HOGSEND_TEST_PHONE`
   (blocks + records a `failed` row when unset). Preference checks stay keyed to
   the original recipient.
6. Insert `queued` → render → `provider.send` → update `sent` + `messageId` +
   `segments` → emit `sms.sent` on the outbound spine.

## Delivery + inbound webhooks

`POST /v1/webhooks/sms/:providerId` resolves the provider from the registry,
verifies the signature (Twilio's `X-Twilio-Signature` over the public URL + form
params — the route builds the URL from `API_PUBLIC_URL`, not the proxied host),
and dispatches the normalized `SmsEvent`:

- `sms.delivered` / `sms.failed` update the row status and emit outbound (the
  provider webhook is the single source — there is no first-party signal). A
  permanent-class failure auto-suppresses the number
  (`sms_suppressions(carrier_permanent)`), mirroring email hard-bounce suppress.
- `sms.inbound` runs STOP/START/HELP keyword handling.

## STOP / opt-out compliance (TCPA / CTIA)

Inbound `STOP` / `STOPALL` / `UNSUBSCRIBE` / `CANCEL` / `END` / `QUIT`
(case-insensitive, punctuation-stripped) suppress the phone in **both** tracks:
the phone-keyed `sms_suppressions` table (authoritative — works even for a number
with no contact) and, when the phone resolves to a contact with an email, the
`sms` channel category on `email_preferences` (keeps the preference center
consistent; reuses the single `upsertEmailPreference` write choke, which emits
`contact.unsubscribed`). `START` / `UNSTOP` / `YES` resubscribe.

Confirmation replies default **off** (`sms.optOutReplies: false`) — Twilio's
carrier-level opt-out already replies, and a post-STOP send is blocked by Twilio
error 21610, so a double reply is worse than none. Operators who disable Twilio's
Advanced Opt-Out can enable engine replies.

## Adding another provider

Scaffold `packages/plugin-<name>` mirroring `plugin-twilio`: implement
`createXProvider` via `defineSmsProvider()` (plain-text `send`, normalize webhooks
to `SmsEvent`, verify the provider's signature over the passed `url`), and add an
optional env preset to `smsProvidersFromEnv` behind a guarded dynamic import. A
brand-new `@hogsend/*` package's first npm publish must be manual.

## Deferrals (v1)

Blueprint `send_sms` node (blueprints reach SMS only via code journeys for now),
`check-alerts` SMS monitoring, a durable `sendSmsTask`, MMS, batch sends, Studio
SMS preview, scheduled SMS, quiet-hours enforcement (journeys can use `ctx.when`),
and phone as a merge-participating identity `Kind` (STOP resolves a contact by a
direct `contacts.phone` lookup; import + the resolver set the column, but phone
does not yet drive contact merges).
