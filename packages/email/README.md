# @hogsend/email

Email templating, sending, tracking, and webhook handling for Hogsend. Built on [Resend](https://resend.com) and [React Email](https://react.email).

## Quick start

```ts
import { createEmailService } from "@hogsend/email";
import { createDatabase } from "@hogsend/db";

const { db } = createDatabase(process.env.DATABASE_URL);

// Configure once
const email = createEmailService({
  apiKey: process.env.RESEND_API_KEY,
  defaultFrom: "Hogsend <noreply@hogsend.com>",
  db,                                              // optional: enables DB tracking + suppression
  webhookSecret: process.env.RESEND_WEBHOOK_SECRET, // optional: enables webhook handling
});

// Send a tracked email — one line, fully typed
const result = await email.send({
  template: "welcome",
  props: { name: "Doug" },
  to: "doug@example.com",
});

// result: { emailSendId, resendId, status: "sent" | "suppressed" | "unsubscribed" }
```

Every method follows the **RORO pattern** (Receive an Object, Return an Object) — a single options object in, a structured result out.

## Package structure

```
packages/email/
  src/
    types.ts       Type system: template map, send options, webhook events, errors, service interface
    client.ts      Resend client factory
    registry.ts    Typed template registry with runtime lookup
    service.ts     createEmailService — the main entry point
    send.ts        sendEmail / sendBatchEmails with retry + auto-chunking
    render.ts      React-to-HTML and React-to-plaintext rendering
    tracked.ts     sendTrackedEmail with DB integration (used internally by service)
    webhooks.ts    Webhook signature verification and event dispatch
    index.ts       Public exports
    __tests__/     Vitest test suite (41 tests)
  emails/
    _components/   Shared layout and footer components
    welcome.tsx
    password-reset.tsx
    journey-notification.tsx
```

## Scripts

```bash
pnpm dev           # React Email dev server on port 3003
pnpm build         # tsup build to dist/
pnpm test          # vitest run
pnpm test:watch    # vitest watch
pnpm check-types   # tsc --noEmit
pnpm preview       # Export templates as HTML to out/
```

## `createEmailService`

The recommended way to use this package. Configure once, use everywhere.

```ts
import { createEmailService } from "@hogsend/email";

const email = createEmailService({
  apiKey: "re_...",
  defaultFrom: "Hogsend <noreply@hogsend.com>",   // used when 'from' is not specified per-call
  db,                                               // optional: Database from @hogsend/db
  webhookSecret: "whsec_...",                       // optional: Resend webhook signing secret
  webhookHandlers: { ... },                         // optional: custom handlers per event type
  retryOptions: { maxRetries: 3 },                  // optional: override retry defaults
});
```

### `email.send(options)` — Send a tracked email

Resolves the template, checks suppression, sends via Resend, and writes to `email_sends` — all in one call.

```ts
const result = await email.send({
  template: "welcome",                  // type-safe: only registered template keys
  props: { name: "Doug" },              // type-safe: must match the template's props interface
  to: "doug@example.com",
  // from: "...",                        // optional, defaults to defaultFrom
  // subject: "Custom subject",          // optional, defaults to template's defaultSubject
  // category: "transactional",          // optional, defaults to template's category
  // journeyStateId: "uuid",            // optional, links to journey_states table
  // skipPreferenceCheck: true,          // optional, skip suppression for system emails
  // tags: [{ name: "campaign", value: "onboarding" }],
  // replyTo: "support@hogsend.com",
});

result.status;      // "sent" | "suppressed" | "unsubscribed"
result.emailSendId; // UUID from email_sends table (empty string without db)
result.resendId;    // Resend email ID (empty string if suppressed)
```

Without `db`, sends via Resend directly (no tracking, no suppression check).

### `email.sendRaw(options)` — Send without templates

For one-off emails that don't use the template registry:

```ts
const result = await email.sendRaw({
  from: "Alerts <alerts@hogsend.com>",   // optional, uses defaultFrom
  to: "ops@example.com",
  subject: "Server alert",
  react: <AlertEmail message="CPU at 95%" />,
});

result.id; // Resend email ID
```

### `email.sendBatch(options)` — Batch send

Auto-chunks lists larger than 100 (Resend's per-request limit):

```ts
const { results } = await email.sendBatch({
  emails: [
    { from: "noreply@hogsend.com", to: "a@example.com", subject: "A", react: elementA },
    { from: "noreply@hogsend.com", to: "b@example.com", subject: "B", react: elementB },
    // ... up to any number
  ],
});
```

### `email.render(options)` — Render without sending

Get HTML, plain text, subject, and category for a template:

```ts
const { html, text, subject, category } = await email.render({
  template: "password-reset",
  props: { name: "Jane", resetUrl: "https://app.hogsend.com/reset/abc" },
});
```

### `email.handleWebhook(options)` — Process Resend webhooks

Verifies the signature, auto-updates `email_sends` status columns, then calls your custom handlers:

```ts
// In your route handler (e.g., Hono):
app.post("/webhooks/resend", async (c) => {
  const { type, handled } = await email.handleWebhook({
    payload: await c.req.text(),
    headers: Object.fromEntries(c.req.raw.headers.entries()),
  });

  return c.json({ type, handled });
});
```

When `db` is configured, the service automatically updates these columns on `email_sends`:

| Webhook event           | Sets status to | Timestamps updated |
| ----------------------- | -------------- | ------------------ |
| `email.sent`            | `sent`         | `sentAt`           |
| `email.delivered`       | `delivered`    | `deliveredAt`      |
| `email.opened`          | `opened`       | `openedAt`         |
| `email.clicked`         | `clicked`      | `clickedAt`        |
| `email.bounced`         | `bounced`      | `bouncedAt`        |
| `email.complained`      | `complained`   | `complainedAt`     |

Add custom handlers alongside the auto-tracking:

```ts
const email = createEmailService({
  apiKey: "re_...",
  defaultFrom: "Hogsend <noreply@hogsend.com>",
  db,
  webhookSecret: "whsec_...",
  webhookHandlers: {
    "email.bounced": async (event) => {
      // event is typed as EmailBouncedEvent
      await incrementBounceCount(event.data.email_id);
    },
    "email.clicked": async (event) => {
      // event is typed as EmailClickedEvent
      console.log(`Clicked: ${event.data.click.link}`);
    },
  },
});
```

## Type safety

The template system is fully generic. `TemplateMap` maps each template key to its props interface — the compiler enforces correct props at every call site:

```ts
// Compiles: props match WelcomeEmailProps
email.send({ template: "welcome", props: { name: "Doug" }, to: "..." });

// Compile error: 'resetUrl' is missing from PasswordResetEmailProps
email.send({ template: "password-reset", props: { name: "Doug" }, to: "..." });

// Compile error: 'nonexistent' is not a valid TemplateName
email.send({ template: "nonexistent", props: {}, to: "..." });
```

## Templates

### Available templates

| Key                      | Props                                                  | Category      | Default subject          |
| ------------------------ | ------------------------------------------------------ | ------------- | ------------------------ |
| `welcome`                | `name`, `dashboardUrl?`                                | transactional | Welcome to Hogsend       |
| `password-reset`         | `name`, `resetUrl`, `expiresInMinutes?`                | transactional | Reset your password      |
| `journey-notification`   | `name`, `journeyName`, `eventName`, `body`, `unsubscribeUrl?` | journey       | Journey notification     |

### Adding a new template

1. Add the props interface to `src/types.ts` and add it to `TemplateMap`
2. Create the `.tsx` component in `emails/`
3. Register it in `src/registry.ts` in `defaultRegistry`
4. Export the component from `src/index.ts`

### Previewing templates

```bash
pnpm dev   # Opens React Email UI at http://localhost:3003
```

All templates share the `Layout` wrapper (centered 600px container, gray background, white card) and `Footer` component (with optional unsubscribe link).

### Direct template imports

If you prefer bypassing the registry:

```ts
import { WelcomeEmail, PasswordResetEmail, JourneyNotificationEmail } from "@hogsend/email";
// or
import WelcomeEmail from "@hogsend/email/templates/welcome";
```

## Retry behavior

All send methods retry transient errors with exponential backoff + jitter.

**Retryable** (automatically retried): HTTP 429, HTTP 5xx, network errors (timeout, ECONNRESET, ECONNREFUSED).

**Non-retryable** (thrown immediately): HTTP 4xx, unknown errors.

| Option        | Default  |
| ------------- | -------- |
| `maxRetries`  | 3        |
| `baseDelayMs` | 500ms    |
| `maxDelayMs`  | 30,000ms |

Override globally via `createEmailService({ retryOptions })` or per-call on `sendRaw`.

## Suppression checks

When `db` is configured, `email.send()` queries `email_preferences` before sending:

| Condition                | Result status  |
| ------------------------ | -------------- |
| `suppressed = true`      | `suppressed`   |
| `unsubscribed_all = true`| `unsubscribed` |
| Category opted out       | `unsubscribed` |
| No match                 | Sends normally |

Suppressed emails still create an `email_sends` row (status `failed`) for audit purposes.

Skip the check with `skipPreferenceCheck: true` for system emails like password resets.

## Error handling

Three error classes, all extending `Error`:

```ts
import { EmailSendError, EmailSuppressionError, WebhookVerificationError } from "@hogsend/email";
```

| Class                      | When thrown                          | Key properties             |
| -------------------------- | ----------------------------------- | -------------------------- |
| `EmailSendError`           | Send/batch failures after retry     | `retryable`, `statusCode`  |
| `EmailSuppressionError`    | Recipient is suppressed/unsubscribed| `reason`                   |
| `WebhookVerificationError` | Invalid signature or unknown event  | Standard `Error`           |

```ts
try {
  await email.send({ template: "welcome", props: { name: "Doug" }, to: "..." });
} catch (error) {
  if (error instanceof EmailSendError) {
    console.log(error.retryable, error.statusCode);
  }
}
```

## Lower-level APIs

The service wraps these — they're available if you need direct access:

```ts
import {
  createResendClient,     // Create a raw Resend client
  sendEmail,              // Send with retry (no DB)
  sendBatchEmails,        // Batch with retry + auto-chunking (no DB)
  sendTrackedEmail,       // Send with DB tracking (requires db + client)
  getTemplate,            // Resolve template by key
  getPreviewText,         // Get preview text for a template
  renderToHtml,           // Render React element to HTML
  renderToPlainText,      // Render React element to plain text
  createWebhookHandler,   // Create a webhook handler (no auto-DB updates)
  verifyWebhook,          // Verify webhook signature
  parseWebhookEvent,      // Parse without verification
} from "@hogsend/email";
```

## Peer dependencies

`@hogsend/db` and `drizzle-orm` are optional peer dependencies. Without them, `email.send()` still works but skips DB tracking and suppression checks.
