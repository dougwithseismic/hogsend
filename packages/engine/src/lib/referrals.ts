import type {
  BeforeBindContext,
  BeforeQualifyContext,
  BeforeTouchContext,
  DefinedReferral,
  ReferralVerdict,
} from "@hogsend/core";
import { DEFAULT_REFERRAL_ID, days, durationToMs } from "@hogsend/core";
import { type Database, referralTouches } from "@hogsend/db";
import { and, desc, eq, inArray, isNull, sql } from "drizzle-orm";

/**
 * The referral store (PRD 05 stage 2): the ONE place a `referral_touches` row
 * is ever written. It records touches, stamps the bind at identity-adoption
 * time, applies the self / window / veto rejections, and promotes a bound touch
 * to qualified.
 *
 * House style follows {@link file://./account-links.ts}: single-object-in /
 * result-object-out, `db` injected, typed error classes, and mutation FACTS
 * returned so callers can emit.
 *
 * THIS MODULE NEVER EMITS (PRD 05 §6, DECISIONS §15.7 for the account-link
 * twin). It touches neither the outbound spine nor the journey plane nor
 * analytics: it returns what changed, and the intent layer above it emits
 * `referral.*` outbound AND re-ingests for journeys, side by side. Two tests in
 * `referrals-no-emit.test.ts` pin that - one scans this file for emit symbols,
 * one pins its runtime import list, so the NEXT emit surface fails there
 * whatever it ends up being called.
 */

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type ReferralTouchStatus =
  | "touched"
  | "bound"
  | "qualified"
  | "rejected";

/** The vocabulary of `referral_touches.rejected_reason`. */
export type ReferralRejectReason =
  | "self"
  | "window"
  | "veto"
  | "bot"
  | "duplicate";

export type ReferralTouchSource =
  | "link"
  | "slug_entry"
  | "invite"
  | "manual"
  | "import";

export interface ReferralTouchRecord {
  id: string;
  referralId: string;
  referrerContactId: string;
  refereeKey: string;
  refereeContactId: string | null;
  linkId: string | null;
  clickId: string | null;
  source: string;
  touchedAt: Date;
  boundAt: Date | null;
  status: ReferralTouchStatus;
  rejectedReason: ReferralRejectReason | null;
  qualifiedAt: Date | null;
  qualifiedConversionId: string | null;
  properties: Record<string, unknown>;
}

type TouchRow = typeof referralTouches.$inferSelect;

function toRecord(row: TouchRow): ReferralTouchRecord {
  return {
    id: row.id,
    referralId: row.referralId,
    referrerContactId: row.referrerContactId,
    refereeKey: row.refereeKey,
    refereeContactId: row.refereeContactId,
    linkId: row.linkId,
    clickId: row.clickId,
    source: row.source,
    touchedAt: row.touchedAt,
    boundAt: row.boundAt,
    status: row.status as ReferralTouchStatus,
    rejectedReason: row.rejectedReason as ReferralRejectReason | null,
    qualifiedAt: row.qualifiedAt,
    qualifiedConversionId: row.qualifiedConversionId,
    properties: (row.properties ?? {}) as Record<string, unknown>,
  };
}

/**
 * The property key the caller's idempotency key is filed under. A PROPERTY and
 * not a column: `click_id` already covers the only high-volume path (a click),
 * and the manual/invite paths are low-rate operator writes whose key is
 * usefully visible next to the rest of their bag.
 */
export const REFERRAL_IDEMPOTENCY_PROPERTY = "idempotencyKey";

/** Where a hook's own free-text reason is kept when the row records `veto`. */
export const REFERRAL_VETO_REASON_PROPERTY = "vetoReason";

/**
 * True when a DB error is the Postgres unique_violation on the referral EDGE
 * index. Walks the cause chain - drizzle wraps the driver's PostgresError in a
 * DrizzleQueryError whose `cause` carries the code/constraint.
 */
function isEdgeUniqueViolation(err: unknown): boolean {
  const constraint = "referral_touches_edge_idx";
  for (let e: unknown = err, depth = 0; e && depth < 5; depth++) {
    const candidate = e as {
      code?: string;
      constraint_name?: string;
      message?: string;
      cause?: unknown;
    };
    if (
      candidate.code === "23505" &&
      (candidate.constraint_name === constraint ||
        (candidate.message?.includes(constraint) ?? false))
    ) {
      return true;
    }
    e = candidate.cause;
  }
  return false;
}

