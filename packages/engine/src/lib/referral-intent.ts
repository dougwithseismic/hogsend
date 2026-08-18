import type { HatchetClient } from "@hatchet-dev/typescript-sdk/v1/index.js";
import type { AnalyticsProvider, DefinedReferral } from "@hogsend/core";
import { evaluatePropertyConditions } from "@hogsend/core";
import type { JourneyRegistry } from "@hogsend/core/registry";
import {
  attributionCredits,
  contacts,
  type Database,
  referralTouches,
  userEvents,
} from "@hogsend/db";
import { and, asc, eq, inArray, isNull, sql } from "drizzle-orm";
import { getJourneyRegistrySingleton } from "../journeys/registry-singleton.js";
import { getAnalytics } from "./analytics-singleton.js";
import { createLogger, type Logger } from "./logger.js";
import {
  emitOutbound,
  type OutboundPayloads,
  type ReferralTouchPayload,
} from "./outbound.js";
import type { ReferralRegistry } from "./referral-registry.js";
import { getReferralRuntime } from "./referral-runtime.js";
import {
  bindTouches,
  qualifyTouch,
  type ReferralTouchRecord,
  type ReferralTouchSource,
  recordTouch,
} from "./referrals.js";

/**
 * THE REFERRAL INTENT LAYER (PRD 05 §6, stage 3) - the ONLY module that calls
 * the store's mutators AND emits. The split is the same one
 * `lib/account-links.ts` / `lib/account-link-ingest.ts` draw, for the same
 * reason:
 *
 *  - `lib/referrals.ts` (the STORE) writes `referral_touches` and NEVER emits.
 *    Two tests pin that (`referrals-no-emit.test.ts`).
 *  - THIS module calls the store, reads the returned FACTS, and fans each fact
 *    out onto BOTH planes, side by side:
 *      • the OUTBOUND spine (`emitOutbound`) → `webhook_deliveries` → the
 *        customer's subscriber. Full state, dedupe-keyed.
 *      • the JOURNEY plane (`ingestEvent`) → `user_events` + a Hatchet push, so
 *        `defineJourney({ trigger: { event: "referral.qualified" } })` fires.
 *
 * NEITHER PLANE MAY BE COLLAPSED INTO THE OTHER. Delete either and the other
 * keeps working silently: an outbound-only build leaves every reward journey
 * dead; an ingest-only build leaves every customer mirror stale.
 *
 * ## Identity law
 *
 * Every re-ingest carries the engine-internal `contactId` PIN. The bare
 * canonical key of a referrer is `contactKey()` - possibly an ANONYMOUS id -
 * and passing that alone would have the resolver read it as `external` and
 * mint `external_id = <anonId>` (the ghost-contact law). The referee side of a
 * COLD touch has no contact at all, which is exactly why `referral.touched` is
 * emitted to the REFERRER only: the referee is a browser id, not a person, and
 * minting a CRM row for them is the very thing PRD 02 forbade.
 *
 * ## Replay / exactly-once
 *
 * Every emit is dedupe-keyed off a durable row id, never a clock:
 * `referral:touch:<touchId>`, `referral:bound:<touchId>`,
 * `referral:qualified:<touchId>`, `referral:conv:<conversionId>:<beneficiary>`.
 * The bus keys append the RECIPIENT contact id, because `user_events`
 * `idempotency_key` is globally unique and a two-sided fact (bound / qualified
 * reaches referrer AND referee) would otherwise deliver to one of them only.
 */

const fallbackLogger = createLogger(process.env.LOG_LEVEL);

/** The container handles, when the caller has them. */
export interface ReferralIntentHandles {
  db: Database;
  hatchet?: HatchetClient;
  registry?: JourneyRegistry;
  logger?: Logger;
  analytics?: AnalyticsProvider;
  /** The referral registry; falls back to the process runtime. */
  referrals?: ReferralRegistry;
}

type ReferralEvent =
  | "referral.touched"
  | "referral.bound"
  | "referral.qualified"
  | "referral.converted"
  | "referral.tree_converted"
  | "referral.rejected";

