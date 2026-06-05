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
// EmailProvider contract (the entire provider surface)
// ---------------------------------------------------------------------------

/**
 * The dumb delivery + webhook parse/verify contract every email provider
 * implements (Resend, Postmark, SES, …). All tracking, DB, preference, and
 * render logic lives in the engine's `createTrackedMailer`, never here.
 */
export interface EmailProvider {
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
