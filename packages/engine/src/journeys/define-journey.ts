import type { JsonValue } from "@hatchet-dev/typescript-sdk/v1/types.js";
import { evaluatePropertyConditions } from "@hogsend/core";
import type {
  JourneyMeta,
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
import { createJourneyContext, TERMINAL_STATUSES } from "./journey-context.js";
import { getJourneyRegistrySingleton } from "./registry-singleton.js";

const logger = createLogger(process.env.LOG_LEVEL);

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
  meta: JourneyMeta;
  run: JourneyRunFn;
}): DefinedJourney {
  const { meta } = options;

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

      const [state] = await db
        .insert(journeyStates)
        .values({
          userId,
          userEmail,
          journeyId: meta.id,
          currentNodeId: "start",
          status: "active",
          context: properties,
          hatchetRunId: hatchetCtx.workflowRunId(),
        })
        .returning();

      if (!state) {
        return { status: "skipped", reason: "state_creation_failed" };
      }

      const stateId = state.id;

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

      try {
        await options.run(user, ctx);

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
