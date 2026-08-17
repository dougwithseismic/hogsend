import { eq } from "drizzle-orm";
import type { CloudDb } from "../db";
import { db as defaultDb } from "../db";
import { environments, organizations, sesTenants } from "../db/schema";
import type { EmailSender } from "../lib/email-sender";
import { resolveEmailSender } from "../lib/email-sender";
import {
  renderReinstatementNotice,
  renderSuspensionNotice,
  type SuspensionMeasurement,
} from "../lib/email-suspension-notice";
import { findOwnerEmail } from "../pipeline/provision";
import type { SesClient } from "../ses/contract";
import { getSesClient } from "../ses/index";
import { writeAudit } from "./audit";
import {
  type EmailPauseSource,
  recordEmailSendingStatus,
} from "./email-sending-status";

/**
 * STOPPING ONE TENANT, AND TELLING THEM WHY (PRD 08 tasks 3 and 7).
 *
 * Two callers share this: the reputation sweep, which stops a tenant that
 * crossed a published threshold SES will not catch (a `new` tenant sits on
 * reputation policy `NONE` and is never auto-paused), and an operator acting
 * under AUP §6.2. They are the same act and must produce the same state, so
 * they are one function rather than two that drift.
 *
 * The order is the safety property:
 *
 *   SES stop → mirror → history → notice
 *
 *  - **SES first.** If AWS refuses, nothing is recorded and the sweep retries
 *    the whole thing. A mirror written over a stop that never applied would say
 *    "contained" about a tenant still sending.
 *  - **Mirror before notice.** The relay reads the mirror; a customer told
 *    their sending stopped while it had not is a worse lie than a late email.
 *  - **The notice is keyed on the TRANSITION.** `recordEmailSendingStatus`
 *    reports whether the status actually moved, and only a move is a pause
 *    event. A sweep that re-suspends an already-suspended tenant every tick
 *    would otherwise mail them every tick.
 *
 * A notice that cannot be sent does NOT roll the suspension back. Sending is a
 * best-effort courtesy on top of an enforcement decision; the enforcement is
 * the point, and it is visible in Studio and in the relay's own 403 regardless.
 */

const DEFAULT_ACTOR = "reputation";

export const EMAIL_SUSPENDED_ACTION = "email_sending.suspended";
export const EMAIL_REINSTATED_ACTION = "email_sending.reinstated";

export interface SuspendEmailSendingInput {
  environmentId: string;
  /** The recorded cause. Travels verbatim into the relay's 403. */
  cause: string;
  /** The AUP clause this cites. The notice quotes it. */
  clause: string;
  variant?: "automatic" | "manual";
  measurement?: SuspensionMeasurement;
  actor?: string;
  source?: EmailPauseSource;
  at?: Date;
  db?: CloudDb;
  ses?: SesClient;
  sender?: EmailSender;
}

export interface SuspendEmailSendingResult {
  /** False when the environment was already in this state. */
  suspended: boolean;
  notified: boolean;
  /** Set when the notice could not be delivered. */
  noticeError?: string;
}

