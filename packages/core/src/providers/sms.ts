// `WebhookHandshakeSignal` (channel-neutral) is re-exported from the barrel via
// email.js — SMS providers import it from `@hogsend/core` directly.

// ---------------------------------------------------------------------------
// Send options (plain-text wire — NO React)
// ---------------------------------------------------------------------------

/**
 * The provider send wire. TEXT-ONLY: the engine ALWAYS renders React → plain
 * text itself (via `@hogsend/sms` `renderSmsToText`) before calling `send`, so
 * no React ever crosses the provider boundary. SMS is single-recipient — there
 * is no cc/bcc and `to` is one E.164 number.
 */
export interface SendSmsOptions {
  /**
   * E.164 sender. Optional — the provider may pin a default sender (a Twilio
   * from-number or a messagingServiceSid) at construction, in which case the
   * engine leaves this unset.
   */
  from?: string;
  /** E.164 recipient. */
  to: string;
  /** Plain-text body — the engine renders React → text before the wire. */
  body: string;
}

export interface SmsSendResult {
  id: string;
}

// ---------------------------------------------------------------------------
// Provider-neutral SMS events (the normalized webhook shape)
// ---------------------------------------------------------------------------

/**
 * Provider-neutral SMS failure classification. Mirrors {@link BounceClass} for
 * email: `permanent` drives carrier auto-suppression (the engine writes an
 * `sms_suppressions` row — an invalid/unreachable number should not be paid to
 * text again), `transient` is recorded but never suppresses, `unknown` is the
 * conservative default.
 */
export type SmsFailureClass = "permanent" | "transient" | "unknown";

/**
 * Provider-neutral SMS event types. The `sms.` prefix keeps the engine's status
 * field map + outbound catalog keys uniform with the `email.` family. SMS has a
 * much smaller lifecycle than email — no opens/clicks/bounces. `sms.inbound` is
 * a mobile-originated message (STOP/START/HELP/free-text) the provider forwards.
 */
export type SmsEventType =
  | "sms.sent"
  | "sms.delivered"
  | "sms.failed"
  | "sms.inbound";

/**
 * The provider-neutral SMS event every provider's `verifyWebhook`/`parseWebhook`
 * normalizes its verbatim webhook into — the ONE shape the engine's SMS webhook
 * dispatcher reads. The untouched provider payload is preserved in `raw`.
 */
export interface SmsEvent {
  type: SmsEventType;
  /** Provider message id (Twilio MessageSid). For `sms.inbound`, the MO sid. */
  messageId: string;
  /**
   * E.164 number. Outbound events: the RECIPIENT (delivery target). For
   * `sms.inbound`: the SENDER (`From`) — the number that texted us.
   */
  phone: string;
  /** ISO 8601 timestamp of the provider event. */
  occurredAt: string;
  /** Present on `sms.failed`. `permanent` drives carrier auto-suppression. */
  failure?: {
    class: SmsFailureClass;
    code: string;
    reason?: string;
  };
  /**
   * Present on `sms.inbound` — the message body plus the number it was sent TO
   * (our receiving number). `phone` above is the sender.
   */
  inbound?: {
    body: string;
    to: string;
  };
  /** The untouched provider payload, for handler escape-hatch + debugging. */
  raw: unknown;
}

/**
 * Per-event handler map — the SMS sibling of {@link WebhookHandlerMap}. Lets a
 * consumer observe normalized SMS events (e.g. mirror inbound replies into a
 * CRM) after the engine's built-in handling runs.
 */
export type SmsWebhookHandlerMap = {
  [K in SmsEventType]?: (
    event: Extract<SmsEvent, { type: K }>,
  ) => void | Promise<void>;
};

// ---------------------------------------------------------------------------
// Provider identity & capabilities
// ---------------------------------------------------------------------------

/**
 * Provider identity. `id` is the key the `SmsProviderRegistry` indexes by and
 * the `:providerId` the `POST /v1/webhooks/sms/:providerId` route dispatches on.
 * REQUIRED (unlike {@link EmailProviderMeta} whose optionality is pre-registry
 * back-compat) — SMS has no legacy providers to protect.
 */
export interface SmsProviderMeta {
  id: string;
  name: string;
  description?: string;
}

/**
 * What the provider's wire can and can't do. All flags optional; absent is
 * treated conservatively.
 */
export interface SmsProviderCapabilities {
  /** Has a crypto signature scheme (Twilio X-Twilio-Signature). */
  signedWebhooks?: boolean;
  /** Forwards mobile-originated (inbound) messages via webhook. */
  inboundMessages?: boolean;
  /** Reserved — honors a scheduled send. No engine gate in v1. */
  scheduledSend?: boolean;
}

// ---------------------------------------------------------------------------
// SmsProvider contract (the entire provider surface)
// ---------------------------------------------------------------------------

/**
 * The dumb delivery + webhook parse/verify contract every SMS provider
 * implements (Twilio, Telnyx, …). All preference, suppression, DB, render, and
 * STOP-keyword logic lives in the engine's tracked SMS sender, never here.
 */
export interface SmsProvider {
  /**
   * Provider identity. `meta.id` keys the registry and is the `:providerId` the
   * webhook route dispatches on. REQUIRED.
   */
  readonly meta: SmsProviderMeta;
  /**
   * Optional declaration of what the provider's wire supports. Absent is treated
   * conservatively (no signed webhooks, no inbound).
   */
  readonly capabilities?: SmsProviderCapabilities;

  /** Deliver a single message. Returns the provider message id. */
  send(options: SendSmsOptions): Promise<SmsSendResult>;

  /**
   * Verify the provider's webhook (owns its OWN secrets, constructed-in) and
   * return a normalized {@link SmsEvent}. Throws on a bad signature. Throws
   * {@link WebhookHandshakeSignal} for non-status handshakes / intermediate
   * statuses the route should 200 without dispatch. MAY be async.
   *
   * `url` is the canonical PUBLIC URL the provider POSTed to (the engine builds
   * it from `API_PUBLIC_URL` + path + query). Twilio's HMAC-SHA1 signs that URL
   * plus the sorted form params, so `c.req.url` (wrong host behind a proxy)
   * cannot be used — the engine supplies the deterministic public URL here.
   */
  verifyWebhook(opts: {
    payload: string;
    headers: Record<string, string>;
    url: string;
  }): Promise<SmsEvent> | SmsEvent;

  /** Parse an unsigned webhook payload (trusted contexts/tests). */
  parseWebhook(payload: string): SmsEvent;
}

/**
 * Identity factory for an {@link SmsProvider}. Mirrors `defineEmailProvider` —
 * returns its argument unchanged but pins the literal shape to the contract, so
 * a typo in `meta` or a missing method is caught at definition time.
 */
export function defineSmsProvider(provider: SmsProvider): SmsProvider {
  return provider;
}
