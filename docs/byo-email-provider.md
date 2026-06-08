# Bring-Your-Own Email Provider

**Status:** implementation spec (single source of truth)
**Scope:** make Hogsend's email layer provider-agnostic — Resend today, Postmark
next, SES later — while keeping first-party link/open tracking sovereign.
**Audience:** the implementer of each phase. Everything below is at FILE:LINE
granularity against the current tree.

---

## 1. Overview & end-state mental model

Today the engine's email layer is ~70% structurally decoupled (the
`EmailProvider` contract lives in neutral `@hogsend/core`, the tracked mailer
owns the whole render → suppression → tracked-html → `email_sends` →
`provider.send` → status pipeline, svix is contained in the plugin) but ~30%
**dishonest**: the contract traffics in Resend's wire shapes where it counts. A
Postmark or SES provider would have to **fabricate Resend JSON** to satisfy the
types, and there is no path for a second provider's delivery/bounce webhooks to
reach `email_sends`.

This spec makes the promise — _"the `EmailProvider` is the swappable wire"_ —
actually true.

### The mental model

A provider is **two wires plus identity**, and it is symmetric with the existing
plug-in shapes:

| Direction | Inbound | Email provider | Outbound |
| --- | --- | --- | --- |
| Define helper | `defineWebhookSource()` | **`defineEmailProvider()`** | `defineDestination()` |
| Identity | `meta.id` | **`meta.id`** | `meta.id` |
| Registry keyed by id | source map | **`EmailProviderRegistry`** | `DestinationRegistry` |
| Env presets | `*_WEBHOOK_SECRET` auto-enable | **`emailProvidersFromEnv(env)`** | `destinationsFromEnv(env)` |
| Consumer-wins merge | n/a | **env → opts.providers → opts.provider** | env → opts.destinations |
| Id-dispatched route | `POST /v1/webhooks/:sourceId` | **`POST /v1/webhooks/email/:providerId`** | n/a |
| Translation lives in | `transform()` | **`verifyWebhook()`/`parseWebhook()`** | `transform()` |

A provider therefore owns exactly two things:

1. **A send wire** — `send()` / `sendBatch()` that take **HTML strings** (never
   React) and return a neutral `{ id }`.
2. **A normalized webhook source** — `verifyWebhook()`/`parseWebhook()` that
   translate the provider's verbatim webhook into a provider-neutral
   **`EmailEvent`**, owning its own secrets.

### The two sovereign invariants

