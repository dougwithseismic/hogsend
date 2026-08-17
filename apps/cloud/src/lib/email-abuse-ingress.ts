import { eq } from "drizzle-orm";
import type { CloudDb } from "../db";
import { db as defaultDb } from "../db";
import { environments, organizations, sesTenants } from "../db/schema";
import { env } from "../env";
import {
  EventBridgeParseError,
  isFindingDetailType,
  parseSesAbuseEvent,
  type SesAbuseEvent,
} from "../eventbridge/events";
import {
  EventBridgeVerificationError,
  verifyEventBridgeSecret,
} from "../eventbridge/verify";
import { findOwnerEmail } from "../pipeline/provision";
import {
  claimAbuseEvent,
  claimSuspensionNotice,
  completeAbuseEvent,
  type EmailAbuseEventOutcome,
  releaseSuspensionNotice,
} from "../services/email-abuse-events";
import {
  closeEmailFinding,
  openEmailFinding,
} from "../services/email-findings";
import { recordEmailSendingStatus } from "../services/email-sending-status";
import {
  applyTrustTier,
  countOpenFindings,
} from "../services/email-trust-tiers";
import type { SesClient } from "../ses/contract";
import type { AUP_CLAUSES } from "./email-abuse-policy";
import { type EmailSender, resolveEmailSender } from "./email-sender";
import { renderSuspensionNotice } from "./email-suspension-notice";
import { fail } from "./route-response";

/**
 * THE EVENTBRIDGE INGRESS (PRD 08 task 1) — `POST /api/email/reputation`.
 *
 * SES does the detection; we do the reaction. Reputation policies already pause
 * a tenant automatically, so nothing here recomputes bounce-rate maths: this
 * endpoint consumes the signal, MIRRORS the state so the relay can fail closed
 * without an AWS round trip, notifies the customer, and records everything.
 *
 * The order of operations is the security posture, and mirrors PRD 05's SNS
 * ingress step for step even though the authentication mechanism is different:
 *
 *   secret → body → parse → CLAIM → resolve tenant → dispatch → notify
 *
 *  - **secret first**, so nothing below is reachable anonymously and a flood of
 *    unauthenticated posts costs one hash;
 *  - **claim before anything is acted on**, because the act that matters
 *    (mailing a customer to say their sending stopped) is the one that must not
 *    happen twice;
 *  - **an unresolvable tenant is RECORDED and returns 200.** EARS 9, and it is
 *    the difference between one stale tenant being a line in a journal and one
 *    stale tenant wedging every live tenant's events behind it.
 *
 * Status codes are chosen for what they make EventBridge DO. A 2xx retires the
 * delivery; a 5xx makes it retry on its own schedule. So an event we
 * deliberately dropped answers 200 (retrying changes nothing) and an
 * unexpected failure answers 500 (the redelivery is the durable retry).
 */

export interface SesAbuseIngressDeps {
  db?: CloudDb;
  /** The EventBridge connection secret. Defaults to the env; null refuses. */
  secret?: string | null;
  /** Defaults to the process-wide client for the tenancy's region. */
  ses?: SesClient;
  sender?: EmailSender;
  now?: Date;
}

/** Bodies larger than this are refused unread. An SES event is ~1 KB. */
const MAX_BODY_BYTES = 256 * 1024;

/** The clause an automatic reputation suspension cites. */
const REPUTATION_CLAUSE = "5.1" satisfies keyof typeof AUP_CLAUSES;

function ok(body: Record<string, unknown>): Response {
  return Response.json(body, {
    status: 200,
    headers: { "cache-control": "no-store" },
  });
}

