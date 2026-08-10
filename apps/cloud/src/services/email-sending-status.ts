import { eq } from "drizzle-orm";
import type { CloudDb } from "../db";
import { db as defaultDb } from "../db";
import { emailSendingStatus } from "../db/schema";
import type { emailSendingStatusEnum } from "../db/schema/enums";

/**
 * The control plane's mirror of "may this environment send email at all".
 *
 * PRD 08 owns the WRITES that matter (EventBridge, the reconciliation sweep).
 * This module is the read the relay does before every send, plus the one narrow
 * write the relay itself performs: repairing the mirror when SES answers a send
 * with a paused status we had not heard about.
 */

export type EmailSendingStatusValue =
  (typeof emailSendingStatusEnum.enumValues)[number];

/**
 * The two values that refuse a send. `reinstated` is NOT here — it means
 * "paused once, since let back on", which is a tenant that may send.
 */
export const BLOCKING_EMAIL_SENDING_STATUSES = [
  "paused",
  "enforced",
] as const satisfies readonly EmailSendingStatusValue[];

export function blocksSending(status: EmailSendingStatusValue): boolean {
  const blocking: readonly string[] = BLOCKING_EMAIL_SENDING_STATUSES;
  return blocking.includes(status);
}

export interface EmailSendingStatusRecord {
  status: EmailSendingStatusValue;
  reason: string | null;
  /** When it last entered a blocking status; null while it is sending. */
  pausedAt: Date | null;
}

/** The answer for an environment with no row: never stopped. */
const NEVER_STOPPED: EmailSendingStatusRecord = {
  status: "active",
  reason: null,
  pausedAt: null,
};

/**
 * The relay's pre-send gate.
 *
 * A missing row reads as `active` — see the table's own note for why absence
 * must fail OPEN here while a missed PAUSE is repaired by PRD 08's
 * reconciliation instead.
 */
export async function readEmailSendingStatus(input: {
  environmentId: string;
  db?: CloudDb;
}): Promise<EmailSendingStatusRecord> {
  const db = input.db ?? defaultDb;
  const [row] = await db
    .select({
      status: emailSendingStatus.status,
      reason: emailSendingStatus.reason,
      pausedAt: emailSendingStatus.pausedAt,
    })
    .from(emailSendingStatus)
    .where(eq(emailSendingStatus.environmentId, input.environmentId))
    .limit(1);

  return row ?? NEVER_STOPPED;
}

/**
 * Write the mirror. Idempotent by environment (the unique index is the upsert
 * arbiter), so a repeated EventBridge delivery or a re-drive converges.
 *
 * `pausedAt` is managed here rather than by the caller so the column can never
 * disagree with the status it describes: entering a blocking status stamps it,
 * leaving one clears it. `at` is injected so a mirror repair can record WHEN
 * AWS said so rather than when we noticed.
 */
export async function recordEmailSendingStatus(input: {
  environmentId: string;
  status: EmailSendingStatusValue;
  reason?: string | null;
  at?: Date;
  db?: CloudDb;
}): Promise<EmailSendingStatusRecord> {
  const db = input.db ?? defaultDb;
  const at = input.at ?? new Date();
  const reason = input.reason ?? null;
  const pausedAt = blocksSending(input.status) ? at : null;

  const [row] = await db
    .insert(emailSendingStatus)
    .values({
      environmentId: input.environmentId,
      status: input.status,
      reason,
      pausedAt,
    })
    .onConflictDoUpdate({
      target: emailSendingStatus.environmentId,
      set: { status: input.status, reason, pausedAt, updatedAt: at },
    })
    .returning({
      status: emailSendingStatus.status,
      reason: emailSendingStatus.reason,
      pausedAt: emailSendingStatus.pausedAt,
    });

  return row ?? { status: input.status, reason, pausedAt };
}