/** Resolve the referral's bind window, defaulting to 30 days. */
function bindWindowMs(referral: DefinedReferral | undefined): number {
  return durationToMs(referral?.bindWindow ?? days(30));
}

async function verdict(
  hook:
    | ((ctx: never) => ReferralVerdict | Promise<ReferralVerdict>)
    | undefined,
  ctx: unknown,
): Promise<ReferralVerdict> {
  if (!hook) return { ok: true };
  return await hook(ctx as never);
}

// ---------------------------------------------------------------------------
// recordTouch
// ---------------------------------------------------------------------------

export interface RecordTouchInput {
  db: Database;
  /** Defaults to `"default"`, matching `defineReferral`. */
  referralId?: string;
  /** `links.owner_contact_id` READ AT TOUCH TIME (never re-read later). */
  referrerContactId: string;
  /** The toucher's canonical key - an anonymous id on a cold touch. */
  refereeKey: string;
  /** Set only when the toucher was ALREADY identified; the touch binds now. */
  refereeContactId?: string | null;
  linkId?: string | null;
  /** `link_clicks.id`. Doubles as the touch's replay key when present. */
  clickId?: string | null;
  source: ReferralTouchSource;
  properties?: Record<string, unknown>;
  /**
   * Explicit replay key for the paths with no click (invite/manual/import).
   * A repeat is a NO-OP returning the existing row, never a second edge.
   */
  idempotencyKey?: string;
  /** The definition, for `beforeTouch`. Absent = no veto configured. */
  referral?: DefinedReferral;
  touchedAt?: Date;
}

export interface RecordTouchResult {
  touch: ReferralTouchRecord;
  /** True only when THIS call inserted the row. */
  created: boolean;
  /** True when the call recovered a prior row (replay or same-pair re-touch). */
  existing: boolean;
  /** True when the row was written already-rejected. */
  rejected: boolean;
  /** The rejection's vocabulary reason, or the hook's free text for a veto. */
  reason?: string;
}

/**
 * Record one referral touch. Returns mutation FACTS; it emits nothing.
 *
 * Replay: a touch carrying a `clickId` (or an explicit `idempotencyKey`) is
 * looked up first, so a redelivered click writes no second edge. Same-pair
 * re-touch is a no-op at the DATABASE - the partial-unique edge index is the
 * arbiter, not a judgement call here - which is what keeps a DIFFERENT
 * referrer's touch a genuinely new row for last-touch models to see.
 */
