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
import { durationToMs, evaluateEventCondition } from "@hogsend/core";
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
  IfPast,
  JourneyContext,
  RecentEvent,
  TimeOfDayBuilder,
  WaitForEventResult,
  Weekday,
  WhenBuilder,
} from "@hogsend/core/types";
import {
  type Database,
  emailSends,
  journeyStates,
  userEvents,
} from "@hogsend/db";
import { and, count, desc, eq, gte, max, notInArray, sql } from "drizzle-orm";
import { checkEmailPreferences } from "../lib/enrollment-guards.js";
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
} from "./journey-boundary.js";

/** Journey statuses that are terminal — a journey in any of these must never be
 * resurrected back to "active" by a wait resuming. Exported so the durable task
 * runner can avoid clobbering a terminal row to "failed" on a cancel. */
export const TERMINAL_STATUSES = ["completed", "failed", "exited"] as const;

/** Upper bound for a `waitForEvent` timeout — the journey task's executionTimeout. */
const MAX_WAIT_MS = durationToMs({ hours: JOURNEY_EXECUTION_TIMEOUT_HOURS });

/**
 * Quote a string as a CEL single-quoted string literal, escaping backslashes
 * then single quotes. Used to embed an externally-supplied userId into a CEL
 * filter expression without breaking it or allowing injection.
 */
function celStringLiteral(value: string): string {
  return `'${value.replace(/\\/g, "\\\\").replace(/'/g, "\\'")}'`;
}

interface JourneyContextConfig {
  db: Database;
  hatchet: HatchetClient;
  hatchetCtx: {
    // Hatchet's real `sleepFor` accepts a number (milliseconds) in addition to
    // duration strings/objects; we use the number-ms form for `sleepUntil`.
    sleepFor: (duration: DurationObject | number) => Promise<unknown>;
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
  const enterWait = async (nodeId: string): Promise<void> => {
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
  };

  // Resume from a durable wait: flip "waiting" → "active", but ONLY if the row
  // is still "waiting". If an exit/cancel landed during the wait the row is no
  // longer "waiting" — abort instead of reviving a terminated journey to active
  // (which would let a post-wait side effect fire after the journey exited).
  const resumeFromWait = async (): Promise<void> => {
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
  };

  // Durable sleep with the guarded waiting → active lifecycle. `sleep` passes a
  // DurationObject; `sleepUntil` passes a precomputed ms delay — Hatchet's
  // `sleepFor` accepts both.
  const performSleep = async (
    durationOrMs: DurationObject | number,
    nodeId: string,
  ): Promise<{ sleptAt: string; resumedAt: string }> => {
    const sleptAt = new Date().toISOString();
    await enterWait(nodeId);
    await hatchetCtx.sleepFor(durationOrMs);
    const resumedAt = new Date().toISOString();
    await resumeFromWait();
    // Refresh the memoized clock snapshot so a `ctx.when` chain used right after
    // this wait reads a replay-stable instant (on an eviction engine) instead of
    // the construction-time seed — see `latestNow`.
    await refreshNow();
    // The just-finished wait's label is the "site" the next side effect inherits.
    setBoundaryLabel(nodeId);
    return { sleptAt, resumedAt };
  };

  // Durably wait for THIS user's `event` OR `timeout`, whichever fires first,
  // sharing the same guarded lifecycle as `performSleep`.
  const performWaitForEvent = async (
    event: string,
    timeout: DurationObject,
    nodeId: string,
    lookback?: DurationObject,
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
    // of which path (lookback hit / event / timeout) resolves it.
    setBoundaryLabel(nodeId);

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

    await enterWait(nodeId);

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
        new SleepCondition(durationToMs(timeout), "timeout"),
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

    await resumeFromWait();
    // Refresh the memoized clock snapshot so a `ctx.when` chain after this wait
    // reads a replay-stable instant (eviction engine) rather than the seed.
    await refreshNow();

    return { timedOut, ...(properties ? { properties } : {}) };
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

    async waitForEvent({ event, timeout, label, lookback }) {
      return performWaitForEvent(
        event,
        timeout,
        label ?? `wait-event:${event}`,
        lookback,
      );
    },

    async checkpoint(label) {
      // A checkpoint also advances the "site" the next side effect inherits.
      setBoundaryLabel(label);
      await db
        .update(journeyStates)
        .set({ currentNodeId: label, updatedAt: new Date() })
        .where(eq(journeyStates.id, stateId));
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
    },

    async now() {
      return refreshNow();
    },

    async once<T>(key: string, compute: () => Promise<T> | T): Promise<T> {
      // DB-backed record-once, durable on ANY engine. Read the current state
      // row's context; if this key was already recorded (an earlier run of this
      // enrollment, or a replay-from-top), return the stored value WITHOUT
      // re-running `compute`. Otherwise compute, persist under the reserved
      // `__once__` namespace, and return. The persist uses a jsonb merge keyed on
      // a PARAMETERIZED path so an attacker-controlled `key` cannot inject SQL,
      // and so a concurrent `checkpoint`/`once` write to a different path is not
      // clobbered.
      const read = async (): Promise<Record<string, unknown>> => {
        const row = await db.query.journeyStates.findFirst({
          where: eq(journeyStates.id, stateId),
          columns: { context: true },
        });
        const ctxBag = (row?.context ?? {}) as Record<string, unknown>;
        return (ctxBag.__once__ ?? {}) as Record<string, unknown>;
      };

      const onceBag = await read();
      if (Object.hasOwn(onceBag, key)) {
        return onceBag[key] as T;
      }

      const value = await compute();
      // Persist under context.__once__.<key>. NOTE jsonb_set with
      // create_missing=true cannot create a NESTED key whose parent object is
      // absent (a fresh '{}' has no '__once__'), so we set the TOP-LEVEL
      // '__once__' to (its existing bag) MERGED with the single new key via `||`.
      // This creates '__once__' when missing AND preserves sibling once-keys.
      // `key` and the value are bound parameters (jsonb_build_object), so the
      // write is injection-safe.
      await db
        .update(journeyStates)
        .set({
          context: sql`jsonb_set(
            coalesce(${journeyStates.context}, '{}'::jsonb),
            '{__once__}',
            coalesce(${journeyStates.context} -> '__once__', '{}'::jsonb)
              || jsonb_build_object(${key}::text, ${JSON.stringify(value ?? null)}::jsonb),
            true
          )`,
          updatedAt: new Date(),
        })
        .where(eq(journeyStates.id, stateId));
      return value;
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

      async events({
        userId: targetUserId,
        limit = 50,
        within,
      }): Promise<RecentEvent[]> {
        const conditions = [eq(userEvents.userId, targetUserId)];
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
