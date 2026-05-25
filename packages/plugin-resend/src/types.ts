import type {
  EmailServiceRenderOptions,
  EmailServiceRenderResult,
  RetryOptions,
  TemplateMap,
  TemplateName,
} from "@hogsend/email";
import type { ReactElement } from "react";

// ---------------------------------------------------------------------------
// Send options
// ---------------------------------------------------------------------------

export interface SendEmailOptions {
  from: string;
  to: string | string[];
  subject: string;
  react: ReactElement;
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
// Tracked email (high-level API)
// ---------------------------------------------------------------------------

export interface SendTrackedEmailOptions<
  K extends TemplateName = TemplateName,
> {
  templateKey: K;
  props: TemplateMap[K];
  from: string;
  to: string;
  subject?: string;
  journeyStateId?: string;
  category?: string;
  tags?: Array<{ name: string; value: string }>;
  headers?: Record<string, string>;
  replyTo?: string | string[];
  skipPreferenceCheck?: boolean;
}

export interface TrackedSendResult {
  emailSendId: string;
  resendId: string;
  status: "sent" | "suppressed" | "unsubscribed";
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
// Email service (high-level DX)
// ---------------------------------------------------------------------------

export interface EmailServiceConfig {
  apiKey: string;
  defaultFrom: string;
  db?: unknown;
  webhookSecret?: string;
  webhookHandlers?: WebhookHandlerMap;
  retryOptions?: RetryOptions;
  bounceThreshold?: number;
}

export interface EmailServiceSendOptions<
  K extends TemplateName = TemplateName,
> {
  template: K;
  props: TemplateMap[K];
  to: string;
  from?: string;
  subject?: string;
  journeyStateId?: string;
  category?: string;
  tags?: Array<{ name: string; value: string }>;
  headers?: Record<string, string>;
  replyTo?: string | string[];
  skipPreferenceCheck?: boolean;
}

export interface EmailServiceWebhookOptions {
  payload: string;
  headers: Record<string, string>;
}

export interface EmailServiceWebhookResult {
  type: WebhookEventType;
  handled: boolean;
}

export interface EmailService {
  send<K extends TemplateName>(
    options: EmailServiceSendOptions<K>,
  ): Promise<TrackedSendResult>;

  sendRaw(options: SendEmailOptions): Promise<SendResult>;

  sendBatch(options: { emails: BatchEmailItem[] }): Promise<{
    results: SendResult[];
  }>;

  render<K extends TemplateName>(
    options: EmailServiceRenderOptions<K>,
  ): Promise<EmailServiceRenderResult>;

  handleWebhook(
    options: EmailServiceWebhookOptions,
  ): Promise<EmailServiceWebhookResult>;
}