export async function recordTouch(
  input: RecordTouchInput,
): Promise<RecordTouchResult> {
  const {
    db,
    referrerContactId,
    refereeKey,
    source,
    referral,
    idempotencyKey,
  } = input;
  const referralId = input.referralId ?? referral?.id ?? DEFAULT_REFERRAL_ID;
  const refereeContactId = input.refereeContactId ?? null;
  const clickId = input.clickId ?? null;
  const linkId = input.linkId ?? null;
  const touchedAt = input.touchedAt ?? new Date();
  const properties: Record<string, unknown> = { ...(input.properties ?? {}) };
  if (idempotencyKey) {
    properties[REFERRAL_IDEMPOTENCY_PROPERTY] = idempotencyKey;
  }

  // --- Replay short-circuit -------------------------------------------------
  const replayFilter = idempotencyKey
    ? and(
        eq(referralTouches.referralId, referralId),
        sql`${referralTouches.properties}->>${REFERRAL_IDEMPOTENCY_PROPERTY} = ${idempotencyKey}`,
      )
    : clickId
      ? and(
          eq(referralTouches.referralId, referralId),
          eq(referralTouches.clickId, clickId),
        )
      : null;
  if (replayFilter) {
    const [prior] = await db
      .select()
      .from(referralTouches)
      .where(replayFilter)
      .limit(1);
    if (prior) {
      const record = toRecord(prior);
      return {
        touch: record,
        created: false,
        existing: true,
        rejected: record.status === "rejected",
        reason: record.rejectedReason ?? undefined,
      };
    }
  }

  // --- Vetoes ---------------------------------------------------------------
  // Self-referral falls out of IDENTITY, not a fraud heuristic: if the toucher
  // is already known to be the owner, there is no edge to write.
  let reject: { reason: ReferralRejectReason; detail?: string } | null =
    refereeContactId && refereeContactId === referrerContactId
      ? { reason: "self" }
      : null;

  if (!reject && referral?.meta.beforeTouch) {
    const ctx: BeforeTouchContext = {
      referralId,
      referrerContactId,
      refereeKey,
      refereeContactId,
      source,
      linkId,
      clickId,
      properties,
    };
    const v = await verdict(referral.meta.beforeTouch, ctx);
    if (!v.ok) reject = { reason: "veto", detail: v.reason };
  }

  if (reject?.detail) {
    properties[REFERRAL_VETO_REASON_PROPERTY] = reject.detail;
  }

  const bound = !reject && refereeContactId !== null;
  const values = {
    referralId,
    referrerContactId,
    refereeKey,
    refereeContactId,
    linkId,
    clickId,
    source,
    touchedAt,
    boundAt: bound ? touchedAt : null,
    status: reject ? "rejected" : bound ? "bound" : "touched",
    rejectedReason: reject?.reason ?? null,
    properties,
  };

  try {
    const [row] = await db.insert(referralTouches).values(values).returning();
    if (!row) throw new Error("recordTouch: insert returned no row");
    return {
      touch: toRecord(row),
      created: true,
      existing: false,
      rejected: reject !== null,
      reason: reject?.detail ?? reject?.reason,
    };
  } catch (err) {
    if (!isEdgeUniqueViolation(err)) throw err;
    // The SAME (referral, referee, referrer) triple already has a live edge.
    // A re-touch is a no-op on the edge (PRD 05 §9.3), so recover the winner
    // rather than minting a duplicate the report would double-count.
    const [winner] = await db
      .select()
      .from(referralTouches)
      .where(
        and(
          eq(referralTouches.referralId, referralId),
          eq(referralTouches.referrerContactId, referrerContactId),
          refereeContactId
            ? eq(referralTouches.refereeContactId, refereeContactId)
            : isNull(referralTouches.refereeContactId),
          // Match the partial unique index the 23505 came from: rejected rows
          // are NOT edges, so a stale veto row must not win the recovery.
          sql`${referralTouches.status} <> 'rejected'`,
        ),
      )
      .limit(1);
    if (!winner) throw err;
    return {
      touch: toRecord(winner),
      created: false,
      existing: true,
      rejected: winner.status === "rejected",
      reason: winner.rejectedReason ?? undefined,
    };
  }
}

// ---------------------------------------------------------------------------
// bindTouches
// ---------------------------------------------------------------------------

export interface BindTouchesInput {
  db: Database;
  /** The anonymous/canonical key the visitor touched under. */
  refereeKey: string;
  /** The contact that key just resolved to (identity adoption). */
  contactId: string;
  /** Narrow to one program; default = every unbound touch for the key. */
  referralId?: string;
  /**
   * Definition lookup for `beforeBind` + `bindWindow`. Absent means the
   * defaults apply (no veto, 30-day window) - binding must never depend on a
   * definition being registered, or a redeploy that drops one would silently
   * stop binding.
   */
  resolveReferral?: (referralId: string) => DefinedReferral | undefined;
  now?: Date;
}

export interface BindTouchesResult {
  /** Touches that gained their second end. */
  bound: ReferralTouchRecord[];
  /** Touches refused, with the vocabulary reason. */
  rejected: Array<{
    touch: ReferralTouchRecord;
    reason: ReferralRejectReason;
    detail?: string;
  }>;
}

/**
 * Stamp `referee_contact_id` / `bound_at` on every UNBOUND touch for a key, at
 * identity-adoption time. Self, out-of-window and vetoed touches are rejected
 * in place rather than deleted: an edge that was refused is itself a fact the
 * report and the operator want to see.
 */
