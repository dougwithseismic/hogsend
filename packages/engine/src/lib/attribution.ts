import {
  type AttributionTouchpoint,
  computeAllModels,
} from "@hogsend/attribution";
import { TOUCHPOINT_EVENTS, touchpointChannel } from "@hogsend/core";
import { attributionCredits, type Database, userEvents } from "@hogsend/db";
import { and, asc, eq, gte, inArray, lte } from "drizzle-orm";
import type { Logger } from "./logger.js";

/**
 * The attribution ledger writer (plan §6.1): when a conversion fires, read
 * the contact's touchpoint path inside the definition's lookback window and
 * persist EVERY model's credit allocation into `attribution_credits`.
 * Computing all models up front makes "switch the reporting model" a WHERE
 * clause instead of a historical re-derivation.
 *
 * Idempotent: the unique (conversion, model, touchpoint) index turns any
 * replay into a no-op — same inheritance as the conversion row itself.
 */
export async function recordAttributionCredits(opts: {
  db: Database;
  logger: Logger;
  conversionId: string;
  /** The contact's canonical event key (`user_events.user_id`). */
  userKey: string;
  value: number | null;
  currency: string | null;
  /** When the conversion happened. */
  occurredAt: Date;
  /** Lookback window in days (defineConversion attributionWindowDays). */
  windowDays: number;
}): Promise<{ touchpoints: number }> {
  const { db, logger, conversionId, userKey, value, currency, occurredAt } =
    opts;
  const windowStart = new Date(
    occurredAt.getTime() - opts.windowDays * 24 * 60 * 60 * 1000,
  );

  const rows = await db
    .select({
      id: userEvents.id,
      event: userEvents.event,
      occurredAt: userEvents.occurredAt,
    })
    .from(userEvents)
    .where(
      and(
        eq(userEvents.userId, userKey),
        inArray(userEvents.event, [...TOUCHPOINT_EVENTS]),
        gte(userEvents.occurredAt, windowStart),
        lte(userEvents.occurredAt, occurredAt),
      ),
    )
    .orderBy(asc(userEvents.occurredAt));

  const touchpoints: AttributionTouchpoint[] = [];
  for (const row of rows) {
    const channel = touchpointChannel(row.event);
    if (!channel) continue; // unreachable: the IN filter is the class list
    touchpoints.push({
      id: row.id,
      event: row.event,
      channel,
      occurredAt: row.occurredAt.getTime(),
    });
  }
  if (touchpoints.length === 0) {
    // No path — the conversion stays unattributed (reporting reads the gap
    // as conversion value minus credited value; we never invent a touch).
    return { touchpoints: 0 };
  }

  const byId = new Map(touchpoints.map((t) => [t.id, t]));
  const allModels = computeAllModels(touchpoints, {
    conversionAt: occurredAt.getTime(),
  });

  const values = Object.entries(allModels).flatMap(([model, credits]) =>
    credits.map((credit) => {
      const touch = byId.get(credit.touchpointId) as AttributionTouchpoint;
      return {
        conversionId,
        model,
        touchpointEventId: credit.touchpointId,
        touchpointEvent: touch.event,
        channel: touch.channel,
        touchpointAt: new Date(touch.occurredAt),
        weight: credit.weight,
        value:
          value !== null ? Math.round(credit.weight * value * 100) / 100 : null,
        currency: value !== null ? currency : null,
        convertedAt: occurredAt,
      };
    }),
  );

  await db
    .insert(attributionCredits)
    .values(values)
    .onConflictDoNothing({
      target: [
        attributionCredits.conversionId,
        attributionCredits.model,
        attributionCredits.touchpointEventId,
      ],
    });
  logger.debug("attribution credits recorded", {
    conversionId,
    touchpoints: touchpoints.length,
    rows: values.length,
  });
  return { touchpoints: touchpoints.length };
}