/** The identity pin + recipient fields a re-ingest needs. */
interface ContactPin {
  contactId: string;
  userId: string;
  email: string | null;
}

async function loadPins(
  db: Database,
  ids: string[],
): Promise<Map<string, ContactPin>> {
  const unique = [...new Set(ids.filter(Boolean))];
  if (unique.length === 0) return new Map();
  const rows = await db
    .select({
      id: contacts.id,
      externalId: contacts.externalId,
      anonymousId: contacts.anonymousId,
      email: contacts.email,
    })
    .from(contacts)
    .where(inArray(contacts.id, unique));
  return new Map(
    rows.map((row) => [
      row.id,
      {
        contactId: row.id,
        userId: row.externalId ?? row.anonymousId ?? row.id,
        email: row.email,
      },
    ]),
  );
}

/**
 * Fan ONE fact onto BOTH planes for ONE recipient. Fire-and-forget with an
 * attributed catch: a referral is a side effect of something the visitor
 * already did (a click, an identify, a purchase), so a Hatchet hiccup must
 * never fail that.
 */
function emitBoth<E extends ReferralEvent>(opts: {
  handles: ReferralIntentHandles;
  event: E;
  /** The contact this copy of the fact is FOR (the bus subject). */
  recipient: ContactPin | undefined;
  /**
   * The catalogued payload, which doubles VERBATIM as the journey-bus
   * `eventProperties` - hence the scalar intersection. `ingestEvent` filters
   * the Hatchet push down to scalars, so a nested field here would vanish
   * between `user_events` and the journey it was meant to steer.
   */
  payload: OutboundPayloads[E] &
    Record<string, string | number | boolean | null>;
  dedupeKey: string;
}): void {
  const { handles, event, recipient, payload, dedupeKey } = opts;
  const runtime = getReferralRuntime();
  const logger = handles.logger ?? runtime?.logger ?? fallbackLogger;
  const db = handles.db;

  void (async () => {
    // Prefer the CONTAINER's handles (passed, or held on the runtime) over the
    // module singletons: importing `./hatchet.js` runs `HatchetClient.init`,
    // which throws where no real token exists.
    const hatchet =
      handles.hatchet ??
      runtime?.hatchet ??
      (await import("./hatchet.js")).hatchet;
    await emitOutbound({
      db,
      hatchet,
      logger,
      event,
      payload,
      dedupeKey,
    });
    if (!recipient) return;
    // Dynamic import for the same two reasons `account-link-ingest.ts` gives:
    // `lib/contacts.ts` reaches this module (the bind), and `lib/ingestion.ts`
    // reaches `lib/contacts.ts`, so a static import is a module cycle; and
    // importing `./hatchet.js` eagerly runs `HatchetClient.init`.
    const { ingestEvent } = await import("./ingestion.js");
    const analytics = handles.analytics ?? runtime?.analytics ?? getAnalytics();
    await ingestEvent({
      db,
      registry:
        handles.registry ?? runtime?.registry ?? getJourneyRegistrySingleton(),
      hatchet,
      logger,
      ...(analytics ? { analytics } : {}),
      event: {
        event,
        // The value key only has to EXIST (the resolver requires one); the pin
        // beside it decides the row and can never mint.
        userId: recipient.userId,
        contactId: recipient.contactId,
        ...(recipient.email ? { userEmail: recipient.email } : {}),
        eventProperties: payload,
        source: "referral",
        idempotencyKey: `${dedupeKey}:${recipient.contactId}`,
      },
    });
  })().catch((error: unknown) => {
    logger.error("referral fact emit failed", {
      event,
      dedupeKey,
      error: error instanceof Error ? error.message : String(error),
    });
  });
}

/** Scalar-only payload for a touch-shaped fact. */
function touchPayload(touch: ReferralTouchRecord): ReferralTouchPayload {
  return {
    referralId: touch.referralId,
    touchId: touch.id,
    referrerContactId: touch.referrerContactId,
    refereeContactId: touch.refereeContactId,
    refereeKey: touch.refereeKey,
    source: touch.source,
    linkId: touch.linkId,
    clickId: touch.clickId,
    status: touch.status,
    touchedAt: touch.touchedAt.toISOString(),
  };
}

