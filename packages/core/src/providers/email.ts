import type { ReactElement } from "react";

// ---------------------------------------------------------------------------
// Send options
// ---------------------------------------------------------------------------

export interface SendEmailOptions {
  from: string;
  to: string | string[];
  subject: string;
  react?: ReactElement;
  html?: string;
  replyTo?: string | string[];
  cc?: string | string[];
  bcc?: string | string[];
  scheduledAt?: string;
  tags?: Array<{ name: string; value: string }>;
  headers?: Record<string, string>;
}

export interface BatchEmailItem {
  from: string;
  to: string | string[];
  subject: string;
  react: ReactElement;
  replyTo?: string | string[];
  cc?: string | string[];
  bcc?: string | string[];
  tags?: Array<{ name: string; value: string }>;
  headers?: Record<string, string>;
}

export interface SendResult {
  id: string;
}

// ---------------------------------------------------------------------------
// Webhook events
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

export interface EmailSentEvent extends WebhookEventBase {
  type: "email.sent";
}

export interface EmailDeliveredEvent extends WebhookEventBase {
  type: "email.delivered";
}

export interface EmailBouncedEvent extends WebhookEventBase {
  type: "email.bounced";
  data: WebhookEventBase["data"] & {
    bounce: {
      message: string;
      type: string;
    };
  };
}

export interface EmailComplainedEvent extends WebhookEventBase {
  type: "email.complained";
}

export interface EmailDeliveryDelayedEvent extends WebhookEventBase {
  type: "email.delivery_delayed";
}

export interface EmailOpenedEvent extends WebhookEventBase {
  type: "email.opened";
}

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

export type WebhookEvent =
  | EmailSentEvent
  | EmailDeliveredEvent
  | EmailBouncedEvent
  | EmailComplainedEvent
  | EmailDeliveryDelayedEvent
  | EmailOpenedEvent
  | EmailClickedEvent;

export type WebhookEventType = WebhookEvent["type"];

export type WebhookHandlerMap = {
  [K in WebhookEventType]?: (
    event: Extract<WebhookEvent, { type: K }>,
  ) => void | Promise<void>;
};

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
   * Verify a provider webhook signature and return the parsed event. Throws
   * if the signature is missing/invalid.
   */
  verifyWebhook(opts: {
    payload: string;
    headers: Record<string, string>;
  }): WebhookEvent;

  /** Parse an unsigned webhook payload (used in trusted contexts/tests). */
  parseWebhook(payload: string): WebhookEvent;
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
