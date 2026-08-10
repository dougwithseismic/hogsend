import { createHmac, timingSafeEqual } from "node:crypto";
import type { BounceClass, EmailEvent } from "@hogsend/core";
import { z } from "zod";

/**
 * THE RELAY WEBHOOK WIRE (PRD 04 owns this shape; PRD 05 produces it).
 *
 * The control plane receives SES's SNS/EventBridge notification, normalizes it
 * into this, signs it, and posts it to the tenant instance's
 * `POST /v1/webhooks/email/hogsend`. Defining it HERE rather than in the control
 * plane is what keeps 04 and 05 acyclic: the producer is downstream of the wire,
 * so the wire owns the shape.
 *
 * Two deliberate omissions:
 *
 * - **No opens, no clicks.** Those are FIRST-PARTY and sovereign (the engine's
 *   `/v1/t/o` + `/v1/t/c`), and SES native tracking stays off. A provider-side
 *   open event would give the engine two disagreeing sources of truth for the
 *   same fact, so this wire cannot express one.
 * - **No `bounce.class`.** The wire carries SES's own `bounceType` /
 *   `bounceSubType` verbatim and the PLUGIN maps them to the engine's neutral
 *   {@link BounceClass}. Classification is engine-side policy (it decides
 *   suppression); keeping it here means the control plane never has to guess,
 *   and an SES bounce type we have never seen defaults to `unknown` — recorded,
 *   never suppressing — instead of silently killing a deliverable address.
 */

/** The wire's schema version. Bumped only on a BREAKING change to the shape. */
export const HOGSEND_RELAY_EVENT_VERSION = 1;

/**
 * The only statuses a provider may report. Everything else about an email's
 * life is the engine's own.
 */
export const HOGSEND_RELAY_EMAIL_EVENT_TYPES = [
  "email.delivered",
  "email.bounced",
  "email.complained",
  "email.delivery_delayed",
] as const;

export type HogsendRelayEmailEventType =
  (typeof HOGSEND_RELAY_EMAIL_EVENT_TYPES)[number];

/**
 * The bounce facts, exactly as SES states them. `type` is SES's `bounceType`
 * (`Permanent` | `Transient` | `Undetermined`) or `Complaint`; `subType` is its
 * `bounceSubType` (`General`, `NoEmail`, `Suppressed`, `MailboxFull`, …).
 */
export const hogsendRelayBounceSchema = z.object({
  type: z.string().min(1),
  subType: z.string().min(1).optional(),
  reason: z.string().optional(),
});

/**
 * Not `strictObject`: a newer control plane adding a field must not break an
 * older instance. `version` is the compatibility gate, and `raw` preserves
 * anything this schema does not name.
 */
export const hogsendRelayEmailEventSchema = z.object({
  version: z.literal(HOGSEND_RELAY_EVENT_VERSION),
  type: z.enum(HOGSEND_RELAY_EMAIL_EVENT_TYPES),
  /** The SES message id — the SAME id `send` returned to the engine. */
  messageId: z.string().min(1),
  /**
   * Every recipient the status applies to (an SES bounce or complaint names
   * many). Deliberately NOT `.min(1)`: dropping a real bounce because it
   * arrived with no recipient list is far worse than recording one against the
   * message id, which is what the engine keys on anyway.
   */
  recipients: z.array(z.string()),
  occurredAt: z.string().datetime(),
  bounce: hogsendRelayBounceSchema.optional(),
  /** The verbatim SES/SNS notification, for debugging and `EmailEvent.raw`. */
  raw: z.unknown().optional(),
});

export type HogsendRelayEmailEvent = z.infer<
  typeof hogsendRelayEmailEventSchema
>;

// ---------------------------------------------------------------------------
// Signing
// ---------------------------------------------------------------------------

/** The header the relay puts its HMAC in. */
export const HOGSEND_RELAY_SIGNATURE_HEADER = "x-hogsend-signature";

const SIGNATURE_PREFIX = "sha256=";

/**
 * `sha256=<hex>` — HMAC-SHA256 of the RAW request body under the environment's
 * webhook secret.
 *
 * Exported so the producer (PRD 05) signs with the exact function the consumer
 * verifies with. A wire whose two ends implement the same scheme twice is a wire
 * with two chances to get it wrong.
 */
