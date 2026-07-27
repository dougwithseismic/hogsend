import type { HatchetClient } from "@hatchet-dev/typescript-sdk/v1/index.js";
import type { BucketMeta } from "@hogsend/core";
import type { BucketRegistry, JourneyRegistry } from "@hogsend/core/registry";
import { bucketMemberships, contacts, type Database } from "@hogsend/db";
import { and, eq, inArray, isNull, sql } from "drizzle-orm";
import type { BucketLeaveReason } from "../buckets/bucket-reactions.js";
import {
  type BucketTransitionSource,
  emitBucketTransition,
} from "../lib/bucket-emit.js";
import {
  contactKeySql,
  liveContactByCanonicalKey,
  normalizeEmailOrNull,
} from "../lib/contacts.js";
import type { Logger } from "../lib/logger.js";
import { shouldEmitJoin } from "./check-membership.js";
import {
  computeMaxDwellAt,
  countPriorMemberships,
  minDwellDeadline,
} from "./membership-epoch.js";
import { getBucketRegistrySingleton } from "./registry-singleton.js";

/**
 * THE membership-mutation seam for `kind:"manual"` buckets (PRD 01 T01.3).
 *
 * `emitBucketTransition` ONLY emits — it takes `epoch` as an INPUT, does not
 * derive it, and never touches `bucket_memberships`. Every existing producer
 * (real-time `checkBucketMembership`, the reconcile cron, backfill) writes the
 * membership row ITSELF and only then calls it. These functions are the same
 * shape for the explicit-write path, and they are the ONLY place a manual
 * bucket's membership changes: they own the row write, the epoch via
 * `countPriorMemberships()`, `maxDwellAt` via `computeMaxDwellAt()`, the
 * `entryLimit` gate via `shouldEmitJoin()`, the `minDwell` leave deferral, and
 * then the emit. Callers (the `/v1/buckets/:id/members` route, the cohort
 * poller) call `emitBucketTransition` NEVER.
 *
 * Dependencies are passed EXPLICITLY so a Hatchet task that self-bootstraps
 * `db`/`logger` from `process.env` (the `bucketReconcileTask` shape) can call
 * these with no request container and get identical behaviour.
 */

/** Why a mutation was refused. Mapped to an HTTP status by the route layer. */
export type BucketMembershipErrorCode =
  | "bucket_not_found"
  | "bucket_not_manual";

export class BucketMembershipError extends Error {
  readonly code: BucketMembershipErrorCode;
  readonly bucketId: string;

  constructor(code: BucketMembershipErrorCode, bucketId: string) {
    super(
      code === "bucket_not_found"
        ? `Bucket "${bucketId}" is not registered.`
        : `Bucket "${bucketId}" is not kind:"manual"; its membership is owned by its criteria and must not be mutated explicitly.`,
    );
    this.name = "BucketMembershipError";
    this.code = code;
    this.bucketId = bucketId;
  }
}

/**
 * What the mutation actually did, so a caller (the cohort poller's diff engine)
 * can act on the outcome WITHOUT re-querying `bucket_memberships`:
 *
 *  - `applied`                  — the row was written/flipped AND a transition emitted.
 *  - `already-active`           — an active row already existed; nothing written, nothing emitted.
 *                                 A pending `minDwell`-deferred leave IS disarmed here.
 *  - `already-left`             — no active row to leave (or a concurrent writer won the CAS).
 *  - `deferred`                 — leave held back inside `minDwell`; the row carries a PENDING
 *                                 leave (deadline + `emit` intent) the reconcile pass resolves.
 *                                 Never dropped.
 *  - `suppressed-by-entry-limit`— row written, emit gated by the bucket's `entryLimit`.
 *  - `seeded`                   — a JOIN row written with emission deliberately suppressed
 *                                 (the Customer.io rule: an existing population
 *                                 must not fire into live journeys).
 *  - `leave-seeded`             — a LEAVE flipped with emission deliberately suppressed. A
 *                                 DISTINCT verdict from `seeded` so a poller can tell a
 *                                 suppressed leave from a seeded join without re-querying.
 */
export type BucketMembershipVerdict =
  | "applied"
  | "already-active"
  | "already-left"
  | "deferred"
  | "suppressed-by-entry-limit"
  | "seeded"
  | "leave-seeded";

