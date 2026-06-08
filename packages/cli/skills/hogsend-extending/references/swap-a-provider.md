# Swapping a capability provider

A capability provider is a **swappable implementation of an engine-owned
contract**. The engine drives the capability and routes to whatever you supply.
Today there are two: email (`EmailProvider`) and analytics (`PostHogService`).

## The `EmailProvider` contract

Defined in `@hogsend/core`, re-exported canonically from `@hogsend/engine`. It is
a **dumb wire** — delivery + webhook parse/verify only. No tracking, DB,
preference, or render logic lives here.

```ts
import type { EmailProvider } from "@hogsend/engine";

interface EmailProvider {
  send(options: SendEmailOptions): Promise<SendResult>;            // → { id }
  sendBatch(emails: BatchEmailItem[]): Promise<{ results: SendResult[] }>;
  // Verify a provider webhook signature and return the parsed event.
  // Throws if the signature is missing/invalid.
  verifyWebhook(opts: { payload: string; headers: Record<string, string> }): WebhookEvent;
  // Parse an unsigned payload (trusted contexts/tests).
  parseWebhook(payload: string): WebhookEvent;
}
```

`SendEmailOptions`, `BatchEmailItem`, `SendResult`, and `WebhookEvent` are the
contract's supporting types. **Import the contract types from `@hogsend/engine`**,
**except `SendEmailOptions`**, which collides with the engine's higher-level send
type — import that one from `@hogsend/core`:

```ts
import type { EmailProvider, SendResult, WebhookEvent } from "@hogsend/engine";
import type { SendEmailOptions } from "@hogsend/core";
```

## A provider skeleton

The reference implementation to copy is `createResendProvider`
(`packages/plugin-resend/src/provider.ts`). A custom one mirrors it:

```ts
// src/lib/my-email-provider.ts — your content
import type { SendEmailOptions } from "@hogsend/core";
import type { EmailProvider, SendResult, WebhookEvent } from "@hogsend/engine";

export function createMyEmailProvider(config: { apiKey: string; webhookSecret?: string }): EmailProvider {
  return {
    async send(options: SendEmailOptions): Promise<SendResult> {
      // Call your vendor's SDK. The engine hands you HTML already rewritten for
      // link/open tracking (options.html) on the tracked path; render
      // options.react yourself (renderToHtml/renderToPlainText from
      // @hogsend/email) only if your vendor can't take React.
      const id = await myVendor.send({ from: options.from, to: options.to, subject: options.subject, html: options.html });
      return { id };
    },
    async sendBatch(emails) {
      const results = await Promise.all(emails.map((e) => this.send(e as never)));
      return { results };
    },
    verifyWebhook({ payload, headers }): WebhookEvent {
      if (!config.webhookSecret) throw new Error("webhookSecret required to verify webhooks");
      // Verify with your vendor's scheme, then NORMALIZE into the engine's
      // WebhookEvent shape ({ type: "email.delivered" | "email.bounced" | ... }).
      return normalizeMyVendorEvent(verify(payload, headers, config.webhookSecret));
    },
    parseWebhook(payload): WebhookEvent {
      return normalizeMyVendorEvent(JSON.parse(payload));
    },
  };
}
```

## Wire it

```ts
// src/index.ts — your content
import { createHogsendClient } from "@hogsend/engine";
import { templates } from "./emails/registry.js";
import { createMyEmailProvider } from "./lib/my-email-provider.js";

const client = createHogsendClient({
  journeys,
  email: {
    templates,                                            // REQUIRED, nested under email
    provider: createMyEmailProvider({ apiKey: process.env.MY_API_KEY! }),
  },
  // analytics: createMyAnalytics(...),                   // top-level (engine uses it)
});
```

Pass nothing under `email.provider` and the engine builds the **default Resend
provider** from `RESEND_API_KEY` / `RESEND_WEBHOOK_SECRET`.

## What comes along for free

Everything except the wire. The engine's `createTrackedMailer` runs, in order:
check preferences/suppression → frequency cap → resolve + render the template →
write the `email_sends` row (status `queued`) → rewrite links + inject the open
pixel → **then** `provider.send(...)` → update status. So a swapped provider
keeps **all** of tracking, rendering, preferences, and the `email_sends`
pipeline.

## Inbound webhooks

The engine owns one inbound email-webhook route: `POST /v1/webhooks/resend`. It
reads the raw body + headers and calls your provider's `verifyWebhook`, then maps
the normalized `WebhookEvent` to `email_sends` status updates and
bounce/complaint → suppression. Your provider only has to verify + normalize; the
DB effects are engine-owned.

## Analytics (`PostHogService`)

Same shape: the `PostHogService` contract lives in `@hogsend/core`
(canonical `@hogsend/engine`); `createPostHogService` (`@hogsend/plugin-posthog`)
is the default + reference impl. Supply your own via the **top-level**
`createHogsendClient({ analytics })` option. PostHog is optional — with no
`POSTHOG_API_KEY` the engine resolves analytics to `undefined` and the reads
below become no-ops.

Its role is now **NARROW**. The engine no longer fires the outbound event catalog
(`email.*` / `contact.*` / `journey.completed` / `bucket.*`) through analytics —
that fan-out moved to **destinations** on the durable webhook spine, and PostHog
is now just one destination (`kind="posthog"`, see hogsend-authoring-destinations).
`PostHogService` is load-bearing for exactly two things, both of which a swapped
provider must still satisfy:

1. The identity **PULL** — `getPersonProperties(distinctId)`, used for per-user
   timezone resolution at journey enrollment.
2. The opt-in `bucket.syncToPostHog` person-property mirror (`$set`/`$unset` of a
   cohort boolean on bucket transitions) — a PostHog-direct write because `$set`
   identity semantics have no vendor-neutral envelope.

## Don't over-reach

You are implementing a contract, not building a framework. There is no provider
registry, no marketplace, and no `@hogsend/provider-*` packages — to support a
new vendor you implement `EmailProvider` (or `PostHogService`) and pass it in.
That's the whole story.
