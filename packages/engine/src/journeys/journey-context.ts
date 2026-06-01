import type { HatchetClient } from "@hatchet-dev/typescript-sdk/v1/index.js";
import type { DurationObject } from "@hogsend/core";
import { evaluateEventCondition } from "@hogsend/core";
import type { JourneyRegistry } from "@hogsend/core/registry";
import type { JourneyContext } from "@hogsend/core/types";
import { type Database, emailSends, journeyStates } from "@hogsend/db";
import type { PostHogService } from "@hogsend/plugin-posthog";
import { and, count, eq, max } from "drizzle-orm";
import { checkEmailPreferences } from "../lib/enrollment-guards.js";
import { ingestEvent } from "../lib/ingestion.js";
import type { Logger } from "../lib/logger.js";

interface JourneyContextConfig {
  db: Database;
  hatchet: HatchetClient;
  hatchetCtx: { sleepFor: (duration: DurationObject) => Promise<unknown> };
  registry: JourneyRegistry;
  logger: Logger;
  posthog?: PostHogService;
  stateId: string;
  userId: string;
  userEmail: string;
  journeyContext: Record<string, unknown>;
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
    posthog,
    stateId,
    userId,
    userEmail,
    journeyContext,
  } = config;

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
      await ingestEvent({
        db,
        registry,
        hatchet,
        logger,
        event: {
          event,
          userId: targetUserId,
          userEmail: targetEmail ?? userEmail,
          properties: properties ?? {},
        },
      });
    },

    identify(properties) {
      posthog?.identify(userId, properties);
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
    },

    posthog: {
      capture({ event, properties }) {
        posthog?.captureEvent({
          distinctId: userId,
          event,
          properties,
        });
      },
    },
  };
}