- **First-party open/click tracking is sovereign and is NEVER delegated.** The
  engine rewrites every link to `${API_PUBLIC_URL}/v1/t/c/:id` and injects the
  open pixel at `/v1/t/o/:id` (`lib/tracking.ts`), and the click/open routes are
  the single outbound emitter for opens/clicks (per-hit). Provider-native
  open/click tracking MUST be off (forced where the provider allows, a boot WARN
  where it can't). Provider webhooks are consumed **ONLY** for
  `delivered`/`bounced`/`complained` — the three states that have no first-party
  signal.

- **The engine owns render → preferences → tracking → `email_sends`.** The
  provider is a dumb send + normalize-webhook wire. The engine renders
  React → HTML **itself** before the wire; React Email stays first-class for
  template authoring and Studio preview.

---

## 2. Owner decisions (these override the design where they differ)

1. **The provider-neutral event type is named `EmailEvent`** (not
   `NormalizedEmailEvent`). `EmailEventType` keeps the `email.` prefix on its
   members. NOTE: a UI-only `EmailEvent` row type already exists at
   `packages/studio/src/lib/admin-api.ts:76` — it is unrelated (a Studio
   timeline row). The new `EmailEvent` lives in `@hogsend/core`, a different
   package, so there is no module collision, but do not conflate them; rename
   the Studio one to `EmailTimelineEvent` if it ever causes confusion (see
   followups).
2. **React Email stays first-class** for template authoring AND Studio
   rendering/preview. ONLY the provider `send()` **wire** becomes HTML-only; the
   engine renders React → HTML itself via `@hogsend/email` `renderToHtml`. Never
   remove React Email from templates, the render machinery, or Studio.
3. **The `resendId` → `messageId` rename ships as a MINOR with one-release
   deprecation aliases**, not a breaking major. Old names keep working
   (`@deprecated`) for one minor wherever they are public.

---

## 3. The final TypeScript contract

All of the following lives in `packages/core/src/providers/email.ts` (re-exported
by `@hogsend/core` via `providers/index.ts` and by `@hogsend/engine`).

### 3.1 `EmailEvent` + `EmailEventType`

```ts
// KEEP the `email.` prefix so WebhookHandlerMap keys, WEBHOOK_TO_STATUS,
// WEBHOOK_TO_STATUS_FIELD, and the outbound catalog are all UNCHANGED.
export type EmailEventType =
  | "email.sent"
  | "email.delivered"
  | "email.bounced"
  | "email.complained"
  | "email.delivery_delayed"
  | "email.opened"
  | "email.clicked";

export interface EmailEvent {
  type: EmailEventType;
  /** Resend email_id | Postmark MessageID | SES mail.messageId. */
  messageId: string;
  /** ALL recipients (SES bounce/complaint carry many). */
  recipients: string[];
  /** ISO 8601 timestamp of the provider event. */
  occurredAt: string;
  /** Present on email.bounced / email.complained. Drives suppression. */
  bounce?: {
    class: "permanent" | "transient" | "complaint" | "unknown";
    code: string;
    reason?: string;
  };
  /** Present on email.clicked (native-tracking echo only; first-party owns clicks). */
  click?: { url: string; at?: string; ip?: string; ua?: string };
  /** The untouched provider payload, for handler escape-hatch + debugging. */
  raw: unknown;
}
```

> Field name note: the design used `providerMessageId`. Per owner decision 3 the
> neutral id is `messageId` end-to-end, so the event field is **`messageId`**
> (one name everywhere, no `provider` prefix).

### 3.2 The frozen legacy union (one-minor escape hatch)

```ts
/**
 * @deprecated The Resend-shaped webhook union, frozen for one minor. Cast
 * `event.raw as LegacyResendWebhookEvent` inside a webhookHandler to keep
 * reading the old nested shape while you migrate to EmailEvent fields. Removed
 * the following minor.
 */
export type LegacyResendWebhookEvent = WebhookEvent; // the existing union, kept
```

Keep the existing `WebhookEvent` union and its member interfaces
(`packages/core/src/providers/email.ts:41-101`) but mark them `@deprecated` and
add the `LegacyResendWebhookEvent` alias. They no longer flow through
`verifyWebhook`/`parseWebhook` — they exist only as the cast target.

### 3.3 Provider identity & capabilities

```ts
export interface EmailProviderMeta {
  id: string;
  name: string;
  description?: string;
}

export interface EmailProviderCapabilities {
  /**
   * Whether the provider's OWN open/click tracking is active and the engine
   * cannot force it off per-send. false = the provider disables it per-send
   * (Postmark TrackOpens:false/TrackLinks:'None'; SES omit from config-set) and
   * the engine TRUSTS that. true = an account-level toggle the engine can't
   * reach (Resend) → the engine logs a boot WARN.
   */
  nativeTracking?: boolean;
  /** Honors SendEmailOptions.scheduledAt (Resend yes; Postmark/SES no). */
  scheduledSend?: boolean;
  /** Has a crypto signature scheme (Resend svix; SES SNS cert). false = the
   * provider must fail-closed on its own (Postmark basic-auth). */
  signedWebhooks?: boolean;
}
```

### 3.4 The handshake signal (SNS-style confirmations)

```ts
/**
 * Thrown by verifyWebhook when the request was a non-delivery-status handshake
 * (e.g. SNS SubscriptionConfirmation, Postmark SubscriptionChange) that the
 * provider already handled. The route catches it and returns 200. SNS-specific
 * body-shape knowledge stays entirely inside the provider — the engine route
 * NEVER sniffs the body.
 */
export class WebhookHandshakeSignal extends Error {
  constructor(readonly action: string) {
    super(action);
    this.name = "WebhookHandshakeSignal";
  }
}
```

### 3.5 Send options (HTML-only wire, NO react)

```ts
export interface SendEmailOptions {
  from: string;
  to: string | string[];
  subject: string;
  html: string; // REQUIRED — the engine always renders React → HTML first
  text?: string;
  replyTo?: string | string[];
  cc?: string | string[];
  bcc?: string | string[];
  /** Neutral provider-funnel tag (Resend first tag; Postmark Tag; SES no-op). */
  tag?: string;
  /** Neutral key→value metadata (Resend tags; Postmark Metadata; SES MessageTag). */
  metadata?: Record<string, string>;
  headers?: Record<string, string>;
  /** Honored only when capabilities.scheduledSend; else logged + ignored. */
  scheduledAt?: string;
}

export type BatchEmailItem = Omit<SendEmailOptions, "scheduledAt">;

export interface SendResult {
  id: string; // already neutral — DO NOT rename
}
```

- `react?: ReactElement` is **removed** from both `SendEmailOptions` and
  `BatchEmailItem`. The `import { ReactElement } from "react"` at the top of
  `providers/email.ts:1` is deleted. `@hogsend/core` no longer depends on React.
- `BatchEmailItem.react` was non-optional (`providers/email.ts:25`) — the
  sharpest edge — now derived from the HTML-only `SendEmailOptions`.
- The Resend-shaped `tags?: Array<{name;value}>` (`providers/email.ts:17,29`) is
  replaced by neutral `tag?` + `metadata?`. **The higher-level engine send API
  KEEPS `tags: Array<{name,value}>`** (`EmailServiceSendOptions.tags`,
  `SendTrackedEmailOptions.tags`, `POST /v1/emails`) and the mailer translates
  it before the provider call (see §7.4). Consumer send API is unchanged this
  milestone.

### 3.6 The `EmailProvider` interface + `defineEmailProvider`

```ts
export interface EmailProvider {
  readonly meta: EmailProviderMeta;
  readonly capabilities?: EmailProviderCapabilities;

  send(options: SendEmailOptions): Promise<SendResult>;
  sendBatch(emails: BatchEmailItem[]): Promise<{ results: SendResult[] }>;

  /**
   * Verify the provider's webhook (owns its OWN secrets, constructed-in) and
   * return a normalized EmailEvent. Throws on a bad signature. Throws
   * WebhookHandshakeSignal for non-status handshakes (the route 200s those).
   * MAY be async (SES must GET the SNS SubscribeURL).
   */
  verifyWebhook(opts: {
    payload: string;
    headers: Record<string, string>;
  }): Promise<EmailEvent> | EmailEvent;

  /** Parse an unsigned payload (trusted contexts / tests). */
  parseWebhook(payload: string): EmailEvent;
}

export function defineEmailProvider(p: EmailProvider): EmailProvider {
  return p;
}
```

Changes vs today's interface (`providers/email.ts:120-138`):

- adds `meta` (required) + `capabilities` (optional);
- `verifyWebhook`/`parseWebhook` return `EmailEvent` (not `WebhookEvent`);
- `verifyWebhook` may be async;
- the provider owns its own secrets — there is **no** mailer-level
  `webhookSecret` anymore (§7.5).

---

## 4. The `EmailProviderRegistry` + config resolution

### 4.1 Registry (container-held, NOT a process singleton)

```ts
// packages/engine/src/lib/email-provider-registry.ts (new)
export class EmailProviderRegistry {
  private byId = new Map<string, EmailProvider>();
  constructor(ps: EmailProvider[] = []) {
    for (const p of ps) this.byId.set(p.meta.id, p); // last-writer-wins
  }
  get(id: string): EmailProvider | undefined {
    return this.byId.get(id);
  }
  getAll(): EmailProvider[] {
    return [...this.byId.values()];
  }
  count(): number {
    return this.byId.size;
  }
}
```

**Why container-held, not a singleton:** the `DestinationRegistry` singleton
(`destinations/registry-singleton.ts`) exists ONLY because the self-booting
`deliverWebhookTask` has no container. The email provider is built inside
`createHogsendClient` (`container.ts:304`) and read by (a) the mailer it
constructs and (b) the webhook route, which **has** the container via
`c.get("container")`. Neither is a self-booting task, so the singleton + lazy
preset fallback is dead weight here. Hold it on `HogsendClient.emailProviders`.

### 4.2 Env presets

```ts
// packages/engine/src/lib/email-providers-from-env.ts (new)
export function emailProvidersFromEnv(env): EmailProvider[] {
  const out: EmailProvider[] = [];
  if (env.RESEND_API_KEY) {
    out.push(
      createResendProvider({
        apiKey: env.RESEND_API_KEY,
        webhookSecret: env.RESEND_WEBHOOK_SECRET,
      }),
    );
  }
  // future: if (env.POSTMARK_SERVER_TOKEN) out.push(createPostmarkProvider(...))
  return out;
}
```

Lazy: a provider preset is built only when its key is present. With
`RESEND_API_KEY` made optional (§6), a Postmark-only deploy contributes no
Resend provider here.

### 4.3 Config & resolution (in `container.ts`)

Extend `opts.email`:

```ts
email?: {
  provider?: EmailProvider;       // back-compat single provider
  providers?: EmailProvider[];    // NEW
  defaultProvider?: string;       // NEW — the active id
  templates?: TemplateRegistry;
};
```

Merge (consumer last/wins, mirrors the destinations merge at `container.ts:366`):

```ts
const providers = [
  ...emailProvidersFromEnv(env),
  ...(opts.email?.providers ?? []),
  ...(opts.email?.provider ? [opts.email.provider] : []),
];
const registry = new EmailProviderRegistry(providers);

const activeId =
  opts.email?.defaultProvider ?? env.EMAIL_PROVIDER ?? "resend";
let active = registry.get(activeId);

if (!active) {
  if (activeId === "resend") {
    // The ONLY place RESEND_API_KEY is read directly. Lazily build + register.
    active = createResendProvider({
      apiKey: env.RESEND_API_KEY, // now optional; throw if truly absent
      webhookSecret: env.RESEND_WEBHOOK_SECRET,
    });
    registry["byId"].set("resend", active); // or a registry.register() method
  } else {
    throw new Error(
      `email.defaultProvider "${activeId}" is not registered (registered: ${registry
        .getAll()
        .map((p) => p.meta.id)
        .join(", ")})`,
    );
  }
}
```

Rules:

- Default active id is `'resend'` lazily built — byte-for-byte today's default.
- A `defaultProvider` that resolves to **nothing** THROWS at boot with the list
  of registered ids. **Never** silently fall back to resend for a non-resend id.
- The single resolved `active` provider is injected into `createTrackedMailer`
  (back-compat with `deps.provider` + `overrides.mailer`). The **route** holds
  the registry. This resolves the two-altitude ambiguity: mailer holds ONE
  provider; route holds the registry.
- After resolution, if `active.capabilities?.nativeTracking === true`, log a
  boot WARN (§8).

### 4.4 `HogsendClient` additions

In `container.ts` `HogsendClient` (lines 58-104):

- DROP `email: Resend` (`container.ts:64`) — a Resend SDK type leaking onto the
  DI surface with no real consumer.
- ADD `emailProviders: EmailProviderRegistry;`
- ADD `emailProvider: EmailProvider;` (the resolved active one).
- Remove `createResendClient` import + the `const email = createResendClient(...)`
  at `container.ts:13-16,252` and the `email` field in the returned object
  (`container.ts:407`).

---

## 5. The webhook route `POST /v1/webhooks/email/:providerId`

New file `packages/engine/src/routes/webhooks/email-provider.ts`. Registered in
`registerWebhookRoutes` (`routes/webhooks/index.ts:11-17`) **BEFORE** the
`:sourceId` catch-all so Hono matches the static `email` prefix first:

```ts
// routes/webhooks/index.ts
export function registerWebhookRoutes(app, opts) {
  app.route("/v1/webhooks", resendWebhookRouter);   // kept as a thin alias
  registerEmailProviderRoutes(app);                 // /v1/webhooks/email/:providerId  (BEFORE catch-all)
  registerWebhookSourceRoutes(app, opts.webhookSources); // /v1/webhooks/{sourceId}  (LAST)
}
```

Handler shape:

```ts
app.openapi(emailProviderWebhookRoute, async (c) => {
  const { providerId } = c.req.valid("param");
  const { emailProviders, emailService, logger } = c.get("container");
  const provider = emailProviders.get(providerId);
  if (!provider) return c.json({ error: "Unknown email provider" }, 404);

  const payload = await c.req.text(); // EXACT received bytes (signatures cover these)
  const headers: Record<string, string> = {};
  for (const [k, v] of c.req.raw.headers.entries()) headers[k.toLowerCase()] = v;

  try {
    const event = await provider.verifyWebhook({ payload, headers });
    const result = await emailService.handleWebhook(event, providerId);
    logger.info("Email provider webhook processed", {
      providerId,
      type: event.type,
      handled: result.handled,
    });
    return c.json({ ok: true }, 200);
  } catch (err) {
    if (err instanceof WebhookHandshakeSignal) {
      logger.info("Email webhook handshake", { providerId, action: err.action });
      return c.json({ ok: true }, 200);
    }
    logger.warn("Email provider webhook failed", {
      providerId,
      error: err instanceof Error ? err.message : String(err),
    });
    return c.json({ error: "Webhook verification failed" }, 401);
  }
});
```

- `handleWebhook` now takes the **already-verified** `EmailEvent` + `providerId`
  (route owns provider resolution + verification). See §7.5 for the new
  signature.
- The `verifyWebhook` returns a normalized event OR throws
  `WebhookHandshakeSignal` (route 200s) OR throws a verification error (route
  401s).
- The provider's verifyWebhook is the ONLY place body-shape knowledge lives —
  the route never sniffs `Type: 'SubscriptionConfirmation'`.

### 5.1 Reserve `email` as a forbidden source id

In `defineWebhookSource` (`webhook-sources/define-webhook-source.ts:76-80`), or
in `registerWebhookSourceRoutes` (`routes/webhooks/sources.ts:11`), validate at
registration that no source's `meta.id === "email"` — throw a clear error. This
prevents a source named `email` from shadowing the provider route.

### 5.2 `/v1/webhooks/resend` alias

Keep `resendWebhookRouter` (`routes/webhooks/resend.ts`) as a thin alias.
Rewrite its handler to resolve provider `'resend'` from the registry and verify
+ dispatch exactly like the generic route (so it shares the EmailEvent path).
Mark the route summary `@deprecated — use /v1/webhooks/email/resend`.

---

## 6. Env changes (`packages/engine/src/env.ts`)

- `RESEND_API_KEY`: `z.string().min(1)` → **`z.string().min(1).optional()`**
  (`env.ts:30`). It is read directly ONLY in the lazy-resend branch (§4.3) and
  `emailProvidersFromEnv`.
- ADD `EMAIL_PROVIDER: z.string().optional()` — the active provider id.
- ADD `EMAIL_FROM: z.string().email().optional()` — neutral default-from, with
  `RESEND_FROM_EMAIL` as the fallback. In `container.ts` the mailer
  `defaultFrom` becomes `env.EMAIL_FROM ?? env.RESEND_FROM_EMAIL`
  (`container.ts:330`).
- DO **NOT** add a single `EMAIL_WEBHOOK_SECRET` — one secret cannot serve N
  providers. Webhook secrets live on each provider at construction (§7.5).
- `RESEND_FROM_EMAIL` / `RESEND_WEBHOOK_SECRET` stay (used by the resend preset).

---

## 7. The breaking contract change (mailer, tracked, plugin-resend)

### 7.1 Always render React → HTML before the wire

`packages/engine/src/lib/tracked.ts:259-279`: the wire receives **HTML only**.
Kill BOTH escape hatches:

- `tracked.ts:275` — `...(html ? { html } : { react: sendElement })`. Replace
  with: always render. When `prepareTrackedHtml` + `baseUrl` are present, render
  then rewrite (tracked); otherwise render plain HTML (no tracking rewrite):

  ```ts
  let html: string;
  if (options.baseUrl && prepareTrackedHtml) {
    const rawHtml = await renderToHtml(sendElement);
    html = await prepareTrackedHtml({ html: rawHtml, emailSendId, baseUrl: options.baseUrl, db });
  } else {
    html = await renderToHtml(sendElement);
  }
  const result = await provider.send({
    from: options.from,
    to: options.to,
    subject,
    html,
    metadata: tagsToMetadata(options.tags), // §7.4
    tag: tagsToTag(options.tags),
    headers: sendHeaders,
    replyTo: options.replyTo,
  });
  ```

- `mailer.ts:121-135` — the no-DB branch passes `react: element`. Replace with
  `html: await renderToHtml(element)`. (`renderToHtml` is already imported at
  `mailer.ts:15`.)

`@hogsend/email` `renderToHtml` is the SAME render the tracked happy path
already uses — React Email stays first-class everywhere it authors/previews.

### 7.2 `EmailEvent` flows through verifyWebhook

`plugin-resend` adapts Resend's verified union into `EmailEvent`
(`plugin-resend/src/webhooks.ts`):

- `verifyWebhook` still svix-verifies over the raw payload, THEN maps Resend's
  `data.email_id` → `messageId`, `data.to` → `recipients`, `created_at` →
  `occurredAt`, `data.click` → `click`, and `data.bounce.{type,message}` →
  `bounce`. `parseWebhook` does the same minus verification.
- **Resend `bounce.type` → `bounce.class` table** (Resend gives a free string,
  no enum). Store the raw string in `bounce.code`:

  | Resend `bounce.type` (case-insensitive contains) | `class` |
  | --- | --- |
  | `HardBounce`, `Permanent`, `SuppressedRecipient`, `Suppressed` | `permanent` |
  | `SoftBounce`, `Transient`, `MailboxFull`, `Throttled`, `Undetermined`(transient) | `transient` |
  | `Complaint`, `Spam`, `Abuse` | `complaint` |
  | anything else | `unknown` (conservative — no auto-suppress) |

  Seed this table from Resend's real values and TEST it; an unlisted
  previously-suppressing string silently stops incrementing `bounceCount`.

### 7.3 `dispatchWebhook` reads normalized fields + iterates ALL recipients

Rewrite `mailer.ts:193-251` to read `event.messageId`, `event.recipients`,
`event.bounce.{class,code,reason}`, `event.click`:

```ts
async function dispatchWebhook(event: EmailEvent, userHandlers): Promise<boolean> {
  switch (event.type) {
    case "email.sent":
      await updateEmailStatus(event.type, event.messageId);
      break;
    case "email.delivered":
      await updateEmailStatus(event.type, event.messageId);
      await emitProviderEmailEvent("email.delivered", event.messageId);
      break;
    case "email.opened":
    case "email.clicked":
      // first-party owns these — DB status touch only, NEVER emit outbound
      await updateEmailStatus(event.type, event.messageId);
      break;
    case "email.bounced":
      await updateEmailStatus(event.type, event.messageId, {
        bounceType: event.bounce?.class,        // store class in bounceType
        bounceReason: event.bounce?.reason,
      });
      await emitProviderEmailEvent("email.bounced", event.messageId, {
        bounceType: event.bounce?.class,
        bounceReason: event.bounce?.reason,
      });
      // suppress ONLY on permanent (§8 bounce normalization)
      if (event.bounce?.class === "permanent") {
        await handleBounce(event.recipients);
      }
      break;
    case "email.complained":
      await updateEmailStatus(event.type, event.messageId);
      await emitProviderEmailEvent("email.complained", event.messageId);
      await handleComplaint(event.recipients);
      break;
    case "email.delivery_delayed":
      break; // providers now map transient → email.bounced w/ class:'transient'
  }
  const userHandler = userHandlers[event.type];
  if (userHandler) { await userHandler(event); return true; }
  return false;
}
```

`handleBounce` (`mailer.ts:253-268`) and `handleComplaint`
(`mailer.ts:270-283`) change signature to `(recipients: string[])` and **iterate
all recipients** (today they take `event.data.to` and use only `[0]`). Cap the
recipient count (e.g. skip if `recipients.length > 100`) and log, to avoid a
fan-out bounce mass-suppressing.

### 7.4 `tags` → `{tag, metadata}` translation in the mailer

Add helpers in `mailer.ts`:

```ts
const tagsToTag = (tags?: Array<{ name: string; value: string }>) =>
  tags?.[0]?.value; // first tag → neutral tag
const tagsToMetadata = (tags?: Array<{ name: string; value: string }>) =>
  tags ? Object.fromEntries(tags.map((t) => [t.name, t.value])) : undefined;
```

Apply at every `provider.send(...)` call site in `mailer.ts` and `tracked.ts`.
`EmailServiceSendOptions.tags` / `SendTrackedEmailOptions.tags` stay
`Array<{name,value}>` (`email-service-types.ts:51,133`).

### 7.5 Per-provider secrets — delete the mailer-level gate

- DELETE the `if (!config.webhookSecret) throw` hard-gate
  (`mailer.ts:172-176`) and the `webhookSecret?: string` field on
  `EmailServiceConfig` (`email-service-types.ts:105`).
- `handleWebhook` no longer verifies. New signature (route verifies + passes the
  event):

  ```ts
  // EmailService.handleWebhook(event: EmailEvent, providerId: string)
  async handleWebhook(event: EmailEvent, providerId: string)
    : Promise<EmailServiceWebhookResult> {
    const handled = await dispatchWebhook(event, config.webhookHandlers ?? {});
    return { type: event.type, handled };
  }
  ```

  Update `EmailServiceWebhookOptions` usage and `EmailServiceWebhookResult`
  (`email-service-types.ts:141-149,166-168`) accordingly.
- `createResendProvider` keeps owning its svix `webhookSecret` (already does:
  `plugin-resend/src/provider.ts:42-56`). Drop `webhookSecret` from
  `createTrackedMailer` config in `container.ts:333`.

### 7.6 `scheduledAt` capability gate

Before `provider.send`, if `options.scheduledAt` is set and
`provider.capabilities?.scheduledSend !== true`, log a WARN and drop it
(`logger.warn("scheduledAt ignored: provider <id> has no native scheduled send; use ctx.sleepUntil")`).
Apply in `tracked.ts` / `mailer.ts` where send options are assembled.

### 7.7 `WebhookHandlerMap` keys unchanged; handler bodies migrate

`WebhookHandlerMap` keys stay `email.*` (`providers/email.ts:105-109`). Each
handler now receives `Extract<EmailEvent, { type: K }>`. Existing consumer
handler **bodies** that read `event.data.email_id` / `event.data.bounce` must
switch to `event.messageId` / `event.bounce` OR cast
`event.raw as LegacyResendWebhookEvent` during the deprecation window. Ship a
changeset + codemod note (§10).

---

## 8. Tracking rule & bounce normalization

### 8.1 `capabilities.nativeTracking` enforcement

The rule: **first-party tracking is the single source of truth; provider-native
tracking MUST be off, enforced as strongly as the provider allows.**

- Providers that CAN force it off per-send (Postmark `TrackOpens:false,
  TrackLinks:'None'`; SES omit open/click from the config-set) declare
  `nativeTracking: false` and the engine TRUSTS it — genuinely enforced.
- Resend's open/click tracking is an account-level toggle the provider can't
  disable per-send, so the Resend provider declares `nativeTracking: true`. The
  engine does ONE concrete thing: at boot, if the **active** provider has
  `nativeTracking === true`, log a WARN:

  ```
  provider <id> reports account-level native tracking ON; disable it in the
  dashboard — first-party tracking is Hogsend's source of truth.
  ```

- The outbound-echo suppression stays as defence: an `email.opened` /
  `email.clicked` provider webhook only touches DB status, never emits outbound
  (`dispatchWebhook` `email.opened`/`email.clicked` branch). So a misconfigured
  Resend account is at most a redundant DB status touch (first-write-wins),
  never a second link-rewrite or a second outbound event.

### 8.2 Bounce → suppression

- `bounce.class` drives suppression. **Auto-suppress (`bounceCount++` toward
  threshold) ONLY on `class === 'permanent'`** (§7.3).
- Transient/soft bounces map to `email.bounced` carrying `bounce.class:
  'transient'` — they ARE recorded (`bouncedAt`, `status: 'bounced'`,
  `bounceType: 'transient'`) but do **NOT** increment the suppression counter.
  This is the explicit fix for the old `transient → email.delivery_delayed`
  mapping, which was a pure no-op (`mailer.ts:238` records nothing — zero DB
  effect). DOCUMENT this as intentional: soft bounces now appear in
  `email_sends` as bounced.
- `complaint` → `email.complained` → `handleComplaint` (immediate suppress).
- `unknown` → recorded, never suppresses (conservative).
- `handleBounce`/`handleComplaint` iterate ALL `event.recipients` (§7.3).

---

## 9. Per-phase implementation checklist (FILE:LINE)

Phasing keeps existing Resend consumers from breaking at runtime: the
inherently-breaking surface is type-level (compile-caught) + the DB rename
(additive) + the `webhookHandlers` shape (mitigated by a deprecated alias).

### Phase 0 — non-breaking enablers

- [ ] `env.ts:30` — `RESEND_API_KEY` → `.optional()`.
- [ ] `env.ts` (server block) — add `EMAIL_PROVIDER: z.string().optional()` and
  `EMAIL_FROM: z.string().email().optional()`.
- [ ] `container.ts:13-16` — drop the `createResendClient` import (keep
  `createResendProvider`).
- [ ] `container.ts:16` — drop `import type { Resend } from "resend"`.
- [ ] `container.ts:64` — remove `email: Resend` from `HogsendClient`.
- [ ] `container.ts:252` — remove `const email = createResendClient(...)`.
- [ ] `container.ts:407` — remove `email` from the returned object.
- [ ] `container.ts:304-309` — keep the lazy-resend default for now (registry
  comes in Phase 1); make `defaultFrom = env.EMAIL_FROM ?? env.RESEND_FROM_EMAIL`
  at `container.ts:330`.
- [ ] `routes/webhooks/index.ts:11-17` — add `registerEmailProviderRoutes(app)`
  BEFORE `registerWebhookSourceRoutes`.
- [ ] NEW `routes/webhooks/email-provider.ts` — the `:providerId` route (§5).
  (Resolves provider from `container.emailProviders` — wire fully in Phase 1;
  in Phase 0 it can resolve a single active provider off the client.)
- [ ] `routes/webhooks/sources.ts:11` (or `define-webhook-source.ts:76`) —
  reserve `email` as a forbidden source id (§5.1).
- [ ] `routes/webhooks/resend.ts` — keep as alias; mark summary deprecated.

**Test (Phase 0):** boot with no `RESEND_API_KEY` set and a stub provider →
boots; `POST /v1/webhooks/email/resend` reaches the handler; a source with
`meta.id: "email"` throws at registration; existing `/v1/webhooks/resend` still
200s.

### Phase 1 — registry + meta (non-breaking add)

- [ ] `providers/email.ts` — add `EmailProviderMeta`,
  `EmailProviderCapabilities`, `defineEmailProvider`; add `meta` +
  `capabilities` to `EmailProvider` (optional `capabilities`).
- [ ] `plugin-resend/src/provider.ts:30` — return via `defineEmailProvider({...})`
  with `meta: { id: "resend", name: "Resend" }` and `capabilities: {
  nativeTracking: true, scheduledSend: true, signedWebhooks: true }`.
- [ ] NEW `lib/email-provider-registry.ts` — `EmailProviderRegistry` (§4.1).
- [ ] NEW `lib/email-providers-from-env.ts` — `emailProvidersFromEnv` (§4.2).
- [ ] `container.ts` — extend `opts.email` with `providers?` + `defaultProvider?`
  (`container.ts:137-140`); build registry + resolve active (§4.3); add
  `emailProviders` + `emailProvider` to `HogsendClient` and the returned object;
  inject `active` into `createTrackedMailer`.
- [ ] `container.ts` — boot WARN when `active.capabilities?.nativeTracking`
  (§8.1).
- [ ] `routes/webhooks/email-provider.ts` — read `container.emailProviders.get`.
- [ ] `core` + `engine` index — export `defineEmailProvider`,
  `EmailProviderMeta`, `EmailProviderCapabilities`, `EmailProviderRegistry`,
  `WebhookHandshakeSignal`.

**Test (Phase 1):** `defaultProvider: "postmark"` with no postmark registered
THROWS at boot with the registered-ids list; no email config resolves `'resend'`
lazily; `opts.email.providers` + `opts.email.provider` merge consumer-last.

### Phase 2 — `resend_id` → `message_id` (additive, zero-downtime) + index

Migration + the COMPLETE rename inventory + three deprecated aliases.

**DB:**

- [ ] `db/src/schema/email-sends.ts:25` — `resendId: text("resend_id")` →
  `messageId: text("message_id")`.
- [ ] `db/src/schema/email-sends.ts:47-63` — ADD
  `index("email_sends_message_id_idx").on(table.messageId)` (none exists today;
  the by-id resolver seq-scans).
- [ ] `cd packages/db && pnpm db:generate` — produces
  `ALTER TABLE email_sends RENAME COLUMN resend_id TO message_id` +
  `CREATE INDEX email_sends_message_id_idx`. Verify the generated SQL is a
  RENAME (not drop+add) so data is preserved.

**Engine (rename + aliases):**

- [ ] `lib/tracking-events.ts:8-14` — `EmailSendContext.resendId` → `messageId`.
- [ ] `lib/tracking-events.ts:24,40` — select/return `emailSends.messageId`.
- [ ] `lib/tracking-events.ts:45-51` — `ResendEmailSendContext` →
  `EmailSendContext` (the by-id-keyed one; if names now collide, name the
  by-message-id result `EmailSendContextByMessageId`).
- [ ] `lib/tracking-events.ts:64-93` — `resolveEmailSendContextByResendId` →
  `resolveEmailSendContextByMessageId`; param `resendId` → `messageId`;
  `.where(eq(emailSends.messageId, messageId))`.
- [ ] `lib/tracking-events.ts` — ADD `@deprecated export const
  resolveEmailSendContextByResendId = resolveEmailSendContextByMessageId;`
- [ ] `lib/outbound.ts:18-20` — re-export the new names; ADD the deprecated
  re-export alias for `resolveEmailSendContextByResendId`.
- [ ] `lib/outbound.ts:31` — `EmailEventPayload.resendId: string | null` →
  `messageId: string | null` (KEEP nullable).
- [ ] `lib/outbound.ts:72` — `OutboundPayloads["email.sent"].resendId: string`
  → `messageId: string` (KEEP **required** — do not loosen).
- [ ] `lib/email-service-types.ts:66` — `TrackedSendResult.resendId: string` →
  `messageId: string`; ADD a `@deprecated` read-alias getter `resendId` that
  returns `messageId` (or document that consumers map it).
- [ ] `lib/tracked.ts:76,140,170` — placeholder `resendId: ""` → `messageId: ""`.
- [ ] `lib/tracked.ts:285,309,327` — `resendId: result.id` → `messageId:
  result.id`.
- [ ] `lib/mailer.ts:32` — import `resolveEmailSendContextByMessageId`.
- [ ] `lib/mailer.ts:133` — `resendId: result.id` → `messageId: result.id`.
- [ ] `lib/mailer.ts:289,298,304,309,349,357,375` — rename the
  `emitProviderEmailEvent` param + the `resolveEmailSendContextByMessageId`
  call + the outbound `messageId` field + `eq(emailSends.messageId, messageId)`.
- [ ] `routes/tracking/click.ts:124` — `resendId: ctx.resendId ?? null` →
  `messageId: ctx.messageId ?? null`.
- [ ] `routes/tracking/open.ts:84` — same.
- [ ] `routes/admin/emails.ts:29` — `resendId: z.string().nullable()` →
  `messageId`; ADD a deprecated `resendId: z.string().nullable()` in the
  response schema for one minor.
- [ ] `routes/admin/emails.ts:91` (`serializeEmail`) — `resendId: row.resendId`
  → `messageId: row.messageId`, AND emit BOTH `messageId` + deprecated
  `resendId: row.messageId` for one minor.
- [ ] `engine/src/index.ts:208` — export `resolveEmailSendContextByMessageId`;
  keep the `@deprecated` re-export `resolveEmailSendContextByResendId`.

**Studio + seed:**

- [ ] `studio/src/lib/admin-api.ts:31` — `resendId: string | null` →
  `messageId: string | null` (the admin response carries both during the
  deprecation window, so this can switch to `messageId`).
- [ ] `studio/src/views/sends/send-detail-drawer.tsx:170` —
  `value={detail.email.resendId ?? "—"}` → `detail.email.messageId ?? "—"`.
- [ ] `db/src/demo-seed.ts:545` — `resendId:` → `messageId:`.

**Tests:**

- [ ] `apps/api/src/__tests__/outbound-webhooks-emit.test.ts:215,301` —
  `resendId:` → `messageId:`.
- [ ] `apps/api/src/__tests__/outbound-webhooks-delivery.test.ts:753` —
  `resendId: null` → `messageId: null`.

**Test (Phase 2):** migration is a column RENAME (data preserved); the by-message
resolver hits `email_sends_message_id_idx`; admin response carries BOTH
`messageId` and (deprecated) `resendId`; the deprecated function alias resolves.

### Phase 3 — the breaking contract change (one coordinated engine minor)

- [ ] `providers/email.ts:1` — delete `import { ReactElement } from "react"`.
- [ ] `providers/email.ts:7-19` — `SendEmailOptions`: `html` required, drop
  `react`, drop `tags`, add `tag?` + `metadata?` + `text?` (§3.5).
- [ ] `providers/email.ts:21-31` — `BatchEmailItem = Omit<SendEmailOptions,
  "scheduledAt">`.
- [ ] `providers/email.ts:41-101` — mark `WebhookEvent` + members `@deprecated`;
  add `LegacyResendWebhookEvent = WebhookEvent`.
- [ ] `providers/email.ts` — add `EmailEvent` + `EmailEventType` (§3.1),
  `WebhookHandshakeSignal` (§3.4).
- [ ] `providers/email.ts:120-138` — `EmailProvider.verifyWebhook`/`parseWebhook`
  return `EmailEvent`; `verifyWebhook` may be async.
- [ ] `core` `providers/email.ts` — remove the `react` peer/types dep from
  `@hogsend/core` if no other core file imports React (verify).
- [ ] `lib/tracked.ts:259-279` — always render HTML; kill the react hatch (§7.1).
- [ ] `lib/tracked.ts` — apply `tagsToTag`/`tagsToMetadata` at the
  `provider.send` call (§7.4); apply the `scheduledAt` capability gate (§7.6).
- [ ] `lib/mailer.ts:121-135` — no-DB branch renders HTML (§7.1).
- [ ] `lib/mailer.ts:1-7` — import `EmailEvent`, `EmailEventType`,
  `WebhookHandlerMap` (drop `WebhookEvent`).
- [ ] `lib/mailer.ts:169-188` — `handleWebhook(event, providerId)` (§7.5).
- [ ] `lib/mailer.ts:172-176` — DELETE the `webhookSecret` gate.
- [ ] `lib/mailer.ts:193-251` — rewrite `dispatchWebhook` to normalized fields,
  suppress only on `permanent` (§7.3).
- [ ] `lib/mailer.ts:253-283` — `handleBounce`/`handleComplaint` take
  `recipients: string[]` and iterate all (§7.3).
- [ ] `lib/email-service-types.ts:105` — remove `webhookSecret`.
- [ ] `lib/email-service-types.ts:141-149` — adapt `handleWebhook` signature in
  `EmailService` + `EmailServiceWebhookResult`.
- [ ] `container.ts:333` — drop `webhookSecret` from `createTrackedMailer`.
- [ ] `plugin-resend/src/types.ts` — re-export the new core types; keep deprecated
  `WebhookEvent` re-export for one minor.
- [ ] `plugin-resend/src/webhooks.ts` — `verifyWebhook`/`parseWebhookEvent`
  return `EmailEvent` (adapt + the `bounce.type → class` table, §7.2).
- [ ] `plugin-resend/src/provider.ts:42-61` — `verifyWebhook`/`parseWebhook`
  return `EmailEvent`.
- [ ] `plugin-resend/src/send.ts:107,178` — drop the `react` fallback; send
  `html` only (the `...(options.html ? {html} : {react})` ternary becomes
  `html: options.html`); map `tags` → Resend `tags` from `metadata`/`tag` if you
  keep Resend tag support, else pass nothing.
- [ ] `plugin-resend/src/index.ts:11-26` — export the new types; keep deprecated
  `WebhookEvent` for one minor.
- [ ] `engine/src/index.ts:12-20` — export `EmailEvent`, `EmailEventType`,
  `defineEmailProvider`, `WebhookHandshakeSignal`; keep deprecated `WebhookEvent`.
- [ ] `routes/admin/emails.ts:25-53` — verify the `eventSchema` /
  `bounceType`/`bounceReason` surfacing still matches (bounceType now holds the
  `class`).
- [ ] Run the `release` skill: bump `ENGINE_VERSION` + all 7 scaffold packages on
  the engine minor line; verify a real `create-hogsend` install compiles.

**Test (Phase 3):** the Resend `bounce.type → class` table (each row); suppress
ONLY on `permanent`; multi-recipient bounce iterates all; transient bounce
records `email.bounced` with `class:'transient'` and does NOT suppress;
HTML-only send (no react reaches the wire); `event.raw as
LegacyResendWebhookEvent` still typechecks; Studio render/preview path still
compiles (React Email intact).

### Phase 4 — `@hogsend/plugin-postmark`

- [x] Scaffold `packages/plugin-postmark` from `plugin-resend` (`type: module`,
  `src/index.ts` raw TS, dep `@hogsend/core` `workspace:^` + `postmark` SDK,
  tsup `external: ["postmark"]`). Use `pnpm add postmark@latest`.
- [x] Implement `createPostmarkProvider` (§11). Force `TrackOpens: false`,
  `TrackLinks: "None"` per send; `capabilities: { nativeTracking: false,
  scheduledSend: false, signedWebhooks: false }`; fail-closed when
  `webhookBasicAuth` is unset; transient bounces → `email.bounced` w/
  `class:'transient'`; non-status RecordTypes throw `WebhookHandshakeSignal`.
- [x] Add `POSTMARK_SERVER_TOKEN` + `POSTMARK_WEBHOOK_*` to
  `emailProvidersFromEnv` (optional preset).
- [ ] **First publish MUST be MANUAL** — CI `NPM_TOKEN` cannot CREATE a new
  `@hogsend/*` package; thereafter CI handles it. Bump onto the engine version
  line (run `release`). _(deferred — not published this slice)_

**Test (Phase 4):** Postmark `TypeCode` table → `class`; `toMessage` always
HTML; unconfigured webhook fails closed; SubscriptionChange throws the handshake
signal the route 200s; a Delivery/Bounce/SpamComplaint webhook updates
`email_sends`.

#### Opt-in (Postmark is NOT the default)

Resend stays the default. Postmark is opt-in two equivalent ways; in both, you
still must set `EMAIL_PROVIDER=postmark` (or `email.defaultProvider: "postmark"`)
to make it the **active** provider — registering it alone never changes the
default.

1. **Env preset** — set `POSTMARK_SERVER_TOKEN` (+ optional
   `POSTMARK_MESSAGE_STREAM`, and `POSTMARK_WEBHOOK_USER` /
   `POSTMARK_WEBHOOK_PASS` for the HTTP-Basic webhook auth). The preset is built
   ONLY when the token is present (`emailProvidersFromEnv`), so a deploy with no
   Postmark token contributes no Postmark provider:

   ```bash
   POSTMARK_SERVER_TOKEN=pm_xxx
   POSTMARK_WEBHOOK_USER=hogsend
   POSTMARK_WEBHOOK_PASS=super-secret
   EMAIL_PROVIDER=postmark
   ```

2. **In code** — register it explicitly on the container:

   ```ts
   import { createPostmarkProvider } from "@hogsend/plugin-postmark";

   createHogsendClient({
     email: {
       providers: [
         createPostmarkProvider({
           serverToken: process.env.POSTMARK_SERVER_TOKEN!,
           webhookBasicAuth: { user: "hogsend", pass: process.env.POSTMARK_WEBHOOK_PASS! },
         }),
       ],
       defaultProvider: "postmark",
     },
   });
   ```

Postmark has no native scheduled send (`capabilities.scheduledSend: false`), so a
`scheduledAt` is logged + dropped by the engine — use `ctx.sleepUntil` instead.
Webhook authenticity is HTTP Basic creds in the webhook URL (no HMAC): unset
creds → `verifyWebhook` fails closed and the status update is rejected.

---

## 10. Back-compat / deprecation-alias plan

All aliases ship in the same minor as their rename and are removed **deliberately
the following minor** (track in a changeset). Aliases to ship:

| Surface | New | Deprecated alias (one minor) |
| --- | --- | --- |
| `TrackedSendResult` | `messageId` | `resendId` read-alias |
| Admin `GET` emails response | `messageId` | also emit `resendId` |
| Engine SDK export | `resolveEmailSendContextByMessageId` | re-export `resolveEmailSendContextByResendId` |
| `outbound.ts` re-export | `EmailSendContext` (by-message) | re-export old `ResendEmailSendContext` |
| Core webhook union | `EmailEvent` | `LegacyResendWebhookEvent` (= old `WebhookEvent`) + `WebhookEvent` kept `@deprecated` |
| plugin-resend export | `EmailEvent` types | `WebhookEvent` kept `@deprecated` |
| Route | `/v1/webhooks/email/resend` | `/v1/webhooks/resend` thin alias |

`webhookHandlers` migration (the single most consumer-facing break): keys stay
`email.*`; handler **bodies** that read `event.data.*` migrate to `event.*`
fields OR cast `event.raw as LegacyResendWebhookEvent`. Ship a changeset +
codemod note. A consumer who ignores the deprecation reads `undefined` off the
new shape, so the alias MUST actually ship.

---

## 11. Postmark provider reference implementation

```ts
// @hogsend/plugin-postmark — src/index.ts
import { ServerClient } from "postmark";
import {
  type BatchEmailItem,
  defineEmailProvider,
  type EmailEvent,
  type EmailEventType,
  type EmailProvider,
  type SendEmailOptions,
  type SendResult,
  WebhookHandshakeSignal,
} from "@hogsend/core";

interface PostmarkConfig {
  serverToken: string;
  messageStream?: string;
  webhookBasicAuth?: { user: string; pass: string };
}

export function createPostmarkProvider(cfg: PostmarkConfig): EmailProvider {
  const client = new ServerClient(cfg.serverToken);
  const stream = cfg.messageStream ?? "outbound";
  const join = (v?: string | string[]) =>
    v ? ([] as string[]).concat(v).join(",") : undefined;

  const toMessage = (o: SendEmailOptions | BatchEmailItem) => ({
    From: o.from,
    To: join(o.to),
    Cc: join(o.cc),
    Bcc: join(o.bcc),
    Subject: o.subject,
    HtmlBody: o.html, // engine ALWAYS renders HTML — no React on the wire
    TextBody: o.text,
    ReplyTo: join(o.replyTo),
    Tag: o.tag,
    Metadata: o.metadata,
    Headers: o.headers
      ? Object.entries(o.headers).map(([Name, Value]) => ({ Name, Value }))
      : undefined,
    TrackOpens: false, // NATIVE TRACKING OFF — first-party is sovereign
    TrackLinks: "None" as const,
    MessageStream: stream,
  });

  return defineEmailProvider({
    meta: { id: "postmark", name: "Postmark" },
    capabilities: {
      nativeTracking: false,
      scheduledSend: false,
      signedWebhooks: false,
    },

    async send(o) {
      const r = await client.sendEmail(toMessage(o));
      if (r.ErrorCode !== 0)
        throw new Error(`Postmark ${r.ErrorCode}: ${r.Message}`);
      return { id: r.MessageID } satisfies SendResult;
    },

    async sendBatch(items) {
      const r = await client.sendEmailBatch(items.map(toMessage)); // chunk at 500 if needed
      return { results: r.map((x) => ({ id: x.MessageID })) };
    },

    // Postmark has no svix/HMAC. Auth = HTTP Basic creds in the webhook URL.
    // FAIL CLOSED when unconfigured so an unauthenticated status update is rejected.
    verifyWebhook({ payload, headers }) {
      if (!cfg.webhookBasicAuth)
        throw new Error("Postmark webhook auth not configured");
      const expected =
        "Basic " +
        Buffer.from(
          `${cfg.webhookBasicAuth.user}:${cfg.webhookBasicAuth.pass}`,
        ).toString("base64");
      if (headers["authorization"] !== expected)
        throw new Error("Postmark webhook auth failed");
      return this.parseWebhook(payload);
    },

    parseWebhook(payload) {
      const p = JSON.parse(payload) as Record<string, any>;
      const recipients = [p.Recipient ?? p.Email].filter(Boolean);
      const base = { messageId: p.MessageID as string, recipients, raw: p };
      switch (p.RecordType as string) {
        case "Delivery":
          return { ...base, type: "email.delivered" as EmailEventType, occurredAt: p.DeliveredAt };
        case "Open":
          // arrives only if native tracking is on (we keep it off → status no-op echo)
          return { ...base, type: "email.opened" as EmailEventType, occurredAt: p.ReceivedAt };
        case "Click":
          return {
            ...base,
            type: "email.clicked" as EmailEventType,
            occurredAt: p.ReceivedAt,
            click: { url: p.OriginalLink, at: p.ReceivedAt, ua: p.UserAgent },
          };
        case "SpamComplaint":
          return {
            ...base,
            type: "email.complained" as EmailEventType,
            occurredAt: p.BouncedAt ?? new Date().toISOString(),
            bounce: { class: "complaint", code: "SpamComplaint", reason: p.Description },
          };
        case "Bounce": {
          // TypeCode: HardBounce=1, Transient=2, DnsError=256, SpamNotification=512,
          // SoftBounce=4096, BadEmailAddress=100000, SpamComplaint=100001, Blocked=100006…
          const code: number = p.TypeCode;
          const complaint = code === 100001 || code === 512;
          const transient = code === 2 || code === 4096 || code === 256;
          const cls = complaint ? "complaint" : transient ? "transient" : "permanent";
          // Do NOT map transient → email.delivery_delayed (engine no-ops it).
          // Map BOTH transient + permanent → email.bounced; carry bounce.class so
          // the ENGINE decides suppression (only 'permanent' increments).
          return {
            ...base,
            type: (complaint ? "email.complained" : "email.bounced") as EmailEventType,
            occurredAt: p.BouncedAt,
            bounce: { class: cls, code: String(p.Type), reason: p.Description },
          };
        }
        default:
          // SubscriptionChange etc. — not a delivery-status event. Throw a typed
          // skip the route 200s.
          throw new WebhookHandshakeSignal(`ignored RecordType ${p.RecordType}`);
      }
    },
  });
}
```

---

## 12. Risks carried forward (from the design)

- **`webhookHandlers` body break** — handler bodies must migrate or use the
  `raw` cast; a consumer who ignores the deprecation reads `undefined`. The
  alias MUST ship and be removed deliberately.
- **Resend `bounce.type` is a free string** — the class table is best-effort;
  `unknown` must be conservative (no suppression). Seed from real values + test.
- **Postmark/SES have no svix signature** — fail-closed on missing creds.
- **Resend native tracking left ON** by a careless operator still
  double-rewrites links; the engine logs a boot WARN but can't force the account
  toggle — documented operational requirement for Resend.
- **Always-render-to-HTML** removes Resend's server-side React fast-path; do a
  visual diff on a few templates before Phase 3 ships (low risk — the tracked
  happy path already renders via `@hogsend/email`).
- **Soft bounces now recorded** as `email.bounced` (intentional, documented).
- **Multi-recipient bounce fan-out** — cap/validate `recipients.length` before
  iterating to avoid mass-suppression.
- **`scheduledAt` silently dropped** on non-Resend providers — capability gate +
  WARN + docs to `ctx.sleepUntil`.
- **SES redelivery (later track)** — SNS is at-least-once; derive a `dedupeKey`
  from the SNS MessageId before SES ships. SES is a clean follow-on through the
  `WebhookHandshakeSignal` seam (async `verifyWebhook` + SubscriptionConfirmation
  GET SubscribeURL + X.509 verify + multi-recipient normalize); defer until
  Postmark validates the contract.

---

## 13. Effort

- Phase 0: M — env/container/route, mechanical; the lazy-construct + active-id
  resolution is the subtlety.
- Phase 1: M — container-held registry (less code than mirroring
  `DestinationRegistry`); the resolve-or-throw is the only new logic.
- Phase 2: M-L — one migration + ~14 mechanical edits + 3 deprecated aliases;
  broad but shallow.
- Phase 3: L — the conceptual core + the one breaking change; needs the most
  test coverage.
- Phase 4: S-M — ~1 day provider + parser + basic-auth verify + the
  manual-first-publish + version-line ritual.
- SES (later): L — +4-6 days.

Total to first-class Postmark: ~1.5-2 focused weeks (Phases 0-4).
