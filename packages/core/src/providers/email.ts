// ---------------------------------------------------------------------------
// Send options (HTML-only wire — NO React)
// ---------------------------------------------------------------------------

/**
 * The provider send wire. HTML-ONLY: the engine ALWAYS renders React → HTML
 * itself (via `@hogsend/email` `renderToHtml`) before calling `send`, so no
 * React ever crosses the provider boundary. React Email stays first-class for
 * template authoring + Studio preview — only this wire is HTML.
 */
export interface SendEmailOptions {
  from: string;
  to: string | string[];
  subject: string;
  /** REQUIRED — the engine always renders React → HTML before the wire. */
  html: string;
  /** Optional plain-text alternative. */
  text?: string;
  replyTo?: string | string[];
  cc?: string | string[];
  bcc?: string | string[];
  /** Neutral provider-funnel tag (Resend first tag; Postmark Tag; SES no-op). */
  tag?: string;
  /** Neutral key→value metadata (Resend tags; Postmark Metadata; SES MessageTag). */
  metadata?: Record<string, string>;
  headers?: Record<string, string>;
  /** Honored only when `capabilities.scheduledSend`; else logged + ignored. */
  scheduledAt?: string;
}

/** A single batch item — the send wire minus the per-message `scheduledAt`. */
export type BatchEmailItem = Omit<SendEmailOptions, "scheduledAt">;

export interface SendResult {
  id: string;
}

// ---------------------------------------------------------------------------
// Provider-neutral email events (the normalized webhook shape)
// ---------------------------------------------------------------------------

/**
 * Provider-neutral email event types. The `email.` prefix is intentional — it
 * keeps the `WebhookHandlerMap` keys, `WEBHOOK_TO_STATUS`,
 * `WEBHOOK_TO_STATUS_FIELD`, and the outbound catalog all UNCHANGED.
 */
export type EmailEventType =
  | "email.sent"
  | "email.delivered"
  | "email.bounced"
  | "email.complained"
  | "email.delivery_delayed"
  | "email.opened"
  | "email.clicked";

/**
 * The provider-neutral email event every provider's `verifyWebhook`/
 * `parseWebhook` normalizes its verbatim webhook into. This is the ONE shape the
 * engine's `dispatchWebhook` reads — Resend, Postmark, and SES all adapt their
 * wire payloads into this. The untouched provider payload is preserved in `raw`
 * as a handler escape hatch (cast to {@link LegacyResendWebhookEvent} for the
 * old Resend shape during the deprecation window).
 */
export interface EmailEvent {
  type: EmailEventType;
  /** Resend `email_id` | Postmark `MessageID` | SES `mail.messageId`. */
  messageId: string;
  /** ALL recipients (SES bounce/complaint carry many). */
  recipients: string[];
  /** ISO 8601 timestamp of the provider event. */
  occurredAt: string;
  /** Present on `email.bounced` / `email.complained`. Drives suppression. */
  bounce?: {
    class: "permanent" | "transient" | "complaint" | "unknown";
    code: string;
    reason?: string;
  };
  /** Present on `email.clicked` (native-tracking echo only; first-party owns clicks). */
  click?: { url: string; at?: string; ip?: string; ua?: string };
  /** The untouched provider payload, for handler escape-hatch + debugging. */
  raw: unknown;
}

/**
 * Per-event handler map. Keys are UNCHANGED `email.*` event types; each handler
 * now receives the provider-neutral {@link EmailEvent}. Handler bodies that read
 * the old Resend shape (`event.data.email_id`, `event.data.bounce`) must switch
 * to `event.messageId` / `event.bounce` OR cast
 * `event.raw as LegacyResendWebhookEvent` during the deprecation window.
 */
export type WebhookHandlerMap = {
  [K in EmailEventType]?: (
    event: Extract<EmailEvent, { type: K }>,
  ) => void | Promise<void>;
};

/**
 * Thrown by `verifyWebhook` when the request was a non-delivery-status handshake
 * (e.g. SNS SubscriptionConfirmation, Postmark SubscriptionChange) that the
 * provider already handled. The webhook route catches it and returns 200.
 * Provider-specific body-shape knowledge stays entirely inside the provider —
 * the engine route NEVER sniffs the body.
 */
export class WebhookHandshakeSignal extends Error {
  constructor(readonly action: string) {
    super(action);
    this.name = "WebhookHandshakeSignal";
  }
}

// ---------------------------------------------------------------------------
// Legacy Resend-shaped webhook union (frozen escape hatch, one minor)
// ---------------------------------------------------------------------------

interface WebhookEventBase {
  created_at: string;
  data: {
    email_id: string;
    from: string;
    to: string[];
    subject: string;
    created_at: string;
  };
}

/** @deprecated Use {@link EmailEvent}. Frozen for one minor as a `raw` cast target. */
export interface EmailSentEvent extends WebhookEventBase {
  type: "email.sent";
}

/** @deprecated Use {@link EmailEvent}. Frozen for one minor as a `raw` cast target. */
export interface EmailDeliveredEvent extends WebhookEventBase {
  type: "email.delivered";
}

/** @deprecated Use {@link EmailEvent}. Frozen for one minor as a `raw` cast target. */
export interface EmailBouncedEvent extends WebhookEventBase {
  type: "email.bounced";
  data: WebhookEventBase["data"] & {
    bounce: {
      message: string;
      type: string;
    };
  };
}

/** @deprecated Use {@link EmailEvent}. Frozen for one minor as a `raw` cast target. */
export interface EmailComplainedEvent extends WebhookEventBase {
  type: "email.complained";
}

/** @deprecated Use {@link EmailEvent}. Frozen for one minor as a `raw` cast target. */
export interface EmailDeliveryDelayedEvent extends WebhookEventBase {
  type: "email.delivery_delayed";
}