// ---------------------------------------------------------------------------
// touch
// ---------------------------------------------------------------------------

export interface TouchReferralInput extends ReferralIntentHandles {
  referral: DefinedReferral;
  referrerContactId: string;
  /** The toucher's canonical key - an ANONYMOUS id on a cold touch. */
  refereeKey: string;
  /** Set only when the toucher is already a known person. */
  refereeContactId?: string | null;
  linkId?: string | null;
  clickId?: string | null;
  source: ReferralTouchSource;
  properties?: Record<string, unknown>;
  idempotencyKey?: string;
}

export interface TouchReferralResult {
  touch: ReferralTouchRecord | null;
  created: boolean;
  rejected: boolean;
}

/**
 * Record a referral touch and announce it. `referral.touched` goes to the
 * REFERRER only (see the identity note in the module header).
 */
export async function touchReferral(
  input: TouchReferralInput,
): Promise<TouchReferralResult> {
  const { referral, db } = input;
  const result = await recordTouch({
    db,
    referral,
    referralId: referral.id,
    referrerContactId: input.referrerContactId,
    refereeKey: input.refereeKey,
    refereeContactId: input.refereeContactId ?? null,
    linkId: input.linkId ?? null,
    clickId: input.clickId ?? null,
    source: input.source,
    ...(input.properties ? { properties: input.properties } : {}),
    ...(input.idempotencyKey ? { idempotencyKey: input.idempotencyKey } : {}),
  });

  // Only a FRESH write is news. A replayed click / same-pair re-touch recovered
  // an existing row and announcing it again would re-fire the reward journey.
  if (!result.created) {
    return { touch: result.touch, created: false, rejected: result.rejected };
  }

  const pins = await loadPins(db, [
    result.touch.referrerContactId,
    ...(result.touch.refereeContactId ? [result.touch.refereeContactId] : []),
  ]);
  const referrer = pins.get(result.touch.referrerContactId);

  if (result.rejected) {
    emitBoth({
      handles: input,
      event: "referral.rejected",
      recipient: referrer,
      payload: {
        ...touchPayload(result.touch),
        reason: result.touch.rejectedReason,
      },
      dedupeKey: `referral:rejected:${result.touch.id}`,
    });
    return { touch: result.touch, created: true, rejected: true };
  }

  emitBoth({
    handles: input,
    event: "referral.touched",
    recipient: referrer,
    payload: touchPayload(result.touch),
    dedupeKey: `referral:touch:${result.touch.id}`,
  });

  // An already-identified toucher binds at the same instant, so the bind fact
  // is due now: a reward journey listens on `referral.bound`, and only the
  // COLD path reaches `bindReferral` later.
  if (result.touch.status === "bound" && result.touch.refereeContactId) {
    announceBound(input, result.touch, pins);
    // Same law as the cold path in `bindReferral`: a referral with NO qualify
    // config is EARNED at bind. Without this an identified toucher (token
    // arrival, invite, manual) would sit at `bound` forever and no reward
    // journey would ever see `referral.qualified`.
    if (!referral.meta.qualify) {
      await qualifyReferral({ ...input, touch: result.touch, referral });
    }
  }

  return { touch: result.touch, created: true, rejected: false };
}

// ---------------------------------------------------------------------------
// bind
// ---------------------------------------------------------------------------

export interface BindReferralInput extends ReferralIntentHandles {
  /** The anonymous/canonical key the visitor touched under. */
  refereeKey: string;
  /** The contact that key just resolved to. */
  contactId: string;
}

/**
 * Bind every unbound touch for a key at identity-adoption time, and announce
 * each outcome. Called POST-COMMIT from `resolveContactShared` - never inside
 * the resolver's transaction, because this emits and a rolled-back merge must
 * never have announced a bind that never happened.
 */
