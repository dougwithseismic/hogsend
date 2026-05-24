import type { JsonValue } from "@hatchet-dev/typescript-sdk/v1/types.js";
import type {
  JourneyMeta,
  JourneyRunFn,
  JourneyUser,
} from "@hogsend/core/types";
import { createDatabase, type Database, journeyStates } from "@hogsend/db";
import { eq } from "drizzle-orm";
import {
  checkEmailPreferences,
  checkEntryLimit,
  evaluateTriggerConditions,
} from "../lib/enrollment-guards.js";
import { hatchet } from "../lib/hatchet.js";
import { sendEmailTask } from "../workflows/send-email.js";
import { createJourneyContext } from "./journey-context.js";

let _db: Database | undefined;

function getDb(): Database {
  if (!_db) {
    const { db } = createDatabase(process.env.DATABASE_URL ?? "");
    _db = db;
  }
  return _db;
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

      if (meta.trigger.where?.length) {
        if (!evaluateTriggerConditions(meta.trigger.where, properties)) {
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

      const prefs = await checkEmailPreferences(db, userId);
      if (prefs.unsubscribed) {
        return { status: "skipped", reason: "user_unsubscribed" };
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
      };

      const ctx = createJourneyContext({
        db,
        hatchet,
        hatchetCtx,
        sendEmailTask,
        stateId,
        journeyId: meta.id,
        journeyName: meta.name,
        userId,
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
