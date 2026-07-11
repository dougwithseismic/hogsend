import {
  type SmsEvent,
  type SmsFailureClass,
  WebhookHandshakeSignal,
} from "@hogsend/core";
// `twilio` v6 is CommonJS — `validateRequest` hangs off the default export, not
// an ESM named export (a named import type-checks but throws at runtime).
import twilio from "twilio";

const { validateRequest } = twilio;

/** Twilio delivery-receipt statuses that mean "handed off, nothing final yet". */
const INTERMEDIATE_STATUSES = new Set([
  "queued",
  "accepted",
  "scheduled",
  "sending",
]);

/**
 * Twilio error codes that are PERMANENT failures — the number is dead, not a
 * mobile, or has opted out. Drives `sms_suppressions(carrier_permanent)` on the
 * engine side, so classification is deliberately conservative: an ambiguous or
 * transient-leaning code must NOT auto-suppress a live subscriber.
 *
 * Excluded on purpose:
 * - 30003 (unreachable handset) — phone off / out of coverage; transient.
 * - 30004 (message blocked) — frequently a one-off carrier content/spam
 *   filter on a LIVE number, not an opt-out (that is 21610); suppressing on
 *   it would permanently silence a valid subscriber after a single filtered
 *   message. Recorded as `unknown` (logged, never suppresses).
 */
const PERMANENT_ERROR_CODES = new Set([
  "21610", // recipient unsubscribed (STOP)
  "21614", // not a valid mobile number
  "30005", // unknown handset / nonexistent number
  "30006", // landline / unreachable carrier
]);

function classifyFailure(errorCode: string | undefined): SmsFailureClass {
  if (!errorCode) return "unknown";
  if (PERMANENT_ERROR_CODES.has(errorCode)) return "permanent";
  return "unknown";
}

/** Parse a form-encoded Twilio payload into a flat string map. */
function parseForm(payload: string): Record<string, string> {
  const params = new URLSearchParams(payload);
  const out: Record<string, string> = {};
  for (const [k, v] of params.entries()) out[k] = v;
  return out;
}

/**
 * Normalize a parsed Twilio webhook (status callback OR inbound MO message) into
 * the provider-neutral {@link SmsEvent}. Throws {@link WebhookHandshakeSignal}
 * for intermediate statuses / unrecognized payloads so the route 200s without
 * dispatch.
 */
export function toSmsEvent(params: Record<string, string>): SmsEvent {
  const occurredAt = new Date().toISOString();
  const messageId = params.MessageSid ?? params.SmsSid ?? "";

  // Status callback: has a MessageStatus field.
  const status = params.MessageStatus ?? params.SmsStatus;
  if (status) {
    if (INTERMEDIATE_STATUSES.has(status)) {
      throw new WebhookHandshakeSignal(`intermediate_status:${status}`);
    }
    const base = {
      messageId,
      phone: params.To ?? "",
      occurredAt,
      raw: params,
    };
    if (status === "delivered") return { ...base, type: "sms.delivered" };
    if (status === "undelivered" || status === "failed") {
      const code = params.ErrorCode;
      return {
        ...base,
        type: "sms.failed",
        failure: {
          class: classifyFailure(code),
          code: code ?? "",
          ...(params.ErrorMessage ? { reason: params.ErrorMessage } : {}),
        },
      };
    }
    // "sent" (and anything else terminal-ish) → accepted-by-carrier echo.
    return { ...base, type: "sms.sent" };
  }

  // Inbound (mobile-originated) message: has Body + From, no MessageStatus.
  if (params.Body !== undefined && params.From) {
    return {
      type: "sms.inbound",
      messageId,
      phone: params.From,
      occurredAt,
      inbound: { body: params.Body, to: params.To ?? "" },
      raw: params,
    };
  }

  throw new WebhookHandshakeSignal("unrecognized_payload");
}

/**
 * Verify a Twilio webhook's `X-Twilio-Signature` (HMAC-SHA1 over the public URL
 * + sorted form params, keyed by the auth token) and normalize it. Fail-closed:
 * a missing signature/token throws.
 */
export function verifyWebhook(opts: {
  payload: string;
  headers: Record<string, string>;
  url: string;
  authToken: string;
}): SmsEvent {
  const signature =
    opts.headers["x-twilio-signature"] ?? opts.headers["X-Twilio-Signature"];
  if (!signature) {
    throw new Error("Missing X-Twilio-Signature header");
  }
  if (!opts.authToken) {
    throw new Error("Twilio authToken is required to verify webhooks");
  }

  const params = parseForm(opts.payload);
  const valid = validateRequest(opts.authToken, signature, opts.url, params);
  if (!valid) {
    throw new Error("Twilio webhook signature verification failed");
  }
  return toSmsEvent(params);
}

/** Parse an unsigned Twilio payload (trusted contexts/tests). */
export function parseWebhook(payload: string): SmsEvent {
  return toSmsEvent(parseForm(payload));
}
