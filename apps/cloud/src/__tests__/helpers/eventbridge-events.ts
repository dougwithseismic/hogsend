/**
 * EventBridge envelopes for SES reputation events (PRD 08 task 1).
 *
 * A DIFFERENT stream from PRD 05's SNS notifications, with a different shape
 * and a different authentication story — these arrive through an EventBridge
 * API destination, which authenticates with a connection secret rather than by
 * signing the body. The two are kept apart deliberately: conflating them would
 * mean one parser guessing which wire it is looking at.
 *
 * The field set below is AWS's documented EventBridge envelope plus the SES
 * `detail` payloads. PRD 08's Seams note says the real `detail` shapes must be
 * confirmed against a live account once PRD 01 lands, which is exactly why the
 * parser reads several plausible field names and keeps the raw payload — these
 * fixtures pin the shape we build against, not a shape we have observed.
 */

let seq = 0;

/** A distinct EventBridge event id. Redelivery is modelled by REUSING one. */
export function eventBridgeId(prefix = "evt"): string {
  seq += 1;
  return `${prefix}-${seq}-${"0".repeat(4)}`;
}

export function tenantArn(tenantName: string, region = "us-east-1"): string {
  return `arn:aws:ses:${region}:000000000000:tenant/${tenantName}`;
}

interface Envelope {
  id?: string;
  time?: string;
  region?: string;
  source?: string;
}

function envelope(
  detailType: string,
  detail: Record<string, unknown>,
  resources: string[],
  options: Envelope,
): Record<string, unknown> {
  return {
    version: "0",
    id: options.id ?? eventBridgeId(),
    "detail-type": detailType,
    source: options.source ?? "aws.ses",
    account: "000000000000",
    time: options.time ?? "2026-08-11T10:00:00Z",
    region: options.region ?? "us-east-1",
    resources,
    detail,
  };
}

export function sendingStatusDisabled(
  input: { tenantName: string; cause?: string } & Envelope,
): Record<string, unknown> {
  const arn = tenantArn(input.tenantName);
  return envelope(
    "Sending Status Disabled",
    {
      reputationEntityType: "RESOURCE",
      reputationEntityReference: arn,
      sendingStatus: "DISABLED",
      cause:
        input.cause ??
        "Complaint rate of 0.31% exceeded the account review threshold.",
    },
    [arn],
    input,
  );
}

export function sendingStatusEnabled(
  input: { tenantName: string; cause?: string } & Envelope,
): Record<string, unknown> {
  const arn = tenantArn(input.tenantName);
  return envelope(
    "Sending Status Enabled",
    {
      reputationEntityType: "RESOURCE",
      reputationEntityReference: arn,
      sendingStatus: "REINSTATED",
      ...(input.cause ? { cause: input.cause } : {}),
    },
    [arn],
    input,
  );
}

export function advisorRecommendationOpen(
  input: {
    tenantName: string;
    type?: string;
    impact?: string;
    description?: string;
  } & Envelope,
): Record<string, unknown> {
  const arn = tenantArn(input.tenantName);
  return envelope(
    "Advisor Recommendation Status Open",
    {
      resourceArn: arn,
      type: input.type ?? "COMPLAINT",
      impact: input.impact ?? "HIGH",
      status: "OPEN",
      description:
        input.description ??
        "Your complaint rate is approaching the level at which sending is paused.",
    },
    [arn],
    input,
  );
}

export function advisorRecommendationClosed(
  input: { tenantName: string; type?: string } & Envelope,
): Record<string, unknown> {
  const arn = tenantArn(input.tenantName);
  return envelope(
    "Advisor Recommendation Status Closed",
    {
      resourceArn: arn,
      type: input.type ?? "COMPLAINT",
      impact: "HIGH",
      status: "FIXED",
      description: "The complaint rate has recovered.",
    },
    [arn],
    input,
  );
}