export async function bindTouches(
  input: BindTouchesInput,
): Promise<BindTouchesResult> {
  const { db, refereeKey, contactId, resolveReferral } = input;
  const now = input.now ?? new Date();

  const pending = await db
    .select()
    .from(referralTouches)
    .where(
      and(
        eq(referralTouches.refereeKey, refereeKey),
        isNull(referralTouches.refereeContactId),
        eq(referralTouches.status, "touched"),
        ...(input.referralId
          ? [eq(referralTouches.referralId, input.referralId)]
          : []),
      ),
    )
    .orderBy(desc(referralTouches.touchedAt));

  const result: BindTouchesResult = { bound: [], rejected: [] };

  for (const row of pending) {
    const referral = resolveReferral?.(row.referralId);
    let reject: { reason: ReferralRejectReason; detail?: string } | null = null;

    // The merge is the fraud check: if the referee turns out to BE the
    // referrer, the edge is a self-referral no matter how it was created.
    if (row.referrerContactId === contactId) {
      reject = { reason: "self" };
    } else if (
      now.getTime() - row.touchedAt.getTime() >
      bindWindowMs(referral)
    ) {
      reject = { reason: "window" };
    } else if (referral?.meta.beforeBind) {
      const ctx: BeforeBindContext = {
        referralId: row.referralId,
        touchId: row.id,
        referrerContactId: row.referrerContactId,
        refereeKey: row.refereeKey,
        refereeContactId: contactId,
        touchedAt: row.touchedAt,
        properties: (row.properties ?? {}) as Record<string, unknown>,
      };
      const v = await verdict(referral.meta.beforeBind, ctx);
      if (!v.ok) reject = { reason: "veto", detail: v.reason };
    }

    if (reject) {
      const rejected = await rejectTouch({
        db,
        touchId: row.id,
        reason: reject.reason,
        detail: reject.detail,
      });
      if (rejected.touch) {
        result.rejected.push({
          touch: rejected.touch,
          reason: reject.reason,
          detail: reject.detail,
        });
      }
      continue;
    }

    try {
      // `refereeContactId IS NULL` in the predicate makes the stamp itself the
      // race arbiter: two concurrent adoptions cannot both bind the same row.
      const [updated] = await db
        .update(referralTouches)
        .set({
          refereeContactId: contactId,
          boundAt: now,
          status: "bound",
        })
        .where(
          and(
            eq(referralTouches.id, row.id),
            isNull(referralTouches.refereeContactId),
          ),
        )
        .returning();
      if (updated) result.bound.push(toRecord(updated));
    } catch (err) {
      if (!isEdgeUniqueViolation(err)) throw err;
      // This contact ALREADY has a live edge from this referrer (an earlier
      // touch under a different anon key). One pair is one edge, so the later
      // row is a duplicate rather than a second referral.
      const dup = await rejectTouch({
        db,
        touchId: row.id,
        reason: "duplicate",
      });
      if (dup.touch) {
        result.rejected.push({ touch: dup.touch, reason: "duplicate" });
      }
    }
  }

  return result;
}

// ---------------------------------------------------------------------------
// qualifyTouch / rejectTouch
// ---------------------------------------------------------------------------

export interface QualifyTouchInput {
  db: Database;
  touchId: string;
  /** The event that triggered the evaluation (for `beforeQualify`). */
  event?: string;
  eventProperties?: Record<string, unknown>;
  conversionId?: string | null;
  referral?: DefinedReferral;
  at?: Date;
}

export interface QualifyTouchResult {
  touch: ReferralTouchRecord | null;
  /** True only when THIS call promoted the row. */
  qualified: boolean;
  /** True when the row was already qualified (a replay). */
  existing: boolean;
  rejected: boolean;
  reason?: string;
}

/**
 * Promote a BOUND touch to qualified, exactly once. The `qualified_at IS NULL`
 * predicate is the replay guard, so a redelivered qualify event returns
 * `existing: true` instead of re-firing the reward journey downstream.
 */
