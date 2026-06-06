import type { HatchetClient } from "@hatchet-dev/typescript-sdk/v1/index.js";
import {
  type BucketMeta,
  collectPropertyNames,
  durationToMs,
  evaluateCondition,
} from "@hogsend/core";
import type { JourneyRegistry } from "@hogsend/core/registry";
import { bucketMemberships, contacts, type Database } from "@hogsend/db";
import { and, desc, eq, isNotNull, isNull } from "drizzle-orm";
import { emitBucketTransition } from "../lib/bucket-emit.js";
import type { Logger } from "../lib/logger.js";
import {
  BUCKET_EVENT_PREFIX,
  computeExpiresAt,
  computeMaxDwellAt,
  countPriorMemberships,
} from "./membership-epoch.js";
import { getBucketRegistrySingleton } from "./registry-singleton.js";

export type BucketTransitionKind = "entered" | "left";

export interface BucketTransition {
  bucketId: string;
  transition: BucketTransitionKind;
}

/**
 * Real-time bucket-membership re-evaluation, invoked from inside `ingestEvent`
 * AFTER the `userEvents` insert / idempotency short-circuit (Section 6.1).
 *
 * For the ingested event it narrows the candidate buckets via the registry's
 * event + property inverted indexes (Section 6.2), evaluates each candidate's
 * criteria against MERGED contact state (Section 6.1 rule #3), diffs the result
 * against the current `bucket_memberships` rows, and performs the atomic
 * RETURNING-gated mutation (partial-unique INSERT for joins, compare-and-swap
 * UPDATE for leaves — Section 6.3). On a real transition it emits
 * `bucket:entered:<id>` / `bucket:left:<id>` back through `ingestEvent`, gated on
 * the entryLimit policy and deferring leaves still inside `minDwell`.
 *
 * Returns the computed transition list so a unit test can assert enter/leave/no-op
 * WITHOUT a live Hatchet (Section 14 — the testing seam). Production callers
 * ignore the return value (the emission has already happened via recursion).
 */
