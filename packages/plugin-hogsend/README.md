# @hogsend/plugin-hogsend

Hogsend Email delivery for [Hogsend](https://github.com/dougwithseismic/hogsend):
single + batch sends through the Hogsend Cloud send relay, and signed status
webhooks normalized into the provider-neutral `EmailEvent` the engine consumes.

`createHogsendEmailProvider` implements the `EmailProvider` contract — the
contract itself lives in `@hogsend/core` (canonical author import
`@hogsend/engine`). It is an **opt-in** provider: Resend stays the default for
self-hosted deploys, and Postmark stays supported. Nothing in the engine imports
this package statically, so a consumer without it still type-checks and boots.

Hogsend Email is provisioned by **Hogsend Cloud**, which is the only issuer of
relay tokens. There is no public signup and no standalone API. The plugin itself
is not coupled to Cloud — `relayUrl` and `tenantToken` are plain config, and
nothing here knows about AWS. AWS credentials never leave the control plane;
an instance holds a relay token and nothing more.

Three invariants this provider enforces:

- **HTML-only wire.** The engine renders React → HTML itself before the wire.
  The request body is constructed field by field rather than spread, so no React
  value has a path onto it — and the relay's own schema is strict and would
  refuse one regardless.
- **First-party open/click tracking is the single source of truth.** SES native
  tracking is never enabled, so `capabilities.nativeTracking` is `false` and the
  engine trusts it. This wire cannot even express an open or a click.
- **Fail closed, loudly, no fallback.** A paused tenant's send throws a
  `HogsendRelayPausedError` carrying the reason and the pause timestamp, so the
  journey records why. Nothing is silently rerouted, and no 4xx is ever retried.

## Opt-in usage

```ts
import { createHogsendEmailProvider } from "@hogsend/plugin-hogsend";
import { createHogsendClient } from "@hogsend/engine";

const client = createHogsendClient({
  email: {
    providers: [
      createHogsendEmailProvider({
        relayUrl: process.env.HOGSEND_EMAIL_RELAY_URL!,
        tenantToken: process.env.HOGSEND_EMAIL_TOKEN!,
        // HMAC secret for status webhooks. Unconfigured = fail-closed: every
        // webhook is rejected and the payload is never parsed.
        webhookSecret: process.env.HOGSEND_EMAIL_WEBHOOK_SECRET,
      }),
    ],
    defaultProvider: "hogsend",
  },
});
```

Status webhooks arrive at `POST /v1/webhooks/email/hogsend`.

Hogsend Email has no scheduled send (`capabilities.scheduledSend` is `false`): a
`scheduledAt` is logged once and dropped — use `ctx.sleepUntil` instead, which is
durable, visible in the journey, and cancellable.

## Errors

| Relay answer | Thrown |
| --- | --- |
| `403 tenant_paused` | `HogsendRelayPausedError` (`reason`, `pausedAt`) |
| `401` / `402` / `400` / `413` | `HogsendRelayError`, `retryable: false` |
| `429 rate_limited`, `503 send_unavailable` | `HogsendRelayError`, `retryable: true`, `retryAfterSeconds` |
| a batch with any failed item | `HogsendRelayBatchError` (every positional outcome) |

`retryable` is advisory. This wire never retries anything — retry policy belongs
to the durable task layer that can see the whole journey.

## The webhook wire

This package owns the relay's webhook payload shape and exports it
(`HogsendRelayEmailEvent`, `hogsendRelayEmailEventSchema`) along with the signer
(`signHogsendRelayWebhook`), so the control plane produces against exactly what
the instance verifies.
