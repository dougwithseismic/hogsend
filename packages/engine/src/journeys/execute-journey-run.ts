import type { Conditions } from "@hatchet-dev/typescript-sdk/v1/index.js";
import type { JsonValue } from "@hatchet-dev/typescript-sdk/v1/types.js";
import {
  type DurationObject,
  durationToMs,
  evaluatePropertyConditions,
} from "@hogsend/core";
import type {
  JourneyMeta,
  JourneyRunFn,
  JourneyUser,
} from "@hogsend/core/types";
import {
  contacts,
  type Database,
  journeyConfigs,
  journeyStates,
} from "@hogsend/db";
import { and, eq, inArray, notInArray, sql } from "drizzle-orm";
import { getAnalytics } from "../lib/analytics-singleton.js";
import { blueprintGraphLock } from "../lib/blueprint-lock.js";
import { getDb } from "../lib/db.js";
import {
  checkEmailPreferences,
  checkEntryLimit,
} from "../lib/enrollment-guards.js";
import { hatchet } from "../lib/hatchet.js";
import { isHeldOut } from "../lib/holdout.js";
import { ingestEvent } from "../lib/ingestion.js";
import { createLogger } from "../lib/logger.js";
import { emitOutbound } from "../lib/outbound.js";
import { resolveTimezoneWithSource } from "../lib/timezone.js";
import { getClientScheduleDefaults } from "./client-defaults-singleton.js";
import { JourneyExitedError } from "./errors.js";
import {
  createMemoize,
  type JourneyBoundary,
  runWithJourneyBoundary,
  supportsEviction,
} from "./journey-boundary.js";
import { createJourneyContext, TERMINAL_STATUSES } from "./journey-context.js";
import { logTransition } from "./journey-log.js";
import { getJourneyRegistrySingleton } from "./registry-singleton.js";

const logger = createLogger(process.env.LOG_LEVEL);

/**
 * Log whether Hatchet's durable `memo` (Layer-1 fast path) is actually durable
 * on this engine — ONCE per worker process. `supportsEviction === false`
 * (hatchet-lite < v0.80.0) means `memo` silently no-ops, so Layer 2 (the
 * Postgres `email_sends`/`user_events` unique-index dedup) is the sole live
 * guarantee. Surfaced at boot so the team knows which layer is carrying the load.
 */
let evictionSupportLogged = false;
function logEvictionSupportOnce(hatchetCtx: unknown): void {
  if (evictionSupportLogged) return;
  evictionSupportLogged = true;
  const live = supportsEviction(hatchetCtx);
  logger.info(
    live
      ? "journey replay-safety: Layer-1 memo fast path is LIVE (engine supports eviction)"
      : "journey replay-safety: Layer-1 memo is INERT (engine < v0.80.0); " +
          "exactly-once relies on the Layer-2 Postgres unique-index dedup",
  );
}

/** The event payload a journey durable task receives from `hatchet.events.push`. */
export interface EventPayloadInput {
  userId: JsonValue;
  userEmail: JsonValue;
  properties: JsonValue;
  [key: string]: JsonValue;
}

/**
 * The structural slice of Hatchet's `DurableContext` the journey run lifecycle
 * needs. The real SDK context satisfies it; tests pass a stub. Mirrors the
 * shape `createJourneyContext` documents (sleepFor/waitFor normalization,
 * memoized `now`), plus the run-id anchor and the abort signal the
 * shutdown-release path reads.
 */
export interface JourneyDurableCtx {
  /** Replay-stable id of THIS logical durable run (see runAnchor below). */
  workflowRunId: () => string;
  sleepFor: (
    duration: DurationObject | number | `${number}s`,
  ) => Promise<unknown>;
  waitFor: (
    conditions: Conditions | Conditions[],
  ) => Promise<Record<string, unknown>>;
  /** Replay-memoized clock (SDK >= 1.22.3); optional so stubs fall back live. */
  now?: () => Promise<Date>;
  /** Aborted when the worker releases the run (graceful shutdown). */
  abortController?: { signal?: { aborted?: boolean } };
}