export async function checkBucketMembership(opts: {
  db: Database;
  /** The JOURNEY registry — forwarded into the recursive emit ingestEvent. */
  registry: JourneyRegistry;
  hatchet: HatchetClient;
  logger: Logger;
  userId: string;
  userEmail: string | null;
  event: string;
  properties: Record<string, unknown>;
  /** Optional override; defaults to the process bucket-registry singleton. */
  bucketRegistry?: ReturnType<typeof getBucketRegistrySingleton>;
}): Promise<BucketTransition[]> {
  const {
    db,
    registry,
    hatchet,
    logger,
    userId,
    userEmail,
    event,
    properties,
  } = opts;

  // (1) Recursion guard — MUST be first. bucket:-prefixed events are transition
  // rows (still written to userEvents / pushed to Hatchet / run through
  // checkExits) but MUST NOT trigger bucket re-evaluation, else the emit recurses
  // forever. ingestEvent has no built-in re-entry guard, so this prefix check is
  // the bound on recursion (Section 6.1 rule #1).
  if (event.startsWith(BUCKET_EVENT_PREFIX)) {
    return [];
  }

  // The bucket registry is resolved separately from the journey registry; the
  // two are never conflated (Section 6.1 signature note).
  const bucketRegistry = opts.bucketRegistry ?? getBucketRegistrySingleton();

  // (2) Candidate narrowing — the UNION of buckets referencing this event name
  // (eventIndex + the degenerate wildcard set) and buckets referencing any
  // property present in this payload (propertyIndex). Section 6.2.
  const candidateMap = new Map<string, BucketMeta>();
  for (const bucket of bucketRegistry.getByReferencedEvent(event)) {
    candidateMap.set(bucket.id, bucket);
  }
  for (const key of Object.keys(properties ?? {})) {
    for (const bucket of bucketRegistry.getByReferencedProperty(key)) {
      candidateMap.set(bucket.id, bucket);
    }
  }

  if (candidateMap.size === 0) {
    return [];
  }

  const candidates = Array.from(candidateMap.values()).filter(
    // manual buckets are not criteria-driven; they never appear in the indexes,
    // but guard defensively. enabled is the static load-time flag (the DB
    // bucket_configs override is a later-phase concern, not read on this hot
    // path — Section 6.2).
    (bucket) =>
      bucket.enabled && bucket.kind !== "manual" && bucket.criteria != null,
  );

  if (candidates.length === 0) {
    return [];
  }

  // (3) Property predicates evaluate against MERGED contact state, NOT the bare
  // event payload (Section 6.1 rule #3). Read the EXISTING contacts row ONCE iff
  // any surviving candidate references a property — pure event/count buckets skip
  // the read entirely. We read the row that already exists (not the one
  // upsertContact is concurrently writing) so we do not depend on the
  // fire-and-forget upsert having run.
  const needsContactState = candidates.some(
    (bucket) =>
      bucket.criteria != null &&
      collectPropertyNames(bucket.criteria).length > 0,
  );

  let contactProperties: Record<string, unknown> = {};
  let contactDeleted = false;
  if (needsContactState) {
    const [contact] = await db
      .select({
        properties: contacts.properties,
        deletedAt: contacts.deletedAt,
      })
      .from(contacts)
      .where(eq(contacts.externalId, userId))
      .limit(1);
    if (contact) {
      contactProperties =
        (contact.properties as Record<string, unknown> | null) ?? {};
      contactDeleted = contact.deletedAt != null;
    }
  }

  // GDPR: never (re-)evaluate or emit for a soft-deleted contact (Section 8.6).
  if (contactDeleted) {
    return [];
  }

  // event payload overlays cumulative contact state.
  const journeyContext: Record<string, unknown> = {
    ...contactProperties,
    ...(properties ?? {}),
  };

  const transitions: BucketTransition[] = [];

  for (const bucket of candidates) {
    if (!bucket.criteria) continue;

    // wasMember — current active, non-deleted membership row (cheap pre-filter;
    // the authoritative guard is the RETURNING-gated mutation below).
    const active = await db.query.bucketMemberships.findFirst({
      where: and(
        eq(bucketMemberships.userId, userId),
        eq(bucketMemberships.bucketId, bucket.id),
        eq(bucketMemberships.status, "active"),
        isNull(bucketMemberships.deletedAt),
      ),
    });
    const wasMember = !!active;

    // isMember — the criteria evaluation. event/count sub-conditions read
    // userEvents (the just-stored row is visible on the same connection — the
    // documented no-pooler assumption, Section 6.1 rule #2); property
    // sub-conditions read the merged journeyContext.
    const isMember = await evaluateCondition({
      condition: bucket.criteria,
      ctx: { db, userId, journeyContext },
    });

    if (!wasMember && isMember) {
      const transition = await handleJoin({
        db,
        registry,
        hatchet,
        logger,
        bucket,
        userId,
        userEmail,
      });
      if (transition) transitions.push(transition);
    } else if (wasMember && isMember) {
      // stable member → no transition, no emit. Cheap observability bump.
      await db
        .update(bucketMemberships)
        .set({ lastEvaluatedAt: new Date() })
        .where(eq(bucketMemberships.id, active.id));
    } else if (wasMember && !isMember) {
      const transition = await handleLeave({
        db,
        registry,
        hatchet,
        logger,
        bucket,
        active,
        userId,
        userEmail,
      });
      if (transition) transitions.push(transition);
    }
    // !wasMember && !isMember → nothing.
  }

  return transitions;
}

