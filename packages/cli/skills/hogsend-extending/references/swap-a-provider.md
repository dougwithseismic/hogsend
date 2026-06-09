# Swapping a capability provider

A capability provider is a **swappable implementation of an engine-owned
contract**. The engine drives the capability and routes to whatever you supply.
Today there are two: email (`EmailProvider`) and analytics (`PostHogService`).

## Postmark is already shipped — install it, don't reimplement it

As of **0.10.0** Postmark is a **shipped reference implementation**:
`@hogsend/plugin-postmark` (`createPostmarkProvider`). You do **not** implement
the contract to use it — you install the package and opt in. Resend stays the
default; the engine type-checks identically with or without the package
installed (it's an engine `optionalDependency`, lazily `import()`-ed only when
`POSTMARK_SERVER_TOKEN` is set).

```bash
pnpm add @hogsend/plugin-postmark@latest
```

Implementing the `EmailProvider` contract yourself is the path for a provider
that does **not** ship a plugin yet (e.g. SES). The contract below is what you
implement in that case — and what the shipped Resend/Postmark providers already
satisfy.

## The `EmailProvider` contract

Defined in `@hogsend/core`, re-exported canonically from `@hogsend/engine`. It is
a **dumb wire** — delivery + webhook parse/verify only. No tracking, DB,
preference, or render logic lives here. React **never** crosses this boundary:
the engine always renders React → HTML (via `@hogsend/email` `renderToHtml`)
before calling `send`, so the wire is **HTML-only** — there is no `react` field.

```ts
import type { EmailProvider } from "@hogsend/engine";

interface EmailProvider {
  readonly meta?: EmailProviderMeta;                 // { id, name, description? }
  readonly capabilities?: EmailProviderCapabilities; // tracking/scheduled/signed flags

  // Deliver one / a batch. SendResult is { id } (the provider message id).
  send(options: SendEmailOptions): Promise<SendResult>;
  sendBatch(emails: BatchEmailItem[]): Promise<{ results: SendResult[] }>;

  // Verify the provider's webhook (owns its OWN secrets, constructed-in) and
  // return a normalized EmailEvent. Throws on a bad signature. Throws
  // WebhookHandshakeSignal for non-status handshakes (the route 200s those).
  // MAY be async (SES must GET the SNS SubscribeURL).
  verifyWebhook(opts: {
    payload: string;
    headers: Record<string, string>;
  }): Promise<EmailEvent> | EmailEvent;

  // Parse an unsigned payload (trusted contexts/tests).
  parseWebhook(payload: string): EmailEvent;
}
```

`meta` and `capabilities`:

- **`meta`** (`{ id, name, description? }`) — `meta.id` is the registry key **and**
  the `:providerId` that `POST /v1/webhooks/email/:providerId` dispatches on. It
  is OPTIONAL for back-compat (the registry falls back to `"resend"` when
  absent) but becomes required in a later breaking phase — **always supply it**.
- **`capabilities`** (`{ nativeTracking?, scheduledSend?, signedWebhooks? }`) —
  optional; absent is treated conservatively. `nativeTracking: true` (Resend)
  means the provider's own open/click tracking is an account-level toggle the
  engine can't reach → the engine logs a boot WARN telling you to disable it
  (first-party tracking is the single source of truth). `nativeTracking: false`
  (Postmark, SES) means the provider disables its own tracking per-send and the
  engine **trusts** it — no WARN. `scheduledSend` gates
  `SendEmailOptions.scheduledAt`; `signedWebhooks: false` means the provider
  fails-closed on its own (Postmark basic-auth).

The webhook wire normalized into `EmailEvent`:

```ts
type EmailEventType =
  | "email.sent" | "email.delivered" | "email.bounced" | "email.complained"
  | "email.delivery_delayed" | "email.opened" | "email.clicked";

type BounceClass = "permanent" | "transient" | "complaint" | "unknown";

interface EmailEvent {
  type: EmailEventType;
  messageId: string;        // Resend email_id | Postmark MessageID | SES mail.messageId
  recipients: string[];     // ALL recipients
  occurredAt: string;       // ISO 8601
  bounce?: { class: BounceClass; code: string; reason?: string }; // on bounced/complained
  click?: { url: string; at?: string; ip?: string; ua?: string }; // on clicked (native echo only)
  raw: unknown;             // untouched provider payload (escape hatch)
}
```

`bounce.class` drives suppression: `permanent` auto-suppresses (the engine
increments `bounceCount`), `complaint` suppresses immediately, `transient` is
recorded but **never** suppresses, `unknown` is the conservative default.

The send wire is HTML-only:

