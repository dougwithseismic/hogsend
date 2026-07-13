import type { DefinedConversion } from "@hogsend/core";
import {
  conversionSourceAllowed,
  defineConversion,
  evaluatePropertyConditions,
  resolveConversionValue,
} from "@hogsend/core";
import { conversions, type Database } from "@hogsend/db";
import type { Logger } from "./logger.js";
import { REVENUE_EXCLUDED_EVENTS } from "./revenue.js";
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

/**
 * Registry: definitions indexed by trigger event name. `trigger.event: "*"`
 * is a WILDCARD (impact plan §5.2): the definition is a candidate for EVERY
 * ingested event, narrowed only by its `where`/`sources` gates — how the
 * built-in zero-config `revenue` conversion matches any trusted valued
 * event without naming it.
 */
export class ConversionRegistry {
  private byEvent = new Map<string, DefinedConversion[]>();
  private wildcard: DefinedConversion[] = [];
  private all: DefinedConversion[] = [];

  constructor(definitions: DefinedConversion[] = []) {
    for (const def of definitions) {
      if (def.meta.trigger.event === "*") {
        this.wildcard.push(def);
      } else {
        const list = this.byEvent.get(def.meta.trigger.event) ?? [];
        list.push(def);
        this.byEvent.set(def.meta.trigger.event, list);
      }
      this.all.push(def);
    }
  }

  forEvent(event: string): DefinedConversion[] {
    const named = this.byEvent.get(event);
    if (this.wildcard.length === 0) return named ?? [];
    return [...(named ?? []), ...this.wildcard];
  }

  getAll(): DefinedConversion[] {
    return [...this.all];
  }

  count(): number {
    return this.all.length;
  }
}

const singleton = createOptionalSingleton<ConversionRegistry>();
export const setConversionRegistry = singleton.set;
export const getConversionRegistry = singleton.get;
/** Reset the singleton — only for test cleanup. */
export const resetConversionRegistry = singleton.reset;

/**
 * The built-in zero-config revenue conversion (impact plan §5.2): any
 * TRUSTED valued event fires it — a fresh adopter who points one Stripe /
 * order webhook at a source sees the Impact tab populate with no
 * configuration. Seeded by `createHogsendClient` unless the consumer
 * authors their own `id: "revenue"` definition or sets
 * `HOGSEND_DEFAULT_REVENUE_CONVERSION=false`.
 *
 * Guards, matching the revenue-rollup semantics (lib/revenue.ts):
 *  - `value > 0` — valueless events never fire it;
 *  - quote-shaped events excluded (`crm.stage_changed` re-carries a deal's
 *    value on every change; a quote is unrealized money) — only
 *    `crm.deal_sold` and genuine order/subscription events count;
 *  - browser (`inapp`) events excluded by the default `sources` gate
 *    (forged-value guard).
 */
export const defaultRevenueConversion: DefinedConversion = defineConversion({
  id: "revenue",
  name: "Revenue",
  description:
    'Built-in: any trusted valued event (orders, subscriptions, crm.deal_sold). Author your own id:"revenue" definition to replace it.',
  trigger: {
    event: "*",
    where: [
      { type: "property", property: "value", operator: "gt", value: 0 },
      ...REVENUE_EXCLUDED_EVENTS.map((event) => ({
        type: "property" as const,
        property: "event",
        operator: "neq" as const,
        value: event,
      })),
    ],
  },
});

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
    // `currency` (money events like crm.deal_quoted carry no property twin)
    // AND the event NAME as `event` (lets wildcard definitions carve out
    // exclusions, e.g. the built-in revenue conversion skipping quote
    // events), so "quotes over £10k" is expressible; the columns win a name
    // collision.
    if (
      def.where &&
      def.where.length > 0 &&
      !evaluatePropertyConditions({
        conditions: def.where,
        properties: {
          ...event.properties,
          event: event.name,
          ...(event.value !== null
            ? {
                value: event.value,
                ...(event.currency ? { currency: event.currency } : {}),
              }
            : {}),
        },
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
        scopeJourneyId: def.meta.scope?.journeyId ?? null,
        scopeCampaignId: def.meta.scope?.campaignId ?? null,
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
