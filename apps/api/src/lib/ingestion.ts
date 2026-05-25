import type { HatchetClient } from "@hatchet-dev/typescript-sdk/v1/index.js";
import { evaluatePropertyConditions } from "@hogsend/core";
import type { JourneyRegistry } from "@hogsend/core/registry";
import { type Database, journeyStates, userEvents } from "@hogsend/db";
import { and, eq, inArray } from "drizzle-orm";
import { upsertContact } from "./contacts.js";
import type { Logger } from "./logger.js";

export interface IngestEvent {
  event: string;
  userId: string;
  userEmail: string;
  properties: Record<string, unknown>;
}

export interface ExitResult {
  journeyId: string;
  stateId: string;
  exited: boolean;
}

export interface IngestResult {
  stored: boolean;
  exits: ExitResult[];
}

export async function ingestEvent(opts: {
  db: Database;
  registry: JourneyRegistry;
  hatchet: HatchetClient;
  logger: Logger;
  event: IngestEvent;
}): Promise<IngestResult> {
  const { db, registry, hatchet, logger, event } = opts;
  await db.insert(userEvents).values({
    userId: event.userId,
    event: event.event,
    properties: event.properties,
  });

  const serializableProperties = Object.fromEntries(
    Object.entries(event.properties).filter(
      ([, v]) =>
        typeof v === "string" ||
        typeof v === "number" ||
        typeof v === "boolean" ||
        v === null,
    ),
  ) as Record<string, string | number | boolean | null>;

  const [, exits] = await Promise.all([
    hatchet.events.push(event.event, {
      userId: event.userId,
      userEmail: event.userEmail,
      properties: serializableProperties,
    }),
    checkExits(db, registry, {
      userId: event.userId,
      eventName: event.event,
      properties: event.properties,
    }),
    upsertContact({
      db,
      externalId: event.userId,
      email: event.userEmail || undefined,
      properties: event.properties,
    }).catch((err) => {
      logger.warn("Contact upsert failed", {
        userId: event.userId,
        error: err instanceof Error ? err.message : String(err),
      });
    }),
  ]);

  logger.info("Event ingested", {
    event: event.event,
    userId: event.userId,
    exits: exits.filter((e) => e.exited).length,
  });

  return { stored: true, exits };
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

  const statesToExit: string[] = [];

  for (const state of activeStates) {
    const journey = registry.get(state.journeyId);
    if (!journey?.exitOn) continue;

    const shouldExit = journey.exitOn.some((exitCondition) => {
      if (exitCondition.event !== event.eventName) return false;
      if (!exitCondition.where?.length) return true;
      return evaluatePropertyConditions({
        conditions: exitCondition.where,
        properties: event.properties,
      });
    });

    if (shouldExit) {
      statesToExit.push(state.id);
    }

    results.push({
      journeyId: state.journeyId,
      stateId: state.id,
      exited: shouldExit,
    });
  }

  if (statesToExit.length > 0) {
    await db
      .update(journeyStates)
      .set({
        status: "exited",
        exitedAt: new Date(),
        updatedAt: new Date(),
      })
      .where(inArray(journeyStates.id, statesToExit));
  }

  return results;
}
