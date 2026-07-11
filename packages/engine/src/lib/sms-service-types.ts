import type {
  SendSmsOptions,
  SmsEvent,
  SmsEventType,
  SmsProvider,
  SmsWebhookHandlerMap,
} from "@hogsend/core";
import type {
  SmsTemplateName,
  SmsTemplateRegistry,
  SmsTemplateRegistryMap,
} from "@hogsend/sms";
import type { FrequencyCapConfig } from "./email-service-types.js";
import type { Logger } from "./logger.js";

// ---------------------------------------------------------------------------
// Tracked SMS (high-level API)
// ---------------------------------------------------------------------------

export interface SendTrackedSmsOptions<
  K extends SmsTemplateName = SmsTemplateName,
> {
  templateKey: K;
  props: SmsTemplateRegistryMap[K];
  from: string;
  to: string;
  journeyStateId?: string;
  /** Denormalized recipient identity, persisted on the sms_sends row. */
  userId?: string;
  category?: string;
  skipPreferenceCheck?: boolean;
  /**
   * Caller-supplied idempotency key. A retry with the same key short-circuits to
   * the prior `sms_sends` row instead of dispatching a duplicate provider send.
   */
  idempotencyKey?: string;
}

export interface SmsTrackedSendResult {
  smsSendId: string;
  /** The provider's neutral message id (Twilio MessageSid). */
  messageId: string;
  status: "sent" | "suppressed" | "unsubscribed" | "skipped";
  /**
   * Present only when `status === "skipped"`:
   * - `"frequency_capped"` — the per-recipient frequency cap was hit.
   * - `"journey_suppressed"` — the journey's `meta.suppress` min-gap found a
   *   recent SMS to this recipient from the same journey.
   * - `"test_mode_blocked"` — test mode active but no `HOGSEND_TEST_PHONE`, so
   *   the send was blocked rather than delivered to the real recipient.
   */
  reason?: "frequency_capped" | "journey_suppressed" | "test_mode_blocked";
}

// ---------------------------------------------------------------------------
// SMS service (high-level DX) — engine-owned tracked SMS sender
// ---------------------------------------------------------------------------

export interface SmsServiceConfig {
  defaultFrom?: string;
  /** The client app's SMS template registry (key → component + category). */
  templates: SmsTemplateRegistry;
  db?: unknown;
  webhookHandlers?: SmsWebhookHandlerMap;
  /** Optional per-client frequency cap; undefined disables capping. */
  frequencyCap?: FrequencyCapConfig;
  logger?: Logger;
  /**
   * The compliance footer appended to non-transactional bodies when it isn't
   * already present. `false` disables it entirely; a string overrides the
   * default `"Reply STOP to opt out"`.
   */
  stopFooter?: string | false;
  /**
   * Whether the engine sends STOP/START/HELP confirmation replies on inbound
   * keywords. Default `false`: Twilio's carrier-level opt-out already replies,
   * and a post-STOP send is blocked by error 21610 — a double reply is worse
   * than none. Operators who disable Twilio's Advanced Opt-Out can enable this.
   */
  optOutReplies?: boolean;
  /**
   * Resolves whether SMS test mode is active per send (container-wired from the
   * validated HOGSEND_TEST_MODE, coherent with the email side's auto-arm).
   * Absent ⇒ never active.
   */
  testMode?: () => boolean;
  /** The redirect target while test mode is active (env.HOGSEND_TEST_PHONE). */
  testPhone?: string;
}

export interface SmsServiceSendOptions<
  K extends SmsTemplateName = SmsTemplateName,
> {
  template: K;
  props: SmsTemplateRegistryMap[K];
  to: string;
  from?: string;
  journeyStateId?: string;
  userId?: string;
  category?: string;
  skipPreferenceCheck?: boolean;
  idempotencyKey?: string;
}

export interface SmsServiceRenderOptions<
  K extends SmsTemplateName = SmsTemplateName,
> {
  template: K;
  props: SmsTemplateRegistryMap[K];
}

export interface SmsServiceRenderResult {
  text: string;
  category?: string;
  segments: number;
}

export interface SmsServiceWebhookResult {
  type: SmsEventType;
  handled: boolean;
}

export interface SmsService {
  send<K extends SmsTemplateName>(
    options: SmsServiceSendOptions<K>,
  ): Promise<SmsTrackedSendResult>;

  /** Deliver a raw text body (no template, no tracking) — used for confirmations. */
  sendRaw(options: SendSmsOptions): Promise<{ id: string }>;

  render<K extends SmsTemplateName>(
    options: SmsServiceRenderOptions<K>,
  ): Promise<SmsServiceRenderResult>;

  /**
   * Dispatch an already-verified, provider-neutral {@link SmsEvent} into the
   * status/suppression/inbound pipeline. The webhook route owns provider
   * resolution + signature verification.
   */
  handleWebhook(
    event: SmsEvent,
    providerId?: string,
  ): Promise<SmsServiceWebhookResult>;
}

/** The active SMS provider a tracked sender delegates raw delivery to. */
export type { SmsProvider };