export interface BucketMembershipResult {
  /** True iff `emitBucketTransition` ran for this call. */
  emitted: boolean;
  /**
   * The membership epoch (`bucket_memberships.entryCount`) this call acted on.
   * For `already-left` with no history at all it is 0 — there is no epoch.
   */
  epoch: number;
  verdict: BucketMembershipVerdict;
}

/**
 * The explicit dependency bundle. NEVER `c.get("container")`, never a
 * request-resolved module singleton — a Hatchet task passes its own
 * self-bootstrapped `db`/`logger` here (AC 11).
 */
export interface BucketMembershipDeps {
  db: Database;
  /** The JOURNEY registry, forwarded into the transition re-ingest. */
  registry: JourneyRegistry;
  hatchet: HatchetClient;
  logger: Logger;
  /** Optional override; defaults to the process bucket-registry singleton. */
  bucketRegistry?: BucketRegistry;
}

/** Default `bucket_memberships.source` for each write path. */
const MANUAL_SOURCE = "manual";
const SEED_SOURCE = "seed";

/**
 * The `bucket_memberships.context` key under which a `minDwell`-DEFERRED leave
 * is recorded. AC 7 says `minDwell` must "defer the leave, never drop it", so a
 * deferral has to be a PENDING INTENT the reconcile pass can find and honour —
 * not merely a timestamp on `expiresAt`.
 *
 * `expiresAt` alone is not enough for two reasons:
 *
 *  1. It is ambiguous. On a dynamic bucket `expiresAt` is the criteria-window /
 *     fastExpiry arming epoch; keying the resolution pass on a bare `expiresAt`
 *     means "somebody asked for this leave" and "this membership window is
 *     armed" are the same state.
 *  2. It cannot carry the caller's `emit` intent, so a leave suppressed with
 *     `emit: false` would still be emitted later by the reconcile pass —
 *     breaking the seed contract (DECISIONS §2.7a).
 *
 * The marker is written and cleared with jsonb merge/delete SQL (never a
 * read-modify-write of the whole `context` blob), so a concurrent writer
 * touching another key is not clobbered.
 */
export const PENDING_LEAVE_KEY = "__pendingLeave__";

/** The recorded pending leave. See {@link PENDING_LEAVE_KEY}. */
export interface PendingBucketLeave {
  /** ISO of the armed `minDwell` deadline; mirrors the row's `expiresAt`. */
  deferUntil: string;
  /** The caller's `emit` intent, replayed when the deferral is resolved. */
  emit: boolean;
}

/** Read the pending-leave marker off a membership row's `context`, if any. */
export function readPendingLeave(
  context: Record<string, unknown> | null | undefined,
): PendingBucketLeave | null {
  const raw = context?.[PENDING_LEAVE_KEY];
  if (raw == null || typeof raw !== "object") return null;
  const { deferUntil, emit } = raw as Partial<PendingBucketLeave>;
  if (typeof deferUntil !== "string") return null;
  return { deferUntil, emit: emit !== false };
}

/** `context || {"__pendingLeave__": …}` — an atomic jsonb merge. */
function armPendingLeaveSql(pending: PendingBucketLeave) {
  return sql`coalesce(${bucketMemberships.context}, '{}'::jsonb) || ${JSON.stringify(
    { [PENDING_LEAVE_KEY]: pending },
  )}::jsonb`;
}

/** `context - '__pendingLeave__'` — an atomic jsonb key delete. */
function disarmPendingLeaveSql() {
  return sql`coalesce(${bucketMemberships.context}, '{}'::jsonb) - ${PENDING_LEAVE_KEY}`;
}

/** Seed insert chunk size — the `import-contacts` / backfill precedent. */
const DEFAULT_BATCH_SIZE = 500;

/**
 * Resolve the bucket and refuse anything that is not `kind:"manual"`. A dynamic
 * bucket's membership is owned by its criteria: an explicit write would be
 * silently reverted by the next real-time evaluation or reconcile sweep, so it
 * fails LOUDLY instead.
 */