/** @deprecated Use {@link EmailEvent}. Frozen for one minor as a `raw` cast target. */
export interface EmailOpenedEvent extends WebhookEventBase {
  type: "email.opened";
}

/** @deprecated Use {@link EmailEvent}. Frozen for one minor as a `raw` cast target. */
export interface EmailClickedEvent extends WebhookEventBase {
  type: "email.clicked";
  data: WebhookEventBase["data"] & {
    click: {
      link: string;
      timestamp: string;
      ipAddress: string;
      userAgent: string;
    };
  };
}

/**
 * @deprecated The Resend-shaped webhook union, frozen for one minor. It no
 * longer flows through `verifyWebhook`/`parseWebhook` — those now return the
 * provider-neutral {@link EmailEvent}. Cast `event.raw as WebhookEvent` (alias
 * {@link LegacyResendWebhookEvent}) inside a `webhookHandler` to keep reading the
 * old nested shape while you migrate to {@link EmailEvent} fields. Removed the
 * following minor.
 */
export type WebhookEvent =
  | EmailSentEvent
  | EmailDeliveredEvent
  | EmailBouncedEvent
  | EmailComplainedEvent
  | EmailDeliveryDelayedEvent
  | EmailOpenedEvent
  | EmailClickedEvent;

/**
 * @deprecated The Resend-shaped webhook union, frozen for one minor. Cast
 * `event.raw as LegacyResendWebhookEvent` inside a `webhookHandler` to keep
 * reading the old nested shape while you migrate to {@link EmailEvent} fields.
 * Removed the following minor.
 */
export type LegacyResendWebhookEvent = WebhookEvent;

/**
 * @deprecated Use {@link EmailEventType}. Kept for one minor as the type of the
 * legacy union's `type` discriminant.
 */
export type WebhookEventType = WebhookEvent["type"];

// ---------------------------------------------------------------------------
// Provider identity & capabilities
// ---------------------------------------------------------------------------

/**
 * Provider identity. `id` is the key the {@link EmailProviderRegistry} indexes
 * by and the `:providerId` the `POST /v1/webhooks/email/:providerId` route
 * dispatches on. `name` is the human label; `description` is optional prose.
 */
export interface EmailProviderMeta {
  id: string;
  name: string;
  description?: string;
}

/**
 * What the provider's wire can and can't do. Drives engine-side enforcement
 * decisions (the tracking-sovereignty boot WARN, the `scheduledAt` capability
 * gate). All flags are optional — an absent flag is treated conservatively.
 */
export interface EmailProviderCapabilities {
  /**
   * Whether the provider's OWN open/click tracking is active and the engine
   * cannot force it off per-send. `false` = the provider disables it per-send
   * (Postmark TrackOpens:false/TrackLinks:'None'; SES omit from config-set) and
   * the engine TRUSTS that. `true` = an account-level toggle the engine can't
   * reach (Resend) → the engine logs a boot WARN. First-party open/click
   * tracking is always the single source of truth.
   */
  nativeTracking?: boolean;
  /** Honors `SendEmailOptions.scheduledAt` (Resend yes; Postmark/SES no). */
  scheduledSend?: boolean;
  /**
   * Has a crypto signature scheme (Resend svix; SES SNS cert). `false` = the
   * provider must fail-closed on its own (Postmark basic-auth).
   */
  signedWebhooks?: boolean;
}

// ---------------------------------------------------------------------------
// EmailProvider contract (the entire provider surface)
// ---------------------------------------------------------------------------

/**
 * The dumb delivery + webhook parse/verify contract every email provider
 * implements (Resend, Postmark, SES, …). All tracking, DB, preference, and
 * render logic lives in the engine's `createTrackedMailer`, never here.
 */
export interface EmailProvider {
  /**
   * Provider identity. `meta.id` is the key the {@link EmailProviderRegistry}
   * indexes by and the `:providerId` the webhook route dispatches on. Optional
   * for back-compat with providers built before the registry; the registry
   * falls back to `"resend"` when absent. Becomes required in a later
   * (breaking) phase — new providers should always supply it.
   */
  readonly meta?: EmailProviderMeta;
  /**
   * Optional declaration of what the provider's wire supports. Read by the
   * engine for the native-tracking boot WARN and the `scheduledAt` gate. Absent
   * is treated conservatively (no native tracking assumed, no scheduled send).
   */
  readonly capabilities?: EmailProviderCapabilities;

  /** Deliver a single message. Returns the provider message id. */
  send(options: SendEmailOptions): Promise<SendResult>;

  /** Deliver a batch of messages. */
  sendBatch(emails: BatchEmailItem[]): Promise<{ results: SendResult[] }>;

  /**
   * Verify the provider's webhook (owns its OWN secrets, constructed-in) and
   * return a normalized {@link EmailEvent}. Throws on a bad signature. Throws
   * {@link WebhookHandshakeSignal} for non-status handshakes (the route 200s
   * those). MAY be async (SES must GET the SNS SubscribeURL).
   */
  verifyWebhook(opts: {
    payload: string;
    headers: Record<string, string>;
  }): Promise<EmailEvent> | EmailEvent;

  /** Parse an unsigned webhook payload (trusted contexts/tests). */
  parseWebhook(payload: string): EmailEvent;
}

/**
 * Identity factory for an {@link EmailProvider}. Mirrors `defineWebhookSource` /
 * `defineDestination` — it returns its argument unchanged but pins the literal
 * shape to the {@link EmailProvider} contract, so a typo in `meta` or a missing
 * method is caught at definition time rather than at the call site.
 */
export function defineEmailProvider(provider: EmailProvider): EmailProvider {
  return provider;
}