```ts
interface SendEmailOptions {
  from: string;
  to: string | string[];
  subject: string;
  html: string;             // REQUIRED — the engine renders React → HTML before the wire
  text?: string;            // optional plain-text alternative
  replyTo?: string | string[];
  cc?: string | string[];
  bcc?: string | string[];
  tags?: Array<{ name: string; value: string }>; // neutral; each provider maps natively
  headers?: Record<string, string>;
  scheduledAt?: string;     // honored only when capabilities.scheduledSend; else logged + ignored
}

type BatchEmailItem = Omit<SendEmailOptions, "scheduledAt">;
interface SendResult { id: string }
```

> **Migrating from a pre-0.10.0 provider:** the old `WebhookEvent` union and the
> nested `event.data.email_id` shape are **gone from the wire** — `verifyWebhook`
> / `parseWebhook` now return the provider-neutral `EmailEvent`. There is **no
> `react` field** on `SendEmailOptions`. The deprecated `WebhookEvent` union
> survives **only** as a frozen `event.raw` cast target (alias
> `LegacyResendWebhookEvent`) for one minor — a handler still on the old shape
> casts `event.raw as LegacyResendWebhookEvent`, but the supported path is
> `event.messageId` / `event.bounce` / `event.type`.

All of these types — plus the `defineEmailProvider` factory and the
`normalizeRecipients` / `joinRecipients` helpers — are exported from
`@hogsend/core` (re-exported canonically from `@hogsend/engine`):

```ts
import {
  defineEmailProvider,
  joinRecipients,
  type BatchEmailItem,
  type BounceClass,
  type EmailEvent,
  type EmailEventType,
  type EmailProvider,
  type SendEmailOptions,
  type SendResult,
  WebhookHandshakeSignal,
} from "@hogsend/core";
```

## A provider skeleton (implementing the contract yourself, e.g. SES)

The shipped reference implementations to copy are `createResendProvider`
(`packages/plugin-resend/src/provider.ts`) and `createPostmarkProvider`
(`packages/plugin-postmark/src/index.ts`). Use `defineEmailProvider` so a typo
in `meta` or a missing method is caught at definition time. A custom one mirrors
them:

```ts
// src/lib/my-email-provider.ts — your content
import {
  defineEmailProvider,
  joinRecipients,
  type EmailEvent,
  type EmailProvider,
  type SendEmailOptions,
  type SendResult,
  WebhookHandshakeSignal,
} from "@hogsend/core";

export function createMyEmailProvider(config: {
  apiKey: string;
  webhookSecret?: string;
}): EmailProvider {
  return defineEmailProvider({
    meta: { id: "myvendor", name: "MyVendor" }, // meta.id = registry key + :providerId
    capabilities: {
      nativeTracking: false, // disable your own tracking per-send → engine trusts it
      scheduledSend: false,  // honor SendEmailOptions.scheduledAt? else it's dropped + WARN
      signedWebhooks: true,  // false ⇒ you must fail-closed yourself
    },

    async send(options: SendEmailOptions): Promise<SendResult> {
      // Call your vendor's SDK. The engine hands you HTML already rendered +
      // rewritten for link/open tracking (options.html) — no React on the wire.
      const id = await myVendor.send({
        from: options.from,
        to: options.to,
        subject: options.subject,
        html: options.html,
      });
      return { id };
    },

    async sendBatch(emails) {
      const results = await Promise.all(emails.map((e) => this.send(e)));
      return { results };
    },

    verifyWebhook({ payload, headers }): EmailEvent {
      if (!config.webhookSecret) {
        throw new Error("webhookSecret required to verify webhooks");
      }
      const raw = verify(payload, headers, config.webhookSecret);
      // A non-delivery-status handshake (subscription confirmations, etc.)?
      // Throw WebhookHandshakeSignal — the engine route 200s it without sniffing
      // the body. Body-shape knowledge stays INSIDE the provider.
      if (isHandshake(raw)) throw new WebhookHandshakeSignal("confirm-subscription");
      // Otherwise NORMALIZE into the provider-neutral EmailEvent
      // ({ type: "email.delivered" | "email.bounced" | ..., messageId, recipients, ... }).
      return normalizeMyVendorEvent(raw);
    },

    parseWebhook(payload): EmailEvent {
      return normalizeMyVendorEvent(JSON.parse(payload));
    },
  });
}
```

## Wire it / opt in

### Opt into Postmark (env, no code)

The simplest path — the engine builds the Postmark provider from env and
activates it. Setting `POSTMARK_SERVER_TOKEN` builds the preset but does **not**
change the active provider; you must also set `EMAIL_PROVIDER=postmark`.

```bash
EMAIL_PROVIDER=postmark
POSTMARK_SERVER_TOKEN=pm-server-xxxxxxxx   # required — also gates the lazy import of the plugin
POSTMARK_MESSAGE_STREAM=outbound           # optional
POSTMARK_WEBHOOK_USER=hook                 # Postmark has no HMAC — Basic-auth in the webhook URL
POSTMARK_WEBHOOK_PASS=super-secret         # BOTH required together to enable verify
EMAIL_FROM=noreply@yourdomain.com          # neutral from; else falls back to RESEND_FROM_EMAIL
# RESEND_API_KEY is now OPTIONAL — omit it entirely for a Postmark-only deploy
```