function resolveManualBucket(
  bucketId: string,
  bucketRegistry?: BucketRegistry,
): BucketMeta {
  const registry = bucketRegistry ?? getBucketRegistrySingleton();
  const bucket = registry.get(bucketId);
  if (!bucket) {
    throw new BucketMembershipError("bucket_not_found", bucketId);
  }
  if ((bucket.kind ?? "dynamic") !== "manual") {
    throw new BucketMembershipError("bucket_not_manual", bucketId);
  }
  return bucket;
}

/**
 * Fill the contact provenance pin + denormalized email from the LIVE contacts
 * row when the caller did not supply them.
 *
 * The pin is load-bearing (issue #608): `emitBucketTransition` re-ingests the
 * transition, and `userId` is the contact's CANONICAL key
 * (`external_id ?? anonymous_id ?? id`) while the resolver treats a bare
 * `userId` as an EXTERNAL key. Without the pin, an anonymous-only contact gets
 * a phantom `external_id` twin minted on every transition. Resolving here makes
 * the seam correct by construction rather than depending on every caller
 * remembering.
 */
async function resolveIdentity(
  db: Database,
  userId: string,
  given: { contactId?: string; userEmail?: string | null },
): Promise<{ contactId?: string; userEmail: string | null }> {
  if (given.contactId != null && given.userEmail !== undefined) {
    return {
      contactId: given.contactId,
      userEmail: normalizeEmailOrNull(given.userEmail),
    };
  }
  const [contact] = await db
    .select({ id: contacts.id, email: contacts.email })
    .from(contacts)
    .where(liveContactByCanonicalKey(userId))
    .limit(1);
  return {
    contactId: given.contactId ?? contact?.id,
    userEmail: normalizeEmailOrNull(
      given.userEmail !== undefined ? given.userEmail : contact?.email,
    ),
  };
}

/**
 * The single active, non-deleted membership row for (user, bucket), if any.
 *
 * BOTH predicates are load-bearing and neither is implied by the other:
 *
 *  - `status = 'active'` — without it a `left` row is returned for a non-member,
 *    so `removeBucketMember` reports that row's stale epoch and (on a `minDwell`
 *    bucket) arms a pending leave on an ALREADY-LEFT membership.
 *  - `deleted_at IS NULL` — without it a soft-deleted row is returned, and the
 *    CAS below (which keys on id + status only, since the partial-unique index
 *    already guarantees at most one live active row) flips it and emits a
 *    `bucket:left` for a membership that was erased.
 */
function activeMembership(db: Database, bucketId: string, userId: string) {
  return db.query.bucketMemberships.findFirst({
    where: and(
      eq(bucketMemberships.userId, userId),
      eq(bucketMemberships.bucketId, bucketId),
      eq(bucketMemberships.status, "active"),
      isNull(bucketMemberships.deletedAt),
    ),
  });
}

/**
 * Add a member to a manual bucket: write the active `bucket_memberships` row,
 * then emit `bucket:entered:<id>` subject to the bucket's `entryLimit`.
 *
 * Idempotent via the partial-unique active index (`uq_user_bucket_active`) — a
 * second add while active inserts nothing and emits nothing.
 */
