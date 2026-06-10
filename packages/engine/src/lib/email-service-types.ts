import type {
  BatchEmailItem,
  DurationObject,
  EmailEvent,
  EmailEventType,
  SendEmailOptions,
  SendResult,
  WebhookHandlerMap,
} from "@hogsend/core";
import type {
  EmailServiceRenderOptions,
  EmailServiceRenderResult,
  RetryOptions,
  TemplateName,
  TemplateRegistry,
  TemplateRegistryMap,
} from "@hogsend/email";
import type { Logger } from "./logger.js";

export type {
  BatchEmailItem,
  SendEmailOptions,
  SendResult,
} from "@hogsend/core";

/**
 * Input to the mailer's low-level {@link EmailService.sendRaw}: the provider
 * contract's `SendEmailOptions`, but `from` is optional — the mailer resolves it
 * from `config.defaultFrom` when absent (see `resolveFrom` in mailer.ts). The
 * wire contract keeps `from` required because the provider always receives a
 * resolved address.
 */
export type SendRawOptions = Omit<SendEmailOptions, "from"> & { from?: string };

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
  /** Denormalized recipient identity, persisted on the email_sends row for reporting. */
  userId?: string;
  userEmail?: string;
  category?: string;
  tags?: Array<{ name: string; value: string }>;
  headers?: Record<string, string>;
  replyTo?: string | string[];
  skipPreferenceCheck?: boolean;
  baseUrl?: string;
  /**
   * Caller-supplied idempotency key (POST /v1/emails). A retry with the same key
   * short-circuits to the prior `email_sends` row instead of dispatching a
   * duplicate provider send.
   */
  idempotencyKey?: string;
}

export interface TrackedSendResult {
  emailSendId: string;
  /** The provider's neutral message id (Resend email_id / Postmark MessageID). */
  messageId: string;
  /**
   * @deprecated Renamed to {@link TrackedSendResult.messageId}. This read-alias
   * always mirrors `messageId`; kept for one minor and removed the following
   * minor. Build results via {@link trackedSendResult} so the alias stays live.
   */
  resendId: string;
  status: "sent" | "suppressed" | "unsubscribed" | "skipped";
  /**
   * Present only when `status === "skipped"`:
   * - `"frequency_capped"` — the per-recipient frequency cap was hit.
   * - `"test_mode_blocked"` — test mode was active but no redirect address
   *   resolved (no `HOGSEND_TEST_EMAIL` / `STUDIO_ADMIN_EMAIL`), so the send was
   *   blocked rather than delivered to the real recipient.
   */
  reason?: "frequency_capped" | "test_mode_blocked";
}

/**
 * Build a {@link TrackedSendResult}, attaching a live `@deprecated` `resendId`
 * read-alias getter that mirrors `messageId`. Lets every send path return a
 * single canonical `messageId` while public consumers reading the old `resendId`
 * field keep working for one minor.
 */
export function trackedSendResult(
  result: Omit<TrackedSendResult, "resendId">,
): TrackedSendResult {
  return Object.defineProperty({ ...result }, "resendId", {
    get(this: { messageId: string }) {
      return this.messageId;
    },
    enumerable: true,
  }) as TrackedSendResult;
}

// ---------------------------------------------------------------------------
// Frequency capping (client default config)
// ---------------------------------------------------------------------------

export interface FrequencyCapWindow {
  count: number;
  window: DurationObject;
}

export interface FrequencyCapConfig {
  /** Global send count allowed within `window` per recipient. */
  count: number;
  window: DurationObject;
  /** Per-category overrides (count + window, filtered by that category). */
  byCategory?: Record<string, FrequencyCapWindow>;
  /** Categories exempt from capping. Defaults to ["transactional"]. */
  exemptCategories?: string[];
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
  webhookHandlers?: WebhookHandlerMap;
  retryOptions?: RetryOptions;
  bounceThreshold?: number;
  baseUrl?: string;
  /**
   * Optional per-client frequency cap. When set, sends are counted per
   * recipient within the window and skipped (no provider call, no `sent` row)
   * once the cap is reached. Opt-in: undefined ⇒ no capping.
   */
  frequencyCap?: FrequencyCapConfig;
  /** Optional structured logger; used e.g. to record frequency-cap skips. */
  logger?: Logger;
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
  /** Denormalized recipient identity, persisted on the email_sends row for reporting. */
  userId?: string;
  userEmail?: string;
  category?: string;
  tags?: Array<{ name: string; value: string }>;
  headers?: Record<string, string>;
  replyTo?: string | string[];
  skipPreferenceCheck?: boolean;
  /** Caller-supplied idempotency key (POST /v1/emails) — dedups duplicate sends. */
  idempotencyKey?: string;
}

/**
 * @deprecated The route now verifies the provider webhook and hands
 * {@link EmailService.handleWebhook} an already-parsed {@link EmailEvent}. This
 * raw `{ payload, headers }` shape is no longer the handler input.
 */
export interface EmailServiceWebhookOptions {
  payload: string;
  headers: Record<string, string>;
}

export interface EmailServiceWebhookResult {
  type: EmailEventType;
  handled: boolean;
}

export interface EmailService {
  send<K extends TemplateName>(
    options: EmailServiceSendOptions<K>,
  ): Promise<TrackedSendResult>;

  sendRaw(options: SendRawOptions): Promise<SendResult>;

  sendBatch(options: { emails: BatchEmailItem[] }): Promise<{
    results: SendResult[];
  }>;

  render<K extends TemplateName>(
    options: EmailServiceRenderOptions<K>,
  ): Promise<EmailServiceRenderResult>;

  /**
   * Dispatch an already-verified, provider-neutral {@link EmailEvent} into the
   * status/suppression/outbound pipeline. The webhook route owns provider
   * resolution + signature verification and passes the parsed event + the
   * resolving `providerId` (the latter is informational for now).
   */
  handleWebhook(
    event: EmailEvent,
    providerId?: string,
  ): Promise<EmailServiceWebhookResult>;
}