export async function bindReferral(input: BindReferralInput): Promise<void> {
  const referrals = resolveRegistry(input);
  if (!referrals || referrals.count() === 0) return;

  const result = await bindTouches({
    db: input.db,
    refereeKey: input.refereeKey,
    contactId: input.contactId,
    resolveReferral: (id) => referrals.get(id),
  });
  if (result.bound.length === 0 && result.rejected.length === 0) return;

  const pins = await loadPins(input.db, [
    input.contactId,
    ...result.bound.map((t) => t.referrerContactId),
    ...result.rejected.map((r) => r.touch.referrerContactId),
  ]);

  for (const touch of result.bound) {
    announceBound(input, touch, pins);
    // A referral with NO qualify config is EARNED at bind: the referee is a
    // known person, which is all the program asked for. Without this the touch
    // would sit at `bound` forever and no reward journey would ever fire.
    const referral = referrals.get(touch.referralId);
    if (referral && !referral.meta.qualify) {
      await qualifyReferral({ ...input, touch, referral });
    }
  }

  for (const { touch, reason, detail } of result.rejected) {
    emitBoth({
      handles: input,
      event: "referral.rejected",
      recipient: pins.get(touch.referrerContactId),
      payload: {
        ...touchPayload(touch),
        reason,
        detail: detail ?? null,
      },
      dedupeKey: `referral:rejected:${touch.id}`,
    });
  }
}

/** `referral.bound` reaches BOTH ends - the referrer and the referee. */
function announceBound(
  handles: ReferralIntentHandles,
  touch: ReferralTouchRecord,
  pins: Map<string, ContactPin>,
): void {
  const payload = {
    ...touchPayload(touch),
    boundAt: touch.boundAt?.toISOString() ?? new Date().toISOString(),
  };
  emitBoth({
    handles,
    event: "referral.bound",
    recipient: pins.get(touch.referrerContactId),
    payload: { ...payload, side: "referrer" },
    dedupeKey: `referral:bound:${touch.id}`,
  });
  if (touch.refereeContactId) {
    emitBoth({
      handles,
      event: "referral.bound",
      recipient: pins.get(touch.refereeContactId),
      payload: { ...payload, side: "referee" },
      // SAME outbound dedupe key: the customer's subscriber gets ONE delivery
      // of the fact (the payload is the same edge). The bus keys differ only
      // because `emitBoth` appends the recipient id.
      dedupeKey: `referral:bound:${touch.id}`,
    });
  }
}

// ---------------------------------------------------------------------------
// qualify
// ---------------------------------------------------------------------------

export interface QualifyReferralInput extends ReferralIntentHandles {
  touch: ReferralTouchRecord;
  referral?: DefinedReferral;
  event?: string;
  eventProperties?: Record<string, unknown>;
  conversionId?: string | null;
}

/**
 * Promote a BOUND touch to qualified and announce it to BOTH ends. The store's
 * `qualified_at IS NULL` predicate is the exactly-once guard, so a redelivered
 * qualify event returns `existing` and emits nothing.
 */
export async function qualifyReferral(
  input: QualifyReferralInput,
): Promise<void> {
  const result = await qualifyTouch({
    db: input.db,
    touchId: input.touch.id,
    ...(input.referral ? { referral: input.referral } : {}),
    ...(input.event ? { event: input.event } : {}),
    ...(input.eventProperties
      ? { eventProperties: input.eventProperties }
      : {}),
    ...(input.conversionId ? { conversionId: input.conversionId } : {}),
  });
  const touch = result.touch;
  if (!touch) return;

  const pins = await loadPins(input.db, [
    touch.referrerContactId,
    ...(touch.refereeContactId ? [touch.refereeContactId] : []),
  ]);

  if (result.rejected) {
    emitBoth({
      handles: input,
      event: "referral.rejected",
      recipient: pins.get(touch.referrerContactId),
      payload: {
        ...touchPayload(touch),
        reason: touch.rejectedReason,
        detail: result.reason ?? null,
      },
      dedupeKey: `referral:rejected:${touch.id}`,
    });
    return;
  }
  if (!result.qualified) return;

  const payload = {
    ...touchPayload(touch),
    event: input.event ?? null,
    conversionId: touch.qualifiedConversionId,
    qualifiedAt: touch.qualifiedAt?.toISOString() ?? new Date().toISOString(),
  };
  emitBoth({
    handles: input,
    event: "referral.qualified",
    recipient: pins.get(touch.referrerContactId),
    payload: { ...payload, side: "referrer" },
    dedupeKey: `referral:qualified:${touch.id}`,
  });
  if (touch.refereeContactId) {
    emitBoth({
      handles: input,
      event: "referral.qualified",
      recipient: pins.get(touch.refereeContactId),
      payload: { ...payload, side: "referee" },
      dedupeKey: `referral:qualified:${touch.id}`,
    });
  }
}