export async function handleSesAbuseEvent(
  request: Request,
  deps: SesAbuseIngressDeps = {},
): Promise<Response> {
  const db = deps.db ?? defaultDb;
  const now = deps.now ?? new Date();

  try {
    verifyEventBridgeSecret({
      headers: request.headers,
      secret:
        deps.secret !== undefined
          ? deps.secret
          : (env.CLOUD_SES_EVENTBRIDGE_SECRET ?? null),
    });
  } catch (error) {
    if (!(error instanceof EventBridgeVerificationError)) throw error;
    // 403 for BOTH refusals, with the reason in the body rather than in the
    // status: a prober learns nothing, an operator reading a log learns which
    // check refused them.
    return fail(
      403,
      error.reason === "not_configured"
        ? "eventbridge_not_configured"
        : "forbidden",
      error.message,
    );
  }

  const declared = Number(request.headers.get("content-length") ?? "0");
  if (Number.isFinite(declared) && declared > MAX_BODY_BYTES) {
    return fail(413, "payload_too_large", "That event is too large.");
  }
  const body = await request.text();
  if (body.length > MAX_BODY_BYTES) {
    return fail(413, "payload_too_large", "That event is too large.");
  }

  let event: SesAbuseEvent;
  try {
    event = parseSesAbuseEvent(JSON.parse(body) as unknown, now);
  } catch (error) {
    if (error instanceof EventBridgeParseError) {
      if (error.reason === "source") {
        return fail(403, "unknown_source", error.message);
      }
      if (error.reason === "detail_type") {
        // 200: a subscription we did not narrow is a configuration to fix, not
        // a reason for EventBridge to redeliver forever.
        return ok({ ok: true, action: "ignored", reason: error.message });
      }
      return fail(400, "invalid_event", error.message);
    }
    return fail(400, "invalid_event", "That body is not an EventBridge event.");
  }

  const claim = await claimAbuseEvent({ event, db });
  if (claim.outcome === "duplicate") {
    return ok({ ok: true, action: "duplicate", eventId: event.id });
  }

  const environmentId = event.tenantName
    ? await resolveEnvironmentId(db, event.tenantName)
    : null;

  if (!environmentId) {
    // EARS 9. Recorded, never thrown: the event is evidence of a provisioning
    // gap, and one stale tenant may not stop the pipeline for live ones.
    await completeAbuseEvent({
      rowId: claim.rowId,
      outcome: "unknown_tenant",
      at: now,
      db,
    });
    return ok({
      ok: true,
      action: "unknown_tenant",
      tenantName: event.tenantName,
    });
  }

  const outcome = await dispatch({
    event,
    environmentId,
    rowId: claim.rowId,
    now,
    db,
    ...(deps.ses ? { ses: deps.ses } : {}),
    ...(deps.sender ? { sender: deps.sender } : {}),
  });

  await completeAbuseEvent({
    rowId: claim.rowId,
    outcome,
    environmentId,
    at: now,
    db,
  });

  return ok({ ok: true, action: outcome, environmentId });
}

interface DispatchInput {
  event: SesAbuseEvent;
  environmentId: string;
  rowId: string;
  now: Date;
  db: CloudDb;
  ses?: SesClient;
  sender?: EmailSender;
}

async function dispatch(input: DispatchInput): Promise<EmailAbuseEventOutcome> {
  const { event } = input;

  if (isFindingDetailType(event.detailType)) {
    return event.detailType === "Advisor Recommendation Status Open"
      ? findingOpened(input)
      : findingClosed(input);
  }

  return event.detailType === "Sending Status Disabled"
    ? sendingDisabled(input)
    : sendingEnabled(input);
}

/**
 * EARS 1 — mirror the pause, with the event's own cause and timestamp, and
 * touch nothing else.
 *
 * `paused` rather than `enforced`: AWS's reputation policy stopped this tenant,
 * not us, and the two are different conversations during an appeal.
 */
async function sendingDisabled(
  input: DispatchInput,
): Promise<EmailAbuseEventOutcome> {
  const { event, environmentId, db } = input;
  const cause = event.cause ?? "SES paused this tenant";

  await recordEmailSendingStatus({
    environmentId,
    status: "paused",
    reason: cause,
    // The instant AWS says it happened, not the instant we heard.
    at: event.occurredAt,
    source: "eventbridge",
    eventId: event.id,
    db,
  });

  await notifyOwner(input, cause);
  return "paused";
}

/** SES letting a tenant back on. `reinstated`, never `active`. */
async function sendingEnabled(
  input: DispatchInput,
): Promise<EmailAbuseEventOutcome> {
  await recordEmailSendingStatus({
    environmentId: input.environmentId,
    status: "reinstated",
    reason: input.event.cause ?? "SES reinstated this tenant",
    at: input.event.occurredAt,
    source: "eventbridge",
    eventId: input.event.id,
    db: input.db,
  });
  return "reinstated";
}

