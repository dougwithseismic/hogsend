# @hogsend/plugin-postmark

Postmark email delivery for [Hogsend](https://github.com/dougwithseismic/hogsend):
single + batch sends and webhook parsing/verification, normalized into the
provider-neutral `EmailEvent` the engine consumes.

`createPostmarkProvider` implements the `EmailProvider` contract — the contract
itself lives in `@hogsend/core` (canonical author import `@hogsend/engine`). It is
an **opt-in** provider: Resend stays the default. Register it explicitly (see
below) or via the `POSTMARK_SERVER_TOKEN` env preset, then make it active with
`EMAIL_PROVIDER=postmark` (or `email.defaultProvider: "postmark"`).

Two sovereign invariants Hogsend enforces through this provider:

- **First-party open/click tracking is the single source of truth.** Postmark's
  native tracking is forced OFF on every send (`TrackOpens: false`,
  `TrackLinks: "None"`) — `capabilities.nativeTracking` is `false` and the engine
  trusts it.
- **The engine renders React → HTML itself** before the wire; this provider only
  ever sees HTML (`HtmlBody`).

## Opt-in usage

```ts
import { createPostmarkProvider } from "@hogsend/plugin-postmark";
import { createHogsendClient } from "@hogsend/engine";

const client = createHogsendClient({
  email: {
    providers: [
      createPostmarkProvider({
        serverToken: process.env.POSTMARK_SERVER_TOKEN!,
        // Postmark has no HMAC — webhook auth is HTTP Basic creds baked into the
        // webhook URL. Unconfigured = fail-closed (status updates rejected).
        webhookBasicAuth: { user: "hogsend", pass: process.env.POSTMARK_WEBHOOK_PASS! },
      }),
    ],
    defaultProvider: "postmark",
  },
});
```

Postmark has no native scheduled send (`capabilities.scheduledSend` is `false`):
a `scheduledAt` is logged + dropped by the engine — use `ctx.sleepUntil` instead.

This package ships raw TypeScript source; consumers bundle it via their own build
(tsup `noExternal`). See the
[release model](https://github.com/dougwithseismic/hogsend/blob/main/docs/RELEASING.md).