/** The `journey_states` row an enrollment insert returns. */
export type JourneyStateRow = typeof journeyStates.$inferSelect;

/**
 * Insert the enrollment row, tolerating the partial-unique-index race.
 *
 * The active-state read guard in the run lifecycle (a `findFirst` over the live
 * statuses) is NOT atomic with this insert: two near-simultaneous FIRST events
 * for the same (user, journey) — a burst, which is the digest primitive's whole
 * target workload — can BOTH clear that guard and race here. The loser would
 * otherwise hit the `uq_user_journey_active` partial unique index with a raw
 * 23505 that escapes the task fn (durable tasks run with `retries: 0`) and
 * surfaces as a FAILED Hatchet run. `onConflictDoNothing` against that index
 * absorbs the loser, returning `undefined` (0 rows) — the SAME outcome the read
 * guard produces, so the caller maps it to the `already_active` skip.
 *
 * DRIZZLE GOTCHA (from prior prod debugging in this repo — mirrors
 * campaigns/reconcile.ts): for a PARTIAL unique index the arbiter predicate goes
 * in `where`, NOT `targetWhere`. A `targetWhere` is silently ignored and
 * Postgres then throws 42P10 ("no unique or exclusion constraint matching the ON
 * CONFLICT specification") at runtime. The `where` reproduces the index
 * predicate (`status IN ('active','waiting')`) EXACTLY — see
 * journey-states.ts:uq_user_journey_active.
 */
export async function insertEnrollment(opts: {
  db: Database;
  userId: string;
  userEmail: string;
  journeyId: string;
  context: Record<string, unknown>;
  hatchetRunId?: string;
  /**
   * Blueprint runs serialize this insert against a concurrent GRAPH EDIT via a
   * transaction-scoped advisory lock — `updateBlueprint` takes the SAME lock
   * ({@link blueprintGraphLock}) around its in-flight count + guarded update,
   * so an enrollment cannot become active/waiting in the window between that
   * count and update. Code journeys have no mutable graph, so they insert
   * lock-free (the default).
   */
  serializeWithGraphLock?: boolean;
}): Promise<JourneyStateRow | undefined> {
  const values = {
    userId: opts.userId,
    userEmail: opts.userEmail,
    journeyId: opts.journeyId,
    currentNodeId: "start",
    status: "active" as const,
    context: opts.context,
    hatchetRunId: opts.hatchetRunId,
  };
  const onConflict = {
    target: [journeyStates.userId, journeyStates.journeyId],
    where: sql`status IN ('active', 'waiting')`,
  };

  if (!opts.serializeWithGraphLock) {
    const [row] = await opts.db
      .insert(journeyStates)
      .values(values)
      .onConflictDoNothing(onConflict)
      .returning();
    return row;
  }

  return opts.db.transaction(async (tx) => {
    await tx.execute(blueprintGraphLock(opts.journeyId));
    const [row] = await tx
      .insert(journeyStates)
      .values(values)
      .onConflictDoNothing(onConflict)
      .returning();
    return row;
  });
}

export interface ExecuteJourneyRunOptions {
  /**
   * The journey's resolved meta. For a code journey this is `defineJourney`'s
   * normalized `JourneyMeta`; for a blueprint it is built from the
   * `journey_blueprints` row (same shape — that is the whole point: the
   * enrollment guards below receive it verbatim, spec §6).
   */
  meta: JourneyMeta;
  /** The run body — a code journey's `run` or the blueprint tree-walk. */
  run: JourneyRunFn;
  /** The Hatchet event payload the durable task received. */
  input: EventPayloadInput;
  /** The Hatchet `DurableContext` (or a structural stub in tests). */
  hatchetCtx: JourneyDurableCtx;
  /**
   * Extra keys merged into the enrollment row's `context` jsonb on FIRST entry
   * (a replay recovers the existing row and never re-writes it). The blueprint
   * interpreter pins `__blueprintVersion` here (spec §12).
   */
  extraContext?: Record<string, unknown>;
  /**
   * Serialize the enrollment insert against a concurrent blueprint graph edit
   * with a transaction-scoped advisory lock (spec §12). Set by the blueprint
   * interpreter — the blueprint id IS the journeyId, so the lock key matches
   * `updateBlueprint`'s. Code journeys leave it unset (no mutable graph).
   */
  serializeEnrollment?: boolean;
  /**
   * Serialize a run failure into `journeyStates.errorMessage`. Defaults to the
   * error's message; the blueprint interpreter writes the structured
   * `{ blueprintId, nodeId, message }` JSON instead (spec §6.1).
   */
  serializeError?: (err: unknown) => string;
}