export function signHogsendRelayWebhook(opts: {
  payload: string;
  secret: string;
}): string {
  const digest = createHmac("sha256", opts.secret)
    .update(opts.payload, "utf8")
    .digest("hex");
  return `${SIGNATURE_PREFIX}${digest}`;
}

/**
 * Constant-time signature check.
 *
 * The length guard is not cosmetic: `timingSafeEqual` THROWS on unequal buffer
 * lengths, so a truncated signature would surface as a 500 rather than a clean
 * rejection.
 */
export function verifyHogsendRelaySignature(opts: {
  payload: string;
  secret: string;
  signature: string;
}): boolean {
  const trimmed = opts.signature.trim();
  // A PREFIX strip, not a `replace`: `replace` would also eat a `sha256=` that
  // appeared anywhere else in the string and mangle an otherwise-clean compare.
  const presented = trimmed.startsWith(SIGNATURE_PREFIX)
    ? trimmed.slice(SIGNATURE_PREFIX.length)
    : trimmed;
  const expected = signHogsendRelayWebhook({
    payload: opts.payload,
    secret: opts.secret,
  }).slice(SIGNATURE_PREFIX.length);
  if (presented.length !== expected.length) return false;
  return timingSafeEqual(Buffer.from(presented), Buffer.from(expected));
}

// ---------------------------------------------------------------------------
// Normalization into the provider-neutral EmailEvent
// ---------------------------------------------------------------------------

const BOUNCE_CLASSES: Record<string, BounceClass> = {
  permanent: "permanent",
  transient: "transient",
  complaint: "complaint",
  undetermined: "unknown",
};

/**
 * SES `bounceType` → the engine's neutral {@link BounceClass}.
 *
 * Anything unrecognized is `unknown`: recorded, never suppressing. Defaulting to
 * `permanent` would let one new SES bounce type quietly unsubscribe a whole
 * list.
 */
export function classifyHogsendRelayBounce(type: string): BounceClass {
  return BOUNCE_CLASSES[type.trim().toLowerCase()] ?? "unknown";
}

/** The most specific provider code available, without losing the general one. */
function bounceCode(type: string, subType?: string): string {
  return subType ? `${type}/${subType}` : type;
}

function toBounce(
  event: HogsendRelayEmailEvent,
): EmailEvent["bounce"] | undefined {
  // A delay is NOT a bounce. Attaching one would drive the engine's suppression
  // path off a message that may still be delivered.
  if (event.type !== "email.bounced" && event.type !== "email.complained") {
    return undefined;
  }

  // A complaint is a complaint whatever the relay named it — the event type is
  // the stronger signal and it is what drives immediate suppression.
  const isComplaint = event.type === "email.complained";
  const type = event.bounce?.type ?? (isComplaint ? "Complaint" : "Unknown");
  const cls = isComplaint ? "complaint" : classifyHogsendRelayBounce(type);

  return {
    class: cls,
    code: bounceCode(type, event.bounce?.subType),
    ...(event.bounce?.reason ? { reason: event.bounce.reason } : {}),
  };
}

/**
 * Adapt a relay payload into the provider-neutral {@link EmailEvent} the
 * engine's `dispatchWebhook` reads.
 *
 * `raw` is the whole parsed relay event: from the engine's point of view THIS
 * wire is the provider, and the verbatim SES notification is preserved one level
 * down in the relay event's own `raw`. Nothing is discarded.
 */
export function parseHogsendRelayWebhook(payload: string): EmailEvent {
  let json: unknown;
  try {
    json = JSON.parse(payload);
  } catch {
    throw new Error(
      "Hogsend relay webhook: the payload is not a Hogsend relay email event (not JSON)",
    );
  }

  const parsed = hogsendRelayEmailEventSchema.safeParse(json);
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    throw new Error(
      `Hogsend relay webhook: the payload is not a Hogsend relay email event (${
        issue
          ? `${issue.path.join(".") || "payload"}: ${issue.message}`
          : "unrecognized shape"
      })`,
    );
  }

  const event = parsed.data;
  const bounce = toBounce(event);
  return {
    type: event.type,
    messageId: event.messageId,
    recipients: event.recipients,
    occurredAt: event.occurredAt,
    ...(bounce ? { bounce } : {}),
    raw: event,
  };
}