/**
 * The `ingestEvent` hook: does THIS event qualify any of this contact's bound
 * touches? Cheap on a miss - one map lookup on the registry - so it is safe to
 * call on every ingested event.
 */
export async function qualifyReferralsForEvent(opts: {
  handles: ReferralIntentHandles;
  event: string;
  eventProperties: Record<string, unknown>;
  contactId: string;
}): Promise<void> {
  const referrals = resolveRegistry(opts.handles);
  const watching = referrals?.byQualifyEvent(opts.event) ?? [];
  if (watching.length === 0) return;

  const rows = await opts.handles.db
    .select()
    .from(referralTouches)
    .where(
      and(
        eq(referralTouches.refereeContactId, opts.contactId),
        eq(referralTouches.status, "bound"),
        isNull(referralTouches.qualifiedAt),
        inArray(
          referralTouches.referralId,
          watching.map((r) => r.id),
        ),
      ),
    )
    .orderBy(asc(referralTouches.touchedAt));

  for (const row of rows) {
    const referral = watching.find((r) => r.id === row.referralId);
    if (!referral) continue;
    // The `where` on `qualify` is the SAME builder journeys use for
    // `trigger.where`, normalized once at `defineReferral` time - so "first
    // paid invoice over 10" needs no custom veto hook.
    if (
      referral.qualifyWhere &&
      !evaluatePropertyConditions({
        conditions: referral.qualifyWhere,
        properties: opts.eventProperties,
      })
    ) {
      continue;
    }
    await qualifyReferral({
      ...opts.handles,
      touch: toTouchRecord(row),
      referral,
      event: opts.event,
      eventProperties: opts.eventProperties,
    });
  }
}

// ---------------------------------------------------------------------------
// convert
// ---------------------------------------------------------------------------

/** How far up the tree a conversion is announced. Hard cap (PRD 05 §5.3). */
export const REFERRAL_TREE_MAX_DEPTH = 5;

export interface ConvertReferralInput extends ReferralIntentHandles {
  /** The contact who converted - the REFEREE at level 1. */
  contactId: string;
  conversionId: string;
  value: number | null;
  currency: string | null;
  occurredAt: Date;
}

/**
 * Announce a conversion up the referral tree: `referral.converted` to the
 * DIRECT referrer, `referral.tree_converted` to each ancestor above them, to
 * {@link REFERRAL_TREE_MAX_DEPTH}.
 *
 * `level` is a FACT on the event, never program config - a reward journey
 * filters with `trigger.where: (b) => b.prop("level").eq(1)`. That is the only
 * place levels appear in code, which is what keeps depth and weights
 * report-time parameters.
 */