async function handleJoin(opts: {
  db: Database;
  registry: JourneyRegistry;
  hatchet: HatchetClient;
  logger: Logger;
  bucket: BucketMeta;
  userId: string;
  userEmail: string | null;
}): Promise<BucketTransition | null> {
  const { db, registry, hatchet, logger, bucket, userId, userEmail } = opts;

  // entryCount ordinal = 1 + count of ALL prior memberships (active + left) for
  // this (user, bucket) (Section 6.3 / 8.2). priorCount also drives the entryLimit
  // gate. Shared with the reconcile-discovered join path so the ordinal can
  // never drift between the two writers.
  const priorCount = await countPriorMemberships(db, bucket.id, userId);
  const epoch = priorCount + 1;

  // INSERT a FRESH active row. ON CONFLICT DO NOTHING targets the partial active
  // unique index (uq_user_bucket_active): a concurrent emitter that already
  // inserted the active row makes THIS insert return zero rows → we do NOT emit
  // (the loser mutates nothing — Section 6.3 governing rule).
  const expiresAt = computeExpiresAt(bucket);
  // Unconditional TTL deadline — set once on join, swept by the reconcile cron.
  const maxDwellAt = computeMaxDwellAt(bucket);
  const inserted = await db
    .insert(bucketMemberships)
    .values({
      userId,
      userEmail,
      bucketId: bucket.id,
      status: "active",
      source: "event",
      entryCount: epoch,
      expiresAt,
      maxDwellAt,
      lastEvaluatedAt: new Date(),
    })
    .onConflictDoNothing()
    .returning({ id: bucketMemberships.id });

  const insertedRow = inserted[0];
  if (!insertedRow) {
    // Lost the race; the winner emits. We did not change a row → no emit.
    return null;
  }

  // Arm the per-user fast-expiry durable timer (Section 6.5) AFTER the active row
  // is written. The cron remains the authoritative backstop, so a push failure
  // is best-effort. We arm against the persisted expiresAt so the timer's CAS on
  // wake matches the row (or no-ops if a later event re-armed the window).
  if (bucket.fastExpiry && expiresAt) {
    await armExpiryTimer({
      hatchet,
      logger,
      bucket,
      rowId: insertedRow.id,
      userId,
      userEmail,
      expiresAt,
    });
  }

  // The active row is always written (Studio size must reflect reality) and the
  // epoch always advances via the real insert; only the bucket:entered emission
  // is gated by the entryLimit policy (Section 6.3).
  if (await shouldEmitJoin({ db, bucket, userId, priorCount })) {
    await emitBucketTransition({
      db,
      registry,
      hatchet,
      logger,
      kind: "entered",
      bucket,
      userId,
      userEmail,
      epoch,
      source: "event",
    });
  } else {
    logger.info("Bucket join emit suppressed by entryLimit policy", {
      bucketId: bucket.id,
      userId,
      entryLimit: bucket.entryLimit ?? "unlimited",
    });
  }

  return { bucketId: bucket.id, transition: "entered" };
}

async function handleLeave(opts: {
  db: Database;
  registry: JourneyRegistry;
  hatchet: HatchetClient;
  logger: Logger;
  bucket: BucketMeta;
  active: typeof bucketMemberships.$inferSelect;
  userId: string;
  userEmail: string | null;
}): Promise<BucketTransition | null> {
  const { db, registry, hatchet, logger, bucket, active, userId, userEmail } =
    opts;

  // minDwell DEFERS (never silently drops) the leave (Section 6.3). We set a
  // pending-leave deadline on expiresAt = enteredAt + minDwell so the reconcile
  // cron / fastExpiry timer re-checks after the dwell window and emits the leave
  // via the CAS path. We do NOT emit now.
  if (withinMinDwell(active, bucket)) {
    const deadline = new Date(
      active.enteredAt.getTime() +
        durationToMs(bucket.minDwell as NonNullable<BucketMeta["minDwell"]>),
    );
    await db
      .update(bucketMemberships)
      .set({ expiresAt: deadline, lastEvaluatedAt: new Date() })
      .where(
        and(
          eq(bucketMemberships.id, active.id),
          eq(bucketMemberships.status, "active"),
        ),
      );
    logger.info("Bucket leave deferred by minDwell", {
      bucketId: bucket.id,
      userId,
      deferUntil: deadline.toISOString(),
    });
    return null;
  }

  // Compare-and-swap: only the emitter whose UPDATE actually flips the active row
  // emits. A concurrent emitter that already flipped it matches zero rows → no
  // emit (Section 6.3).
  const left = await db
    .update(bucketMemberships)
    .set({
      status: "left",
      leftAt: new Date(),
      lastEvaluatedAt: new Date(),
      updatedAt: new Date(),
    })
    .where(
      and(
        eq(bucketMemberships.id, active.id),
        eq(bucketMemberships.status, "active"),
      ),
    )
    .returning({
      id: bucketMemberships.id,
      entryCount: bucketMemberships.entryCount,
    });

  const flipped = left[0];
  if (!flipped) {
    return null;
  }

  await emitBucketTransition({
    db,
    registry,
    hatchet,
    logger,
    kind: "left",
    bucket,
    userId,
    userEmail,
    epoch: flipped.entryCount,
    source: "event",
    reason: "criteria",
  });

  return { bucketId: bucket.id, transition: "left" };
}

