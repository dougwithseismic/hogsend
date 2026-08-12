import { and, eq, isNull } from "drizzle-orm";
import type { CloudDb } from "../db";
import { db as defaultDb } from "../db";
import { emailAbuseEvents } from "../db/schema";
import type { emailAbuseEventOutcomeEnum } from "../db/schema/enums";
import type { SesAbuseEvent } from "../eventbridge/events";

/**
 * THE EVENTBRIDGE JOURNAL (PRD 08 task 1 / task 7).
 *
 * EventBridge delivery is at-least-once, and the two things this stack does on
 * a pause event are exactly the two things that must not happen twice: stopping
 * a tenant (idempotent, harmless) and MAILING a customer to tell them their
 * sending has stopped (not idempotent, and arriving twice at the worst moment
 * of their week).
 *
 * So the journal row IS the claim. The unique index on `event_id` is what makes
 * a redelivery a no-op, and it is checked by INSERT-then-conflict rather than
 * by check-then-insert — the same reason the send relay's idempotency does:
 * two replicas handling one delivery race the read and both win it.
 *
 * `handled_at` is what makes the claim recoverable rather than merely safe. A
 * process that died between claiming the row and finishing the work leaves
 * `handled_at` null, and the redelivery that follows RESUMES instead of being
 * dropped. Without it, a crash mid-handling would convert an at-least-once
 * stream into a silently-lost pause.
 */

export type EmailAbuseEventOutcome =
  (typeof emailAbuseEventOutcomeEnum.enumValues)[number];

export type AbuseEventClaim =
  /** First sight of this event id. Handle it. */
  | { outcome: "fresh"; rowId: string }
  /** Claimed before, never finished. Handle it again. */
  | { outcome: "resume"; rowId: string }
  /** Already handled to completion. Do nothing. */
  | { outcome: "duplicate"; rowId: string };

/**
 * Claim this EventBridge delivery, recording it either way.
 *
 * Recording FIRST is deliberate: an event we cannot resolve to a tenant, or one
 * whose handling then throws, is still evidence and still has to be in the
 * journal. The alternative — record on success — loses exactly the events worth
 * keeping.
 */
export async function claimAbuseEvent(input: {
  event: SesAbuseEvent;
  db?: CloudDb;
}): Promise<AbuseEventClaim> {
  const db = input.db ?? defaultDb;
  const { event } = input;

  const [inserted] = await db
    .insert(emailAbuseEvents)
    .values({
      eventId: event.id,
      detailType: event.detailType,
      tenantName: event.tenantName,
      occurredAt: event.occurredAt,
      payload: event.raw,
    })
    .onConflictDoNothing({ target: emailAbuseEvents.eventId })
    .returning({ id: emailAbuseEvents.id });

  if (inserted) return { outcome: "fresh", rowId: inserted.id };

  const [existing] = await db
    .select({ id: emailAbuseEvents.id, handledAt: emailAbuseEvents.handledAt })
    .from(emailAbuseEvents)
    .where(eq(emailAbuseEvents.eventId, event.id))
    .limit(1);
  if (!existing) {
    // The conflicting row vanished between the insert and this read — only
    // reachable through a concurrent environment cascade. Treat it as fresh:
    // re-handling is idempotent, dropping it is not recoverable.
    return { outcome: "fresh", rowId: "" };
  }
  return {
    outcome: existing.handledAt ? "duplicate" : "resume",
    rowId: existing.id,
  };
}

/** Stamp the journal row with what we did, and that we finished doing it. */
export async function completeAbuseEvent(input: {
  rowId: string;
  outcome: EmailAbuseEventOutcome;
  environmentId?: string | null;
  at: Date;
  db?: CloudDb;
}): Promise<void> {
  if (!input.rowId) return;
  const db = input.db ?? defaultDb;
  await db
    .update(emailAbuseEvents)
    .set({
      outcome: input.outcome,
      environmentId: input.environmentId ?? null,
      handledAt: input.at,
      updatedAt: input.at,
    })
    .where(eq(emailAbuseEvents.id, input.rowId));
}

/**
 * Claim the right to send THIS pause event's suspension notice.
 *
 * A conditional update (`WHERE notified_at IS NULL`) rather than a read
 * followed by a write, so two replicas handling the same delivery cannot both
 * decide the notice is unsent. Returns false when somebody else already has it.
 */
export async function claimSuspensionNotice(input: {
  rowId: string;
  at: Date;
  db?: CloudDb;
}): Promise<boolean> {
  if (!input.rowId) return false;
  const db = input.db ?? defaultDb;
  const claimed = await db
    .update(emailAbuseEvents)
    .set({ notifiedAt: input.at, noticeError: null })
    .where(
      and(
        eq(emailAbuseEvents.id, input.rowId),
        isNull(emailAbuseEvents.notifiedAt),
      ),
    )
    .returning({ id: emailAbuseEvents.id });
  return claimed.length > 0;
}

/**
 * Hand the claim back after a failed send, with the reason.
 *
 * The pause STAYS — a notice we could not deliver is not a reason to let a
 * tenant AWS stopped keep sending — but the claim is released so a redelivery
 * (which resumes, because handling never completed) can try the mail again.
 */
export async function releaseSuspensionNotice(input: {
  rowId: string;
  error: string;
  db?: CloudDb;
}): Promise<void> {
  if (!input.rowId) return;
  const db = input.db ?? defaultDb;
  await db
    .update(emailAbuseEvents)
    .set({ notifiedAt: null, noticeError: input.error.slice(0, 2_000) })
    .where(eq(emailAbuseEvents.id, input.rowId));
}
