import type { HatchetClient } from "@hatchet-dev/typescript-sdk/v1/index.js";
import { evaluatePropertyConditions } from "@hogsend/core";
import type { JourneyRegistry } from "@hogsend/core/registry";
import {
  contacts,
  type Database,
  journeyStates,
  userEvents,
} from "@hogsend/db";
import { and, eq, inArray, isNull } from "drizzle-orm";
import { checkBucketMembership } from "../buckets/check-membership.js";
import { resolveOrCreateContact } from "./contacts.js";
import type { Logger } from "./logger.js";

export interface IngestEvent {
  event: string;
  /** D1: optional — email-only / anonymous events resolve a key downstream. */
  userId?: string;
  userEmail?: string;
  /** D1: future anonymous→identified path. Threaded into the resolver. */
  anonymousId?: string;
  /** D2: → `user_events` + Hatchet `trigger.where`/`exitOn` ONLY. */
  eventProperties: Record<string, unknown>;
  /** D2: → `contacts.properties` merge ONLY. */
  contactProperties?: Record<string, unknown>;
  idempotencyKey?: string;
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

  // (1) Resolve identity FIRST (awaited — no longer fire-and-forget). The
  // contact-referencing tables join on a NOT NULL text key, so an email-only /
  // anonymous event (D1 optional userId) needs a canonical key resolved before
  // any insert (risk 2). The resolver applies ONLY contactProperties to
  // `contacts.properties` (D2 split) and returns the canonical contact id; we
  // read back the row to derive the resolved string key
  // (external_id ?? anonymous_id ?? contact.id — risk 1/6).
  const { id: contactId } = await resolveOrCreateContact({
    db,
    userId: event.userId,
    email: event.userEmail || undefined,
    anonymousId: event.anonymousId,
    contactProperties: event.contactProperties,
  });

  const [resolved] = await db
    .select({
      externalId: contacts.externalId,
      anonymousId: contacts.anonymousId,
    })
    .from(contacts)
    .where(eq(contacts.id, contactId))
    .limit(1);

  const resolvedKey =
    resolved?.externalId ?? resolved?.anonymousId ?? contactId;

  // (2) Idempotency dedup + `user_events` insert keyed on the resolved key, with
  // ONLY eventProperties in the properties bag (D2).
  if (event.idempotencyKey) {
    const result = await db
      .insert(userEvents)
      .values({
        userId: resolvedKey,
        event: event.event,
        properties: event.eventProperties,
        idempotencyKey: event.idempotencyKey,
      })
      .onConflictDoNothing({
        target: userEvents.idempotencyKey,
      })
      .returning({ id: userEvents.id });

    if (result.length === 0) {
      return { stored: false, exits: [] };
    }
  } else {
    await db.insert(userEvents).values({
      userId: resolvedKey,
      event: event.event,
      properties: event.eventProperties,
    });
  }

  // (3) Build the JSON-serializable subset of eventProperties for the Hatchet
  // push payload (scalars only — the SDK serializes the envelope).
  const serializableProperties = Object.fromEntries(
    Object.entries(event.eventProperties).filter(
      ([, v]) =>
        typeof v === "string" ||
        typeof v === "number" ||
        typeof v === "boolean" ||
        v === null,
    ),
  ) as Record<string, string | number | boolean | null>;

  // (4) Hatchet push + (5) checkExits, both keyed on the resolved key. The push
  // payload wire key STAYS `properties` (bucket tests assert on it — risk 9).
  const [, exits] = await Promise.all([
    hatchet.events.push(event.event, {
      userId: resolvedKey,
      userEmail: event.userEmail ?? "",
      properties: serializableProperties,
    }),
    checkExits(db, registry, hatchet, logger, {
      userId: resolvedKey,
      eventName: event.event,
      properties: event.eventProperties,
    }),
  ]);

  // (6) Real-time bucket membership re-evaluation (Section 6.1). NOT part of the
  // Promise.all above: its property eval reads contact state ⊕ this-ingest
  // contactProperties patch, and its bucket:entered/left emissions recurse back
  // into ingestEvent (the recursion guard in checkBucketMembership bounds them).
  // Best-effort: a bucket failure must not fail the ingest of the originating
  // event.
  try {
    await checkBucketMembership({
      db,
      registry,
      hatchet,
      logger,
      userId: resolvedKey,
      userEmail: event.userEmail || null,
      event: event.event,
      eventProperties: event.eventProperties,
      contactProperties: event.contactProperties ?? {},
    });
  } catch (err) {
    logger.warn("Bucket membership check failed", {
      event: event.event,
      userId: resolvedKey,
      error: err instanceof Error ? err.message : String(err),
    });
  }

  logger.info("Event ingested", {
    event: event.event,
    userId: resolvedKey,
    exits: exits.filter((e) => e.exited).length,
  });

  return { stored: true, exits };
}

async function checkExits(
  db: Database,
  registry: JourneyRegistry,
  hatchet: HatchetClient,
  logger: Logger,
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
      isNull(journeyStates.deletedAt),
    ),
  });

  const statesToExit: string[] = [];
  const runIdsToCancel: string[] = [];

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
      if (state.hatchetRunId) {
        runIdsToCancel.push(state.hatchetRunId);
      }
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

    // Cancel the live durable runs so a journey suspended in a sleep or
    // `waitForEvent` can't resume and fire after it has exited. Best-effort: a
    // run may have already finished, and the in-run resume guard
    // (JourneyExitedError) is the backstop if a cancel races a resume.
    if (runIdsToCancel.length > 0) {
      try {
        await hatchet.runs.cancel({ ids: runIdsToCancel });
      } catch (err) {
        logger.warn("Failed to cancel exited journey runs", {
          count: runIdsToCancel.length,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }
  }

  return results;
}
