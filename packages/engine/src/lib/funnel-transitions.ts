import type { HatchetClient } from "@hatchet-dev/typescript-sdk/v1/index.js";
import type { AnalyticsProvider, DefinedFunnel } from "@hogsend/core";
import {
  canonicalStageRank,
  evaluatePropertyConditions,
  overlayEventMoney,
  sourceAllowed,
} from "@hogsend/core";
import type { JourneyRegistry } from "@hogsend/core/registry";
import { type Database, deals } from "@hogsend/db";
import { and, desc, eq, isNull, sql } from "drizzle-orm";
import { applyCrmStageEvent, EVENTS_DEAL_PROVIDER } from "./crm-deals.js";
import { FUNNEL_STAGE_CHANGED } from "./crm-ingest.js";
import { mintDealMoneyEvents } from "./deal-money-events.js";
import type { FunnelRegistry } from "./funnel-registry.js";
import type { Logger } from "./logger.js";
import { emitOutbound } from "./outbound.js";

/**
 * Event-driven funnel stage transitions — the step-(5d) ingest hook. For
 * each funnel whose `on`/`lostOn` triggers match the just-stored event:
 * trust-gate the source, evaluate the `where` conditions, pick the winning
 * stage, and apply it to the contact's open deal in that funnel (one deal
 * per contact per funnel, across producers — an open CRM-born row is moved
 * in place; no open deal mints a synthetic `events`-provider row). Money
 * milestones ride the same projection freshness as the CRM path, so
 * whichever producer reaches a milestone first mints it.
 *
 * The triggering event IS already on the spine, so this path never ingests
 * a `funnel.stage_changed` twin — it emits outbound only. Loop safety is
 * define-time: `deal.`/`funnel.`/`crm.` events are rejected as triggers, so
 * the money events this hook mints can never re-enter it.
 */
export async function applyFunnelTransitionsAtIngest(opts: {
  db: Database;
  registry: JourneyRegistry;
  hatchet: HatchetClient;
  logger: Logger;
  analytics?: AnalyticsProvider;
  funnels: FunnelRegistry;
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
}): Promise<void> {
  const {
    db,
    registry,
    hatchet,
    logger,
    analytics,
    funnels,
    event,
    eventRowId,
    contactId,
    userKey,
  } = opts;

  const matches = funnels.transitionsFor(event.name);
  if (matches.length === 0) return;

  const whereProperties = overlayEventMoney(
    event.properties,
    event.value,
    event.currency,
  );

  // Group per funnel, then pick each funnel's winning stage: the highest-
  // ranked matching positive stage; `lost` only wins unopposed.
  const byFunnel = new Map<
    string,
    { funnel: DefinedFunnel; stages: string[] }
  >();
  for (const { funnel, transition } of matches) {
    if (!sourceAllowed(funnel.meta.sources, event.source)) {
      logger.debug("funnel transition skipped: source not allowed", {
        funnel: funnel.meta.id,
        event: event.name,
        source: event.source,
      });
      continue;
    }
    if (
      transition.where &&
      !evaluatePropertyConditions({
        conditions: transition.where,
        properties: whereProperties,
      })
    ) {
      continue;
    }
    const entry = byFunnel.get(funnel.meta.id) ?? { funnel, stages: [] };
    entry.stages.push(transition.stageId);
    byFunnel.set(funnel.meta.id, entry);
  }

  for (const { funnel, stages } of byFunnel.values()) {
    try {
      const positive = stages
        .filter((s) => s !== "lost")
        .sort(
          (a, b) =>
            (canonicalStageRank(b, funnel.ladder) ?? -1) -
            (canonicalStageRank(a, funnel.ladder) ?? -1),
        );
      const target = positive[0] ?? "lost";
      const funnelId = funnel.meta.id;

      // Explicit multi-deal: a `deal_id` event property addresses one deal
      // directly. Otherwise: the contact's open deal in THIS funnel,
      // whichever producer created it. A `lost` trigger only ever CLOSES an
      // existing deal — with none (open, or seen under the explicit id) it
      // is a no-op, never a row born lost.
      const rawDealId = event.properties.deal_id;
      const explicitDealId =
        typeof rawDealId === "string" || typeof rawDealId === "number"
          ? String(rawDealId)
          : null;
      let provider = EVENTS_DEAL_PROVIDER;
      let externalId = explicitDealId
        ? `${funnelId}:${contactId}:${explicitDealId}`
        : `${funnelId}:${contactId}`;
      let pipelineId: string | undefined;
      if (explicitDealId) {
        if (target === "lost") {
          const exists = await db
            .select({ id: deals.id })
            .from(deals)
            .where(
              and(
                eq(deals.provider, provider),
                eq(deals.externalId, externalId),
              ),
            )
            .limit(1);
          if (!exists[0]) continue;
        }
      } else {
        const open = await db
          .select({
            provider: deals.provider,
            externalId: deals.externalId,
            pipelineId: deals.pipelineId,
          })
          .from(deals)
          .where(
            and(
              eq(deals.funnelId, funnelId),
              eq(deals.contactId, contactId),
              isNull(deals.soldAt),
              isNull(deals.lostAt),
            ),
          )
          .orderBy(
            sql`${deals.lastStageAt} desc nulls last`,
            desc(deals.createdAt),
          )
          .limit(1);
        if (open[0]) {
          provider = open[0].provider;
          externalId = open[0].externalId;
          pipelineId = open[0].pipelineId ?? undefined;
        } else if (target === "lost") {
          continue;
        }
      }

      const applied = await applyCrmStageEvent({
        db,
        logger,
        providerId: provider,
        contactId,
        event: {
          dealId: externalId,
          stageId: target,
          ...(pipelineId ? { pipelineId } : {}),
          ...(event.value !== null
            ? {
                value: {
                  amount: event.value,
                  ...(event.currency ? { currency: event.currency } : {}),
                },
              }
            : {}),
          occurredAt: event.occurredAt.toISOString(),
        },
        canonicalStage: target,
        ladder: funnel.ladder,
        funnelId,
        // A new-cycle trigger colliding with a closed synthetic row must not
        // clobber its realized value (re-entry is deferred, not destructive).
        protectTerminalValue: true,
      });

      const outboundPayload = {
        provider,
        dealId: externalId,
        pipelineId: pipelineId ?? null,
        funnelId,
        canonicalStage: target,
        value: applied.value,
        currency: applied.currency,
        userId: userKey,
        at: event.occurredAt.toISOString(),
      };
      void emitOutbound({
        db,
        hatchet,
        logger,
        event: FUNNEL_STAGE_CHANGED,
        payload: {
          ...outboundPayload,
          stageId: target,
          stageName: null,
          status: null,
        },
        dedupeKey: `funnel-stage:${funnelId}:${externalId}:${target}:${eventRowId}`,
      }).catch((err) => logger.warn("funnel outbound emit failed", { err }));

      await mintDealMoneyEvents({
        db,
        registry,
        hatchet,
        logger,
        analytics,
        applied,
        ladder: funnel.ladder,
        idempotencyPrefix: `funnel-canonical:${funnelId}:${externalId}`,
        source: "funnel",
        userId: userKey,
        contactId,
        baseProperties: {
          deal_id: externalId,
          funnel_id: funnelId,
          trigger_event: event.name,
        },
        occurredAt: event.occurredAt.toISOString(),
        outboundPayload,
      });
    } catch (err) {
      logger.warn("funnel transition failed", {
        funnel: funnel.meta.id,
        event: event.name,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }
}
