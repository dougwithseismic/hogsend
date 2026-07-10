import type { Database } from "@hogsend/db";
import { emailSends, journeyStates } from "@hogsend/db";
import { and, eq, gte, ne } from "drizzle-orm";
import type { JourneyBoundary } from "../journeys/journey-boundary.js";
import { recordOnce } from "../journeys/record-once.js";

/**
 * True if a non-failed `email_sends` row exists for THIS journey — across ALL
 * of its enrollments — to THIS recipient within the suppress window. The
 * INNER JOIN to `journey_states` on `journey_state_id`, filtered by
 * `journey_id`, is what crosses enrollments: `meta.suppress` is a per-JOURNEY
 * min-gap, not per-enrollment, so a re-enrollment inside the window is still
 * gapped. Failed rows (`status = 'failed'`, never dispatched) are excluded,
 * mirroring {@link countRecentSends}. EXISTS semantics only — `limit(1)`, no
 * count needed.
 */
export async function hasRecentJourneySend(opts: {
  db: Database;
  journeyId: string;
  to: string;
  since: Date;
}): Promise<boolean> {
  const rows = await opts.db
    .select({ id: emailSends.id })
    .from(emailSends)
    .innerJoin(journeyStates, eq(emailSends.journeyStateId, journeyStates.id))
    .where(
      and(
        eq(journeyStates.journeyId, opts.journeyId),
        eq(emailSends.toEmail, opts.to),
        gte(emailSends.createdAt, opts.since),
        ne(emailSends.status, "failed"),
      ),
    )
    .limit(1);
  return rows.length > 0;
}

/**
 * The RECORDED-once journey-suppress verdict for a boundary send. Returns
 * `{ suppressed }` — `true` means the tracked mailer must skip the send
 * (`journey_suppressed`, no provider call, no `email_sends` row).
 *
 * REPLAY STABILITY (non-negotiable): the live EXISTS check diverges on replay —
 * the run's OWN send lands in the window, so an originally-ALLOWED send would
 * re-check as suppressed (a late duplicate), and an originally-SUPPRESSED send
 * could re-check as allowed if the blocking row was purged. So the verdict is
 * frozen set-once under `context.__throttle__` keyed by the send's resolved
 * idempotency key (already per-run-unique via `registerKey`, so it needs no
 * extra registration) and replayed verbatim thereafter — durable on ANY engine.
 *
 * The guard is INERT (returns `{ suppressed: false }` without touching the DB)
 * when there is no boundary, no `journeyId`, a zero `suppressMs`, or no resolved
 * idempotency key — i.e. every non-journey / transactional send is unaffected.
 */
export async function checkJourneySuppress(opts: {
  db: Database;
  boundary: JourneyBoundary | undefined;
  to: string;
  idempotencyKey: string | undefined;
  /** Injectable clock for tests; defaults to the live wall clock. */
  now?: number;
}): Promise<{ suppressed: boolean }> {
  const { db, boundary, to, idempotencyKey } = opts;
  if (
    !boundary?.journeyId ||
    !boundary.suppressMs ||
    boundary.suppressMs <= 0 ||
    !idempotencyKey
  ) {
    return { suppressed: false };
  }

  const { journeyId, suppressMs, stateId } = boundary;
  return recordOnce<{ suppressed: boolean }>({
    db,
    stateId,
    namespace: "__throttle__",
    key: `suppress:${idempotencyKey}`,
    compute: async () => {
      const since = new Date((opts.now ?? Date.now()) - suppressMs);
      return {
        suppressed: await hasRecentJourneySend({ db, journeyId, to, since }),
      };
    },
  });
}