export async function suspendEmailSending(
  input: SuspendEmailSendingInput,
): Promise<SuspendEmailSendingResult> {
  const db = input.db ?? defaultDb;
  const at = input.at ?? new Date();

  const target = await loadTarget(db, input.environmentId);
  if (!target) return { suspended: false, notified: false };

  const ses = input.ses ?? getSesClient(target.region);
  // The seam's operator-stop verb. Distinct from AWS's own reputation pause on
  // purpose: `getReputationEntity` reports the two separately, and only one of
  // them is ours to reverse.
  await ses.setTenantSendingStatus({
    tenantName: target.tenantName,
    status: "DISABLED",
  });

  const status = await recordEmailSendingStatus({
    environmentId: input.environmentId,
    // `enforced`, not `paused`: this is our stop, not AWS's, and the pause
    // history has to be able to say which.
    status: "enforced",
    reason: input.cause,
    at,
    source: input.source ?? "operator",
    db,
  });

  await writeAudit(db, {
    actor: input.actor ?? DEFAULT_ACTOR,
    organizationId: target.organizationId,
    action: EMAIL_SUSPENDED_ACTION,
    subject: input.environmentId,
    detail: {
      clause: input.clause,
      cause: input.cause,
      transition: status.changed,
    },
  });

  if (!status.changed) return { suspended: false, notified: false };

  const notice = renderSuspensionNotice({
    variant: input.variant ?? "automatic",
    environment: target.environmentName,
    environmentId: input.environmentId,
    suspendedAt: at,
    clause: input.clause,
    cause: input.cause,
    ...(input.measurement ? { measurement: input.measurement } : {}),
  });

  const owner = await findOwnerEmail(db, target.organizationId);
  if (!owner) {
    // A control-plane organization with no membership rows, which the real
    // signup path cannot produce. The suspension stands.
    return { suspended: true, notified: false, noticeError: "no owner" };
  }

  const sender = input.sender ?? resolveEmailSender();
  try {
    await sender.send({
      to: owner,
      subject: notice.subject,
      text: notice.text,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error(
      `[cloud:email-enforcement] suspension notice for environment ${input.environmentId} failed:`,
      error,
    );
    return { suspended: true, notified: false, noticeError: message };
  }

  return { suspended: true, notified: true };
}

/**
 * Let a tenant back on — the human end of the appeals queue (AUP §6.6).
 *
 * A function, never a route and never a Studio button. Reinstatement is never
 * granted on request alone, and a button is an automatic bypass wearing a UI.
 *
 * The status becomes `reinstated` rather than `active`, mirroring SES's own
 * vocabulary, so "has this tenant ever been stopped" survives the recovery —
 * which is what AUP §6.4's repeat-breach rule is applied against.
 *
 * It tells the customer, for the reason the notice copy itself gives: a
 * suspension notice that promises a way back needs its other half, and someone
 * who fixed the problem and hears nothing assumes we forgot. Same posture as
 * the suspension notice — keyed on the TRANSITION, and a failed send never
 * rolls the reinstatement back.
 */
export async function reinstateEmailSending(input: {
  environmentId: string;
  actor: string;
  reason?: string;
  at?: Date;
  db?: CloudDb;
  ses?: SesClient;
  sender?: EmailSender;
}): Promise<{ reinstated: boolean; notified: boolean }> {
  const db = input.db ?? defaultDb;
  const at = input.at ?? new Date();

  const target = await loadTarget(db, input.environmentId);
  if (!target) return { reinstated: false, notified: false };

  const ses = input.ses ?? getSesClient(target.region);
  await ses.setTenantSendingStatus({
    tenantName: target.tenantName,
    status: "REINSTATED",
  });

  const status = await recordEmailSendingStatus({
    environmentId: input.environmentId,
    status: "reinstated",
    reason: input.reason ?? `reinstated by ${input.actor}`,
    at,
    source: "operator",
    db,
  });

  await writeAudit(db, {
    actor: input.actor,
    organizationId: target.organizationId,
    action: EMAIL_REINSTATED_ACTION,
    subject: input.environmentId,
    detail: { reason: input.reason ?? null, transition: status.changed },
  });

  if (!status.changed) return { reinstated: false, notified: false };

  const notified = await notify(
    db,
    target,
    renderReinstatementNotice({
      environment: target.environmentName,
      environmentId: input.environmentId,
    }),
    input.sender,
    input.environmentId,
  );
  return { reinstated: true, notified };
}

/**
 * Send one notice to the environment's owner. Never throws.
 *
 * Shared by both directions because they have the same rule: the enforcement
 * decision has already landed, and a transport failure must not undo it. What
 * a failure does instead is say so loudly and report `false`, so the caller can
 * put it in a sweep result rather than swallow it.
 */
async function notify(
  db: CloudDb,
  target: EnforcementTarget,
  notice: { subject: string; text: string },
  sender: EmailSender | undefined,
  environmentId: string,
): Promise<boolean> {
  const owner = await findOwnerEmail(db, target.organizationId);
  // A control-plane organization with no membership rows, which the real
  // signup path cannot produce.
  if (!owner) return false;

  try {
    await (sender ?? resolveEmailSender()).send({
      to: owner,
      subject: notice.subject,
      text: notice.text,
    });
    return true;
  } catch (error) {
    console.error(
      `[cloud:email-enforcement] notice for environment ${environmentId} failed:`,
      error,
    );
    return false;
  }
}

interface EnforcementTarget {
  tenantName: string;
  region: "us" | "eu";
  organizationId: string;
  organizationName: string;
  environmentName: string;
}

/**
 * Everything a stop needs, in one read.
 *
 * Null when the environment has no SES tenancy: there is no tenant in AWS to
 * disable and no relay traffic to stop, so a "suspension" would be a row
 * describing an enforcement that does not exist.
 */
async function loadTarget(
  db: CloudDb,
  environmentId: string,
): Promise<EnforcementTarget | null> {
  const [row] = await db
    .select({
      tenantName: sesTenants.tenantName,
      region: sesTenants.region,
      organizationId: environments.organizationId,
      organizationName: organizations.name,
      environmentName: environments.name,
    })
    .from(sesTenants)
    .innerJoin(environments, eq(environments.id, sesTenants.environmentId))
    .innerJoin(organizations, eq(organizations.id, environments.organizationId))
    .where(eq(sesTenants.environmentId, environmentId))
    .limit(1);
  return row ?? null;
}
