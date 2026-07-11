# SMS channel

Hogsend's SMS channel mirrors the email architecture: a provider-neutral
`SmsProvider` contract, a dumb provider plugin (Twilio is the reference), an
engine-owned tracked sender, React-authored templates rendered to plain text, a
replay-safe `sendSms()` for journeys, first-party short-link click tracking,
delivery-status webhooks, and a full TCPA/CTIA consent model (explicit opt-in +
inbound STOP/START). Configuring the channel is **operator opt-in**: with no
provider configured the SMS service is an inert stub and `sendSms` throws — an
existing deploy without SMS credentials is unaffected. Texting a contact is
**recipient opt-in**: marketing SMS requires an explicit consent grant (see
[Consent](#consent-tcpa--ctia)).

## Setup

Set the Twilio credentials plus a sender (a from-number OR a Messaging Service):

```bash
TWILIO_ACCOUNT_SID=ACxxxx…
TWILIO_AUTH_TOKEN=your_auth_token
SMS_FROM=+15551234567            # or TWILIO_MESSAGING_SERVICE_SID=MGxxxx…
# SMS_PROVIDER=twilio            # active provider id (default "twilio")
# HOGSEND_TEST_PHONE=+15557654321 # redirect target while SMS test mode is armed
# SMS_LINK_TRACKING=true         # first-party short-link rewriting (default on)
# SMS_LINK_HOST=https://hs.example.com # branded short domain (falls back to API_PUBLIC_URL)
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

1. **Idempotency short-circuit** — a dispatched (`sent`/`delivered`) row is a
   satisfied duplicate; an orphaned `queued` row (crash mid-send) is reused and
   re-driven **with its stored body**, so rewritten short links are never
   re-minted on replay.
2. **Suppression + consent** (always; `skipPreferenceCheck` and transactional
   sends bypass only the consent + topic gates):
   - an active `sms_suppressions` row for the phone (STOP / permanent carrier
     failure) → `suppressed` — never bypassed;
   - the contact's global `unsubscribed_all` → `unsubscribed` — never bypassed;
   - the explicit-opt-in consent gate → `no_consent` / `channel_off` (see
     [Consent](#consent-tcpa--ctia));
   - the topic-category gate → `unsubscribed`.
   A blocked send writes a `failed` row (with the reason in `metadata`)
   **without** consuming the idempotency key, so a later retry after a grant /
   re-subscribe can still send.
3. **Frequency cap** — a separate `isSmsFrequencyCapped` over `sms_sends` (email
   and SMS budgets never consume each other).
4. **Journey suppress** — the `meta.suppress` per-recipient min-gap guard runs
   against SMS send history exactly as it gaps email (skips with
   `journey_suppressed`; recorded set-once, replay-stable).
5. **Link rewrite** — bare URLs in the rendered body become first-party short
   links (see [Link tracking](#link-tracking)).
6. **STOP footer** — `Reply STOP to opt out` is appended to non-transactional
   bodies unless disabled (`sms.stopFooter: false`) or the body already carries
   an opt-out *instruction* (`Reply STOP…`) — prose merely containing the word
   "stop" still gets the footer.
7. **Test mode** — deploy-wide coherence with email: `HOGSEND_TEST_MODE=true`
   forces SMS test mode, and `auto` arms it whenever the email side's test mode
   is armed (unverified domain) — a staging deploy that redirects email never
   live-texts real numbers. Redirects go to `HOGSEND_TEST_PHONE` (blocked +
   recorded when unset). Preference checks stay keyed to the original recipient.
8. Insert `queued` + the send's `tracked_links` in **one transaction** →
   `provider.send` → update `sent` + `messageId` + `segments` → emit `sms.sent`
   on the outbound spine.

## Delivery + inbound webhooks

`POST /v1/webhooks/sms/:providerId` resolves the provider from the registry,
verifies the signature (Twilio's `X-Twilio-Signature` over the public URL + form
params — the route builds the URL from `API_PUBLIC_URL`, not the proxied host),
and dispatches the normalized `SmsEvent`:

- `sms.delivered` / `sms.failed` update the row status (guarded monotonic —
  Twilio callbacks are unordered HTTP requests, so a late `sent` echo can never
  regress a `delivered` row, and a duplicate callback emits nothing) and emit
  outbound with per-row dedupe keys (the provider webhook is the single
  source — there is no first-party signal). A permanent-class failure
  (dead/landline/opted-out number — deliberately NOT the transient-leaning
  30003/30004 carrier blocks) auto-suppresses the number
  (`sms_suppressions(carrier_permanent)`), mirroring email hard-bounce suppress.
- `sms.inbound` runs STOP/START/HELP keyword handling.

## Consent (TCPA / CTIA)

The `sms` channel is **explicit opt-in** (`defaultOptIn: false`, not
configurable): TCPA — and CASL/PECR — require prior *express* consent for
marketing SMS, so holding a phone number is not permission to text it. A
marketing send needs one of:

- an explicit `categories.sms === true` grant on the contact's
  `email_preferences` — written by `POST /v1/lists/sms/subscribe`,
  `PUT /v1/contacts { lists: { sms: true } }`, the SDK's
  `setPreference("sms", true)`, or the preference center;
- **phone-track consent**: an inbound `START` (texting START *is* express
  consent) — recorded on `sms_suppressions` with its timestamp, which also
  covers phone-only contacts that can't hold a preference row.
  `POST /v1/lists/sms/subscribe` falls back to this track for a contact with a
  phone but no email.

Without a grant the send fails **closed** (`no_consent` — a `failed` row with
the reason in metadata; the idempotency key is not consumed). An explicit
`categories.sms === false` (STOP / preference-center off) beats phone consent.
Transactional sends (`category: "transactional"` or `skipPreferenceCheck`) are
exempt from the consent gate but **never** from the phone STOP list or
`unsubscribed_all`.

Every genuine grant emits the **`contact.subscribed`** outbound event (the
mirror of `contact.unsubscribed`) with `source` provenance
(`api` / `preference_center` / `started_keyword`) — the consent audit signal.
The preference center needs no changes: the sms row renders OFF by default
until granted.

**Migrating pre-existing consent**: operators who already hold express consent
batch-grant via `POST /v1/lists/sms/subscribe` per contact (emits the audit
event), or write `email_preferences.categories.sms = true` directly for silent
historical imports.

Inbound `STOP` / `STOPALL` / `UNSUBSCRIBE` / `CANCEL` / `END` / `QUIT`
(case-insensitive; matched on the whole message AND the leading keyword, so
"STOP texting me" opts out) suppress the phone in **both** tracks: the
phone-keyed `sms_suppressions` table (authoritative — works even for a number
with no contact) and, when the phone resolves to a contact with an email, the
`sms` channel category on `email_preferences` (emits `contact.unsubscribed`).
`START` / `UNSTOP` / `YES` grant/resubscribe (emitting `contact.subscribed`).
A STOPped number stays suppressed until it texts START — an API re-grant alone
does not lift the phone-track suppression (Twilio 21610 blocks at the carrier
regardless).

Confirmation replies default **off** (`sms.optOutReplies: false`) — Twilio's
carrier-level opt-out already replies, and a post-STOP send is blocked by Twilio
error 21610, so a double reply is worse than none. Operators who disable Twilio's
Advanced Opt-Out can enable engine replies.

## Link tracking

Bare URLs in rendered bodies are rewritten to first-party short links —
`<host>/s/<code>` with an 8-char GSM-7-safe code — riding the same
`tracked_links` → `link_clicks` click spine as email. Why: a full
`/v1/t/c/<uuid>` tracking URL eats a third of a 160-char GSM-7 segment, and US
carriers filter public shorteners; short codes on your own domain are the
practice.

- **On by default** (mirrors email's always-on tracking). Disable with
  `SMS_LINK_TRACKING=false` / `sms: { linkTracking: false }`.
- Short links serve from `SMS_LINK_HOST` (a branded short domain routed to the
  same app — recommended) falling back to `API_PUBLIC_URL`. Container mirror:
  `sms: { linkHost }`.
- Unsubscribe/preference URLs and the engine's own `/s/`, `/l/`, `/v1/t/` URLs
  are never rewritten; identical URLs share one code; trailing sentence
  punctuation is never swallowed.
- The `tracked_links` rows commit in the same transaction as the `sms_sends`
  row, so a code on the wire always resolves; crash replays reuse the stored
  body and never re-mint.
- A click 302s to the original URL and records: a per-hit `link_clicks` row +
  `clickCount`, first-touch `sms_sends.clicked_at`, the per-hit
  **`sms.clicked`** outbound event, and the **`sms.link_clicked`** bus event
  for journeys (`trigger` / `ctx.waitForEvent`) — suppressed for unfurl bots
  (iMessage/WhatsApp prefetch) and for sends with no resolvable contact.
- Deferred: no `hs_t` identity token on SMS clicks, no semantic SMS links.

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
phone as a merge-participating identity `Kind` (STOP resolves a contact by a
direct `contacts.phone` lookup; import + the resolver set the column, but phone
does not yet drive contact merges), `hs_t` identity tokens on SMS clicks, and
semantic SMS links.
