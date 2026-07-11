import type {
  Conditions,
  HatchetClient,
} from "@hatchet-dev/typescript-sdk/v1/index.js";
import {
  Or,
  SleepCondition,
  UserEventCondition,
} from "@hatchet-dev/typescript-sdk/v1/index.js";
import type { DurationObject } from "@hogsend/core";
import {
  durationToMs,
  evaluateEventCondition,
  evaluatePropertyConditions,
  normalizeWhere,
} from "@hogsend/core";
import type { JourneyRegistry } from "@hogsend/core/registry";
import {
  isValidTimeZone,
  resolveAfter,
  resolveNextLocalTime,
  resolveNextWeekday,
  resolveTomorrow,
  type SendWindow,
} from "@hogsend/core/schedule";
import type {
  DigestEvent,
  DigestOptions,
  DigestResult,
  IfPast,
  JourneyContext,
  PropertyCondition,
  RecentEvent,
  ThrottleOptions,
  ThrottleResult,
  TimeOfDayBuilder,
  WaitForEventResult,
  Weekday,
  WhenBuilder,
} from "@hogsend/core/types";
import {
  type Database,
  emailSends,
  journeyStates,
  smsSends,
  userEvents,
} from "@hogsend/db";
import {
  and,
  asc,
  count,
  desc,
  eq,
  gte,
  lte,
  max,
  notInArray,
  sql,
} from "drizzle-orm";
import { checkEmailPreferences } from "../lib/enrollment-guards.js";
import { countRecentSends } from "../lib/frequency-cap.js";
import { toSleepDuration } from "../lib/hatchet-duration.js";
import { ingestEvent } from "../lib/ingestion.js";
import type { Logger } from "../lib/logger.js";
import {
  JOURNEY_EXECUTION_TIMEOUT,
  JOURNEY_EXECUTION_TIMEOUT_HOURS,
} from "./constants.js";
import { JourneyExitedError } from "./errors.js";
import {
  deriveJourneyKey,
  getJourneyBoundary,
  registerKey,
  registerRecordLabel,
} from "./journey-boundary.js";
import { logTransition } from "./journey-log.js";
import { recordOnce } from "./record-once.js";

/** Journey statuses that are terminal — a journey in any of these must never be
 * resurrected back to "active" by a wait resuming. Exported so the durable task
 * runner can avoid clobbering a terminal row to "failed" on a cancel. */
export const TERMINAL_STATUSES = ["completed", "failed", "exited"] as const;

/** Upper bound for a `waitForEvent` timeout — the journey task's executionTimeout. */
const MAX_WAIT_MS = durationToMs({ hours: JOURNEY_EXECUTION_TIMEOUT_HOURS });

/** Default cap on events a single digest returns AND records. */
const DIGEST_DEFAULT_MAX_EVENTS = 100;
/** Hard ceiling on the digest event cap — bounds the recorded jsonb payload. */
const DIGEST_MAX_EVENTS_CEILING = 500;
/** Default backward widening so the enrolling event is caught by the scan. */
const DIGEST_DEFAULT_LOOKBACK: DurationObject = { minutes: 15 };

/**
 * `journeyId:nodeId:reason` keys already warned about a digest/definition
 * interplay this process. Warn-once so a replay-from-top (which re-runs the
 * whole `run()`) doesn't spam the log with the same authoring advisory.
 */
const digestWarned = new Set<string>();

/**
 * Quote a string as a CEL single-quoted string literal, escaping backslashes
 * then single quotes. Used to embed an externally-supplied userId into a CEL
 * filter expression without breaking it or allowing injection.
 */
function celStringLiteral(value: string): string {
  return `'${value.replace(/\\/g, "\\\\").replace(/'/g, "\\'")}'`;
}

/** SQL eq-pushdown predicates for a `where` — a COARSE narrowing pre-filter,
 * never the verdict: jsonb `->>` extracts TEXT (a stored string "50"
 * text-matches `.eq(50)`), so every consumer MUST re-verify fetched rows with
 * the strict condition engine in JS. A null-eq is NOT pushdownable — `->> p =
 * 'null'` never matches a jsonb null (SQL NULL) — so it is excluded here and
 * resolved entirely by that JS re-verify. */
const eqPushdownPreds = (where: PropertyCondition[]) =>
  where
    .filter(
      (c) => c.operator === "eq" && c.value !== undefined && c.value !== null,
    )
    .map(
      (c) =>
        sql`${userEvents.properties} ->> ${c.property} = ${String(c.value)}`,
    );

interface JourneyContextConfig {
  db: Database;
  hatchet: HatchetClient;
  hatchetCtx: {
    // Hatchet's real `sleepFor` accepts a Go duration string, a DurationObject,
    // or a number (ms). We always pass a normalized whole-seconds string (see
    // `toSleepDuration`) — the multi-unit strings the SDK derives from a raw ms
    // number are silently no-op'd by some hatchet-lite versions. The param is the
    // exact `${number}s` literal (a subtype of the SDK's `Duration`) so the real
    // `DurableContext` stays assignable to this structural stub.
    sleepFor: (
      duration: DurationObject | number | `${number}s`,
    ) => Promise<unknown>;
    // The forwarded object is the real Hatchet `DurableContext`, which also has
    // `waitFor` (used by `waitForEvent`). Param mirrors the SDK signature so the
    // real context is assignable; we read back the envelope as a plain record.
    waitFor: (
      conditions: Conditions | Conditions[],
    ) => Promise<Record<string, unknown>>;
    // The real `DurableContext.now()` (SDK 1.22.3, public): a clock memoized
    // across replays — same Date on every replay of the same run. Optional so a
    // pre-eviction engine (or a test ctx without it) falls back to the live
    // clock via `nowProvider` below; that only affects RECOMPUTED instants, never
    // the DB-key exactly-once of sends/triggers, so correctness is preserved.
    now?: () => Promise<Date>;
  };
  registry: JourneyRegistry;
  logger: Logger;
  stateId: string;
  userId: string;
  userEmail: string;
  journeyContext: Record<string, unknown>;
  /** The user's resolved IANA timezone, bound into `ctx.when`. */
  resolvedTimezone: string;
  /** The client default send window, auto-applied by `ctx.when`. */
  defaultSendWindow?: SendWindow;
  /** The journey's trigger event — `ctx.digest`'s default `event`. */
  triggerEvent?: string;
  /** The journey's already-normalized `trigger.where` — `ctx.digest` applies it
   * when digesting the trigger event with no explicit `where` (honors the
   * trigger contract). */
  triggerWhere?: PropertyCondition[];
  /** The journey id — keys the digest definition-interplay warn-once. */
  journeyId?: string;
  /** The journey's entry limit — drives `ctx.digest` interplay warnings. */
  entryLimit?: "once" | "once_per_period" | "unlimited";
  /** The journey's entry period (for `once_per_period`). */
  entryPeriod?: DurationObject;
}

