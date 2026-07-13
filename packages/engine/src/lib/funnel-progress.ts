import { evaluatePropertyConditions } from "@hogsend/core";
import { type Database, funnelProgress } from "@hogsend/db";
import type { FunnelRegistry } from "./funnel-registry.js";
import type { Logger } from "./logger.js";

/**
 * Event-funnel projection writer (docs/attribution-impact-plan.md §3.3) —
 * the ingest hook that turns a matching event into a first-reach
 * `funnel_progress` row. Sibling of `evaluateConversionsAtIngest`: same
 * slot, same idempotency stance (the unique (contact, funnel, stage) index
 * makes any replay or repeat event a no-op — `reachedAt` is FIRST reach by
 * construction).
 *
 * `where` sees the event's first-class value/currency injected exactly like
 * conversion triggers do, so a stage like "orders over £100" is expressible.
 */
export async function recordFunnelProgressAtIngest(opts: {
  db: Database;
  logger: Logger;
  funnels: FunnelRegistry | undefined;
  event: {
    name: string;
    properties: Record<string, unknown>;
    value: number | null;
    currency: string | null;
    occurredAt: Date;
  };
  eventRowId: string;
  contactId: string;
  userKey: string;
}): Promise<{ reached: number }> {
  const { db, logger, funnels, event, eventRowId, contactId, userKey } = opts;
  if (!funnels?.hasEventStages()) return { reached: 0 };
  const claims = funnels.forEvent(event.name);
  if (claims.length === 0) return { reached: 0 };

  const properties =
    event.value !== null
      ? {
          ...event.properties,
          value: event.value,
          ...(event.currency ? { currency: event.currency } : {}),
        }
      : event.properties;

  let reached = 0;
  for (const claim of claims) {
    if (
      claim.where &&
      claim.where.length > 0 &&
      !evaluatePropertyConditions({ conditions: claim.where, properties })
    ) {
      continue;
    }
    const inserted = await db
      .insert(funnelProgress)
      .values({
        contactId,
        userKey,
        funnelId: claim.funnel.meta.id,
        stage: claim.stage,
        stageRank: claim.rank,
        reachedAt: event.occurredAt,
        eventId: eventRowId,
      })
      .onConflictDoNothing({
        target: [
          funnelProgress.contactId,
          funnelProgress.funnelId,
          funnelProgress.stage,
        ],
      })
      .returning({ id: funnelProgress.id });
    if (inserted[0]) {
      reached++;
      logger.debug("funnel stage reached", {
        funnel: claim.funnel.meta.id,
        stage: claim.stage,
        userKey,
      });
    }
  }
  return { reached };
}