export async function convertReferral(
  input: ConvertReferralInput,
): Promise<void> {
  const referrals = resolveRegistry(input);
  if (!referrals || referrals.count() === 0) return;

  const first = await firstBoundTouch(input.db, input.contactId);
  if (!first) return;

  // Best-effort ledger stamp: tie the credits earned by this touch's own
  // click/arrive touchpoint to the edge, so `attribution_credits` and the
  // referral tree reconcile. Nothing downstream depends on it, so a miss is
  // silent (the touchpoint may predate the ledger window, or the conversion
  // may have no touchpoint rows at all).
  await stampAttributionCredits(input, first).catch((err: unknown) => {
    (input.logger ?? fallbackLogger).warn("referral attribution stamp failed", {
      error: err instanceof Error ? err.message : String(err),
    });
  });

  // Walk UP: level 1 is the referee's direct referrer, level 2 that person's
  // referrer, and so on. `visited` is the cycle guard - A referred B referred A
  // is legal data (two edges, both valid) and would otherwise loop forever.
  const visited = new Set<string>([input.contactId]);
  let via = input.contactId;
  let touch: ReferralTouchRecord | null = first;
  const pinIds: string[] = [input.contactId];

  const hops: Array<{
    level: number;
    beneficiary: string;
    via: string;
    touch: ReferralTouchRecord;
  }> = [];
  for (let level = 1; level <= REFERRAL_TREE_MAX_DEPTH && touch; level++) {
    const beneficiary = touch.referrerContactId;
    if (visited.has(beneficiary)) break;
    visited.add(beneficiary);
    hops.push({ level, beneficiary, via, touch });
    pinIds.push(beneficiary);
    via = beneficiary;
    touch = await firstBoundTouch(input.db, beneficiary);
  }
  if (hops.length === 0) return;

  const pins = await loadPins(input.db, pinIds);
  for (const hop of hops) {
    emitBoth({
      handles: input,
      event: hop.level === 1 ? "referral.converted" : "referral.tree_converted",
      recipient: pins.get(hop.beneficiary),
      payload: {
        referralId: hop.touch.referralId,
        touchId: hop.touch.id,
        level: hop.level,
        beneficiaryContactId: hop.beneficiary,
        refereeContactId: input.contactId,
        // The NEXT hop toward the referee, so a journey can name "your
        // friend's friend" without walking the tree itself.
        viaContactId: hop.via,
        conversionId: input.conversionId,
        // NOT `value` - see `ReferralConversionPayload.conversionValue`.
        conversionValue: input.value,
        currency: input.currency,
        at: input.occurredAt.toISOString(),
      },
      dedupeKey: `referral:conv:${input.conversionId}:${hop.beneficiary}`,
    });
  }
}

/**
 * The FIRST bound touch for a referee, by `touched_at`. First-touch is the pin
 * for the tree walk on purpose: the walk must be STABLE (a later touch would
 * silently re-parent an ancestor chain already announced), while the report
 * picks its own model over the full edge log at query time.
 */
async function firstBoundTouch(
  db: Database,
  contactId: string,
): Promise<ReferralTouchRecord | null> {
  const [row] = await db
    .select()
    .from(referralTouches)
    .where(
      and(
        eq(referralTouches.refereeContactId, contactId),
        inArray(referralTouches.status, ["bound", "qualified"]),
      ),
    )
    .orderBy(asc(referralTouches.touchedAt))
    .limit(1);
  return row ? toTouchRecord(row) : null;
}

/**
 * Stamp `attribution_credits.referral_touch_id` on the rows this conversion
 * produced whose touchpoint IS this touch's click/arrive event, so
 * `WHERE channel = 'referral'` reconciles with the tree.
 */
async function stampAttributionCredits(
  input: ConvertReferralInput,
  touch: ReferralTouchRecord,
): Promise<void> {
  if (!touch.clickId) return;
  await input.db
    .update(attributionCredits)
    .set({ referralTouchId: touch.id })
    .where(
      and(
        eq(attributionCredits.conversionId, input.conversionId),
        isNull(attributionCredits.referralTouchId),
        inArray(
          attributionCredits.touchpointEventId,
          input.db
            .select({ id: userEvents.id })
            .from(userEvents)
            .where(
              sql`${userEvents.properties}->>'ref' = ${touch.clickId} or ${userEvents.properties}->>'clickId' = ${touch.clickId}`,
            ),
        ),
      ),
    );
}

// ---------------------------------------------------------------------------
// shared
// ---------------------------------------------------------------------------

function resolveRegistry(
  handles: ReferralIntentHandles,
): ReferralRegistry | undefined {
  return handles.referrals ?? getReferralRuntime()?.referrals;
}

/** `referral_touches` row → the store's record shape. */
function toTouchRecord(
  row: typeof referralTouches.$inferSelect,
): ReferralTouchRecord {
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
    status: row.status as ReferralTouchRecord["status"],
    rejectedReason: row.rejectedReason as ReferralTouchRecord["rejectedReason"],
    qualifiedAt: row.qualifiedAt,
    qualifiedConversionId: row.qualifiedConversionId,
    properties: (row.properties ?? {}) as Record<string, unknown>,
  };
}
