import type {
  EmailServiceRenderOptions,
  EmailServiceRenderResult,
  RetryOptions,
  TemplateName,
  TemplateRegistry,
  TemplateRegistryMap,
} from "@hogsend/email";
import type {
  BatchEmailItem,
  SendEmailOptions,
  SendResult,
  WebhookEventType,
  WebhookHandlerMap,
} from "@hogsend/plugin-resend";

export type {
  BatchEmailItem,
  SendEmailOptions,
  SendResult,
} from "@hogsend/plugin-resend";

// ---------------------------------------------------------------------------
// Tracked email (high-level API)
// ---------------------------------------------------------------------------

export interface SendTrackedEmailOptions<
  K extends TemplateName = TemplateName,
> {
  templateKey: K;
  props: TemplateRegistryMap[K];
  from: string;
  to: string;
  subject?: string;
  journeyStateId?: string;
  category?: string;
  tags?: Array<{ name: string; value: string }>;
  headers?: Record<string, string>;
  replyTo?: string | string[];
  skipPreferenceCheck?: boolean;
  baseUrl?: string;
}

export interface TrackedSendResult {
  emailSendId: string;
  resendId: string;
  status: "sent" | "suppressed" | "unsubscribed";
}

// ---------------------------------------------------------------------------
// Email service (high-level DX) — engine-owned tracked mailer
// ---------------------------------------------------------------------------

export interface EmailServiceConfig {
  defaultFrom: string;
  /**
   * The client app's template registry (key → component + subject + category).
   * Threaded into `getTemplate(..., { registry })` at send + render time so the
   * engine never bakes in concrete business templates. Required to send/render
   * any template; an empty registry simply has no sendable keys.
   */
  templates: TemplateRegistry;
  db?: unknown;
  webhookSecret?: string;
  webhookHandlers?: WebhookHandlerMap;
  retryOptions?: RetryOptions;
  bounceThreshold?: number;
  baseUrl?: string;
}

export interface EmailServiceSendOptions<
  K extends TemplateName = TemplateName,
> {
  template: K;
  props: TemplateRegistryMap[K];
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
