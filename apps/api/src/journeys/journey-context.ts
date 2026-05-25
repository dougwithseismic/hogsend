import type { HatchetClient } from "@hatchet-dev/typescript-sdk/v1/index.js";
import type { DurationObject } from "@hogsend/core";
import { evaluateCondition } from "@hogsend/core";
import type { JourneyContext } from "@hogsend/core/types";
import { type Database, journeyStates, userEvents } from "@hogsend/db";
import { eq } from "drizzle-orm";

interface JourneyContextConfig {
  db: Database;
  hatchet: HatchetClient;
  hatchetCtx: { sleepFor: (duration: DurationObject) => Promise<unknown> };
  stateId: string;
  journeyId: string;
  journeyContext: Record<string, unknown>;
}

export function createJourneyContext(
  config: JourneyContextConfig,
): JourneyContext {
  const { db, hatchet, hatchetCtx, stateId, journeyId, journeyContext } =
    config;

  async function updateCheckpoint(label: string): Promise<void> {
    await db
      .update(journeyStates)
      .set({ currentNodeId: label, updatedAt: new Date() })
      .where(eq(journeyStates.id, stateId));
  }

  return {
    async sleep({ duration, label }) {
      const sleptAt = new Date().toISOString();

      await db
        .update(journeyStates)
        .set({
          status: "waiting",
          currentNodeId: label ?? `wait:${JSON.stringify(duration)}`,
          updatedAt: new Date(),
        })
        .where(eq(journeyStates.id, stateId));

      await hatchetCtx.sleepFor(duration);

      const resumedAt = new Date().toISOString();

      await db
        .update(journeyStates)
        .set({ status: "active", updatedAt: new Date() })
        .where(eq(journeyStates.id, stateId));

      return { sleptAt, resumedAt };
    },

    async checkpoint(label) {
      await updateCheckpoint(label);
    },

    event: {
      async check({ userId: targetUserId, event, withinHours }) {
        const found = await evaluateCondition({
          condition: {
            type: "event",
            eventName: event,
            check: "exists",
            withinHours,
          },
          ctx: { db, userId: targetUserId, journeyContext },
        });
        return { found, count: found ? 1 : 0 };
      },

      async fire({ userId: targetUserId, event, properties = {} }) {
        await updateCheckpoint(`event:${event}`);

        await db.insert(userEvents).values({
          userId: targetUserId,
          event,
          properties,
        });

        const eventKey = `user:${event}`;
        await hatchet.events.push(eventKey, {
          userId: targetUserId,
          journeyId,
          properties,
        });

        return { eventKey, firedAt: new Date().toISOString() };
      },
    },
  };
}
