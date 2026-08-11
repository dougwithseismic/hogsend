import { z } from "zod";

/**
 * SES reputation events on EventBridge → a shape this control plane can act on.
 *
 * FOUR detail-types, and deliberately not more. Status is the ENFORCEMENT
 * surface and findings are the WARNING surface; both are recorded and only
 * status gates sending (PRD 08 Locked decisions).
 *
 * **This parser is deliberately generous about WHERE it reads a field from, and
 * strict about WHAT it will act on.** PRD 08's Seams note is explicit that the
 * real `detail` shapes must be confirmed against a live AWS account once PRD 01
 * lands, and the SES tenant APIs shipped in August 2025 — so reading only one
 * field path would mean a rename in AWS's payload surfacing as "the pause never
 * arrived", which is the fail-OPEN direction. The whole envelope is kept in
 * `raw` so a shape we did not anticipate is diagnosable from the journal rather
 * than lost.
 *
 * What is NOT generous: the `source` must be `aws.ses`, the detail-type must be
 * one of the four, and an event we cannot pin to a tenant is recorded as
 * unresolved rather than guessed at.
 */

export const SES_ABUSE_DETAIL_TYPES = [
  "Sending Status Disabled",
  "Sending Status Enabled",
  "Advisor Recommendation Status Open",
  "Advisor Recommendation Status Closed",
] as const;

export type SesAbuseDetailType = (typeof SES_ABUSE_DETAIL_TYPES)[number];

/** The only source we act on. */
export const SES_EVENT_SOURCE = "aws.ses";

export type EventBridgeParseReason = "malformed" | "source" | "detail_type";

export class EventBridgeParseError extends Error {
  readonly reason: EventBridgeParseReason;

  constructor(message: string, reason: EventBridgeParseReason) {
    super(message);
    this.name = "EventBridgeParseError";
    this.reason = reason;
  }
}

/**
 * The EventBridge envelope. NOT strict — AWS adds fields, and a control plane
 * that 400'd on a new one would break on an AWS release. Only what is named
 * here is ever read.
 */
const envelopeSchema = z.object({
  id: z.string().min(1),
  "detail-type": z.string().min(1),
  source: z.string().min(1),
  account: z.string().optional(),
  region: z.string().optional(),
  time: z.string().optional(),
  resources: z.array(z.string()).optional(),
  detail: z.record(z.string(), z.unknown()).optional(),
});

export interface SesAbuseFinding {
  /** SES's own recommendation type: `BOUNCE`, `COMPLAINT`, `DKIM`, … */
  type: string;
  impact: string | null;
  description: string | null;
}

export interface SesAbuseEvent {
  /** EventBridge's event id. THE idempotency key. */
  id: string;
  detailType: SesAbuseDetailType;
  /** The SES tenant, or null when the event named none we could read. */
  tenantName: string | null;
  /** When SES says it happened. Falls back to now when the envelope has none. */
  occurredAt: Date;
  /** WHY, in AWS's own words. Null when the event carried no cause. */
  cause: string | null;
  /** Present only on the two Advisor detail-types. */
  finding: SesAbuseFinding | null;
  /** The whole envelope, verbatim. */
  raw: Record<string, unknown>;
}

function str(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

/**
 * The tenant name inside an SES ARN, or null.
 *
 * Matched on the `tenant/<name>` resource segment rather than by splitting on
 * `:` and taking the last field, because an identity ARN
 * (`…:identity/acme.test`) and a configuration-set ARN have the same arity and
 * would both yield a plausible-looking "tenant name" that resolves to nothing.
 */
export function tenantNameFromArn(arn: string): string | null {
  const match = /^arn:[^:]*:ses:[^:]*:[^:]*:tenant\/(.+)$/.exec(arn.trim());
  return match?.[1] ?? null;
}

/**
 * Every place an SES reputation event has been seen to name its tenant, in
 * precedence order. An explicit `tenantName` wins over an ARN we have to parse.
 */
function resolveTenantName(
  detail: Record<string, unknown>,
  resources: string[],
): string | null {
  const direct = str(detail.tenantName) ?? str(detail.TenantName);
  if (direct) return direct;

  const arns = [
    str(detail.reputationEntityReference),
    str(detail.resourceArn),
    str(detail.tenantArn),
    ...resources,
  ];
  for (const arn of arns) {
    if (!arn) continue;
    const name = tenantNameFromArn(arn);
    if (name) return name;
  }
  return null;
}

function isDetailType(value: string): value is SesAbuseDetailType {
  return (SES_ABUSE_DETAIL_TYPES as readonly string[]).includes(value);
}

export function isFindingDetailType(type: SesAbuseDetailType): boolean {
  return type.startsWith("Advisor Recommendation Status");
}

/**
 * Parse an EventBridge delivery, or throw {@link EventBridgeParseError}.
 *
 * The three refusals are separate `reason`s because the route answers them
 * differently: a malformed body is a 400 (nobody should send it again), a
 * foreign source is a 403 (someone is trying), and an unconsumed detail-type is
 * a 200 (a subscription we did not narrow, and redelivering it forever changes
 * nothing).
 */
export function parseSesAbuseEvent(
  payload: unknown,
  now: Date = new Date(),
): SesAbuseEvent {
  const parsed = envelopeSchema.safeParse(payload);
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    throw new EventBridgeParseError(
      `not an EventBridge event (${
        issue
          ? `${issue.path.join(".") || "payload"}: ${issue.message}`
          : "unrecognized shape"
      })`,
      "malformed",
    );
  }

  const envelope = parsed.data;
  if (envelope.source !== SES_EVENT_SOURCE) {
    throw new EventBridgeParseError(
      `events from ${JSON.stringify(envelope.source)} are not consumed here`,
      "source",
    );
  }

  const detailType = envelope["detail-type"];
  if (!isDetailType(detailType)) {
    throw new EventBridgeParseError(
      `detail-type ${JSON.stringify(detailType)} is not one this control plane consumes`,
      "detail_type",
    );
  }

  const detail = envelope.detail ?? {};
  const occurredAt = envelope.time ? new Date(envelope.time) : now;

  return {
    id: envelope.id,
    detailType,
    tenantName: resolveTenantName(detail, envelope.resources ?? []),
    // An unparseable `time` is not a reason to drop a pause; the moment we
    // heard about it is a defensible second-best.
    occurredAt: Number.isNaN(occurredAt.getTime()) ? now : occurredAt,
    cause:
      str(detail.cause) ??
      str(detail.reason) ??
      str(detail.sendingStatusReasonType) ??
      (isFindingDetailType(detailType) ? str(detail.description) : null),
    finding: isFindingDetailType(detailType)
      ? {
          type: str(detail.type) ?? str(detail.recommendationType) ?? "UNKNOWN",
          impact: str(detail.impact),
          description: str(detail.description),
        }
      : null,
    raw: payload as Record<string, unknown>,
  };
}