/**
 * Build the timezone-bound fluent scheduler. A thin wrapper over the pure core
 * resolvers: it injects the user's resolved tz, the real current instant, and
 * the (optionally overridden) send window, returning absolute `Date`s.
 */
function createWhenBuilder(opts: {
  timezone: string;
  window?: SendWindow;
  ifPast: IfPast;
  /**
   * The current instant, supplied by the context so `ctx.when` reads the
   * replay-stable (memoized) clock instead of a raw `new Date()` — the resolved
   * instant must be identical across a durable replay or a scheduled `.next(...)`
   * could land on a different day the second time through.
   */
  now: () => Date;
}): WhenBuilder {
  const baseOpts = () => ({
    timezone: opts.timezone,
    now: opts.now(),
    window: opts.window,
    ifPast: opts.ifPast,
  });

  const timeBuilder = (resolve: (time: string) => Date): TimeOfDayBuilder => ({
    at: (time) => resolve(time),
  });

  return {
    next(weekday: Weekday) {
      return timeBuilder((time) =>
        resolveNextWeekday(weekday, time, baseOpts()),
      );
    },
    nextLocal(time: string) {
      return resolveNextLocalTime(time, baseOpts());
    },
    tomorrow() {
      return timeBuilder((time) => resolveTomorrow(time, baseOpts()));
    },
    in(duration: DurationObject) {
      return timeBuilder((time) => resolveAfter(duration, time, baseOpts()));
    },
    tz(timezone: string) {
      if (!isValidTimeZone(timezone)) {
        throw new TypeError(`ctx.when.tz: invalid timezone "${timezone}"`);
      }
      return createWhenBuilder({ ...opts, timezone });
    },
    window(start: string, end: string) {
      return createWhenBuilder({ ...opts, window: { start, end } });
    },
    ifPast(strategy: IfPast) {
      return createWhenBuilder({ ...opts, ifPast: strategy });
    },
  };
}