export type ExecuteJourneyRunResult =
  | { status: "skipped"; reason: string }
  | { stateId: string; status: "completed" | "exited" };

/**
 * The full journey durable-run lifecycle, shared VERBATIM by `defineJourney`
 * tasks and the blueprint interpreter: replay recovery by run id → enrollment
 * guards (entry only) → enrollment insert → timezone resolve → journey context
 * + replay-safety boundary → `run()` → terminal transitions (completed /
 * exited / released / failed). Extracted from `defineJourney` so the blueprint
 * interpreter executes through the IDENTICAL machinery instead of a parallel
 * reimplementation (spec §6) — behavior for code journeys is unchanged.
 */
export async function executeJourneyRun(
  options: ExecuteJourneyRunOptions,
): Promise<ExecuteJourneyRunResult> {
  const { meta, input, hatchetCtx } = options;
  const db = getDb();
  const userId = input.userId as string;
  const userEmail = input.userEmail as string;
  const properties = (input.properties ?? {}) as Record<
    string,
    string | number | boolean | null
  >;

  // The replay-stable anchor for this enrollment: the Hatchet run id is
  // preserved across replays of the SAME logical durable run (crash / OOM /
  // eviction / redeploy mid-run), whereas a freshly-minted journeyStates.id
  // is not. Both dedup-key derivation AND the enrollment-recovery below key
  // on it so a replay re-derives the SAME stateId and the SAME keys.
  const workflowRunId = hatchetCtx.workflowRunId();

  // REPLAY RECOVERY — must run BEFORE the enrollment guards below. An
  // eviction-capable Hatchet engine (hatchet-lite >= v0.80.0) replays the fn
  // from the top on every durable-wait resume, so every statement above the
  // first durable primitive re-runs on each resume. The enrollment guards
  // (entryLimit / preferences / trigger conditions / enabled / active-state)
  // are ENTRY gates: re-running them on a resume is wrong. In particular a
  // `once` journey's own entry-limit guard would find the row it created on
  // first entry and skip EVERY resume, stranding the journey in `waiting` and
  // silently dropping all sends after the first. Recovering by the run-stable
  // id first lets a resume reuse its enrollment and bypass the entry gates (a
  // resume is not an entry). It also keeps the original purpose: a journey
  // whose prior enrollment reached a TERMINAL status (unlimited /
  // once_per_period) recovers the SAME stateId so derived keys still collide.
  const recovered = workflowRunId
    ? await db.query.journeyStates.findFirst({
        where: and(
          eq(journeyStates.hatchetRunId, workflowRunId),
          eq(journeyStates.journeyId, meta.id),
        ),
      })
    : undefined;

  let state = recovered;

  // FIRST ENTRY ONLY — the enrollment guards gate ENTRY, not resume. A
  // recovered enrollment already passed them on first entry, so it skips
  // straight to resuming the run. (Sends inside `run` still re-check
  // subscription via `ctx.guard.isSubscribed()` after every wait, so
  // bypassing the entry-time preference gate never emails an unsubscriber.)
  if (!state) {
    if (!meta.enabled) {
      return { status: "skipped", reason: "journey_disabled" };
    }

    const configOverride = await db.query.journeyConfigs.findFirst({
      where: eq(journeyConfigs.journeyId, meta.id),
    });
    if (configOverride && !configOverride.enabled) {
      return { status: "skipped", reason: "journey_disabled_by_admin" };
    }

    if (meta.trigger.where?.length) {
      if (
        !evaluatePropertyConditions({
          conditions: meta.trigger.where,
          properties,
        })
      ) {
        return { status: "skipped", reason: "trigger_conditions_not_met" };
      }
    }

    const entryAllowed = await checkEntryLimit({
      db,
      journey: meta,
      userId,
    });
    if (!entryAllowed.allowed) {
      return {
        status: "skipped",
        reason: entryAllowed.reason ?? "entry_limit",
      };
    }

    const prefs = await checkEmailPreferences({ db, userId });
    if (prefs.unsubscribed) {
      return { status: "skipped", reason: "user_unsubscribed" };
    }

    // HOLDOUT DIVERSION (impact plan §4.1) — deliberately LAST in the guard
    // chain: a contact who'd have been blocked by any gate above is never
    // counted as held out (intent-to-treat — the control must mirror the
    // would-have-entered population, not the triggered one). Assignment is a
    // deterministic hash (replay law: no RNG in durable paths), so the same
    // contact diverts identically on every trigger AND every replay. One
    // held_out row per (user, journey), ever; the spine event's idempotency
    // key carries the same once-ever semantics for fan-out/analytics.
    if (meta.holdout && meta.holdout.percent > 0) {
      const diverted = isHeldOut({
        userId,
        journeyId: meta.id,
        percent: meta.holdout.percent,
        salt: meta.holdout.salt,
      });
      if (diverted) {
        const priorHoldout = await db.query.journeyStates.findFirst({
          where: and(
            eq(journeyStates.userId, userId),
            eq(journeyStates.journeyId, meta.id),
            eq(journeyStates.status, "held_out"),
          ),
        });
        if (!priorHoldout) {
          const heldOutAt = new Date();
          const inserted = await db
            .insert(journeyStates)
            .values({
              userId,
              userEmail,
              journeyId: meta.id,
              currentNodeId: "held-out",
              status: "held_out",
              context: properties,
              exitedAt: heldOutAt,
            })
            .returning({ id: journeyStates.id });
          const holdoutStateId = inserted[0]?.id;
          if (holdoutStateId) {
            // The counterfactual as data (the Iterable Send Skip pattern):
            // queryable on the spine, fan-out-able to journeys/destinations.
            // Once-ever per (user, journey) via the idempotency key — a
            // concurrent double-diversion dedups here even if it raced the
            // row existence check above.
            try {
              await ingestEvent({
                db,
                registry: getJourneyRegistrySingleton(),
                hatchet,
                logger,
                event: {
                  event: "journey.heldout",
                  userId,
                  userEmail,
                  eventProperties: {
                    journeyId: meta.id,
                    journeyName: meta.name,
                    holdoutPercent: meta.holdout.percent,
                  },
                  source: "journey",
                  idempotencyKey: `journey:heldout:${meta.id}:${userId}`,
                },
              });
            } catch (err) {
              logger.warn("journey.heldout ingest failed", {
                journeyId: meta.id,
                userId,
                error: err instanceof Error ? err.message : String(err),
              });
            }
            void emitOutbound({
              db,
              hatchet,
              logger,
              event: "journey.heldout",
              dedupeKey: `journey.heldout:${holdoutStateId}`,
              payload: {
                journeyId: meta.id,
                journeyName: meta.name,
                stateId: holdoutStateId,
                userId,
                userEmail,
                heldOutAt: heldOutAt.toISOString(),
              },
            }).catch(logger.warn);
          }
        }
        return { status: "skipped", reason: "held_out" };
      }
    }

    const activeState = await db.query.journeyStates.findFirst({
      where: and(
        eq(journeyStates.userId, userId),
        eq(journeyStates.journeyId, meta.id),
        inArray(journeyStates.status, ["active", "waiting"]),
      ),
    });
    if (activeState) {
      return { status: "skipped", reason: "already_active" };
    }

    // A successful insert always returns exactly one row, so undefined here
    // can ONLY mean a burst-race conflict (see insertEnrollment's doc for
    // the race + arbiter mechanics) — the same outcome as the read guard,
    // mapped to the identical skip.
    state = await insertEnrollment({
      db,
      userId,
      userEmail,
      journeyId: meta.id,
      context: options.extraContext
        ? { ...properties, ...options.extraContext }
        : properties,
      hatchetRunId: workflowRunId,
      serializeWithGraphLock: options.serializeEnrollment,
    });
    if (!state) {
      return { status: "skipped", reason: "already_active" };
    }
  }

  const stateId = state.id;

  // Fire-and-forget enrollment transition (FRESH entry only — a replay
  // recovers `state` by run id above and must NOT re-log an entry). Writes
  // `journey_logs` best-effort; never throws into / alters execution.
  if (!recovered) {
    logTransition({
      db,
      journeyStateId: stateId,
      from: null,
      to: "start",
      action: "entered",
    });
  }

  // The replay-stable key anchor: prefer the run id (constant across replays
  // of this run), fall back to stateId when the engine has no run id.
  const runAnchor = workflowRunId || stateId;

  const user: JourneyUser = {
    id: userId,
    email: userEmail,
    properties,
    stateId,
    journeyId: meta.id,
    journeyName: meta.name,
  };

  // The injected analytics instance (set by createHogsendClient). Same
  // object as container.analytics; undefined when POSTHOG_API_KEY is unset.
  const posthog = getAnalytics();
  const scheduleDefaults = getClientScheduleDefaults();

  // Resolve the user's timezone via the precedence chain (explicit is N/A
  // at enrollment; PostHog person props → contacts row → client default →
  // UTC). Best-effort: failures fall through to the client default tz.
  // Independent I/O — fetch the contact row and PostHog person props
  // concurrently. PostHog failures fall through to undefined.
  const [contact, posthogProperties] = await Promise.all([
    // Both legs are best-effort tz inputs: a failure here must fall through
    // to the client-default tz, never reject the `Promise.all` and throw out
    // of the fn BEFORE the try/catch below (which would strand the row —
    // already inserted "active" — outside the failure handling). The PostHog
    // leg already `.catch`es; mirror it on the contact read.
    db.query.contacts
      .findFirst({ where: eq(contacts.externalId, userId) })
      .catch(() => undefined),
    posthog?.getPersonProperties(userId).catch(() => undefined),
  ]);

  const tz = resolveTimezoneWithSource({
    posthogProperties,
    contactTimezone: contact?.timezone ?? null,
    contactProperties: contact?.properties ?? null,
    defaultTimezone: scheduleDefaults.timezone,
    logger,
  });

  // Opportunistic cache write: when the tz came from a PostHog source and
  // the contacts.timezone column is empty, persist it (fire-and-forget;
  // PostHog/JSONB remain authoritative so nothing blocks on the column).
  if (
    (tz.source === "posthog_timezone" || tz.source === "posthog_geoip") &&
    contact &&
    !contact.timezone
  ) {
    db.update(contacts)
      .set({ timezone: tz.timezone, updatedAt: new Date() })
      .where(eq(contacts.id, contact.id))
      .catch(() => {
        // best-effort cache write; never block the journey
      });
  }

  const ctx = createJourneyContext({
    db,
    hatchet,
    // The real DurableContext structurally satisfies the (widened) config —
    // it exposes `sleepFor`/`waitFor` AND a replay-memoized `now()` (SDK
    // 1.22.3). Forwarding it whole lets ctx clock reads (ctx.when,
    // sleepUntil delta, lookback, ctx.now) read the memoized clock on an
    // eviction-capable engine, falling back to the live clock pre-eviction.
    hatchetCtx,
    registry: getJourneyRegistrySingleton(),
    logger,
    stateId,
    userId,
    userEmail,
    journeyContext: { ...properties },
    resolvedTimezone: tz.timezone,
    defaultSendWindow: scheduleDefaults.sendWindow,
    // Digest defaults: the trigger event + its already-normalized `where`
    // (so a digest of the journey's own trigger honors the trigger contract
    // without restating it), plus the enrollment shape for the digest's
    // definition-interplay warnings.
    triggerEvent: meta.trigger.event,
    ...(meta.trigger.where ? { triggerWhere: meta.trigger.where } : {}),
    journeyId: meta.id,
    entryLimit: meta.entryLimit,
    ...(meta.entryPeriod ? { entryPeriod: meta.entryPeriod } : {}),
  });

  // The journey boundary makes journey side effects (sendEmail, ctx.trigger)
  // EXACTLY-ONCE across a durable replay WITHOUT any change to journey
  // authoring. It is established once around `run()`: a replay-from-top
  // re-enters this scope from the top. Its `runAnchor` is the replay-stable
  // Hatchet run id (recovered above so the SAME stateId is reused on replay),
  // so the derived keys collide across a replay of the same run even if the
  // enrollment row had to be recovered rather than freshly inserted.
  // `memoize` is the Layer-1 fast path (durable only when the engine supports
  // eviction); the auto-derived `email_sends`/`user_events` idempotency keys
  // (anchored on `runAnchor`) are the version-independent Layer-2 guarantee.
  logEvictionSupportOnce(hatchetCtx);
  const boundary: JourneyBoundary = {
    stateId,
    runAnchor,
    currentLabel: undefined,
    seenKeys: new Set<string>(),
    seenRecordLabels: new Set<string>(),
    memoize: createMemoize(hatchetCtx),
    journeyId: meta.id,
    // `meta.suppress` is a required DurationObject, but a `{}` / zero
    // duration must yield 0 (disabled); `durationToMs` maps both to 0.
    // Guard against a runtime-absent value so an undefined never reaches
    // durationToMs (which would throw dereferencing `.hours`).
    suppressMs: meta.suppress ? durationToMs(meta.suppress) : 0,
    // The journey-level email-preference category (validated fail-closed at
    // boot). The standalone `sendEmail` reads it off the boundary and stamps
    // it on the send, overriding the template's own category. Undefined for
    // journeys without a `meta.category` (incl. bucket reactions) ⇒ the send
    // keeps the built-in `journey` default.
    category: meta.category,
  };

  // Seed the context's memoized-clock snapshot ONCE before run() so a
  // `ctx.when` chain used BEFORE the first durable step reads a replay-stable
  // instant (on an eviction engine) instead of the construction-time
  // `new Date()` seed. Best-effort: on a pre-eviction engine this reads the
  // live clock, same as before.
  await ctx.now();

  try {
    await runWithJourneyBoundary(boundary, () => options.run(user, ctx));

    const completedAt = new Date();
    await db
      .update(journeyStates)
      .set({
        status: "completed",
        completedAt,
        updatedAt: completedAt,
      })
      .where(eq(journeyStates.id, stateId));

    // Fire-and-forget completion transition (best-effort; never throws).
    logTransition({
      db,
      journeyStateId: stateId,
      from: boundary.currentLabel ?? null,
      to: "end-completed",
      action: "completed",
    });

    await hatchet.events.push("journey:completed", {
      journeyId: meta.id,
      stateId,
      userId,
    });

    // OUTBOUND `journey.completed` — fired alongside the internal
    // `journey:completed` push. Runs in the WORKER (this durable task), so it
    // uses the engine `db`/`hatchet`/`logger` singletons. `dedupeKey` =
    // `journey.completed:<stateId>`: a Hatchet re-execution recomputes the
    // identical key and the unique `(endpointId, dedupeKey)` index absorbs the
    // duplicate (risk 3). `journey:failed` is NOT in the catalog → no emit.
    void emitOutbound({
      db,
      hatchet,
      logger,
      event: "journey.completed",
      dedupeKey: `journey.completed:${stateId}`,
      payload: {
        journeyId: meta.id,
        journeyName: meta.name,
        stateId,
        userId,
        userEmail,
        completedAt: completedAt.toISOString(),
      },
    }).catch(logger.warn);

    return { stateId, status: "completed" };
  } catch (err) {
    // The journey reached a terminal state (exitOn / cancel) while suspended
    // in a durable wait. The state row is already terminal — stop gracefully
    // without marking it "failed" or re-pushing a journey:failed event.
    if (err instanceof JourneyExitedError) {
      return { stateId, status: "exited" };
    }

    // Graceful worker shutdown (SIGTERM → worker.stop()) ABORTS in-flight
    // durable runs so Hatchet can REASSIGN them: the suspended sleepFor/
    // waitFor rejects with the SDK's AbortError. That is a RELEASE, not a
    // failure — writing "failed" + pushing journey:failed here permanently
    // POISONS the enrollment (recovery-first later finds a terminal row and
    // never resumes), turning every graceful redeploy mid-wait into enrollment
    // death. Detect the abort by the SDK's error CONTRACT (name/code — the
    // message text varies, so never match on it), with the DurableContext's
    // aborted signal as a belt-and-braces fallback.
    const isAbort =
      (err instanceof Error &&
        (err.name === "AbortError" ||
          (err as { code?: string }).code === "ABORT_ERR")) ||
      hatchetCtx.abortController?.signal?.aborted === true;

    if (isAbort) {
      // Read the CURRENT status: an exitOn/admin cancel may have flipped the
      // row terminal BEFORE the abort surfaced — keep today's "exited"
      // outcome there. Otherwise the row is still waiting/active (the
      // graceful-shutdown release) — leave it EXACTLY as-is so recovery-first
      // (by hatchetRunId) resumes the recorded window on re-dispatch. The old
      // "failed" write was converting a redeploy into permanent enrollment
      // death; if Hatchet ever fails to re-dispatch, the stranded-waiting
      // alert flags the row — strictly better than a false "failed".
      const current = await db.query.journeyStates.findFirst({
        where: eq(journeyStates.id, stateId),
        columns: { status: true },
      });
      const status = current?.status;
      if (status && (TERMINAL_STATUSES as readonly string[]).includes(status)) {
        return { stateId, status: "exited" };
      }
      logger.info(
        "journey run released mid-wait (worker shutdown/reassignment); " +
          "enrollment left intact for re-dispatch",
        { journeyId: meta.id, stateId, status },
      );
      // Rethrow so the SDK completes its cancellation flow. NO row write, NO
      // journey:failed push, NO "failed" transition.
      throw err;
    }

    const message = options.serializeError
      ? options.serializeError(err)
      : err instanceof Error
        ? err.message
        : "Unknown error during journey";

    // Mark "failed" ONLY if the row isn't already terminal. A run cancelled
    // by exitOn (ingestEvent sets "exited" then `runs.cancel`) or by the
    // admin route surfaces here as a Hatchet AbortError thrown from the
    // suspended waitFor/sleepFor — NOT a JourneyExitedError. Guarding on a
    // non-terminal status prevents clobbering that "exited" row to "failed"
    // and emitting a spurious journey:failed event.
    const [failed] = await db
      .update(journeyStates)
      .set({
        status: "failed",
        errorMessage: message,
        updatedAt: new Date(),
      })
      .where(
        and(
          eq(journeyStates.id, stateId),
          notInArray(journeyStates.status, [...TERMINAL_STATUSES]),
        ),
      )
      .returning({ id: journeyStates.id });

    if (!failed) {
      // Already terminal (cancelled after exit) — swallow the cancellation
      // so the run doesn't double-report as failed.
      return { stateId, status: "exited" };
    }

    logger.error("Journey run failed", {
      journeyId: meta.id,
      journeyName: meta.name,
      stateId,
      userId,
      error: message,
    });

    // Fire-and-forget failure transition — only reached when a row was
    // actually flipped to "failed" (the guard above). `to` is the best-effort
    // last durable node (approximate — see plan Guardrails). Never throws.
    logTransition({
      db,
      journeyStateId: stateId,
      from: null,
      to: boundary.currentLabel ?? state.currentNodeId ?? null,
      action: "failed",
      detail: { error: message },
    });

    await hatchet.events.push("journey:failed", {
      journeyId: meta.id,
      stateId,
      userId,
      error: message,
    });

    throw err;
  }
}
