import { and, eq, inArray, isNull, lt } from "drizzle-orm";
import type { CloudDb } from "../db";
import { db as defaultDb } from "../db";
import { emailIdempotency } from "../db/schema";

/**
 * The relay's exactly-once guard.
 *
 * READ THE TABLE'S OWN NOTE FIRST (`db/schema/email-idempotency.ts`) — it
 * states why the row is inserted BEFORE the send rather than after, and why a
 * check-then-insert is not a smaller version of the same thing but a different,
 * broken one.
 *
 * The protocol, in three calls:
 *
 *  1. `claimIdempotencyKey` — INSERT … ON CONFLICT DO NOTHING. A returned row
 *     means we won and may go to the wire. No row means somebody else has the
 *     key, and the existing row says who: a message id means it already sent
 *     (replay it), a null one means a send is at the wire right now.
 *  2. `commitIdempotencyClaim` — the send returned an id; write it, and the
 *     claim becomes the replayable answer.
 *  3. `releaseIdempotencyClaim` — the send did NOT happen; delete the claim,
 *     presenting the `claimedAt` the claim handed back as proof it is still
 *     OURS (a stale-claim takeover reuses the row, so a row id alone is not).
 *     Any failure at all releases, so the invariant a caller can rely on is
 *     absolute: A ROW WITH A MESSAGE ID MEANS THE MESSAGE REACHED SES. An
 *     idempotency entry left behind by a failed send would make the caller's
 *     retry return a success for a message nobody ever received, which is
 *     silent, permanent loss (PRD 03, EARS 6).
 */

/**
 * How long a recorded send stays replayable.
 *
 * Seven days. The window has to cover the longest gap between a journey step
 * running and the same step being replayed after a crash or a redeploy, and
 * Hatchet's own run retention is the practical bound on that. Longer buys
 * nothing a durable run could use and costs an unbounded table; shorter risks a
 * genuine replay finding no row and sending twice, which is the failure this
 * whole module exists to prevent.
 */
export const EMAIL_IDEMPOTENCY_RETENTION_MS = 7 * 24 * 60 * 60 * 1000;

/**
 * How long a claim with no message id is believed to be live.
 *
 * A process killed between the claim and the send leaves a claim nobody will
 * ever finish. Without a takeover that idempotency key is poisoned forever and
 * the message can never be sent — so past this window the claim is re-takeable.
 * Sixty seconds is comfortably longer than any single SES round trip plus its
 * bounded retries, so a claim this old is not slow, it is dead.
 *
 * THE ONE WINDOW THIS SYSTEM IS AT-LEAST-ONCE, stated plainly because it cannot
 * be closed and should not be discovered later: a process that dies AFTER SES
 * accepted the message but BEFORE `commitIdempotencyClaim` lands leaves a claim
 * indistinguishable from one that died before the send. The takeover therefore
 * re-sends, and the recipient gets it twice. There is no fix — SES is not in
 * our transaction — only a choice of which way to be wrong, and for lifecycle
 * and transactional mail a duplicate is recoverable while a password reset that
 * never arrives is not. So the default is deliberately "send again".
 */
export const EMAIL_IDEMPOTENCY_CLAIM_TIMEOUT_MS = 60_000;

export type IdempotencyClaim =
  /**
   * We own the key. Go to the wire, then commit or release.
   *
   * `claimedAt` is the ownership proof: the exact instant this claim stamped
   * on the row. A release must present it, because after the stale-claim
   * takeover below the SAME row id can belong to a NEWER claimant — a row id
   * alone says which row, never whose claim.
   */
  | { outcome: "claimed"; rowId: string; claimedAt: Date }
  /** Already sent under this key. Return this id; do NOT call SES. */
  | { outcome: "replay"; messageId: string }
  /** Somebody else is at the wire with this key right now. */
  | { outcome: "in_flight" };

export interface ClaimIdempotencyInput {
  environmentId: string;
  idempotencyKey: string;
  /** Injected by tests so the stale-claim takeover is reachable. */
  now?: Date;
  db?: CloudDb;
}

export async function claimIdempotencyKey(
  input: ClaimIdempotencyInput,
): Promise<IdempotencyClaim> {
  const db = input.db ?? defaultDb;
  const now = input.now ?? new Date();

  // THE GUARD. Two simultaneous identical sends both run this statement; the
  // unique index means exactly one of them gets a row back.
  const [inserted] = await db
    .insert(emailIdempotency)
    .values({
      environmentId: input.environmentId,
      idempotencyKey: input.idempotencyKey,
      createdAt: now,
      claimedAt: now,
    })
    .onConflictDoNothing({
      target: [emailIdempotency.environmentId, emailIdempotency.idempotencyKey],
    })
    .returning({ id: emailIdempotency.id });

  if (inserted) {
    return { outcome: "claimed", rowId: inserted.id, claimedAt: now };
  }

  const existing = await findClaim(
    db,
    input.environmentId,
    input.idempotencyKey,
  );
  // Gone between the conflict and this read: the other contender's send failed
  // and released. Nothing was sent, and the caller's own retry is the right
  // place to try again — re-claiming here would race the same way twice.
  if (!existing) return { outcome: "in_flight" };
  if (existing.messageId) {
    return { outcome: "replay", messageId: existing.messageId };
  }

  const age = now.getTime() - existing.claimedAt.getTime();
  if (age < EMAIL_IDEMPOTENCY_CLAIM_TIMEOUT_MS) return { outcome: "in_flight" };

  // Stale. Take it over with a compare-and-set on the exact `claimed_at` we
  // read, so if two callers both find it stale, exactly one wins the update and
  // the other is told the key is in flight — which, by then, it is.
  const [taken] = await db
    .update(emailIdempotency)
    .set({ claimedAt: now })
    .where(
      and(
        eq(emailIdempotency.id, existing.id),
        isNull(emailIdempotency.messageId),
        eq(emailIdempotency.claimedAt, existing.claimedAt),
      ),
    )
    .returning({ id: emailIdempotency.id });

  return taken
    ? { outcome: "claimed", rowId: taken.id, claimedAt: now }
    : { outcome: "in_flight" };
}

