import { createHash } from "node:crypto";
import type {
  ConversionDestination,
  ConversionDispatchInput,
} from "@hogsend/core";
import { CLICK_ID_PARAM_NAMES } from "@hogsend/core";
import {
  contacts,
  conversionDispatches,
  conversions,
  type Database,
  userEvents,
} from "@hogsend/db";
import { and, desc, eq, inArray, lte } from "drizzle-orm";
import type { Logger } from "./logger.js";
import { createOptionalSingleton } from "./singleton.js";

/**
 * Conversion dispatch (plan §5.2): fired conversions → destination providers,
 * durably. The ingest hook creates `conversion_dispatches` rows (idempotent
 * on (destination, event_id)) and enqueues the durable task per row; the task
 * assembles the enriched payload (contact identifiers + recovered click
 * context) and calls the provider, retrying with the SAME deterministic
 * event_id so the platform dedups.
 */

export class ConversionDestinationRegistry {
  private byId = new Map<string, ConversionDestination>();

  constructor(destinations: ConversionDestination[] = []) {
    for (const destination of destinations) {
      this.byId.set(destination.meta.id, destination);
    }
  }

  get(id: string): ConversionDestination | undefined {
    return this.byId.get(id);
  }
}

const singleton = createOptionalSingleton<ConversionDestinationRegistry>();
export const setConversionDestinations = singleton.set;
export const getConversionDestinations = singleton.get;
/** Reset the singleton — only for test cleanup. */
export const resetConversionDestinations = singleton.reset;

/** Deterministic dedup id — stable across retries AND re-evaluations. */
export function conversionEventId(opts: {
  contactId: string;
  definitionId: string;
  eventRowId: string;
}): string {
  return createHash("sha256")
    .update(`${opts.contactId}:${opts.definitionId}:${opts.eventRowId}`)
    .digest("hex");
}

/**
 * Create the dispatch rows for a fired conversion (idempotent) and return the
 * ids that were FRESHLY created (the caller enqueues the task for those).
 */
export async function createConversionDispatches(opts: {
  db: Database;
  conversionId: string;
  eventId: string;
  destinationIds: string[];
}): Promise<string[]> {
  const { db, conversionId, eventId, destinationIds } = opts;
  if (destinationIds.length === 0) return [];
  const inserted = await db
    .insert(conversionDispatches)
    .values(
      destinationIds.map((destinationId) => ({
        conversionId,
        destinationId,
        eventId,
      })),
    )
    .onConflictDoNothing({
      target: [
        conversionDispatches.destinationId,
        conversionDispatches.eventId,
      ],
    })
    .returning({ id: conversionDispatches.id });
  return inserted.map((row) => row.id);
}

/**
 * Recover the contact's click context: the most recent `campaign.arrived`
 * touchpoint at-or-before the conversion carrying at least one allowlisted
 * click ID. A later click-ID-less arrival (a `utm_*`-only newsletter landing)
 * must not shadow a real ad click, so we scan back past it; only when NO
 * arrival carries a click ID does the latest one stand (for `landingPage`).
 * The chosen arrival's `occurredAt` doubles as the click timestamp (`fbc`
 * needs the real one).
 */
export async function recoverClickContext(opts: {
  db: Database;
  userKey: string;
  before: Date;
}): Promise<ConversionDispatchInput["clicks"]> {
  const rows = await opts.db
    .select({
      properties: userEvents.properties,
      occurredAt: userEvents.occurredAt,
    })
    .from(userEvents)
    .where(
      and(
        eq(userEvents.userId, opts.userKey),
        eq(userEvents.event, "campaign.arrived"),
        lte(userEvents.occurredAt, opts.before),
      ),
    )
    .orderBy(desc(userEvents.occurredAt))
    .limit(25);
  if (rows.length === 0) return { clickIds: {} };

  const extractClickIds = (row: (typeof rows)[number]) => {
    const properties = (row.properties ?? {}) as Record<string, unknown>;
    const clickIds: Record<string, string> = {};
    for (const param of CLICK_ID_PARAM_NAMES) {
      const value = properties[param];
      if (typeof value === "string" && value) clickIds[param] = value;
    }
    return clickIds;
  };

  let chosen = rows[0] as (typeof rows)[number];
  let clickIds = extractClickIds(chosen);
  if (Object.keys(clickIds).length === 0) {
    for (const row of rows.slice(1)) {
      const candidate = extractClickIds(row);
      if (Object.keys(candidate).length > 0) {
        chosen = row;
        clickIds = candidate;
        break;
      }
    }
  }

  const landingPage = (chosen.properties as Record<string, unknown> | null)
    ?.landing_page;
  return {
    clickIds,
    clickAt: chosen.occurredAt.getTime(),
    ...(typeof landingPage === "string" ? { landingPage } : {}),
  };
}

/**
 * Deliver ONE dispatch row: load, enrich, send, record. Called by the durable
 * task (which owns retry/backoff); a throw here signals Hatchet to retry.
 * `maxAttempts` marks the row failed instead of throwing once exhausted.
 */