export async function addBucketMember(
  opts: BucketMembershipDeps & {
    bucketId: string;
    userId: string;
    /** Denormalized onto the row; resolved from the contact when omitted. */
    userEmail?: string | null;
    /** Provenance pin for the emit; resolved from the contact when omitted. */
    contactId?: string;
    /** `bucket_memberships.source`. Default `"manual"`. */
    source?: string;
    /** Provenance carried on the emitted transition. Default `"manual"`. */
    transitionSource?: BucketTransitionSource;
    /** Persisted on the membership row (e.g. the source person id). */
    context?: Record<string, unknown>;
    /**
     * `false` → write the row, emit NOTHING (verdict `"seeded"`). The
     * single-member form of the bulk seed path: binding an existing population
     * must not fire into live journeys (the Customer.io rule).
     */
    emit?: boolean;
  },
): Promise<BucketMembershipResult> {
  const {
    db,
    registry,
    hatchet,
    logger,
    bucketRegistry,
    bucketId,
    userId,
    source = MANUAL_SOURCE,
    transitionSource = "manual",
    context,
    emit = true,
  } = opts;

  const bucket = resolveManualBucket(bucketId, bucketRegistry);
  const identity = await resolveIdentity(db, userId, {
    contactId: opts.contactId,
    userEmail: opts.userEmail,
  });

  // entryCount ordinal = 1 + ALL prior memberships (active + left), the same
  // status-agnostic count the real-time and reconcile join paths use, so the
  // ordinal can never drift between writers. priorCount also drives the
  // entryLimit gate below.
  const priorCount = await countPriorMemberships(db, bucketId, userId);
  const epoch = priorCount + 1;

  // ON CONFLICT DO NOTHING targets the partial active unique index
  // (uq_user_bucket_active): an existing active row makes this insert return
  // zero rows → we mutated nothing → we do NOT emit (AC 5).
  //
  // `expiresAt` is deliberately NOT stamped: it is the criteria-window /
  // minDwell-defer arming epoch, and a manual bucket has no criteria window.
  // `maxDwellAt` IS stamped, because the unconditional TTL sweep filters
  // isNotNull(maxDwellAt) and would otherwise never force-leave the member.
  const inserted = await db
    .insert(bucketMemberships)
    .values({
      userId,
      userEmail: identity.userEmail,
      bucketId,
      status: "active",
      source,
      entryCount: epoch,
      maxDwellAt: computeMaxDwellAt(bucket),
      ...(context ? { context } : {}),
      lastEvaluatedAt: new Date(),
    })
    .onConflictDoNothing()
    .returning({ id: bucketMemberships.id });

  if (!inserted[0]) {
    // Already an active member (or a concurrent writer won). Report the epoch
    // of the row that IS active so the caller need not re-query.
    const active = await activeMembership(db, bucketId, userId);

    // A re-add DISARMS a pending `minDwell`-deferred leave. Without this the
    // member is simultaneously a current member AND carries a live leave
    // deadline, so the reconcile pass force-leaves them and emits a spurious
    // `bucket:left` — for a member the caller just re-added. On a manual bucket
    // `expiresAt` can ONLY be a deferred-leave deadline (the manual join path
    // deliberately never stamps it), so clearing it here is unambiguous.
    if (
      active &&
      (active.expiresAt != null || readPendingLeave(active.context))
    ) {
      await db
        .update(bucketMemberships)
        .set({
          expiresAt: null,
          context: disarmPendingLeaveSql(),
          lastEvaluatedAt: new Date(),
        })
        .where(
          and(
            eq(bucketMemberships.id, active.id),
            eq(bucketMemberships.status, "active"),
          ),
        );
      logger.info("Bucket pending leave disarmed by re-add", {
        bucketId,
        userId,
      });
    }

    return {
      emitted: false,
      epoch: active?.entryCount ?? epoch,
      verdict: "already-active",
    };
  }

  if (!emit) {
    return { emitted: false, epoch, verdict: "seeded" };
  }

  // The active row is ALWAYS written (bucket size must reflect reality) and the
  // epoch always advances via the real insert; only the emission is gated by
  // the entryLimit policy — the same gate the real-time and reconcile joins
  // apply, so the explicit path cannot bypass it.
  if (await shouldEmitJoin({ db, bucket, userId, priorCount })) {
    await emitBucketTransition({
      db,
      registry,
      hatchet,
      logger,
      kind: "entered",
      bucket,
      userId,
      userEmail: identity.userEmail,
      contactId: identity.contactId,
      epoch,
      source: transitionSource,
    });
    return { emitted: true, epoch, verdict: "applied" };
  }

  logger.info("Bucket join emit suppressed by entryLimit policy", {
    bucketId,
    userId,
    entryLimit: bucket.entryLimit ?? "unlimited",
  });
  return { emitted: false, epoch, verdict: "suppressed-by-entry-limit" };
}

/**
 * Remove a member from a manual bucket: flip the active row to `left` via a
 * compare-and-swap, then emit `bucket:left:<id>`.
 *
 * A leave inside the bucket's `minDwell` window is DEFERRED, never dropped: the
 * row stays active carrying a PENDING leave (`expiresAt` armed to
 * `enteredAt + minDwell` plus the {@link PENDING_LEAVE_KEY} intent marker,
 * which replays the caller's `emit`), and the reconcile cron applies it once
 * the window elapses. A re-add before then disarms it (see
 * {@link addBucketMember}).
 */