export function createJourneyContext(
  config: JourneyContextConfig,
): JourneyContext {
  const {
    db,
    hatchet,
    hatchetCtx,
    registry,
    logger,
    stateId,
    userId,
    userEmail,
    journeyContext,
    resolvedTimezone,
    defaultSendWindow,
  } = config;

  // Replay-stable clock: the real DurableContext.now() is memoized across
  // replays; a pre-eviction engine (or a test ctx without it) falls back to the
  // live clock. Only RECOMPUTED instants depend on this — never the DB-key
  // exactly-once of sends/triggers — so a live fallback never breaks correctness.
  const nowProvider = (): Promise<Date> =>
    hatchetCtx.now ? hatchetCtx.now() : Promise.resolve(new Date());

  // `ctx.when` resolves instants synchronously, but the memoized clock is async.
  // Keep a snapshot of the most recent memoized instant that `ctx.when` reads
  // synchronously; refresh it whenever an async primitive runs AND once at the
  // start of `run()` (define-journey awaits `ctx.now()` before running so the
  // seed below is replaced by the memoized instant before any `ctx.when` read).
  // The live `new Date()` is only a fallback for a context whose `run()` never
  // gets that pre-seed (tests) or a pre-eviction engine (best-effort, unchanged).
  let latestNow = new Date();
  const refreshNow = async (): Promise<Date> => {
    latestNow = await nowProvider();
    return latestNow;
  };

  // Capture the nearest authored wait/checkpoint label on the active journey
  // boundary so the NEXT side effect (sendEmail / ctx.trigger) inherits it as
  // its idempotency-key "site" discriminant. This is what lets two sends of the
  // SAME template on different branches derive distinct keys for free, without
  // any explicit authoring label. No-op outside a journey run (no boundary).
  const setBoundaryLabel = (label: string): void => {
    const boundary = getJourneyBoundary();
    if (boundary) boundary.currentLabel = label;
  };

  // Enter a durable wait: flip "active" → "waiting", but ONLY if the journey
  // hasn't already reached a terminal state (e.g. exitOn fired before we got
  // here). A no-op update means the journey is already done — abort the run.
  const enterWait = async (
    nodeId: string,
    action: "sleep" | "wait",
  ): Promise<void> => {
    const entered = await db
      .update(journeyStates)
      .set({ status: "waiting", currentNodeId: nodeId, updatedAt: new Date() })
      .where(
        and(
          eq(journeyStates.id, stateId),
          notInArray(journeyStates.status, [...TERMINAL_STATUSES]),
        ),
      )
      .returning({ id: journeyStates.id });

    if (entered.length === 0) {
      throw new JourneyExitedError(stateId);
    }

    // Fire-and-forget transition log (best-effort; never affects the wait). The
    // boundary's current label (if any) is the node we're leaving.
    const prior = getJourneyBoundary()?.currentLabel;
    logTransition({
      db,
      journeyStateId: stateId,
      from: prior && prior !== nodeId ? prior : null,
      to: nodeId,
      action,
    });
  };

  // Resume from a durable wait: flip "waiting" → "active", but ONLY if the row
  // is still "waiting". If an exit/cancel landed during the wait the row is no
  // longer "waiting" — abort instead of reviving a terminated journey to active
  // (which would let a post-wait side effect fire after the journey exited).
  const resumeFromWait = async (
    nodeId: string,
    detail?: Record<string, unknown>,
  ): Promise<void> => {
    const resumed = await db
      .update(journeyStates)
      .set({ status: "active", updatedAt: new Date() })
      .where(
        and(eq(journeyStates.id, stateId), eq(journeyStates.status, "waiting")),
      )
      .returning({ id: journeyStates.id });

    if (resumed.length === 0) {
      throw new JourneyExitedError(stateId);
    }

    // Fire-and-forget resume transition (best-effort; never affects the run).
    logTransition({
      db,
      journeyStateId: stateId,
      from: null,
      to: nodeId,
      action: "resume",
      ...(detail ? { detail } : {}),
    });
  };

  // Durable sleep with the guarded waiting → active lifecycle. `sleep` passes a
  // DurationObject; `sleepUntil`/`digest` pass a precomputed ms delay. Both are
  // normalized to a whole-seconds Go string (see `toSleepDuration`) — a raw ms
  // number would be rendered by the SDK as a multi-unit string some hatchet-lite
  // versions silently no-op, resolving the wait instantly.
  const performSleep = async (
    durationOrMs: DurationObject | number,
    nodeId: string,
  ): Promise<{ sleptAt: string; resumedAt: string }> => {
    const sleptAt = new Date().toISOString();
    await enterWait(nodeId, "sleep");
    await hatchetCtx.sleepFor(toSleepDuration(durationOrMs));
    const resumedAt = new Date().toISOString();
    await resumeFromWait(nodeId);
    // Refresh the memoized clock snapshot so a `ctx.when` chain used right after
    // this wait reads a replay-stable instant (on an eviction engine) instead of
    // the construction-time seed — see `latestNow`.
    await refreshNow();
    // The just-finished wait's label is the "site" the next side effect inherits.
    setBoundaryLabel(nodeId);
    return { sleptAt, resumedAt };
  };

  const narrowScalars = (
    props: Record<string, unknown> | null | undefined,
  ): NonNullable<WaitForEventResult["properties"]> =>
    Object.fromEntries(
      Object.entries(props ?? {}).filter(
        ([, v]) =>
          typeof v === "string" ||
          typeof v === "number" ||
          typeof v === "boolean" ||
          v === null,
      ),
    ) as NonNullable<WaitForEventResult["properties"]>;

  // WHERE-filtered durable wait. Unlike the legacy single-wait (which resolves
  // on the FIRST same-name event, ignoring properties), this resolves ONLY on an
  // event whose properties satisfy `where`. Correctness:
  //  • DURABLE DEADLINE — persisted to `journey_states.wait_deadline`
  //    read-first/set-once, so a Hatchet replay-from-top reuses it instead of
  //    extending the wait on every replay (the single-`sleepFor` durability
  //    trick does not survive a multi-iteration re-arm).
  //  • GAP-PROOF — each iteration re-scans `user_events` over the WHOLE window
  //    since the wait began (ingest writes the row BEFORE the Hatchet push), so
  //    a match landing in the gap between a non-matching wake and the re-arm is
  //    never lost. `lookback` widens the window backward.
  //  • enterWait / resumeFromWait fire EXACTLY ONCE around the loop; an `exitOn`
  //    landing mid-wait is caught by the per-iteration terminal-status check.
  const performFilteredWaitForEvent = async (
    event: string,
    timeout: DurationObject,
    nodeId: string,
    where: PropertyCondition[],
    lookback?: DurationObject,
  ): Promise<WaitForEventResult> => {
    // Durable deadline: read-first / set-once.
    const stateRow = await db
      .select({ waitDeadline: journeyStates.waitDeadline })
      .from(journeyStates)
      .where(eq(journeyStates.id, stateId))
      .limit(1);
    const storedDeadline = stateRow[0]?.waitDeadline ?? null;
    const deadline = storedDeadline
      ? new Date(storedDeadline)
      : new Date(Date.now() + durationToMs(timeout));
    if (!storedDeadline) {
      await db
        .update(journeyStates)
        .set({ waitDeadline: deadline, updatedAt: new Date() })
        .where(eq(journeyStates.id, stateId));
    }

    const clearDeadline = () =>
      db
        .update(journeyStates)
        .set({ waitDeadline: null, updatedAt: new Date() })
        .where(eq(journeyStates.id, stateId));

    // Scan window: the (durable) instant the wait began — deadline minus the
    // original timeout — widened backward by `lookback`.
    const lookbackMs = lookback ? durationToMs(lookback) : 0;
    const scanSince = new Date(
      deadline.getTime() - durationToMs(timeout) - lookbackMs,
    );

    // Push `eq` conditions (the common "await THIS specific link/campaign" case)
    // into SQL so the LIMIT below bounds MATCHING rows, not all same-name rows —
    // otherwise a chatty user emitting >LIMIT other same-name events could bury
    // the matching row past the cutoff and the wait would falsely time out.
    // Narrowing only — `scanForMatch` re-verifies every row in JS.
    const eqPreds = eqPushdownPreds(where);

    const scanForMatch = async (): Promise<NonNullable<
      WaitForEventResult["properties"]
    > | null> => {
      const recent = await db
        .select({ properties: userEvents.properties })
        .from(userEvents)
        .where(
          and(
            eq(userEvents.userId, userId),
            eq(userEvents.event, event),
            gte(userEvents.occurredAt, scanSince),
            ...eqPreds,
          ),
        )
        .orderBy(desc(userEvents.occurredAt))
        // 100 is a generous backstop for a `where` of ONLY non-eq operators (no
        // SQL pushdown); the eq-pushdown path returns only matching rows, so the
        // cap can never hide a match there.
        .limit(100);
      for (const row of recent) {
        const props = (row.properties ?? {}) as Record<string, unknown>;
        if (
          evaluatePropertyConditions({ conditions: where, properties: props })
        ) {
          return narrowScalars(props);
        }
      }
      return null;
    };

    // Immediate hit (incl. the lookback window) — resolve without a state flip.
    const preHit = await scanForMatch();
    if (preHit) {
      await clearDeadline();
      return { timedOut: false, properties: preHit };
    }

    await enterWait(nodeId, "wait");

    let outcome: WaitForEventResult;
    while (true) {
      const hit = await scanForMatch();
      if (hit) {
        outcome = { timedOut: false, properties: hit };
        break;
      }

      // exitOn landing mid-wait flips the row to a terminal status — abort
      // cleanly (no resume, no post-wait side effects) instead of re-arming.
      const st = await db
        .select({ status: journeyStates.status })
        .from(journeyStates)
        .where(eq(journeyStates.id, stateId))
        .limit(1);
      const status = st[0]?.status;
      if (status && (TERMINAL_STATUSES as readonly string[]).includes(status)) {
        throw new JourneyExitedError(stateId);
      }

      const remainingMs = deadline.getTime() - Date.now();
      if (remainingMs <= 0) {
        outcome = { timedOut: true };
        break;
      }

      const armed = await hatchetCtx.waitFor(
        Or(
          new UserEventCondition(
            event,
            `input.userId == ${celStringLiteral(userId)}`,
            "event",
          ),
          new SleepCondition(toSleepDuration(remainingMs), "timeout"),
        ),
      );
      const fired = (("CREATE" in armed ? armed.CREATE : armed) ??
        {}) as Record<string, unknown>;
      if (!("event" in fired)) {
        // Timeout branch — one final scan for an event landing exactly as the
        // sleep expired, then conclude.
        const last = await scanForMatch();
        outcome = last
          ? { timedOut: false, properties: last }
          : { timedOut: true };
        break;
      }
      // Event branch: loop — the next scan picks up the (already persisted) row
      // if it matches, else re-arms toward the durable deadline.
    }

    await resumeFromWait(nodeId, { timedOut: outcome.timedOut });
    await clearDeadline();
    return outcome;
  };

  // Durably wait for THIS user's `event` OR `timeout`, whichever fires first,
  // sharing the same guarded lifecycle as `performSleep`.
  const performWaitForEvent = async (
    event: string,
    timeout: DurationObject,
    nodeId: string,
    lookback?: DurationObject,
    where?: PropertyCondition[],
  ): Promise<WaitForEventResult> => {
    // Reject a timeout longer than the journey task's executionTimeout up front
    // so it fails fast at authoring time. (Eviction-capable engines may allow
    // longer wall-clock waits, but we cap to the configured ceiling — raise
    // JOURNEY_EXECUTION_TIMEOUT to lift it.)
    if (durationToMs(timeout) > MAX_WAIT_MS) {
      throw new RangeError(
        `waitForEvent timeout exceeds the journey execution limit (${JOURNEY_EXECUTION_TIMEOUT})`,
      );
    }

    // This wait's label is the "site" the next side effect inherits, regardless
    // of which path (filtered re-arm / lookback hit / event / timeout) resolves
    // it — set it before dispatching to either wait path.
    setBoundaryLabel(nodeId);

    // WHERE-filtered wait takes the durable re-arm path; an empty/absent `where`
    // keeps the exact legacy single-wait below byte-for-byte.
    if (where && where.length > 0) {
      return performFilteredWaitForEvent(
        event,
        timeout,
        nodeId,
        where,
        lookback,
      );
    }

    // Optional lookback: the durable wait only matches events pushed AFTER it
    // is established, so an answer landing in the gap (between a send and its
    // wait, or between two back-to-back waits) would otherwise be permanently
    // unobservable — its first-answer idempotency key is already claimed and
    // can never re-push. A recent matching user_events row resolves the wait
    // immediately, payload included.
    if (lookback) {
      const since = new Date(
        (await refreshNow()).getTime() - durationToMs(lookback),
      );
      const recent = await db
        .select({
          properties: userEvents.properties,
          occurredAt: userEvents.occurredAt,
        })
        .from(userEvents)
        .where(
          and(
            eq(userEvents.userId, userId),
            eq(userEvents.event, event),
            gte(userEvents.occurredAt, since),
          ),
        )
        .orderBy(desc(userEvents.occurredAt))
        .limit(1);
      const row = recent[0];
      if (row) {
        const scalars = Object.fromEntries(
          Object.entries(row.properties ?? {}).filter(
            ([, v]) =>
              typeof v === "string" ||
              typeof v === "number" ||
              typeof v === "boolean" ||
              v === null,
          ),
        ) as NonNullable<WaitForEventResult["properties"]>;
        const occurredAt =
          row.occurredAt instanceof Date
            ? row.occurredAt.toISOString()
            : row.occurredAt
              ? String(row.occurredAt)
              : undefined;
        return {
          timedOut: false,
          properties: scalars,
          ...(occurredAt ? { occurredAt } : {}),
        };
      }
    }

    await enterWait(nodeId, "wait");

    // Wait for the user-scoped event or the timeout. The event branch filters on
    // the pushed payload's top-level `userId` (see `ingestEvent`); the SDK turns
    // the ms number into a Go duration string at serialization time.
    const result = await hatchetCtx.waitFor(
      Or(
        new UserEventCondition(
          event,
          `input.userId == ${celStringLiteral(userId)}`,
          "event",
        ),
        new SleepCondition(toSleepDuration(timeout), "timeout"),
      ),
    );

    // Discriminate on which branch's readableDataKey ("event"/"timeout") is
    // present. The eviction-capable path returns the `{ CREATE: { … } }`
    // envelope; the pre-eviction path returns the inner object UN-wrapped — so
    // strip an optional `CREATE` layer first to handle both shapes identically.
    const fired = (("CREATE" in result ? result.CREATE : result) ??
      {}) as Record<string, unknown>;
    const timedOut = !("event" in fired);

    // Surface the matched event's payload (best-effort). The engine returns
    // matches as `[{ id, data }]` where `data` is the pushed ingest payload
    // ({ userId, userEmail, properties }); the pre-eviction path may hand the
    // payload back un-wrapped — tolerate both, mirroring the CREATE-strip.
    let properties: WaitForEventResult["properties"];
    if (!timedOut) {
      const matches = fired.event;
      const first = Array.isArray(matches) ? matches[0] : matches;
      const payload =
        first && typeof first === "object" && "data" in first
          ? (first as { data?: unknown }).data
          : first;
      const candidate =
        payload && typeof payload === "object" && "properties" in payload
          ? (payload as { properties?: unknown }).properties
          : undefined;
      if (
        candidate &&
        typeof candidate === "object" &&
        !Array.isArray(candidate)
      ) {
        properties = candidate as NonNullable<WaitForEventResult["properties"]>;
      }
    }

    await resumeFromWait(nodeId, { timedOut });
    // Refresh the memoized clock snapshot so a `ctx.when` chain after this wait
    // reads a replay-stable instant (eviction engine) rather than the seed.
    await refreshNow();

    return { timedOut, ...(properties ? { properties } : {}) };
  };

  // Scan the digest window ONCE at flush: all `event` rows for THIS user in
  // [scanSince, flushInstant], Studio debug events excluded, capped at `cap`.
  // Pure read — no status flips, no writes — returning a self-consistent,
  // JSON-round-trip-safe DigestResult ready to be recorded set-once.
  const scanDigestWindow = async (opts: {
    event: string;
    scanSince: Date;
    flushInstant: Date;
    where: PropertyCondition[];
    cap: number;
  }): Promise<DigestResult> => {
    const { event, scanSince, flushInstant, where, cap } = opts;

    // Narrow the fetch so a chatty user emitting >LIMIT other same-name events
    // can't bury a match past the cutoff; the JS re-verify below is the verdict.
    const eqPreds = eqPushdownPreds(where);

    // Only the where-less path can trust the fetch as final, so `cap + 1` detects
    // truncation exactly there. ANY `where` re-verifies in JS below (the SQL fetch
    // is then a superset), so pull cap-relative headroom — sized to the cap, not a
    // flat 100, since the chatty-user trap scales with the digest cap.
    const fetchLimit = where.length === 0 ? cap + 1 : Math.min(cap * 10, 2000);

    const rows = await db
      .select({
        id: userEvents.id,
        properties: userEvents.properties,
        occurredAt: userEvents.occurredAt,
      })
      .from(userEvents)
      .where(
        and(
          eq(userEvents.userId, userId),
          eq(userEvents.event, event),
          gte(userEvents.occurredAt, scanSince),
          lte(userEvents.occurredAt, flushInstant),
          // Studio debug events must never pollute a customer digest; EVERY other
          // source (api, webhook source ids, connector ids, journey) is
          // deliberately included so the digest sees the full real event spine.
          sql`${userEvents.source} IS DISTINCT FROM 'studio'`,
          ...eqPreds,
        ),
      )
      // Deterministic tie-break for bulk backfills sharing a timestamp, so a
      // pre-record rescan on replay orders identically.
      .orderBy(asc(userEvents.occurredAt), asc(userEvents.id))
      .limit(fetchLimit);

    // Re-verify EVERY fetched row against the FULL predicate with the canonical
    // strict-equality engine whenever a `where` is present — the SQL eq pushdown
    // is a TEXT narrowing filter only, so a stored string "50" that SQL-matched
    // `.eq(50)` is rejected here, and an unpushdownable null-eq is matched here.
    const matched =
      where.length > 0
        ? rows.filter((row) =>
            evaluatePropertyConditions({
              conditions: where,
              properties: (row.properties ?? {}) as Record<string, unknown>,
            }),
          )
        : rows;

    const events: DigestEvent[] = matched.slice(0, cap).map((row) => ({
      properties: row.properties ? narrowScalars(row.properties) : null,
      occurredAt:
        row.occurredAt instanceof Date
          ? row.occurredAt.toISOString()
          : String(row.occurredAt),
    }));

    // Truncated when more matched than the cap OR the raw fetch itself hit its
    // ceiling (further matches may exist past the fetched slice).
    const truncated = matched.length > cap || rows.length >= fetchLimit;

    return {
      events,
      count: events.length,
      truncated,
      flushedAt: flushInstant.toISOString(),
    };
  };

  // Aggregate multiple trigger events over a fixed window into ONE execution.
  // Each numbered step is a replay-safety requirement — do NOT reorder them.
  const performDigest = async (opts: DigestOptions): Promise<DigestResult> => {
    // 1. VALIDATE — throw BEFORE any durable work (no db/hatchet touched yet).
    const eventName = opts.event ?? config.triggerEvent;
    if (!eventName) {
      throw new TypeError(
        "ctx.digest: no `event` given and the journey has no trigger event",
      );
    }
    const windowMs = durationToMs(opts.window);
    if (windowMs <= 0) {
      throw new RangeError("ctx.digest window must be a positive duration");
    }
    if (windowMs > MAX_WAIT_MS) {
      throw new RangeError(
        `ctx.digest window exceeds the journey execution limit (${JOURNEY_EXECUTION_TIMEOUT})`,
      );
    }
    const cap = Math.min(
      Math.max(1, opts.maxEvents ?? DIGEST_DEFAULT_MAX_EVENTS),
      DIGEST_MAX_EVENTS_CEILING,
    );
    const lookbackMs = durationToMs(opts.lookback ?? DIGEST_DEFAULT_LOOKBACK);
    const nodeId = opts.label ?? `digest:${eventName}`;
    // `where`: an explicit predicate wins; otherwise the trigger contract applies
    // ONLY when digesting the trigger event itself (FM-16), so a digest of the
    // journey's own trigger honors `trigger.where` without restating it.
    const where =
      opts.where !== undefined
        ? (normalizeWhere(opts.where) ?? [])
        : eventName === config.triggerEvent
          ? (config.triggerWhere ?? [])
          : [];

    // 2. REGISTER the site label — reusing a label in one run throws loudly (two
    // digests sharing a durable record would silently over-collapse). No-op
    // outside a durable run (a unit-test context has no boundary).
    registerRecordLabel(getJourneyBoundary(), nodeId);

    // 3. DEFINITION-INTERPLAY WARNINGS — warn-once per process per journeyId:nodeId.
    if (eventName === config.triggerEvent && config.entryLimit === "once") {
      const key = `${config.journeyId ?? ""}:${nodeId}:once`;
      if (!digestWarned.has(key)) {
        digestWarned.add(key);
        logger.warn(
          `ctx.digest: journey "${config.journeyId ?? nodeId}" has entryLimit ` +
            '"once" and digests its own trigger event — it digests exactly ONE ' +
            "window ever; trigger events after the first enrollment are dropped, " +
            'not digested. Use entryLimit "unlimited" for a rolling digest.',
        );
      }
    }
    if (
      config.entryLimit === "once_per_period" &&
      config.entryPeriod &&
      durationToMs(config.entryPeriod) > windowMs
    ) {
      const key = `${config.journeyId ?? ""}:${nodeId}:period`;
      if (!digestWarned.has(key)) {
        digestWarned.add(key);
        logger.warn(
          `ctx.digest: journey "${config.journeyId ?? nodeId}" entryPeriod is ` +
            "longer than the digest window — events arriving in the gap between " +
            "the flush and the next enrollment are absorbed but never digested " +
            "(an enrollment-gap loss band).",
        );
      }
    }

    // 4. DURABLE DEADLINE — DB-only read-first / set-once (issues NO durable
    // journal node: `compute` reads the seeded `latestNow` synchronously). The
    // deadline drives `scanSince`, the stranded-waiting alert, and observability
    // — it is NOT the sleep duration (see step 5). Never cleared; the result
    // record is the terminal mark. Flat `<label>:deadline` / `<label>:result`
    // subkeys keep set-once applying per subkey.
    const deadlineIso = await recordOnce({
      db,
      stateId,
      namespace: "__digest__",
      // Read the seeded memoized snapshot SYNCHRONOUSLY rather than awaiting
      // hatchetCtx.now(): recordOnce freezes this value (a replay reads the
      // recorded deadline back), so the live-clock read never diverges — AND it
      // adds no journal node inside a conditionally-executed compute (which a
      // replay would skip, misaligning the positional journal).
      key: `${nodeId}:deadline`,
      compute: () => new Date(latestNow.getTime() + windowMs).toISOString(),
    });
    const deadline = new Date(deadlineIso);

    // 5. SLEEP THE CONSTANT WINDOW — Hatchet's durable journal is POSITIONAL: on
    // a replay every durable call must be re-issued in the identical order with
    // identical args, and an already-fired node instant-resolves. So we ALWAYS
    // issue `performSleep(windowMs)` — never a remainder (`deadline − now`), whose
    // arg would drift ("87s" vs the journaled "120s") and trip the determinism
    // checker (the exact live-smoke kill). Since `deadline := latestNow + windowMs`
    // and the memoized seed returns the same `latestNow`, the duration is byte-
    // identical every replay. A mid-window re-dispatch re-issues the same sleep and
    // BLOCKS on the original server-side deadline; a post-fire replay instant-
    // resolves. performSleep's enterWait/resumeFromWait lifecycle IS the terminal
    // backstop (exitOn flipped the row terminal → 0 rows → JourneyExitedError),
    // and it advances the boundary label + refreshes the memoized clock.
    //
    // ACCEPTED SEMANTIC: if a crash lands between recording the deadline and this
    // sleep being journaled, the re-dispatch arms a FRESH full window from then —
    // the collection period extends by the crash gap. Rare and harmless (the scan
    // window simply collects more), and the price of journal determinism.
    await performSleep(windowMs, nodeId);

    // 6. FLUSH ONCE, RECORD ONCE — `flushInstant` is issued here on EVERY replay
    // (positionally stable, right after the sleep), scanning up to it (NOT the
    // deadline: a straggler landing during wake latency is still in-window;
    // anything after belongs to the documented straggler band). On a replay-after-
    // flush recordOnce's READ-FIRST returns the recorded result verbatim WITHOUT
    // re-running the scan — the verbatim-replay guarantee lives entirely in
    // recordOnce now (peek fast path removed). The read-back also means a zombie
    // double-writer returns the FIRST-committed snapshot.
    const flushInstant = await refreshNow();
    const scanSince = new Date(deadline.getTime() - windowMs - lookbackMs);
    return recordOnce({
      db,
      stateId,
      namespace: "__digest__",
      key: `${nodeId}:result`,
      compute: () =>
        scanDigestWindow({
          event: eventName,
          scanSince,
          flushInstant,
          where,
          cap,
        }),
    });
  };

  // Advisory, RECORDED-once frequency check the author branches on. The verdict
  // is frozen into the state row the FIRST time this site runs and replayed
  // verbatim thereafter: a live re-count on replay is guaranteed to diverge
  // because the run's OWN send lands in the counting window (check allowed →
  // send → crash → replay re-counts → now blocked → different branch → different
  // template → different idempotency key — the exact divergence class this
  // engine's replay-safety design forbids). recordOnce under `__throttle__`
  // gives that durability on ANY engine; countRecentSends is the SAME COUNT the
  // mailer-level cap enforces on, keyed by recipient EMAIL (userId is NOT the
  // cap key), so advisory and enforcement agree on what they count.
  const performThrottle = async (
    opts: ThrottleOptions,
  ): Promise<ThrottleResult> => {
    // 1. VALIDATE — throw BEFORE any durable work (no db/hatchet touched yet).
    if (!Number.isInteger(opts.limit) || opts.limit < 1) {
      throw new RangeError("ctx.throttle limit must be an integer >= 1");
    }
    const windowMs = durationToMs(opts.window);
    if (windowMs <= 0) {
      throw new RangeError("ctx.throttle window must be a positive duration");
    }

    // 2. SITE — the same "site" rule the send auto-keys use: explicit label ??
    // nearest authored wait label ?? "start" (outside any wait).
    const site = opts.label ?? getJourneyBoundary()?.currentLabel ?? "start";

    // 3. REGISTER + DERIVE KEY. The `throttle:` prefix keeps throttle sites from
    // colliding with digest labels in the shared boundary label set; the key
    // folds in category + limit/window so two DISTINCT throttle configs at one
    // site don't share a record. Reusing a label throws the loud collision error
    // (pass a distinct `label` to re-check).
    const key = `${site}:${opts.category ?? "*"}:${opts.limit}/${windowMs}`;
    registerRecordLabel(getJourneyBoundary(), `throttle:${key}`);

    // 4. RECORD ONCE — the verdict is computed on the first winning writer and
    // replayed verbatim after (recordOnce's read-back means a zombie
    // double-writer returns the first-committed verdict too).
    return recordOnce({
      db,
      stateId,
      namespace: "__throttle__",
      key,
      compute: async () => {
        // Read `latestNow` SYNCHRONOUSLY — never `await refreshNow()` (a memo).
        // This compute is conditionally executed (a replay with a recorded
        // verdict skips it), so a memo inside it would misalign the POSITIONAL
        // journal for every durable call after. With this, ctx.throttle issues
        // ZERO durable calls — it is positionally invisible.
        const since = new Date(latestNow.getTime() - windowMs);
        const count = await countRecentSends({
          db,
          to: userEmail,
          since,
          ...(opts.category ? { category: opts.category } : {}),
        });
        return {
          allowed: count < opts.limit,
          count,
          remaining: Math.max(0, opts.limit - count),
        };
      },
    });
  };

  return {
    when: createWhenBuilder({
      timezone: resolvedTimezone,
      window: defaultSendWindow,
      ifPast: "next",
      // `ctx.when` resolves instants synchronously per chain, so it reads the
      // memoized clock through a cached snapshot refreshed on each access. The
      // memoized DurableContext.now() returns the SAME Date across replays, so a
      // synchronous read of the latest resolved value is replay-stable; a
      // pre-eviction fallback uses the live clock (best-effort, unchanged today).
      now: () => latestNow,
    }),

    async sleep({ duration, label }) {
      return performSleep(
        duration,
        label ?? `wait:${JSON.stringify(duration)}`,
      );
    },

    async sleepUntil(at, opts) {
      const target = at instanceof Date ? at.getTime() : new Date(at).getTime();
      if (Number.isNaN(target)) {
        throw new TypeError("sleepUntil: invalid date");
      }

      // Compute the wake delay ONCE off the memoized clock. Durability comes
      // from Hatchet preserving the deadline across replays/restarts; a past
      // instant gives ms = 0. Reading the memoized now keeps the recomputed delta
      // replay-stable on an eviction engine.
      const ms = Math.max(0, target - (await refreshNow()).getTime());
      return performSleep(
        ms,
        opts?.label ?? `wait-until:${new Date(target).toISOString()}`,
      );
    },

    async waitForEvent({ event, timeout, label, lookback, where }) {
      return performWaitForEvent(
        event,
        timeout,
        label ?? `wait-event:${event}`,
        lookback,
        normalizeWhere(where),
      );
    },

    async checkpoint(label) {
      const prior = getJourneyBoundary()?.currentLabel;
      // A checkpoint also advances the "site" the next side effect inherits.
      setBoundaryLabel(label);
      await db
        .update(journeyStates)
        .set({ currentNodeId: label, updatedAt: new Date() })
        .where(eq(journeyStates.id, stateId));

      // Fire-and-forget checkpoint transition (best-effort; never throws).
      logTransition({
        db,
        journeyStateId: stateId,
        from: prior && prior !== label ? prior : null,
        to: label,
        action: "checkpoint",
      });
    },

    async trigger({
      event,
      userId: targetUserId,
      userEmail: targetEmail,
      properties,
      idempotencyLabel,
    }) {
      // Keep the PUBLIC `TriggerOptions.properties` field name (decision #13 —
      // renaming it would break consumer journeys + scaffold). Map it to the
      // engine-internal `eventProperties` bag here; no `contactProperties` by
      // default (a future `TriggerOptions.contactProperties` is deferred).
      //
      // EXACTLY-ONCE across a durable replay: when inside a journey run, derive a
      // deterministic key (`journeyTrigger:<runAnchor>:<site>:<event>`) so a
      // replay re-pushing this trigger is a no-op. `site` = explicit `idempotencyLabel`
      // ?? the nearest authored wait label ?? the event name. ingestEvent inserts
      // user_events with onConflictDoNothing on the idempotencyKey index and
      // returns early on a duplicate, so NONE of the Hatchet push, checkExits,
      // contact upsert, or analytics alias re-fire. Layer 1 (memoize) skips the
      // ingest call entirely before the DB is touched when eviction is live.
      const boundary = getJourneyBoundary();
      let idempotencyKey: string | undefined;
      if (boundary) {
        const site = idempotencyLabel ?? boundary.currentLabel ?? event;
        idempotencyKey = deriveJourneyKey({
          kind: "trigger",
          anchor: boundary.runAnchor,
          site,
          discriminant: event,
        });
        registerKey(boundary, idempotencyKey);
      }

      const runIngest = () =>
        ingestEvent({
          db,
          registry,
          hatchet,
          logger,
          event: {
            event,
            userId: targetUserId,
            userEmail: targetEmail ?? userEmail,
            eventProperties: properties ?? {},
            // Cross-journey trigger (ctx.trigger).
            source: "journey",
            ...(idempotencyKey ? { idempotencyKey } : {}),
          },
        });

      if (boundary && idempotencyKey) {
        await boundary.memoize([idempotencyKey], runIngest);
      } else {
        await runIngest();
      }

      // Fire-and-forget trigger transition (best-effort; never throws). Inside
      // the exactly-once path, so a replay re-logs — acceptable for a timeline.
      // `to` mirrors the graph's trigger node id (`trigger:<event>`).
      logTransition({
        db,
        journeyStateId: stateId,
        from: boundary?.currentLabel ?? null,
        to: `trigger:${event}`,
        action: "trigger",
        detail: { event },
      });
    },

    async exit(reason?: string): Promise<never> {
      // Terminal "exited": a guarded flip (never clobber an already-terminal
      // row) plus the SAME JourneyExitedError control-flow signal a mid-wait
      // exitOn raises — the run lifecycle maps it to { status: "exited" } with
      // no "failed"/"completed" write and no journey:* event. This is the
      // single mechanism the blueprint interpreter's end-exited node drives too
      // (and the form promote-to-code emits), so there is one path, not two.
      const now = new Date();
      const [exited] = await db
        .update(journeyStates)
        .set({ status: "exited", exitedAt: now, updatedAt: now })
        .where(
          and(
            eq(journeyStates.id, stateId),
            notInArray(journeyStates.status, [...TERMINAL_STATUSES]),
          ),
        )
        .returning({ id: journeyStates.id });
      if (exited) {
        // Fire-and-forget exit transition (best-effort; never affects the run).
        logTransition({
          db,
          journeyStateId: stateId,
          from: getJourneyBoundary()?.currentLabel ?? null,
          to: "end-exited",
          action: "exited",
          ...(reason ? { detail: { reason } } : {}),
        });
      }
      throw new JourneyExitedError(stateId);
    },

    async now() {
      return refreshNow();
    },

    async once<T>(key: string, compute: () => Promise<T> | T): Promise<T> {
      // Durable, engine-agnostic record-once. Delegated to the standalone
      // `recordOnce` (shared with the digest/throttle primitives + the mailer):
      // read-first fast path, FIRST-writer-wins jsonb merge under the reserved
      // `__once__` namespace, read-back return so a zombie double-writer cannot
      // clobber the value the winner already handed to author code.
      return recordOnce({ db, stateId, namespace: "__once__", key, compute });
    },

    digest(opts) {
      return performDigest(opts);
    },

    throttle(opts) {
      return performThrottle(opts);
    },

    guard: {
      async isSubscribed() {
        const prefs = await checkEmailPreferences({ db, userId });
        return !prefs.unsubscribed;
      },
    },

    history: {
      async hasEvent({ userId: targetUserId, event, within }) {
        const result = await evaluateEventCondition({
          condition: {
            type: "event",
            eventName: event,
            check: "exists",
            within,
          },
          ctx: { db, userId: targetUserId, journeyContext },
        });
        return { found: result.matched, count: result.count };
      },

      async journey({ userId: targetUserId, journeyId: targetJourneyId }) {
        const [result] = await db
          .select({
            entryCount: count(),
            lastCompletedAt: max(journeyStates.completedAt),
          })
          .from(journeyStates)
          .where(
            and(
              eq(journeyStates.userId, targetUserId),
              eq(journeyStates.journeyId, targetJourneyId),
            ),
          );

        return {
          completed: result?.lastCompletedAt !== null,
          lastCompletedAt:
            result?.lastCompletedAt instanceof Date
              ? result.lastCompletedAt.toISOString()
              : null,
          entryCount: result?.entryCount ?? 0,
        };
      },

      async email({ email: targetEmail, template }) {
        const [result] = await db
          .select({
            count: count(),
            lastSentAt: max(emailSends.sentAt),
          })
          .from(emailSends)
          .where(
            and(
              eq(emailSends.toEmail, targetEmail),
              eq(emailSends.templateKey, template),
            ),
          );

        const total = result?.count ?? 0;
        return {
          sent: total > 0,
          lastSentAt:
            result?.lastSentAt instanceof Date
              ? result.lastSentAt.toISOString()
              : null,
          count: total,
        };
      },

      async sms({ phone, template }) {
        const [result] = await db
          .select({
            count: count(),
            lastSentAt: max(smsSends.sentAt),
          })
          .from(smsSends)
          .where(
            and(
              eq(smsSends.toPhone, phone),
              eq(smsSends.templateKey, template),
            ),
          );

        const total = result?.count ?? 0;
        return {
          sent: total > 0,
          lastSentAt:
            result?.lastSentAt instanceof Date
              ? result.lastSentAt.toISOString()
              : null,
          count: total,
        };
      },

      async events({
        userId: targetUserId,
        event,
        limit = 50,
        within,
      }): Promise<RecentEvent[]> {
        const conditions = [eq(userEvents.userId, targetUserId)];
        if (event) {
          conditions.push(eq(userEvents.event, event));
        }
        if (within) {
          const since = new Date(
            (await refreshNow()).getTime() - durationToMs(within),
          );
          conditions.push(gte(userEvents.occurredAt, since));
        }
        const rows = await db
          .select({
            event: userEvents.event,
            properties: userEvents.properties,
            occurredAt: userEvents.occurredAt,
          })
          .from(userEvents)
          .where(and(...conditions))
          .orderBy(desc(userEvents.occurredAt))
          .limit(limit);
        return rows.map((row) => ({
          event: row.event,
          properties: row.properties ?? null,
          occurredAt:
            row.occurredAt instanceof Date
              ? row.occurredAt.toISOString()
              : String(row.occurredAt),
        }));
      },
    },
  };
}
