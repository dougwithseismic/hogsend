import { durationToMs, hours } from "@hogsend/core";
import type { JourneyMeta, PropertyCondition } from "@hogsend/core/types";
import { type Database, emailPreferences, journeyStates } from "@hogsend/db";
import { and, eq } from "drizzle-orm";

export function evaluateTriggerConditions(opts: {
  conditions: PropertyCondition[];
  properties: Record<string, unknown>;
}): boolean {
  const { conditions, properties } = opts;
  return conditions.every((condition) => {
    const value = properties[condition.property];
    switch (condition.operator) {
      case "eq":
        return value === condition.value;
      case "neq":
        return value !== condition.value;
      case "gt":
        return (
          value != null && condition.value != null && value > condition.value
        );
      case "gte":
        return (
          value != null && condition.value != null && value >= condition.value
        );
      case "lt":
        return (
          value != null && condition.value != null && value < condition.value
        );
      case "lte":
        return (
          value != null && condition.value != null && value <= condition.value
        );
      case "exists":
        return value !== undefined && value !== null;
      case "not_exists":
        return value === undefined || value === null;
      case "contains":
        return (
          typeof value === "string" &&
          typeof condition.value === "string" &&
          value.includes(condition.value)
        );
      default:
        return false;
    }
  });
}

export async function checkEntryLimit(opts: {
  db: Database;
  journey: JourneyMeta;
  userId: string;
}): Promise<{ allowed: boolean; reason?: string }> {
  const { db, journey, userId } = opts;
  if (journey.entryLimit === "unlimited") return { allowed: true };

  if (journey.entryLimit === "once") {
    const existing = await db.query.journeyStates.findFirst({
      where: and(
        eq(journeyStates.userId, userId),
        eq(journeyStates.journeyId, journey.id),
      ),
    });
    return existing
      ? { allowed: false, reason: "already_entered_once" }
      : { allowed: true };
  }

  if (journey.entryLimit === "once_per_period") {
    const periodMs = durationToMs(journey.entryPeriod ?? hours(24));
    const cutoff = new Date(Date.now() - periodMs);

    const existing = await db.query.journeyStates.findFirst({
      where: and(
        eq(journeyStates.userId, userId),
        eq(journeyStates.journeyId, journey.id),
      ),
      orderBy: (states, { desc }) => [desc(states.createdAt)],
    });

    return existing && existing.createdAt > cutoff
      ? { allowed: false, reason: "period_not_elapsed" }
      : { allowed: true };
  }

  return { allowed: true };
}

export async function checkEmailPreferences(opts: {
  db: Database;
  userId: string;
}): Promise<{ unsubscribed: boolean }> {
  const { db, userId } = opts;
  const prefs = await db.query.emailPreferences.findFirst({
    where: eq(emailPreferences.userId, userId),
  });

  return { unsubscribed: prefs?.unsubscribedAll ?? false };
}