export async function removeBucketMember(
  opts: BucketMembershipDeps & {
    bucketId: string;
    userId: string;
    userEmail?: string | null;
    contactId?: string;
    /** Carried on the leave's properties → `ctx.reason`. Default `"manual"`. */
    reason?: BucketLeaveReason;
    transitionSource?: BucketTransitionSource;
    /**
     * `false` → flip the row, emit NOTHING (verdict `"leave-seeded"`). Honoured
     * on the `minDwell` defer branch too: the suppression is recorded on the
     * pending-leave marker so the deferred resolution stays silent.
     */
    emit?: boolean;
  },
): Promise<BucketMembershipResult> {
  const {
    db,
    registry,
    hatchet,
    logger,
    bucketRegistry,
    bucketId,
    userId,
    reason = "manual",
    transitionSource = "manual",
    emit = true,
  } = opts;

  const bucket = resolveManualBucket(bucketId, bucketRegistry);

  const active = await activeMembership(db, bucketId, userId);
  if (!active) {
    // Not a member. Report the LAST epoch (= the count of all prior rows) so a
    // caller reconciling a diff sees the history without a second query; 0 when
    // this user has never been a member of this bucket.
    const priorCount = await countPriorMemberships(db, bucketId, userId);
    return { emitted: false, epoch: priorCount, verdict: "already-left" };
  }

  // minDwell DEFERS (never silently drops) the leave: record a PENDING leave —
  // the armed deadline on `expiresAt` PLUS the intent marker on `context`,
  // which carries the caller's `emit` so the deferred resolution replays it
  // rather than unconditionally emitting. `reconcilePendingLeaves` selects on
  // the marker (not on a bare `expiresAt`, which is also the dynamic
  // criteria-window epoch) and applies it once the window elapses.
  const deadline = minDwellDeadline(active, bucket);
  if (deadline) {
    const pending: PendingBucketLeave = {
      deferUntil: deadline.toISOString(),
      emit,
    };
    await db
      .update(bucketMemberships)
      .set({
        expiresAt: deadline,
        context: armPendingLeaveSql(pending),
        lastEvaluatedAt: new Date(),
      })
      .where(
        and(
          eq(bucketMemberships.id, active.id),
          eq(bucketMemberships.status, "active"),
        ),
      );
    logger.info("Bucket leave deferred by minDwell", {
      bucketId,
      userId,
      deferUntil: pending.deferUntil,
      emit,
    });
    return { emitted: false, epoch: active.entryCount, verdict: "deferred" };
  }

  // Compare-and-swap: only the writer whose UPDATE actually flips the active
  // row emits. A concurrent writer that already flipped it matches zero rows.
  const flipped = await db
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
    .returning({ entryCount: bucketMemberships.entryCount });

  const row = flipped[0];
  if (!row) {
    return {
      emitted: false,
      epoch: active.entryCount,
      verdict: "already-left",
    };
  }

  // A suppressed LEAVE gets its own verdict: `seeded` is the suppressed JOIN,
  // and a poller diffing membership must be able to tell the two apart from the
  // return value alone.
  if (!emit) {
    return { emitted: false, epoch: row.entryCount, verdict: "leave-seeded" };
  }

  const identity = await resolveIdentity(db, userId, {
    contactId: opts.contactId,
    // `!== undefined`, NOT `??`: an explicit `userEmail: null` means "emit with
    // no email" and must survive, exactly as it does on the add path. `??`
    // silently substituted the stored row email for it.
    userEmail: opts.userEmail !== undefined ? opts.userEmail : active.userEmail,
  });

  await emitBucketTransition({
    db,
    registry,
    hatchet,
    logger,
    kind: "left",
    bucket,
    userId,
    userEmail: identity.userEmail,
    contactId: identity.contactId,
    epoch: row.entryCount,
    source: transitionSource,
    reason,
  });

  return { emitted: true, epoch: row.entryCount, verdict: "applied" };
}

export interface SeedBucketMembersResult {
  /** Rows actually inserted (new active memberships). */
  seeded: number;
  /** Members that already held an active row — the insert was a no-op. */
  alreadyActive: number;
}