/**
 * The send succeeded: this id is what every later replay of the key answers.
 *
 * `messageId IS NULL` makes the FIRST commit win. After a stale-claim
 * takeover, both the thief and a slower-than-the-takeover-window original
 * claimant can reach SES (that duplicate is the takeover's documented price);
 * whichever commits first is the recorded answer, and the later commit must
 * not overwrite it. Deliberately NOT an ownership check: a stolen claimant
 * whose send genuinely reached SES still records it if nobody beat them to
 * it — a real message id is never discarded in favour of nothing.
 */
export async function commitIdempotencyClaim(input: {
  rowId: string;
  messageId: string;
  db?: CloudDb;
}): Promise<void> {
  const db = input.db ?? defaultDb;
  await db
    .update(emailIdempotency)
    .set({ messageId: input.messageId })
    .where(
      and(
        eq(emailIdempotency.id, input.rowId),
        isNull(emailIdempotency.messageId),
      ),
    );
}

/**
 * The send did not happen: leave NOTHING behind — but only OUR nothing.
 *
 * Two predicates, each against a different thief-race:
 *  - `messageId IS NULL` — if this claim was stolen by a later caller who then
 *    SUCCEEDED, our late release must not delete their recorded send;
 *  - `claimedAt = ours` — if the thief is still AT THE WIRE, the row carries
 *    their `claimedAt`, not ours, and deleting it would reopen the key while
 *    their send is in flight: a third contender could claim it (another
 *    duplicate), and the thief's own commit would land on a deleted row,
 *    silently unrecording a message SES accepted — which a later replay would
 *    then send AGAIN. A row id names the row; `claimedAt` names whose claim.
 */
export async function releaseIdempotencyClaim(input: {
  rowId: string;
  claimedAt: Date;
  db?: CloudDb;
}): Promise<void> {
  const db = input.db ?? defaultDb;
  await db
    .delete(emailIdempotency)
    .where(
      and(
        eq(emailIdempotency.id, input.rowId),
        eq(emailIdempotency.claimedAt, input.claimedAt),
        isNull(emailIdempotency.messageId),
      ),
    );
}

/**
 * Release several claims — the batch path's rollback.
 *
 * One `claimedAt` for all of them, because that is what the batch path holds:
 * every claim in one request is stamped with the request's single `now`
 * (fresh insert and takeover alike), so one value proves ownership of all.
 */
export async function releaseIdempotencyClaims(input: {
  rowIds: string[];
  claimedAt: Date;
  db?: CloudDb;
}): Promise<void> {
  if (input.rowIds.length === 0) return;
  const db = input.db ?? defaultDb;
  await db
    .delete(emailIdempotency)
    .where(
      and(
        inArray(emailIdempotency.id, input.rowIds),
        eq(emailIdempotency.claimedAt, input.claimedAt),
        isNull(emailIdempotency.messageId),
      ),
    );
}

/**
 * Retire rows past the retention window.
 *
 * Scoped to one environment by default, because that is how the relay calls it:
 * on the request that OPENS an environment's rate-limit window, exactly once a
 * minute, which is the same idiom `consumeRateLimit` uses to keep its own table
 * bounded — cheap, indexed, deterministic, and no cron to forget to schedule.
 * Omitting `environmentId` sweeps the whole table, for an operator or a future
 * housekeeping task.
 */
export async function sweepEmailIdempotency(input: {
  environmentId?: string;
  now?: Date;
  retentionMs?: number;
  db?: CloudDb;
}): Promise<number> {
  const db = input.db ?? defaultDb;
  const now = input.now ?? new Date();
  const cutoff = new Date(
    now.getTime() - (input.retentionMs ?? EMAIL_IDEMPOTENCY_RETENTION_MS),
  );

  const expired = lt(emailIdempotency.createdAt, cutoff);
  const deleted = await db
    .delete(emailIdempotency)
    .where(
      input.environmentId === undefined
        ? expired
        : and(eq(emailIdempotency.environmentId, input.environmentId), expired),
    )
    .returning({ id: emailIdempotency.id });

  return deleted.length;
}

async function findClaim(
  db: CloudDb,
  environmentId: string,
  idempotencyKey: string,
) {
  const [row] = await db
    .select({
      id: emailIdempotency.id,
      messageId: emailIdempotency.messageId,
      claimedAt: emailIdempotency.claimedAt,
    })
    .from(emailIdempotency)
    .where(
      and(
        eq(emailIdempotency.environmentId, environmentId),
        eq(emailIdempotency.idempotencyKey, idempotencyKey),
      ),
    )
    .limit(1);
  return row;
}
