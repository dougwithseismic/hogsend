import type { JourneyRegistry } from "@hogsend/core/registry";
import type { JourneyDefinition, PropertyCondition } from "@hogsend/core/types";
import {
  type Database,
  emailPreferences,
  journeyStates,
  userEvents,
} from "@hogsend/db";
import { and, eq, inArray } from "drizzle-orm";
import { runJourneyTask } from "../workflows/run-journey.js";
import type { Logger } from "./logger.js";

export interface IngestEvent {
  event: string;
  userId: string;
  userEmail: string;
  properties: Record<string, unknown>;
}

export interface EnrollmentResult {
  journeyId: string;
  enrolled: boolean;
  reason?: string;
}

export interface ExitResult {
  journeyId: string;
  stateId: string;
  exited: boolean;
}

export interface IngestResult {
  stored: boolean;
  enrollments: EnrollmentResult[];
  exits: ExitResult[];
}

export async function ingestEvent(
  db: Database,
  registry: JourneyRegistry,
  logger: Logger,
  event: IngestEvent,
): Promise<IngestResult> {
  await db.insert(userEvents).values({
    userId: event.userId,
    event: event.event,
    properties: event.properties,
  });

  const enrollments = await checkEnrollment(db, registry, event);

  const exits = await checkExits(db, registry, {
    userId: event.userId,
    eventName: event.event,
    properties: event.properties,
  });

  logger.info("Event ingested", {
    event: event.event,
    userId: event.userId,
    enrollments: enrollments.filter((e) => e.enrolled).length,
    exits: exits.filter((e) => e.exited).length,
  });

  return { stored: true, enrollments, exits };
}

async function checkEnrollment(
  db: Database,
  registry: JourneyRegistry,
  event: IngestEvent,
): Promise<EnrollmentResult[]> {
  const matchingJourneys = registry.getByTriggerEvent(event.event);
  if (matchingJourneys.length === 0) return [];

  const prefs = await db.query.emailPreferences.findFirst({
    where: eq(emailPreferences.userId, event.userId),
  });

  const serializableContext = Object.fromEntries(
    Object.entries(event.properties).filter(
      ([, v]) =>
        typeof v === "string" ||
        typeof v === "number" ||
        typeof v === "boolean" ||
        v === null,
    ),
  ) as Record<string, string | number | boolean | null>;

  const results: EnrollmentResult[] = [];

  for (const journey of matchingJourneys) {
    if (!journey.enabled) {
      results.push({
        journeyId: journey.id,
        enrolled: false,
        reason: "journey_disabled",
      });
      continue;
    }

    if (journey.trigger.where?.length) {
      if (!evaluateTriggerConditions(journey.trigger.where, event.properties)) {
        results.push({
          journeyId: journey.id,
          enrolled: false,
          reason: "trigger_conditions_not_met",
        });
        continue;
      }
    }

    const entryAllowed = await checkEntryLimit(db, journey, event.userId);
    if (!entryAllowed.allowed) {
      results.push({
        journeyId: journey.id,
        enrolled: false,
        reason: entryAllowed.reason,
      });
      continue;
    }

    if (prefs?.unsubscribedAll) {
      results.push({
        journeyId: journey.id,
        enrolled: false,
        reason: "user_unsubscribed",
      });
      continue;
    }

    const [state] = await db
      .insert(journeyStates)
      .values({
        userId: event.userId,
        userEmail: event.userEmail,
        journeyId: journey.id,
        currentNodeId: journey.entryNode,
        status: "active",
        context: event.properties,
      })
      .returning();

    if (!state) continue;

    const ref = await runJourneyTask.runNoWait({
      stateId: state.id,
      journeyId: journey.id,
      userId: event.userId,
      userEmail: event.userEmail,
      context: serializableContext,
    });

    const runId = await ref.getWorkflowRunId();

    await db
      .update(journeyStates)
      .set({ hatchetRunId: runId })
      .where(eq(journeyStates.id, state.id));

    results.push({ journeyId: journey.id, enrolled: true });
  }

  return results;
}

export function evaluateTriggerConditions(
  conditions: PropertyCondition[],
  properties: Record<string, unknown>,
): boolean {
  return conditions.every((condition) => {
    const value = properties[condition.property];
    switch (condition.operator) {
      case "eq":
        return value === condition.value;
      case "neq":
        return value !== condition.value;
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

async function checkEntryLimit(
  db: Database,
  journey: JourneyDefinition,
  userId: string,
): Promise<{ allowed: boolean; reason?: string }> {
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
    const periodMs = (journey.entryPeriodHours ?? 24) * 60 * 60 * 1000;
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

async function checkExits(
  db: Database,
  registry: JourneyRegistry,
  event: {
    userId: string;
    eventName: string;
    properties: Record<string, unknown>;
  },
): Promise<ExitResult[]> {
  const results: ExitResult[] = [];

  const activeStates = await db.query.journeyStates.findMany({
    where: and(
      eq(journeyStates.userId, event.userId),
      inArray(journeyStates.status, ["active", "waiting"]),
    ),
  });

  for (const state of activeStates) {
    const journey = registry.get(state.journeyId);
    if (!journey?.exitOn) continue;

    const shouldExit = journey.exitOn.some((exitCondition) => {
      if (exitCondition.event !== event.eventName) return false;
      if (!exitCondition.where?.length) return true;
      return evaluateTriggerConditions(exitCondition.where, event.properties);
    });

    if (shouldExit) {
      await db
        .update(journeyStates)
        .set({
          status: "exited",
          exitedAt: new Date(),
          updatedAt: new Date(),
        })
        .where(eq(journeyStates.id, state.id));

      results.push({
        journeyId: state.journeyId,
        stateId: state.id,
        exited: true,
      });
    } else {
      results.push({
        journeyId: state.journeyId,
        stateId: state.id,
        exited: false,
      });
    }
  }

  return results;
}