/**
 * EARS 2 — record the finding, then demote to `watched`.
 *
 * The demotion goes through the tier engine rather than writing the column
 * here, so the SES reputation policy moves with it. A finding recorded without
 * the policy change would be a warning we noticed and did not act on.
 *
 * A finding does NOT pause sending. Status is the enforcement surface and
 * findings are the warning surface; conflating them would stop a tenant on a
 * low-severity DKIM recommendation.
 */
async function findingOpened(
  input: DispatchInput,
): Promise<EmailAbuseEventOutcome> {
  const { event, environmentId, db } = input;
  if (event.finding) {
    await openEmailFinding({
      environmentId,
      finding: event.finding,
      at: event.occurredAt,
      db,
    });
  }

  await applyTrustTier({
    environmentId,
    tier: "watched",
    reason: `reputation finding ${event.finding?.type ?? "UNKNOWN"} (${
      event.finding?.impact ?? "unknown impact"
    })`,
    db,
    ...(input.ses ? { ses: input.ses } : {}),
  });
  return "finding_opened";
}

/**
 * A finding SES considers fixed.
 *
 * Recorded, and that is ALL. It deliberately does not re-run the tier engine:
 * promotion out of `watched` is a human review (AUP §6.6), and a close that
 * automatically restored the tier would be exactly the automatic reinstate the
 * policy refuses — SES's own `reinstated` state ignores active findings during
 * recovery, so an unpause over an unresolved cause simply re-pauses later.
 */
async function findingClosed(
  input: DispatchInput,
): Promise<EmailAbuseEventOutcome> {
  if (input.event.finding) {
    await closeEmailFinding({
      environmentId: input.environmentId,
      finding: input.event.finding,
      at: input.event.occurredAt,
      db: input.db,
    });
  }
  // Read purely so the count is exercised on this path too — a tenant whose
  // last finding just closed is now eligible for a HUMAN to promote.
  await countOpenFindings({ environmentId: input.environmentId, db: input.db });
  return "finding_closed";
}

/**
 * EARS 3 — one suspension notice per pause event.
 *
 * The gate is the journal claim, not the status transition. That is the
 * difference between "once per pause event" (what EARS asks for, and what a
 * redelivered EventBridge event must not defeat) and "once per state change".
 * A failed send hands the claim back with the reason, so a redelivery — which
 * RESUMES, because handling never completed — can try the mail again.
 */
async function notifyOwner(input: DispatchInput, cause: string): Promise<void> {
  const { environmentId, rowId, db, now } = input;

  const claimed = await claimSuspensionNotice({ rowId, at: now, db });
  if (!claimed) return;

  const [target] = await db
    .select({
      environmentName: environments.name,
      organizationId: environments.organizationId,
      organizationName: organizations.name,
    })
    .from(environments)
    .innerJoin(organizations, eq(organizations.id, environments.organizationId))
    .where(eq(environments.id, environmentId))
    .limit(1);
  if (!target) return;

  const owner = await findOwnerEmail(db, target.organizationId);
  if (!owner) {
    await releaseSuspensionNotice({
      rowId,
      error: "the organization has no member to notify",
      db,
    });
    return;
  }

  const notice = renderSuspensionNotice({
    variant: "automatic",
    environment: target.environmentName,
    environmentId,
    suspendedAt: input.event.occurredAt,
    clause: REPUTATION_CLAUSE,
    cause,
  });

  const sender = input.sender ?? resolveEmailSender();
  try {
    await sender.send({
      to: owner,
      subject: notice.subject,
      text: notice.text,
    });
  } catch (error) {
    // The PAUSE stands. A notice we could not deliver is not a reason to let a
    // tenant AWS stopped keep sending.
    const message = error instanceof Error ? error.message : String(error);
    console.error(
      `[cloud:email-abuse] suspension notice for environment ${environmentId} failed:`,
      error,
    );
    await releaseSuspensionNotice({ rowId, error: message, db });
  }
}

/** The SES tenant name → the environment it belongs to, or null. */
async function resolveEnvironmentId(
  db: CloudDb,
  tenantName: string,
): Promise<string | null> {
  const [row] = await db
    .select({ environmentId: sesTenants.environmentId })
    .from(sesTenants)
    .where(eq(sesTenants.tenantName, tenantName))
    .limit(1);
  return row?.environmentId ?? null;
}
