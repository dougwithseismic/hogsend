import type { HatchetClient } from "@hatchet-dev/typescript-sdk/v1/index.js";
import {
  type BucketMeta,
  bySubject,
  collectPropertyNames,
  durationToMs,
  evaluateCondition,
} from "@hogsend/core";
import type { JourneyRegistry } from "@hogsend/core/registry";
import { bucketMemberships, contacts, type Database } from "@hogsend/db";
import { and, desc, eq, isNotNull, isNull } from "drizzle-orm";
import { emitBucketTransition } from "../lib/bucket-emit.js";
import {
  contactKeySql,
  lookupContactIdByKey,
  normalizeEmailOrNull,
} from "../lib/contacts.js";
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
  /**
   * The subject contact's resolved row id (`contacts.id`) — `ingestEvent` has
   * already resolved the contact before calling us, so it threads the id here
   * and we carry it into every `emitBucketTransition` as the ENGINE-INTERNAL
   * provenance pin. Without it, a transition for a contact whose canonical key
   * is its `anonymous_id` re-ingests a bare `userId` and mints a phantom
   * `external_id` twin (issue #608). Optional: a caller without a resolved
   * contact degrades to the pin-less emit.
   */
  contactId?: string;
  /**
   * D1 creation guard, INHERITED from the originating ingest and forwarded into
   * every `emitBucketTransition` (and from there into both of its re-ingests).
   * `ingestEvent` passes `false` exactly when its own resolve REFUSED, i.e.
   * when there is no `contactId` to pin with — because the alternative,
   * degrading the pin to `contactId ?? undefined`, makes the transition
   * re-ingest treat the anon canonical key as an EXTERNAL key and mint an
   * `external_id = <anonId>` phantom twin (issue #608 from the other side).
   * Bucket evaluation itself is UNAFFECTED: `bucket_memberships` is text-keyed
   * with no contact FK, so a contactless subject is still a first-class member.
   */
  allowCreate?: boolean;
  event: string;
  /**
   * D2: the event payload — candidate-narrowing ONLY. It NO LONGER participates
   * in property eval (the raw-payload overlay was the bucket-side conflation).
   */
  eventProperties: Record<string, unknown>;
  /**
   * D2: this-ingest contact-property patch, overlaid on the read contact row so
   * the very first event after a property change evaluates correctly (risk 7).
   */
  contactProperties?: Record<string, unknown>;
  /**
   * Extra property NAMES for candidate-narrowing ONLY — never overlaid on the
   * contact row for value eval. A producer whose write patch omits a key it
   * nonetheless changed (refinement's fill-if-absent drops already-held facts to
   * avoid clobbering first-party data) lists those names here so their fit
   * buckets are still re-checked against live contact state.
   */
  touchProperties?: string[];
  /** Optional override; defaults to the process bucket-registry singleton. */
  bucketRegistry?: ReturnType<typeof getBucketRegistrySingleton>;
}): Promise<BucketTransition[]> {
  const {
    db,
    registry,
    hatchet,
    logger,
    userId,
    contactId,
    allowCreate,
    event,
    eventProperties,
    contactProperties: contactPropertiesPatch,
    touchProperties,
  } = opts;
  // The caller's email comes verbatim from the raw event payload — normalize
  // ONCE here so the membership row, the emitted bucket:* transition events,
  // and the arm-expiry payload all carry the same normalized address the
  // `email_preferences` keyspace (and every other email write) uses.
  const userEmail = normalizeEmailOrNull(opts.userEmail);

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
  // property present in EITHER bag (propertyIndex): the eventProperties drive
  // event-shaped criteria narrowing, the contactProperties patch surfaces a
  // contact-property change so a property-criteria bucket is re-checked on the
  // first event that mutates it. Section 6.2.
  const candidateMap = new Map<string, BucketMeta>();
  for (const bucket of bucketRegistry.getByReferencedEvent(event)) {
    candidateMap.set(bucket.id, bucket);
  }
  for (const key of [
    ...Object.keys(eventProperties ?? {}),
    ...Object.keys(contactPropertiesPatch ?? {}),
    // Names-only touches (e.g. refinement's fill-if-absent dropped facts) surface
    // a fit bucket here so it is re-checked against live contact state below,
    // even though the value is not in this ingest's write patch.
    ...(touchProperties ?? []),
  ]) {
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

  // (3) Property predicates evaluate against contact state ⊕ this-ingest
  // contactProperties patch — NOT the raw event payload (Section 6.1 rule #3 /
  // D2). Read the EXISTING contacts row ONCE iff any surviving candidate
  // references a property — pure event/count buckets skip the read entirely.
  // `ingestEvent` already awaited `resolveOrCreateContact` before us, so the row
  // exists by the resolved key; the patch overlay still covers the read-after-
  // write gap on a contact's very first event (risk 7).
  const needsContactState = candidates.some(
    (bucket) =>
      bucket.criteria != null &&
      collectPropertyNames(bucket.criteria).length > 0,
  );

  let storedContactProps: Record<string, unknown> = {};
  let contactDeleted = false;
  if (needsContactState) {
    // Match on the CANONICAL key, not `external_id` alone. Memberships and
    // events are keyed on `coalesce(external_id, anonymous_id, id)`
    // (`contactKeySql`), so an email-only contact is keyed on its uuid and an
    // anonymous one on its `anonymous_id` — both have a NULL `external_id` and
    // neither was ever found here. The cron's join scan already made exactly
    // this correction for the same reason (`bucket-reconcile.ts`, "joining on
    // contacts.externalId would … silently drop exactly the dormant email-only
    // contacts this cron exists to reconcile"); this is that fix applied to the
    // real-time path, which was missed.
    //
    // Two things were wrong, and the second is the serious one:
    //   1. property criteria evaluated against `{}` instead of the contact's
    //      real state, so a property leg silently answered "absent" for every
    //      such person;
    //   2. `contactDeleted` stayed false because the row was never found, so
    //      the GDPR guard below — "never (re-)evaluate or emit for a
    //      soft-deleted contact" — did not fire for them. A soft-deleted
    //      email-only contact could still transition buckets and emit.
    //
    // PRD 07 T7 — the presented key resolves through the alias-aware primitive
    // FIRST, so a merged-away key reads the SURVIVOR's properties instead of
    // the nothing-found arm the coalesce probe returned for it.
    //
    // The coalesce probe SURVIVES as the fallback, and it is load-bearing, not
    // belt-and-braces: `lookupContactIdByKey` filters `deleted_at IS NULL`, so
    // it returns null for exactly the soft-deleted contact that failure (2)
    // above is about. Stopping at the null would leave `contactDeleted` false
    // and silently re-open the GDPR guard for the rows it exists to protect.
    const resolvedId = await lookupContactIdByKey(db, userId);
    const [contact] = await db
      .select({
        properties: contacts.properties,
        deletedAt: contacts.deletedAt,
      })
      .from(contacts)
      .where(
        resolvedId ? eq(contacts.id, resolvedId) : eq(contactKeySql(), userId),
      )
      .limit(1);
    if (contact) {
      storedContactProps =
        (contact.properties as Record<string, unknown> | null) ?? {};
      contactDeleted = contact.deletedAt != null;
    }
  }

  // GDPR: never (re-)evaluate or emit for a soft-deleted contact (Section 8.6).
  if (contactDeleted) {
    return [];
  }

  // this-ingest contactProperties patch overlays stored contact state. The raw
  // event payload is REMOVED from property eval (D2 — bucket prop-criteria see
  // contact state only).
  const journeyContext: Record<string, unknown> = {
    ...storedContactProps,
    ...(contactPropertiesPatch ?? {}),
  };

  const transitions: BucketTransition[] = [];

  for (const bucket of candidates) {
    if (!bucket.criteria) continue;

    // wasMember — current active, non-deleted membership row (cheap pre-filter;
    // the authoritative guard is the RETURNING-gated mutation below). Read by
    // SUBJECT: a membership adopted onto this contact under a since-stale key
    // is invisible to a `user_id` probe, and missing it re-runs the JOIN path,
    // which then loses the arbiter-less race and no-ops — a member who silently
    // never re-emits and never leaves.
    const active = await db.query.bucketMemberships.findFirst({
      where: and(
        bySubject(bucketMemberships, {
          contactId: contactId ?? null,
          userKey: userId,
        }),
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
      ctx: {
        db,
        userId,
        // `ingestEvent` resolved the subject before calling us, so the event /
        // count legs read this person's whole history — including the rows
        // adopted from an anon-era key — instead of only what the current
        // string key happens to name.
        contactId: contactId ?? null,
        journeyContext,
      },
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
        contactId,
        allowCreate,
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
        contactId,
        allowCreate,
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
  /** Provenance pin for the emit — see `checkBucketMembership` (issue #608). */
  contactId?: string;
  /** Inherited creation guard for the emit — see `checkBucketMembership`. */
  allowCreate?: boolean;
}): Promise<BucketTransition | null> {
  const {
    db,
    registry,
    hatchet,
    logger,
    bucket,
    userId,
    userEmail,
    contactId,
    allowCreate,
  } = opts;

  // entryCount ordinal = 1 + count of ALL prior memberships (active + left) for
  // this (user, bucket) (Section 6.3 / 8.2). priorCount also drives the entryLimit
  // gate. Shared with the reconcile-discovered join path so the ordinal can
  // never drift between the two writers.
  const priorCount = await countPriorMemberships(
    db,
    bucket.id,
    userId,
    contactId ?? null,
  );
  const epoch = priorCount + 1;

  // INSERT a FRESH active row. ON CONFLICT DO NOTHING covers the partial active
  // unique index (uq_user_bucket_active): a concurrent emitter that already
  // inserted the active row makes THIS insert return zero rows → we do NOT emit
  // (the loser mutates nothing — Section 6.3 governing rule).
  //
  // PRD 05 T3 — the DO NOTHING is deliberately ARBITER-LESS. Two partial unique
  // indexes now guard this table (uq_user_bucket_active and its contact-scoped
  // twin uq_contact_bucket_active), Postgres allows only ONE conflict target per
  // statement, and both must land in the same "already a member" branch: the
  // contact one is what catches an adopted row whose `user_id` still differs.
  // Narrowing this to a column target would let that collision escape as a raw
  // 23505 — and a target naming `contact_id` would additionally miss every
  // contactless (NULL) member.
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
      // PRD 04 dual-write. `contactId` is already a documented param of this
      // function (`ingestEvent` resolved the subject before calling us), so this
      // is ZERO new queries and has no failure mode to wrap: `undefined` — a
      // pin-less caller or a refused resolve — stamps NULL and the join is
      // recorded exactly as before (memberships are text-keyed, no contact FK).
      contactId: contactId ?? null,
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
  // `allowCreate` rides along because the timer's eventual leave emit is a
  // re-ingest DERIVED from this (possibly refused) event — D11 applies to the
  // ASYNCHRONOUS producer exactly as it does to the two synchronous ones. The
  // `contactId` pin deliberately does NOT (see `bucketExpiryTask`).
  if (bucket.fastExpiry && expiresAt) {
    await armExpiryTimer({
      hatchet,
      logger,
      bucket,
      rowId: insertedRow.id,
      userId,
      userEmail,
      expiresAt,
      allowCreate,
    });
  }

  // The active row is always written (Studio size must reflect reality) and the
  // epoch always advances via the real insert; only the bucket:entered emission
  // is gated by the entryLimit policy (Section 6.3).
  if (
    await shouldEmitJoin({
      db,
      bucket,
      userId,
      contactId: contactId ?? null,
      priorCount,
    })
  ) {
    await emitBucketTransition({
      db,
      registry,
      hatchet,
      logger,
      kind: "entered",
      bucket,
      userId,
      userEmail,
      // Pin the re-ingest to the already-resolved contact row so an
      // anonymous-only contact's transition folds in instead of minting a
      // phantom twin (issue #608). With no row to pin to, the originating
      // ingest's refusal is inherited instead — never a degraded pin.
      contactId,
      allowCreate,
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
  /** Provenance pin for the emit — see `checkBucketMembership` (issue #608). */
  contactId?: string;
  /** Inherited creation guard for the emit — see `checkBucketMembership`. */
  allowCreate?: boolean;
}): Promise<BucketTransition | null> {
  const {
    db,
    registry,
    hatchet,
    logger,
    bucket,
    active,
    userId,
    userEmail,
    contactId,
    allowCreate,
  } = opts;

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
    // Same provenance pin (and same inherited refusal) as the join emit — a
    // leave re-ingests through the identical path and would mint the same
    // phantom twin (issue #608).
    contactId,
    allowCreate,
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
  /**
   * The owning contact's `contacts.id`, or `null` when the caller has none.
   * REQUIRED (not optional) on purpose: the prior-cycle lookup below is the
   * cooldown gate, and an optional field a caller forgets silently drops it
   * back onto the mutable text key — which misses the adopted prior cycle and
   * re-emits a `once` join. Pass `null` explicitly for a contactless subject.
   */
  contactId: string | null;
  priorCount: number;
}): Promise<boolean> {
  const { db, bucket, userId, contactId, priorCount } = opts;
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
            bySubject(bucketMemberships, { contactId, userKey: userId }),
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
 *
 * The arm payload is the ONLY channel between this join and the leave the woken
 * task emits, so the inherited D1 refusal has to ride it — otherwise the timer's
 * `emitBucketTransition` re-resolves the anon canonical key create-on-miss and
 * mints the `external_id = <anonId>` phantom twin the synchronous emits were
 * already taught to refuse (issue #608, D11 category (iii)).
 */
async function armExpiryTimer(opts: {
  hatchet: HatchetClient;
  logger: Logger;
  bucket: BucketMeta;
  rowId: string;
  userId: string;
  userEmail: string | null;
  expiresAt: Date;
  /**
   * D1 creation guard inherited from the originating ingest via `handleJoin`.
   * Carried on the wire ONLY when `false`: an omitted key keeps today's
   * create-by-default semantics for every producer that legitimately creates
   * and keeps a JSON null off a Hatchet payload (the
   * `...(contactId !== null ? { contactId } : {})` idiom at `ingestion.ts`).
   */
  allowCreate?: boolean;
}): Promise<void> {
  const {
    hatchet,
    logger,
    bucket,
    rowId,
    userId,
    userEmail,
    expiresAt,
    allowCreate,
  } = opts;
  const msUntilExpiry = Math.max(0, expiresAt.getTime() - Date.now());
  try {
    await hatchet.events.push("bucket:arm-expiry", {
      rowId,
      bucketId: bucket.id,
      userId,
      userEmail,
      armedExpiresAt: expiresAt.toISOString(),
      msUntilExpiry,
      ...(allowCreate === false ? { allowCreate: false } : {}),
    });
  } catch (err) {
    logger.warn("Bucket fast-expiry arm failed (cron backstop covers it)", {
      bucketId: bucket.id,
      userId,
      error: err instanceof Error ? err.message : String(err),
    });
  }
}
