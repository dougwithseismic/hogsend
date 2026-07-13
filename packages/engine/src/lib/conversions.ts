import type { DefinedConversion } from "@hogsend/core";
import {
  conversionSourceAllowed,
  evaluatePropertyConditions,
  resolveConversionValue,
} from "@hogsend/core";
import { conversions, type Database } from "@hogsend/db";
import type { Logger } from "./logger.js";
import { createOptionalSingleton } from "./singleton.js";

/**
 * Conversion evaluation at ingest (docs/revenue-attribution-plan.md §5.1) —
 * the hook `ingestEvent` calls after a FRESH event insert. Definitions are
 * code-first (`createHogsendClient({ conversions })`); a fired instance is
 * recorded once per (definition, event row) — the unique index makes a
 * replayed evaluation a no-op, so this inherits the spine's idempotency.
 */

export interface FiredConversion {
  conversionId: string;
  definition: DefinedConversion;
  value: number | null;
  currency: string | null;
}

/** Registry: definitions indexed by trigger event name. */
export class ConversionRegistry {
  private byEvent = new Map<string, DefinedConversion[]>();
  private count_ = 0;

  constructor(definitions: DefinedConversion[] = []) {
    for (const def of definitions) {
      const list = this.byEvent.get(def.meta.trigger.event) ?? [];
      list.push(def);
      this.byEvent.set(def.meta.trigger.event, list);
      this.count_++;
    }
  }

  forEvent(event: string): DefinedConversion[] {
    return this.byEvent.get(event) ?? [];
  }

  count(): number {
    return this.count_;
  }
}

const singleton = createOptionalSingleton<ConversionRegistry>();
export const setConversionRegistry = singleton.set;
export const getConversionRegistry = singleton.get;
/** Reset the singleton — only for test cleanup. */
export const resetConversionRegistry = singleton.reset;

export async function evaluateConversionsAtIngest(opts: {
  db: Database;
  logger: Logger;
  registry: ConversionRegistry | undefined;
  event: {
    name: string;
    source: string | null;
    properties: Record<string, unknown>;
    value: number | null;
    currency: string | null;
    occurredAt: Date;
  };
  eventRowId: string;
  contactId: string;
  userKey: string;
}): Promise<FiredConversion[]> {
  const { db, logger, registry, event, eventRowId, contactId, userKey } = opts;
  if (!registry) return [];
  const candidates = registry.forEvent(event.name);
  if (candidates.length === 0) return [];

  const fired: FiredConversion[] = [];
  for (const def of candidates) {
    if (!conversionSourceAllowed(def, event.source)) {
      logger.debug("conversion skipped: source not allowed", {
        definition: def.meta.id,
        source: event.source,
      });
      continue;
    }
    // `where` sees the event's first-class value/currency as `value`/
    // `currency` (money events like deal.quoted carry no property twin),
    // so "quotes over £10k" is expressible; the columns win a name collision.
    if (
      def.where &&
      def.where.length > 0 &&
      !evaluatePropertyConditions({
        conditions: def.where,
        properties:
          event.value !== null
            ? {
                ...event.properties,
                value: event.value,
                ...(event.currency ? { currency: event.currency } : {}),
              }
            : event.properties,
      })
    ) {
      continue;
    }

    const { value, currency } = resolveConversionValue(def, {
      value: event.value,
      currency: event.currency,
      properties: event.properties,
    });

    const inserted = await db
      .insert(conversions)
      .values({
        definitionId: def.meta.id,
        contactId,
        userKey,
        eventId: eventRowId,
        value,
        currency,
        occurredAt: event.occurredAt,
      })
      .onConflictDoNothing({
        target: [conversions.definitionId, conversions.eventId],
      })
      .returning({ id: conversions.id });

    if (inserted[0]) {
      fired.push({
        conversionId: inserted[0].id,
        definition: def,
        value,
        currency,
      });
      logger.info("conversion fired", {
        definition: def.meta.id,
        value,
        currency,
        userKey,
      });
    }
  }
  return fired;
}
