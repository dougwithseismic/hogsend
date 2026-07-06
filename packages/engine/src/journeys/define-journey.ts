import type { JsonValue } from "@hatchet-dev/typescript-sdk/v1/types.js";
import { evaluatePropertyConditions, normalizeWhere } from "@hogsend/core";
import type {
  JourneyMeta,
  JourneyMetaInput,
  JourneyRunFn,
  JourneyUser,
} from "@hogsend/core/types";
import { contacts, journeyConfigs, journeyStates } from "@hogsend/db";
import { and, eq, inArray, notInArray } from "drizzle-orm";
import { getAnalytics } from "../lib/analytics-singleton.js";
import { getDb } from "../lib/db.js";
import {
  checkEmailPreferences,
  checkEntryLimit,
} from "../lib/enrollment-guards.js";
import { hatchet } from "../lib/hatchet.js";
import { createLogger } from "../lib/logger.js";
import { emitOutbound } from "../lib/outbound.js";
import { resolveTimezoneWithSource } from "../lib/timezone.js";
import { getClientScheduleDefaults } from "./client-defaults-singleton.js";
import { JOURNEY_EXECUTION_TIMEOUT } from "./constants.js";
import { JourneyExitedError } from "./errors.js";
import {
  createMemoize,
  type JourneyBoundary,
  runWithJourneyBoundary,
  supportsEviction,
} from "./journey-boundary.js";
import { createJourneyContext, TERMINAL_STATUSES } from "./journey-context.js";
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

interface EventPayloadInput {
  userId: JsonValue;
  userEmail: JsonValue;
  properties: JsonValue;
  [key: string]: JsonValue;
}

export interface DefinedJourney {
  meta: JourneyMeta;
  task: ReturnType<typeof hatchet.durableTask>;
}

export function defineJourney(options: {
  meta: JourneyMetaInput;
  run: JourneyRunFn;
}): DefinedJourney {
  const { trigger, exitOn, ...rest } = options.meta;
  const triggerWhere = normalizeWhere(trigger.where);
  const meta: JourneyMeta = {
    ...rest,
    trigger: {
      event: trigger.event,
      ...(triggerWhere ? { where: triggerWhere } : {}),
    },
    ...(exitOn
      ? {
          exitOn: exitOn.map((exit) => {
            const exitWhere = normalizeWhere(exit.where);
            return {
              event: exit.event,
              ...(exitWhere ? { where: exitWhere } : {}),
            };
          }),
        }
      : {}),
  };

  const task = hatchet.durableTask({
    name: `journey-${meta.id}`,
    onEvents: [meta.trigger.event],
    executionTimeout: JOURNEY_EXECUTION_TIMEOUT,
    retries: 0,
    fn: async (input: EventPayloadInput, hatchetCtx) => {
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
      // eviction-capable Hatchet engine (hatchet-lite >= v0.80.0) replays `fn`
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
          return { status: "skipped", reason: entryAllowed.reason };
        }

        const prefs = await checkEmailPreferences({ db, userId });
        if (prefs.unsubscribed) {
          return { status: "skipped", reason: "user_unsubscribed" };
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

        [state] = await db
          .insert(journeyStates)
          .values({
            userId,
            userEmail,
            journeyId: meta.id,
            currentNodeId: "start",
            status: "active",
            context: properties,
            hatchetRunId: workflowRunId,
          })
          .returning();
      }

      if (!state) {
        return { status: "skipped", reason: "state_creation_failed" };
      }

      const stateId = state.id;
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
        db.query.contacts.findFirst({
          where: eq(contacts.externalId, userId),
        }),
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
        memoize: createMemoize(hatchetCtx),
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

        const message =
          err instanceof Error ? err.message : "Unknown error during journey";

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

        await hatchet.events.push("journey:failed", {
          journeyId: meta.id,
          stateId,
          userId,
          error: message,
        });

        throw err;
      }
    },
  });

  return { meta, task };
}