export async function qualifyTouch(
  input: QualifyTouchInput,
): Promise<QualifyTouchResult> {
  const { db, touchId, referral } = input;
  const at = input.at ?? new Date();

  const [row] = await db
    .select()
    .from(referralTouches)
    .where(eq(referralTouches.id, touchId))
    .limit(1);
  if (!row)
    return { touch: null, qualified: false, existing: false, rejected: false };
  if (row.status === "qualified" || row.qualifiedAt !== null) {
    return {
      touch: toRecord(row),
      qualified: false,
      existing: true,
      rejected: false,
    };
  }
  if (row.status !== "bound" || !row.refereeContactId) {
    // Only a BOUND edge can qualify: an unbound touch has no known referee, so
    // there is nobody to reward and nothing to report against.
    return {
      touch: toRecord(row),
      qualified: false,
      existing: false,
      rejected: false,
      reason: "not_bound",
    };
  }

  if (referral?.meta.beforeQualify) {
    const ctx: BeforeQualifyContext = {
      referralId: row.referralId,
      touchId: row.id,
      referrerContactId: row.referrerContactId,
      refereeContactId: row.refereeContactId,
      event: input.event ?? "",
      eventProperties: input.eventProperties ?? {},
      conversionId: input.conversionId ?? null,
      properties: (row.properties ?? {}) as Record<string, unknown>,
    };
    const v = await verdict(referral.meta.beforeQualify, ctx);
    if (!v.ok) {
      const rejected = await rejectTouch({
        db,
        touchId,
        reason: "veto",
        detail: v.reason,
      });
      return {
        touch: rejected.touch,
        qualified: false,
        existing: false,
        rejected: true,
        reason: v.reason,
      };
    }
  }

  const [updated] = await db
    .update(referralTouches)
    .set({
      status: "qualified",
      qualifiedAt: at,
      qualifiedConversionId: input.conversionId ?? null,
    })
    .where(
      and(
        eq(referralTouches.id, touchId),
        isNull(referralTouches.qualifiedAt),
        eq(referralTouches.status, "bound"),
      ),
    )
    .returning();

  if (!updated) {
    // Lost the race to a concurrent qualify; the winner's row is the truth.
    const [winner] = await db
      .select()
      .from(referralTouches)
      .where(eq(referralTouches.id, touchId))
      .limit(1);
    return {
      touch: winner ? toRecord(winner) : null,
      qualified: false,
      existing: true,
      rejected: false,
    };
  }

  return {
    touch: toRecord(updated),
    qualified: true,
    existing: false,
    rejected: false,
  };
}

export interface RejectTouchInput {
  db: Database;
  touchId: string;
  reason: ReferralRejectReason;
  /** A hook's free text, filed alongside the vocabulary reason. */
  detail?: string;
}

export interface RejectTouchResult {
  touch: ReferralTouchRecord | null;
  /** True only when THIS call flipped the row to rejected. */
  rejected: boolean;
}

/**
 * Mark a touch rejected. Idempotent: an already-rejected row is returned as-is
 * with `rejected: false`, so a re-run cannot rewrite the ORIGINAL reason (which
 * is the only record of why the edge was thrown away).
 */
export async function rejectTouch(
  input: RejectTouchInput,
): Promise<RejectTouchResult> {
  const { db, touchId, reason, detail } = input;

  const [updated] = await db
    .update(referralTouches)
    .set({
      status: "rejected",
      rejectedReason: reason,
      ...(detail
        ? {
            properties: sql`coalesce(${referralTouches.properties}, '{}'::jsonb) || ${JSON.stringify(
              { [REFERRAL_VETO_REASON_PROPERTY]: detail },
            )}::jsonb`,
          }
        : {}),
    })
    .where(
      and(
        eq(referralTouches.id, touchId),
        sql`${referralTouches.status} <> 'rejected'`,
      ),
    )
    .returning();

  if (updated) return { touch: toRecord(updated), rejected: true };

  const [existing] = await db
    .select()
    .from(referralTouches)
    .where(eq(referralTouches.id, touchId))
    .limit(1);
  return { touch: existing ? toRecord(existing) : null, rejected: false };
}

// ---------------------------------------------------------------------------
// Reads
// ---------------------------------------------------------------------------

export interface ListTouchesInput {
  db: Database;
  contactId: string;
  referralId?: string;
  status?: ReferralTouchStatus[];
  limit?: number;
}

/** Every touch where this contact is the REFEREE (who referred me). */
export async function listTouchesForReferee(
  input: ListTouchesInput,
): Promise<ReferralTouchRecord[]> {
  return listTouches(input, referralTouches.refereeContactId);
}

/** Every touch where this contact is the REFERRER (who I referred). */
export async function listTouchesForReferrer(
  input: ListTouchesInput,
): Promise<ReferralTouchRecord[]> {
  return listTouches(input, referralTouches.referrerContactId);
}

async function listTouches(
  input: ListTouchesInput,
  column:
    | typeof referralTouches.refereeContactId
    | typeof referralTouches.referrerContactId,
): Promise<ReferralTouchRecord[]> {
  const rows = await input.db
    .select()
    .from(referralTouches)
    .where(
      and(
        eq(column, input.contactId),
        ...(input.referralId
          ? [eq(referralTouches.referralId, input.referralId)]
          : []),
        ...(input.status?.length
          ? [inArray(referralTouches.status, input.status)]
          : []),
      ),
    )
    .orderBy(desc(referralTouches.touchedAt))
    .limit(input.limit ?? 200);
  return rows.map(toRecord);
}