export async function deliverConversionDispatch(opts: {
  db: Database;
  logger: Logger;
  dispatchId: string;
  registry?: ConversionDestinationRegistry;
  maxAttempts?: number;
}): Promise<{ status: "delivered" | "failed" | "skipped" }> {
  const { db, logger, dispatchId } = opts;
  const registry = opts.registry ?? getConversionDestinations();
  const maxAttempts = opts.maxAttempts ?? 5;

  const rows = await db
    .select({
      dispatch: conversionDispatches,
      conversion: conversions,
      contact: contacts,
    })
    .from(conversionDispatches)
    .innerJoin(
      conversions,
      eq(conversionDispatches.conversionId, conversions.id),
    )
    .innerJoin(contacts, eq(conversions.contactId, contacts.id))
    .where(
      and(
        eq(conversionDispatches.id, dispatchId),
        inArray(conversionDispatches.status, ["pending"]),
      ),
    )
    .limit(1);
  const row = rows[0];
  if (!row) return { status: "skipped" };

  const destination = registry?.get(row.dispatch.destinationId);
  if (!destination) {
    await db
      .update(conversionDispatches)
      .set({ status: "failed", lastError: "destination not registered" })
      .where(eq(conversionDispatches.id, dispatchId));
    logger.warn("conversion dispatch: destination not registered", {
      destinationId: row.dispatch.destinationId,
    });
    return { status: "failed" };
  }

  // Need the triggering event's name for platform event mapping.
  const eventRows = await db
    .select({ event: userEvents.event })
    .from(userEvents)
    .where(eq(userEvents.id, row.conversion.eventId))
    .limit(1);

  const clicks = await recoverClickContext({
    db,
    userKey: row.conversion.userKey,
    before: row.conversion.occurredAt,
  });

  const input: ConversionDispatchInput = {
    eventId: row.dispatch.eventId,
    definitionId: row.conversion.definitionId,
    triggerEvent: eventRows[0]?.event ?? "",
    value: row.conversion.value,
    currency: row.conversion.currency,
    occurredAt: row.conversion.occurredAt.getTime(),
    contact: {
      ...(row.contact.email ? { email: row.contact.email } : {}),
      ...(row.contact.externalId ? { externalId: row.contact.externalId } : {}),
      ...(row.contact.anonymousId
        ? { anonymousId: row.contact.anonymousId }
        : {}),
      ...(typeof row.contact.properties?.phone === "string"
        ? { phone: row.contact.properties.phone }
        : {}),
    },
    clicks,
  };

  const attempt = row.dispatch.attempts + 1;
  try {
    const result = await destination.send(input);
    await db
      .update(conversionDispatches)
      .set({
        status: "delivered",
        attempts: attempt,
        response: result.response ?? null,
        lastError: null,
        deliveredAt: new Date(),
      })
      .where(eq(conversionDispatches.id, dispatchId));
    logger.info("conversion dispatched", {
      destination: destination.meta.id,
      definition: row.conversion.definitionId,
      value: row.conversion.value,
    });
    return { status: "delivered" };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    const exhausted = attempt >= maxAttempts;
    await db
      .update(conversionDispatches)
      .set({
        attempts: attempt,
        lastError: message,
        ...(exhausted ? { status: "failed" as const } : {}),
      })
      .where(eq(conversionDispatches.id, dispatchId));
    logger.warn("conversion dispatch attempt failed", {
      destination: destination.meta.id,
      attempt,
      exhausted,
      error: message,
    });
    if (exhausted) return { status: "failed" };
    throw err; // let the durable task retry
  }
}

// Narrow structural type so the ingest hook can enqueue without importing the
// full Hatchet client type.
export interface ConversionDispatchTask {
  runNoWait(input: { dispatchId: string }): unknown;
}

// The durable task reference, set by `createHogsendClient` (the composition
// root imports the workflow module; this lib cannot — it would cycle).
// Deliberately UNSET when the container runs with a hatchet override (tests):
// dispatch rows stay pending and tests drive delivery directly.
const taskSingleton = createOptionalSingleton<ConversionDispatchTask>();
export const setConversionDispatchTask = taskSingleton.set;
export const getConversionDispatchTask = taskSingleton.get;
/** Reset the singleton — only for test cleanup. */
export const resetConversionDispatchTask = taskSingleton.reset;

/**
 * Ingest-side fan-out: create dispatch rows for a fired conversion and
 * enqueue the durable task for each fresh row. Best-effort — the conversion
 * row is already durable; a failed enqueue is retriable via the row's
 * pending status (a future reaper can re-drive).
 */
export async function enqueueConversionDispatches(opts: {
  db: Database;
  logger: Logger;
  task?: ConversionDispatchTask;
  conversionId: string;
  eventId: string;
  destinationIds: string[];
}): Promise<void> {
  const task = opts.task ?? getConversionDispatchTask();
  const created = await createConversionDispatches({
    db: opts.db,
    conversionId: opts.conversionId,
    eventId: opts.eventId,
    destinationIds: opts.destinationIds,
  });
  for (const dispatchId of created) {
    try {
      await task?.runNoWait({ dispatchId });
    } catch (err) {
      opts.logger.warn(
        "conversion dispatch enqueue failed (row stays pending)",
        {
          dispatchId,
          error: err instanceof Error ? err.message : String(err),
        },
      );
    }
  }
}
