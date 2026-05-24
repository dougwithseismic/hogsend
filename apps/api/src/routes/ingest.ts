import type { JourneyRegistry } from "@hogsend/core/registry";
import type { JourneyDefinition, PropertyCondition } from "@hogsend/core/types";
import {
  type Database,
  emailPreferences,
  journeyStates,
  userEvents,
} from "@hogsend/db";
import { createRoute, OpenAPIHono, z } from "@hono/zod-openapi";
import { and, eq } from "drizzle-orm";
import type { AppEnv } from "../app.js";
import { runJourneyTask } from "../workflows/run-journey.js";

const ingestRequestSchema = z.object({
  event: z.string().min(1),
  userId: z.string().min(1),
  userEmail: z.string().email().optional(),
  properties: z.record(z.string(), z.unknown()).optional(),
  timestamp: z.string().datetime().optional(),
});

const ingestResponseSchema = z.object({
  stored: z.boolean(),
  enrollments: z.array(
    z.object({
      journeyId: z.string(),
      enrolled: z.boolean(),
      reason: z.string().optional(),
    }),
  ),
  exits: z.array(
    z.object({
      journeyId: z.string(),
      stateId: z.string(),
      exited: z.boolean(),
    }),
  ),
});

const ingestRoute = createRoute({
  method: "post",
  path: "/",
  tags: ["Ingestion"],
  summary: "Ingest an event",
  description:
    "Receives events from PostHog webhooks or direct API calls. Stores the event, checks for journey enrollment, and processes exit conditions.",
  request: {
    body: {
      content: {
        "application/json": { schema: ingestRequestSchema },
      },
    },
  },
  responses: {
    202: {
      content: {
        "application/json": { schema: ingestResponseSchema },
      },
      description: "Event accepted and processed",
    },
  },
});

export const ingestRouter = new OpenAPIHono<AppEnv>().openapi(
  ingestRoute,
  async (c) => {
    const body = c.req.valid("json");
    const { db, registry, logger } = c.get("container");
    const properties = body.properties ?? {};
    const userEmail = body.userEmail ?? "";

    await db.insert(userEvents).values({
      userId: body.userId,
      event: body.event,
      properties,
    });

    const enrollments = await checkEnrollment(db, registry, {
      userId: body.userId,
      userEmail,
      eventName: body.event,
      properties,
    });

    const exits = await checkExits(db, registry, {
      userId: body.userId,
      eventName: body.event,
      properties,
    });

    logger.info("Event ingested", {
      event: body.event,
      userId: body.userId,
      enrollments: enrollments.filter((e) => e.enrolled).length,
      exits: exits.filter((e) => e.exited).length,
    });

    return c.json({ stored: true, enrollments, exits }, 202);
  },
);

// --- Enrollment ---

interface EnrollmentResult {
  journeyId: string;
  enrolled: boolean;
  reason?: string;
}

async function checkEnrollment(
  db: Database,
  registry: JourneyRegistry,
  event: {
    userId: string;
    userEmail: string;
    eventName: string;
    properties: Record<string, unknown>;
  },
): Promise<EnrollmentResult[]> {
  const matchingJourneys = registry.getByTriggerEvent(event.eventName);
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

function evaluateTriggerConditions(
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

// --- Exits ---

interface ExitResult {
  journeyId: string;
  stateId: string;
  exited: boolean;
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
      eq(journeyStates.status, "active"),
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
