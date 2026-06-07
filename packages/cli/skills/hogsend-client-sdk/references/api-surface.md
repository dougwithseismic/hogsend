# `@hogsend/client` — full API surface

Every method on the `Hogsend` instance, with its input and result shape and the
data-plane route it maps to. All inputs that mutate require an **identity** —
at least one of `email` or `userId` (both may be supplied), enforced by
`assertIdentity` at runtime and the `Identity` union at compile time.

## `hs.contacts`

### `contacts.upsert(input) → { id, created, linked }`

`PUT /v1/contacts`. Upsert a contact by identity; the server resolves/merges
(including identity linking when both `email` and `userId` are given).

```ts
type UpsertContactInput = Identity & {
  properties?: Record<string, unknown>;   // merged onto the contact
  lists?: Record<string, boolean>;        // inline list membership flips
};
// → { id: string; created: boolean; linked: boolean }
```

- `created` — `true` when a brand-new contact row was inserted.
- `linked` — `true` when the upsert merged two previously-separate identities
  (an `email`-only and a `userId`-only contact) into one.

### `contacts.find(input) → Contact[]`

`GET /v1/contacts/find`. Look up non-deleted contacts by EXACTLY ONE of `email`
or `userId` (the find input is `{ email } | { userId }`, not the general
identity union). Returns an array (may be empty).

```ts
type FindContactsInput = { email: string } | { userId: string };

interface Contact {
  id: string;
  externalId: string | null;
  email: string | null;
  properties: Record<string, unknown>;
  firstSeenAt: string;   // ISO — always present
  lastSeenAt: string;    // ISO
  createdAt: string;     // ISO
  updatedAt: string;     // ISO
}
```

### `contacts.delete(input) → { deleted }`

`DELETE /v1/contacts`. Soft-delete a contact by identity. `deleted` is `true`
when a matching contact was found and marked deleted.

## `hs.events`

### `events.send(input) → { stored, exits, listsError? }` · alias `events.track`

`POST /v1/events` → **202 Accepted**. Push an event through the full ingestion
pipeline (store → route to Hatchet/journeys → evaluate `exitOn` → upsert contact).
`events.track` is a literal alias of `events.send`.

```ts
type SendEventInput = Identity & {
  name: string;
  eventProperties?: Record<string, unknown>;   // stored ON the event → trigger.where / exitOn
  contactProperties?: Record<string, unknown>; // merged onto the CONTACT
  lists?: Record<string, boolean>;             // inline list membership
  idempotencyKey?: string;                     // dedup
};

interface IngestResult {
  stored: boolean;                 // false only on idempotency-key dedup
  exits: { journeyId: string; stateId: string; exited: boolean }[];
  listsError?: string;             // present only if the post-ingest lists write failed
}
```

- See the main SKILL for the `eventProperties` vs `contactProperties` split and
  the `listsError`-on-202 semantics.
- **`idempotencyKey`** is sent BOTH as the `Idempotency-Key` HTTP header (which
  wins server-side) AND in the body, matching the route. Reuse the same key to
  make a retried `events.send` a no-op (`stored: false`).

## `hs.emails`

### `emails.send(input) → { emailSendId, status, reason? }`

`POST /v1/emails`. Send a transactional email by template through the full
preferences + tracking pipeline (link-click + open rewriting applied
automatically). Recipient is `to` (raw address) OR `userId` (resolved to the
contact's email server-side).

```ts
type SendEmailInput = SendEmailEnvelope & ( typed-or-untyped template variant );

type SendEmailEnvelope = {
  to?: string;
  userId?: string;
  from?: string;
  subject?: string;
  replyTo?: string;
  category?: string;            // a LIST id to gate the send on (see hogsend-authoring-lists)
  skipPreferenceCheck?: boolean;// bypass unsub/suppression — needs full-admin
  idempotencyKey?: string;
};

interface SendEmailResult {
  emailSendId: string;
  status: string;               // queued | sent | suppressed | unsubscribed | skipped
  reason?: string;
}
```

**Typed templates.** When `@hogsend/email` is installed (a TYPE-ONLY optional
peer) and you augment its `TemplateRegistryMap`, `template` and `props` are
fully type-checked per known template key. Without it, the shape degrades to
`{ template: string; props?: Record<string, unknown> }`.

> tsconfig caveat: the shipped `.d.ts` references `@hogsend/email` by module
> name. If you do NOT install that optional peer, keep `skipLibCheck: true` (the
> scaffold default) or `tsc` emits `TS2307: Cannot find module '@hogsend/email'`
> from this package's declarations. Installing the peer (even type-only) removes
> the caveat. The runtime JS has no dependency on `@hogsend/email`.

- `category` gates the send on a code-defined list's opt-in/opt-out polarity —
  see the hogsend-authoring-lists skill.
- `skipPreferenceCheck: true` bypasses the unsubscribe/suppression gate and
  requires a `full-admin` key, not a plain `ingest` key.

## `hs.lists`

### `lists.list() → ListSummary[]`

`GET /v1/lists`. Every code-defined list in the app.

```ts
interface ListSummary {
  id: string;
  name: string;
  description?: string;
  defaultOptIn: boolean;
}
```

### `lists.subscribe(input) → { subscribed: true }`

`POST /v1/lists/:id/subscribe`. Sets `categories[id] = true` for the identity.

### `lists.unsubscribe(input) → { unsubscribed: true }`

`POST /v1/lists/:id/unsubscribe`. Sets `categories[id] = false` for the identity.

```ts
type SubscribeInput = Identity & { list: string };
```

For how `subscribe`/`unsubscribe` interact with a list's `defaultOptIn` polarity
(opt-in needs an exact `true`, opt-out is blocked only on an exact `false`), see
the hogsend-authoring-lists skill.

## Construction options (recap)

```ts
interface HogsendOptions {
  baseUrl: string;                     // required — e.g. https://api.example.com
  apiKey: string;                      // required — hsk_… key with the `ingest` scope
  fetch?: typeof fetch;                // default: global fetch
  timeoutMs?: number;                  // default: 30000 (aborts the request)
  headers?: Record<string, string>;   // merged onto every request
}
```

## Errors (recap)

- `HogsendAPIError` — `{ status, body }`. `status === 0` = transport failure
  (DNS/connect/timeout); `body` is parsed JSON or raw text.
- `RateLimitError extends HogsendAPIError` — `status === 429`, with `retryAfter`
  (seconds) from the `Retry-After` header when present.

Both are exported from `@hogsend/client` and are real classes, so
`err instanceof RateLimitError` / `err instanceof HogsendAPIError` narrows
correctly (check `RateLimitError` first — it is the subclass).
