import type { ReactElement } from "react";

// ---------------------------------------------------------------------------
// Template registry
// ---------------------------------------------------------------------------

export interface TemplateMap {
  welcome: WelcomeEmailProps;
  "password-reset": PasswordResetEmailProps;
  "journey-notification": JourneyNotificationEmailProps;
}

export type TemplateName = keyof TemplateMap;

export interface WelcomeEmailProps {
  name: string;
  dashboardUrl?: string;
}

export interface PasswordResetEmailProps {
  name: string;
  resetUrl: string;
  expiresInMinutes?: number;
}

export interface JourneyNotificationEmailProps {
  name: string;
  journeyName: string;
  eventName: string;
  body: string;
  unsubscribeUrl?: string;
}

export interface TemplateDefinition<P = Record<string, unknown>> {
  component: (props: P) => ReactElement;
  defaultSubject: string;
  category?: string;
  preview?: (props: P) => string;
}

export type TemplateRegistry = {
  [K in TemplateName]: TemplateDefinition<TemplateMap[K]>;
};

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
// Retry configuration
// ---------------------------------------------------------------------------

export interface RetryOptions {
  maxRetries?: number;
  baseDelayMs?: number;
  maxDelayMs?: number;
}

export const DEFAULT_RETRY_OPTIONS: Required<RetryOptions> = {
  maxRetries: 3,
  baseDelayMs: 500,
  maxDelayMs: 30_000,
};

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
// Errors
// ---------------------------------------------------------------------------

export class EmailSendError extends Error {
  readonly retryable: boolean;
  readonly statusCode?: number;

  constructor(
    message: string,
    options: { retryable: boolean; statusCode?: number; cause?: unknown },
  ) {
    super(message, { cause: options.cause });
    this.name = "EmailSendError";
    this.retryable = options.retryable;
    this.statusCode = options.statusCode;
  }
}

export class EmailSuppressionError extends Error {
  readonly reason: "unsubscribed" | "suppressed" | "category_unsubscribed";

  constructor(reason: EmailSuppressionError["reason"], email: string) {
    super(`Email to ${email} suppressed: ${reason}`);
    this.name = "EmailSuppressionError";
    this.reason = reason;
  }
}

export class WebhookVerificationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "WebhookVerificationError";
  }
}
