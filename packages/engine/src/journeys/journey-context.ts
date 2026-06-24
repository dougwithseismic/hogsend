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
import { and, count, desc, eq, gte, max, notInArray } from "drizzle-orm";
import { checkEmailPreferences } from "../lib/enrollment-guards.js";
import { ingestEvent } from "../lib/ingestion.js";
import type { Logger } from "../lib/logger.js";
import {
  JOURNEY_EXECUTION_TIMEOUT,
  JOURNEY_EXECUTION_TIMEOUT_HOURS,
} from "./constants.js";
import { JourneyExitedError } from "./errors.js";

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
}): WhenBuilder {
  const baseOpts = () => ({
    timezone: opts.timezone,
    now: new Date(),
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

    // Optional lookback: the durable wait only matches events pushed AFTER it
    // is established, so an answer landing in the gap (between a send and its
    // wait, or between two back-to-back waits) would otherwise be permanently
    // unobservable — its first-answer idempotency key is already claimed and
    // can never re-push. A recent matching user_events row resolves the wait
    // immediately, payload included.
    if (lookback) {
      const since = new Date(Date.now() - durationToMs(lookback));
      const recent = await db
        .select({ properties: userEvents.properties })
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
        return { timedOut: false, properties: scalars };
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

    return { timedOut, ...(properties ? { properties } : {}) };
  };

  return {
    when: createWhenBuilder({
      timezone: resolvedTimezone,
      window: defaultSendWindow,
      ifPast: "next",
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

      // Compute the wake delay ONCE. Durability comes from Hatchet preserving
      // the deadline across replays/restarts; a past instant gives ms = 0.
      const ms = Math.max(0, target - Date.now());
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
    }) {
      // Keep the PUBLIC `TriggerOptions.properties` field name (decision #13 —
      // renaming it would break consumer journeys + scaffold). Map it to the
      // engine-internal `eventProperties` bag here; no `contactProperties` by
      // default (a future `TriggerOptions.contactProperties` is deferred).
      await ingestEvent({
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
        },
      });
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
          const since = new Date(Date.now() - durationToMs(within));
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
