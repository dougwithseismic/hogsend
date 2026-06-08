// The email-provider contract now lives in the neutral @hogsend/core package.
// These re-exports keep every existing `import ... from "@hogsend/plugin-resend"`
// working unchanged.

// --- Deprecated Resend-shaped union (frozen one minor) ---------------------
// These no longer flow through verifyWebhook/parseWebhook (which now return the
// provider-neutral `EmailEvent`); they remain only as `event.raw` cast targets.
export type {
  BatchEmailItem,
  /** @deprecated Use {@link EmailEvent}; cast `event.raw`. */
  EmailBouncedEvent,
  /** @deprecated Use {@link EmailEvent}; cast `event.raw`. */
  EmailClickedEvent,
  /** @deprecated Use {@link EmailEvent}; cast `event.raw`. */
  EmailComplainedEvent,
  /** @deprecated Use {@link EmailEvent}; cast `event.raw`. */
  EmailDeliveredEvent,
  /** @deprecated Use {@link EmailEvent}; cast `event.raw`. */
  EmailDeliveryDelayedEvent,
  EmailEvent,
  EmailEventType,
  /** @deprecated Use {@link EmailEvent}; cast `event.raw`. */
  EmailOpenedEvent,
  EmailProvider,
  EmailProviderCapabilities,
  EmailProviderMeta,
  /** @deprecated Use {@link EmailEvent}; cast `event.raw`. */
  EmailSentEvent,
  /** @deprecated Use {@link EmailEvent}. Frozen `event.raw` cast target. */
  LegacyResendWebhookEvent,
  SendEmailOptions,
  SendResult,
  /** @deprecated Use {@link EmailEvent}. Kept for one minor. */
  WebhookEvent,
  /** @deprecated Use {@link EmailEventType}. Kept for one minor. */
  WebhookEventType,
  WebhookHandlerMap,
} from "@hogsend/core";
export { defineEmailProvider, WebhookHandshakeSignal } from "@hogsend/core";