/**
 * The `entryLimit` emit gate, consulted on the JOIN transition only (Section 6.3).
 * Suppressing the emit still wrote the active row and advanced the epoch — only
 * the `bucket:entered` ingestEvent recursion is skipped.
 *
 * The engine now enforces `once_per_period` PRECISELY: it reads the most-recent
 * prior LEAVE (`status:"left"` with `leftAt` set) and emits only once the
 * configured `entryPeriod` has elapsed since that leave. The journey-side
 * entryLimit/entryPeriod is a redundant backstop, no longer the sole gate.
 */
export async function shouldEmitJoin(opts: {
  db: Database;
  bucket: BucketMeta;
  userId: string;
  priorCount: number;
}): Promise<boolean> {
  const { db, bucket, userId, priorCount } = opts;
  // First-ever join always emits.
  if (priorCount === 0) return true;
  switch (bucket.entryLimit ?? "unlimited") {
    case "unlimited":
      return true;
    case "once":
      // Any prior membership → suppress (mirrors checkEntryLimit "once").
      return false;
    case "once_per_period": {
      // Back-compat: with no period configured, preserve 0.2.0 behavior (emit)
      // and defer cooldown to the journey-side entryLimit/entryPeriod.
      if (!bucket.entryPeriod) return true;
      // Look up the most-recent COMPLETED prior cycle. Scoping to status:"left"
      // (not "any prior row") makes this order-independent and race-safe against
      // the active row we just inserted at this join — that row has no leftAt and
      // status:"active", so it can never be mistaken for the prior cycle.
      const [prior] = await db
        .select({ leftAt: bucketMemberships.leftAt })
        .from(bucketMemberships)
        .where(
          and(
            eq(bucketMemberships.userId, userId),
            eq(bucketMemberships.bucketId, bucket.id),
            eq(bucketMemberships.status, "left"),
            isNotNull(bucketMemberships.leftAt),
          ),
        )
        .orderBy(desc(bucketMemberships.leftAt))
        .limit(1);
      // No completed prior cycle to cool off from → emit.
      if (!prior?.leftAt) return true;
      const elapsed = Date.now() - prior.leftAt.getTime();
      return elapsed >= durationToMs(bucket.entryPeriod);
    }
    default:
      return true;
  }
}

/** True while the active membership is still inside its minDwell window. */
function withinMinDwell(
  active: typeof bucketMemberships.$inferSelect,
  bucket: BucketMeta,
): boolean {
  if (!bucket.minDwell) return false;
  const elapsed = Date.now() - active.enteredAt.getTime();
  return elapsed < durationToMs(bucket.minDwell);
}

/**
 * Arm the shared per-user fast-expiry durable timer by pushing a
 * `bucket:arm-expiry` event (Section 6.5). The single shared `bucketExpiryTask`
 * durableTask (workflows/bucket-reconcile.ts) routes on `onEvents:
 * ["bucket:arm-expiry"]`, durably sleeps to the deadline, then leaves via a CAS
 * keyed on the ARMED `expiresAt`. The `bucket:`-prefixed event is recursion-guarded
 * by `checkBucketMembership`, so arming does NOT re-enter bucket evaluation.
 * Best-effort: the cron is the authoritative backstop, so a push failure is logged
 * and swallowed.
 */
async function armExpiryTimer(opts: {
  hatchet: HatchetClient;
  logger: Logger;
  bucket: BucketMeta;
  rowId: string;
  userId: string;
  userEmail: string | null;
  expiresAt: Date;
}): Promise<void> {
  const { hatchet, logger, bucket, rowId, userId, userEmail, expiresAt } = opts;
  const msUntilExpiry = Math.max(0, expiresAt.getTime() - Date.now());
  try {
    await hatchet.events.push("bucket:arm-expiry", {
      rowId,
      bucketId: bucket.id,
      userId,
      userEmail,
      armedExpiresAt: expiresAt.toISOString(),
      msUntilExpiry,
    });
  } catch (err) {
    logger.warn("Bucket fast-expiry arm failed (cron backstop covers it)", {
      bucketId: bucket.id,
      userId,
      error: err instanceof Error ? err.message : String(err),
    });
  }
}
