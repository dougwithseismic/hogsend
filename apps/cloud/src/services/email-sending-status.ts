import { eq } from "drizzle-orm";
import type { CloudDb } from "../db";
import { db as defaultDb } from "../db";
import { emailPauseHistory, emailSendingStatus } from "../db/schema";
import type {
  emailPauseSourceEnum,
  emailSendingStatusEnum,
} from "../db/schema/enums";

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

export type EmailPauseSource = (typeof emailPauseSourceEnum.enumValues)[number];

export interface EmailSendingStatusRecord {
  status: EmailSendingStatusValue;
  reason: string | null;
  /** When it last entered a blocking status; null while it is sending. */
  pausedAt: Date | null;
}

export interface EmailSendingStatusWrite extends EmailSendingStatusRecord {
  /**
   * Did this write actually MOVE the status?
   *
   * The suspension notice is keyed on it for every writer that has no event id
   * to key on (the reputation sweep, an operator stop): a re-asserted pause is
   * not a new pause event, and mailing a customer again about a suspension they
   * already know about is the one thing a notice must never do.
   */
  changed: boolean;
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
 *
 * **It also appends the pause history (PRD 08).** Deliberately here rather than
 * in each caller: this is the ONE choke point every status transition passes
 * through — EventBridge, the relay repairing the mirror at the wire, the
 * reputation sweep, an operator — so a history assembled anywhere else would be
 * missing whichever writer was added last. A row is appended only when the
 * status actually MOVES, because history is a list of transitions and a
 * re-asserted pause is not one.
 *
 * The read-then-write is not transactional, and the benign race it admits is a
 * duplicate history row for two concurrent writers of the SAME transition. The
 * alternative — locking a row that may not exist yet — would put a lock on the
 * relay's hot path to protect a log.
 */
export async function recordEmailSendingStatus(input: {
  environmentId: string;
  status: EmailSendingStatusValue;
  reason?: string | null;
  at?: Date;
  /** Who decided. Defaults to `operator`; the relay passes `relay`. */
  source?: EmailPauseSource;
  /** The EventBridge event behind it, when there was one. */
  eventId?: string | null;
  db?: CloudDb;
}): Promise<EmailSendingStatusWrite> {
  const db = input.db ?? defaultDb;
  const at = input.at ?? new Date();
  const reason = input.reason ?? null;
  const pausedAt = blocksSending(input.status) ? at : null;

  const before = await readEmailSendingStatus({
    environmentId: input.environmentId,
    db,
  });

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

  const changed = before.status !== input.status;
  if (changed) {
    await db.insert(emailPauseHistory).values({
      environmentId: input.environmentId,
      status: input.status,
      reason,
      source: input.source ?? "operator",
      eventId: input.eventId ?? null,
      at,
    });
  }

  return { ...(row ?? { status: input.status, reason, pausedAt }), changed };
}
