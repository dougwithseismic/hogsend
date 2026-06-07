# @hogsend/client

Typed HTTP client for the [Hogsend](https://hogsend.com) data plane — contacts,
events, transactional emails, and lists. Thin wrapper over native `fetch`, no
heavy dependencies, ships compiled ESM + CJS + `.d.ts`.

## Install

```bash
pnpm add @hogsend/client
```

For fully type-checked `emails.send`, also install `@hogsend/email` (a
**type-only optional peer**) and augment its template registry in your app.
Without it, `emails.send` degrades gracefully to `{ template: string; props? }`.

## Usage

```ts
import { Hogsend } from "@hogsend/client";

const hs = new Hogsend({
  baseUrl: "https://api.example.com",
  apiKey: process.env.HOGSEND_DATA_KEY!, // hsk_… key with the `ingest` scope
});

// Contacts ----------------------------------------------------------------
await hs.contacts.upsert({
  email: "ada@example.com",
  userId: "u_1",
  properties: { plan: "pro" },
  lists: { newsletter: true },
}); // -> { id, created, linked }

const found = await hs.contacts.find({ email: "ada@example.com" }); // Contact[]
await hs.contacts.delete({ userId: "u_1" }); // -> { deleted }

// Events ------------------------------------------------------------------
await hs.events.send({
  userId: "u_1",
  name: "signup",
  eventProperties: { source: "landing" }, // → trigger.where / exitOn
  contactProperties: { country: "GB" }, // → contact record
  idempotencyKey: "evt_abc",
}); // -> { stored, exits: [{ journeyId, stateId, exited }] }

hs.events.track(/* … */); // alias of events.send

// Emails ------------------------------------------------------------------
await hs.emails.send({
  to: "ada@example.com",
  template: "welcome",
  props: { name: "Ada" },
}); // -> { emailSendId, status }

// Lists -------------------------------------------------------------------
await hs.lists.list(); // -> ListSummary[]
await hs.lists.subscribe({ list: "newsletter", email: "ada@example.com" });
await hs.lists.unsubscribe({ list: "newsletter", userId: "u_1" });
```

### Identity

Every write takes an **identity** — at least one of `email` or `userId`
(your external id). Both may be supplied; the type union and a runtime guard
enforce that at least one is present.

## Options

| Option      | Type                       | Default   | Notes                                     |
| ----------- | -------------------------- | --------- | ----------------------------------------- |
| `baseUrl`   | `string`                   | —         | API base, e.g. `https://api.example.com`. |
| `apiKey`    | `string`                   | —         | Data-plane `hsk_…` key (`ingest` scope).  |
| `fetch`     | `typeof fetch`             | global    | Override for tests / custom agents.       |
| `timeoutMs` | `number`                   | `30000`   | Per-request timeout (aborts the request). |
| `headers`   | `Record<string, string>`   | `{}`      | Extra headers on every request.           |

## Errors

All non-2xx responses (and transport failures) throw typed errors:

```ts
import { HogsendAPIError, RateLimitError } from "@hogsend/client";

try {
  await hs.emails.send({ to: "x@y.com", template: "welcome", props: {} });
} catch (err) {
  if (err instanceof RateLimitError) {
    // 429 — back off for err.retryAfter seconds
  } else if (err instanceof HogsendAPIError) {
    // err.status (0 = transport failure), err.body (parsed JSON or raw text)
  }
}
```

- `HogsendAPIError` — `{ status, body }`. `status === 0` means the request never
  reached the server (DNS/connect/timeout).
- `RateLimitError extends HogsendAPIError` — `status === 429`, with `retryAfter`
  (seconds, from the `Retry-After` header) when present.

## License

MIT