If `EMAIL_PROVIDER` names a provider that isn't registered, the container throws
at boot with the list of registered ids. If `POSTMARK_SERVER_TOKEN` is set but
`@hogsend/plugin-postmark` isn't installed, the preset is skipped — and if
Postmark was the active provider, boot fails with a "not registered" error
directing you to install it.

### Opt into a provider (code)

```ts
// src/index.ts — your content
import { createHogsendClient } from "@hogsend/engine";
import { createPostmarkProvider } from "@hogsend/plugin-postmark";
import { templates } from "./emails/registry.js";

const client = createHogsendClient({
  journeys,
  email: {
    templates,                                            // REQUIRED, nested under email
    provider: createPostmarkProvider({                    // merged LAST → wins on id collision
      serverToken: process.env.POSTMARK_SERVER_TOKEN!,
      webhookBasicAuth: { user: "hook", pass: process.env.POSTMARK_WEBHOOK_PASS! },
    }),
    defaultProvider: "postmark",                          // the active provider the mailer sends through
  },
  // analytics: createMyAnalytics(...),                   // top-level (engine uses it)
});
```

For a provider you implemented yourself, swap in `createMyEmailProvider({ ... })`
the same way.

### Register many providers

To register **more than one** provider (so `POST /v1/webhooks/email/:providerId`
can verify each) use `providers: [...]` and pick the active one with
`defaultProvider`:

```ts
import { createResendProvider } from "@hogsend/plugin-resend";
import { createPostmarkProvider } from "@hogsend/plugin-postmark";

const client = createHogsendClient({
  email: {
    templates,
    providers: [
      createResendProvider({
        apiKey: process.env.RESEND_API_KEY!,
        webhookSecret: process.env.RESEND_WEBHOOK_SECRET,
      }),
      createPostmarkProvider({
        serverToken: process.env.POSTMARK_SERVER_TOKEN!,
        webhookBasicAuth: { user: "hook", pass: process.env.POSTMARK_WEBHOOK_PASS! },
      }),
    ],
    defaultProvider: "postmark", // resolution: defaultProvider ?? EMAIL_PROVIDER ?? "resend"
  },
});
```

Registry merge order is last-writer-wins: env presets **first** →
`email.providers` → `email.provider` **last**. The container does a registry
lookup for the resolved active id and **throws at boot** if it isn't registered
(`email provider "<id>" is not registered (registered: <ids>)`) — it never
silently falls back for a non-`resend` id. If the active provider declares
`capabilities.nativeTracking === true` (Resend), the engine logs a boot WARN to
disable native tracking; Postmark (`nativeTracking: false`) gets no WARN.

Pass nothing under `email` and the engine builds the **default Resend provider**
from `RESEND_API_KEY` / `RESEND_WEBHOOK_SECRET` (active id `"resend"`).

## What comes along for free

Everything except the wire. The engine's `createTrackedMailer` runs, in order:
check preferences/suppression → frequency cap → resolve + render the template
(React → HTML) → write the `email_sends` row (column `message_id`) → rewrite
links + inject the open pixel → **then** `provider.send(...)` → update status. So
a swapped provider keeps **all** of tracking, rendering, preferences, and the
`email_sends` pipeline.

Reading the result of a send: use `result.messageId` (`TrackedSendResult.messageId`,
the provider-neutral id — Resend `email_id` / Postmark `MessageID`). The old
`result.resendId` still works but is `@deprecated` — it mirrors `messageId` for
one minor, then is removed. The persisted DB column is `message_id` (there is no
`resend_id` column).

## Inbound webhooks

The engine owns the inbound email-webhook route `POST /v1/webhooks/email/:providerId`
(`:providerId` = your `meta.id`; `POST /v1/webhooks/resend` is a deprecated static
alias for `…/email/resend`). It reads the raw body + headers, resolves the
matching provider from the registry, and calls that provider's `verifyWebhook`,
then maps the normalized `EmailEvent` to `email_sends` status updates (keyed by
`event.messageId`) and bounce/complaint → suppression. Your provider only has to
verify + normalize; the DB effects are engine-owned.

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

You are implementing a contract, not building a framework. Two shipped reference
implementations exist — `@hogsend/plugin-resend` (the default) and
`@hogsend/plugin-postmark` — so before reimplementing, check whether a plugin
already covers your vendor and just install + opt in. For a vendor with **no**
plugin yet (e.g. SES) you implement `EmailProvider` (or `PostHogService`) with
`defineEmailProvider` and register it — there's an `EmailProviderRegistry` keyed
by `meta.id`, but no marketplace and no provider discovery. That's the whole
story.