/**
 * BULK/SEED path: materialize membership rows for an existing population with
 * the correct epoch and `maxDwellAt`, emitting NOTHING (AC 12) — mirroring
 * `bucket-backfill.ts`'s join pass ("historical matches must not fire
 * `bucket:entered` into live journeys — the Customer.io rule").
 *
 * Emission is impossible BY CONSTRUCTION here, not by a flag: the signature
 * takes neither the journey registry nor a Hatchet client, so there is nothing
 * to emit through. Binding a 40k-member cohort therefore cannot send 40k emails
 * in one burst; enrolling an existing population stays an explicit, separate
 * opt-in on the caller's side.
 *
 * Set-based and chunked (one email lookup + one prior-count GROUP BY per
 * chunk — never per-member serial queries), idempotent via the partial-unique
 * active index, and safely re-runnable.
 */
export async function seedBucketMembers(opts: {
  db: Database;
  logger: Logger;
  bucketRegistry?: BucketRegistry;
  bucketId: string;
  members: Array<{
    userId: string;
    /** Denormalized onto the row; resolved from the contact when omitted. */
    userEmail?: string | null;
    context?: Record<string, unknown>;
  }>;
  /** `bucket_memberships.source`. Default `"seed"`. */
  source?: string;
  batchSize?: number;
}): Promise<SeedBucketMembersResult> {
  const {
    db,
    logger,
    bucketRegistry,
    bucketId,
    members,
    source = SEED_SOURCE,
    batchSize = DEFAULT_BATCH_SIZE,
  } = opts;

  const bucket = resolveManualBucket(bucketId, bucketRegistry);

  // Dedupe by userId — the partial-unique index would reject the second copy of
  // a repeated member anyway, and counting it as "alreadyActive" would be a lie.
  const byUser = new Map<string, (typeof members)[number]>();
  for (const member of members) byUser.set(member.userId, member);
  const unique = [...byUser.values()];
  if (unique.length === 0) return { seeded: 0, alreadyActive: 0 };

  // Stamped once for the whole seed, mirroring the backfill join pass.
  const maxDwellAt = computeMaxDwellAt(bucket);

  let seeded = 0;
  for (let i = 0; i < unique.length; i += batchSize) {
    const chunk = unique.slice(i, i + batchSize);
    const chunkIds = chunk.map((m) => m.userId);

    // Emails backfilled from the contacts row where the caller did not supply
    // one. Keyed on the SAME canonical-key coalesce the membership rows carry,
    // so an anonymous-only or email-only contact is not missed.
    const resolvedKey = contactKeySql();
    const chunkContacts = await db
      .select({ userKey: resolvedKey, email: contacts.email })
      .from(contacts)
      .where(and(inArray(resolvedKey, chunkIds), isNull(contacts.deletedAt)));
    const emailByUser = new Map(chunkContacts.map((c) => [c.userKey, c.email]));

    // entryCount = 1 + prior memberships for each (user, bucket) — the same
    // monotonic ordinal the live join computes. ONE batched GROUP BY per chunk.
    const priorCounts = await db
      .select({
        userId: bucketMemberships.userId,
        cnt: sql<number>`count(*)::int`,
      })
      .from(bucketMemberships)
      .where(
        and(
          eq(bucketMemberships.bucketId, bucketId),
          inArray(bucketMemberships.userId, chunkIds),
        ),
      )
      .groupBy(bucketMemberships.userId);
    const priorByUser = new Map(
      priorCounts.map((r) => [r.userId, Number(r.cnt)]),
    );

    const values = chunk.map((member) => ({
      userId: member.userId,
      userEmail: normalizeEmailOrNull(
        member.userEmail !== undefined
          ? member.userEmail
          : emailByUser.get(member.userId),
      ),
      bucketId,
      status: "active" as const,
      source,
      entryCount: 1 + (priorByUser.get(member.userId) ?? 0),
      maxDwellAt,
      ...(member.context ? { context: member.context } : {}),
      lastEvaluatedAt: new Date(),
    }));

    const result = await db
      .insert(bucketMemberships)
      .values(values)
      .onConflictDoNothing()
      .returning({ id: bucketMemberships.id });

    seeded += result.length;
  }

  const alreadyActive = unique.length - seeded;
  logger.info("Bucket members seeded (no transitions emitted)", {
    bucketId,
    seeded,
    alreadyActive,
  });
  return { seeded, alreadyActive };
}
