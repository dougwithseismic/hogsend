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
  /**
   * SES accepted the message, returned a message id, and then discarded it —
   * `Reject`, whose only documented reason is `Bad content` (a virus). It is
   * the one outcome the relay CANNOT infer from its own send call, which is
   * why it belongs on this wire even though the relay knows what it sent.
   *
   * Terminal, and suppressing NOTHING. See `EmailEventType` in `@hogsend/core`
   * for why folding it onto `email.bounced` would be a data-loss bug.
   */
  "email.rejected",
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
 * The reject facts, exactly as SES states them. Its own block rather than a
 * `bounce` with an odd `type`: `bounce` is what the engine classifies for
 * SUPPRESSION, and a reject must be structurally unable to reach that path.
 * `reason` is SES's `Reject.reason` VERBATIM — `Bad content` is the only value
 * AWS documents today, and it is neither parsed nor mapped here.
 */
export const hogsendRelayRejectSchema = z.object({
  reason: z.string().min(1),
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
  /** Present on `email.rejected` only. Never drives suppression. */
  reject: hogsendRelayRejectSchema.optional(),
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
// Freshness — the replay window
// ---------------------------------------------------------------------------

/**
 * How old a signed payload may be. **Twenty-four hours, and the unit is not a
 * typo.**
 *
 * The timestamp this bounds is `occurredAt`, which is already INSIDE the signed
 * body — so it is covered by the HMAC and an attacker cannot move it. What this
 * bounds is how long a payload CAPTURED off the wire stays replayable while the
 * environment's webhook secret is unchanged. Without it, forever.
 *
 * **Do not "tighten" this to five minutes.** `occurredAt` is when the EVENT
 * happened, not when the relay sent it, and an SES `DeliveryDelay` describes an
 * instant that can precede its own notification by a long way. Between the two
 * sit SES's emission, SNS's delivery and its own multi-day retry policy, the
 * control plane's bounded retry, and this instance's availability. A minutes-
 * scale window turns every one of those into a SILENTLY DROPPED bounce.
 *
 * And the asymmetry decides it: a replayed event is one the engine already
 * dedupes, while a dropped one means suppression never happens at all — which
 * is the exact failure the whole event-ingress path exists to prevent. Hours is
 * the cautious choice here, not the lax one.
 */
export const HOGSEND_RELAY_MAX_AGE_MS = 24 * 60 * 60 * 1000;

/**
 * How far AHEAD of our clock a payload's timestamp may sit.
 *
 * Not an attacker control — the HMAC already stops anyone forging a timestamp.
 * This catches OUR OWN mistake: a clock bug on the relay (or a timezone
 * arithmetic slip) that stamped an event a year into the future would mint a
 * payload that stays inside the age window, and therefore replayable, for a
 * year. Five minutes leaves room for ordinary NTP drift between two hosts.
 */
export const HOGSEND_RELAY_MAX_FUTURE_MS = 5 * 60 * 1000;

/** Whole hours and minutes, so an operator can size the window from the error. */
function describeAge(ms: number): string {
  const hours = Math.floor(ms / 3_600_000);
  const minutes = Math.round((ms % 3_600_000) / 60_000);
  return hours > 0 ? `${hours}h${minutes}m` : `${minutes}m`;
}

/**
 * Refuse a relay payload whose timestamp is outside the replay window.
 *
 * FAILS CLOSED on a timestamp it cannot read. The schema's `.datetime()` is the
 * first line and would normally catch that, and this is deliberately a second:
 * a gap between the two must never resolve to "no timestamp, so allow".
 *
 * Exported so the window is testable — and auditable — on its own, rather than
 * only through a provider.
 */
export function assertHogsendRelayFresh(opts: {
  occurredAt: string;
  now?: number;
  maxAgeMs?: number;
  maxFutureMs?: number;
}): void {
  const at = Date.parse(opts.occurredAt);
  if (Number.isNaN(at)) {
    throw new Error(
      `Hogsend relay webhook: the payload timestamp could not be read (${JSON.stringify(
        opts.occurredAt,
      )}).`,
    );
  }

  const now = opts.now ?? Date.now();
  const maxAgeMs = opts.maxAgeMs ?? HOGSEND_RELAY_MAX_AGE_MS;
  const maxFutureMs = opts.maxFutureMs ?? HOGSEND_RELAY_MAX_FUTURE_MS;
  const age = now - at;

  if (age > maxAgeMs) {
    throw new Error(
      `Hogsend relay webhook: the payload is too old (${describeAge(
        age,
      )}, limit ${describeAge(maxAgeMs)}) — refusing it as a possible replay.`,
    );
  }
  if (-age > maxFutureMs) {
    throw new Error(
      `Hogsend relay webhook: the payload timestamp is ${describeAge(
        -age,
      )} in the future — refusing it.`,
    );
  }
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
  //
  // Neither is a REJECT, and there the stakes are higher: the recipient's
  // address is fine and it was our content SES objected to, so a bounce block
  // here would put a good address one `class: "permanent"` away from permanent
  // suppression. The gate is on the EVENT TYPE rather than on the presence of
  // the block, so a relay that wrongly populated `bounce` on a reject still
  // cannot smuggle a suppressing class through.
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
  // The reason rides ONLY on the event type that has one, so no other handler
  // can read it, and it is passed through untouched — SES's `Bad content` is
  // the only documented value today and this makes no assumption that it stays
  // the only one.
  const reject =
    event.type === "email.rejected" && event.reject ? event.reject : undefined;
  return {
    type: event.type,
    messageId: event.messageId,
    recipients: event.recipients,
    occurredAt: event.occurredAt,
    ...(bounce ? { bounce } : {}),
    ...(reject ? { reject } : {}),
    raw: event,
  };
}
