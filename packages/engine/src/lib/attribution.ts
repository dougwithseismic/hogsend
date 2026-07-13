import {
  type AttributionTouchpoint,
  computeAllModels,
} from "@hogsend/attribution";
import { TOUCHPOINT_EVENTS, touchpointChannel } from "@hogsend/core";
import {
  attributionCredits,
  type Database,
  emailSends,
  journeyStates,
  userEvents,
} from "@hogsend/db";
import { and, asc, eq, gte, inArray, lte } from "drizzle-orm";
import type { Logger } from "./logger.js";

/**
 * Attribution scope carried per touchpoint into the ledger row
 * (docs/attribution-impact-plan.md §1.3). All nullable — a touch outside any
 * journey/campaign has none.
 */
interface TouchScope {
  journeyId: string | null;
  campaignId: string | null;
  templateKey: string | null;
  funnelId: string | null;
}

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** A property value usable as a scope id (scalar string, non-empty). */
function scopeString(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

/** Like {@link scopeString} but must be a uuid (campaign_id column is uuid). */
function scopeUuid(value: unknown): string | null {
  const str = scopeString(value);
  return str && UUID_RE.test(str) ? str : null;
}

/**
 * Resolve each touchpoint's attribution scope from its stamped properties
 * (`pushTrackingEvent` stamps journeyId/campaignId/templateKey — plan §1.2).
 * Events ingested BEFORE stamping carry an `emailSendId` but no
 * `journeyId`/`campaignId` keys at all (post-stamp events carry explicit
 * nulls) — those fall back to one batched email_sends → journey_states join.
 * SMS pre-stamp events are left unscoped: scope stamping landed days after
 * the SMS channel itself, so the unscoped window is negligible and not worth
 * a second join path.
 */
async function resolveTouchScopes(
  db: Database,
  rows: Array<{ id: string; properties: Record<string, unknown> | null }>,
): Promise<Map<string, TouchScope>> {
  const scopes = new Map<string, TouchScope>();
  /** Pre-stamp email touches: eventRowId → emailSendId, backfilled via join. */
  const fallback = new Map<string, string>();

  for (const row of rows) {
    const props = row.properties ?? {};
    const stamped = "journeyId" in props || "campaignId" in props;
    const emailSendId = scopeString(props.emailSendId);
    if (!stamped && emailSendId) fallback.set(row.id, emailSendId);
    scopes.set(row.id, {
      journeyId: scopeString(props.journeyId),
      campaignId: scopeUuid(props.campaignId),
      templateKey: scopeString(props.templateKey),
      // No touch event stamps funnel scope today; accept either spelling if
      // one ever does (money/deal events use snake_case on the spine).
      funnelId: scopeString(props.funnelId) ?? scopeString(props.funnel_id),
    });
  }

  if (fallback.size > 0) {
    const sendRows = await db
      .select({
        id: emailSends.id,
        campaignId: emailSends.campaignId,
        templateKey: emailSends.templateKey,
        journeyId: journeyStates.journeyId,
      })
      .from(emailSends)
      .leftJoin(journeyStates, eq(emailSends.journeyStateId, journeyStates.id))
      .where(inArray(emailSends.id, [...new Set(fallback.values())]));
    const bySendId = new Map(sendRows.map((send) => [send.id, send]));
    for (const [eventRowId, emailSendId] of fallback) {
      const send = bySendId.get(emailSendId);
      if (!send) continue;
      const scope = scopes.get(eventRowId);
      if (!scope) continue;
      scope.journeyId = send.journeyId;
      scope.campaignId = send.campaignId;
      scope.templateKey ??= send.templateKey;
    }
  }

  return scopes;
}

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
      properties: userEvents.properties,
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

  const scopes = await resolveTouchScopes(db, rows);

  const byId = new Map(touchpoints.map((t) => [t.id, t]));
  const allModels = computeAllModels(touchpoints, {
    conversionAt: occurredAt.getTime(),
  });

  const values = Object.entries(allModels).flatMap(([model, credits]) =>
    credits.map((credit) => {
      const touch = byId.get(credit.touchpointId) as AttributionTouchpoint;
      const scope = scopes.get(credit.touchpointId);
      return {
        conversionId,
        model,
        touchpointEventId: credit.touchpointId,
        touchpointEvent: touch.event,
        channel: touch.channel,
        touchpointAt: new Date(touch.occurredAt),
        journeyId: scope?.journeyId ?? null,
        campaignId: scope?.campaignId ?? null,
        templateKey: scope?.templateKey ?? null,
        funnelId: scope?.funnelId ?? null,
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
