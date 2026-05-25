import type { JsonValue } from "@hatchet-dev/typescript-sdk/v1/types.js";
import type {
  JourneyMeta,
  JourneyRunFn,
  JourneyUser,
} from "@hogsend/core/types";
import { journeyConfigs, journeyStates } from "@hogsend/db";
import { and, eq, inArray } from "drizzle-orm";
import { getDb } from "../lib/db.js";
import {
  checkEmailPreferences,
  checkEntryLimit,
  evaluateTriggerConditions,
} from "../lib/enrollment-guards.js";
import { hatchet } from "../lib/hatchet.js";
import { createLogger } from "../lib/logger.js";
import { createJourneyContext } from "./journey-context.js";
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
    executionTimeout: "720h",
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
          !evaluateTriggerConditions({
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
      });

      try {
        await options.run(user, ctx);

        await db
          .update(journeyStates)
          .set({
            status: "completed",
            completedAt: new Date(),
            updatedAt: new Date(),
          })
          .where(eq(journeyStates.id, stateId));

        await hatchet.events.push("journey:completed", {
          journeyId: meta.id,
          stateId,
          userId,
        });

        return { stateId, status: "completed" };
      } catch (err) {
        const message =
          err instanceof Error ? err.message : "Unknown error during journey";

        await db
          .update(journeyStates)
          .set({
            status: "failed",
            errorMessage: message,
            updatedAt: new Date(),
          })
          .where(eq(journeyStates.id, stateId));

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
