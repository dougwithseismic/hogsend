import type { HatchetClient } from "@hatchet-dev/typescript-sdk/v1/index.js";
import type { AnalyticsProvider, PipelineLadder } from "@hogsend/core";
import type { JourneyRegistry } from "@hogsend/core/registry";
import type { Database } from "@hogsend/db";
import type { AppliedStageChange } from "./crm-deals.js";
import { DEAL_QUOTED, DEAL_SOLD } from "./crm-ingest.js";
import { ingestEvent } from "./ingestion.js";
import type { Logger } from "./logger.js";
import { type CrmDealEventPayload, emitOutbound } from "./outbound.js";

/**
 * Mint the once-per-deal money events (`deal.quoted`/`deal.sold`) after a
 * projection apply — the shared tail of BOTH stage-change producers (the
 * CRM ingest sink and the event-trigger path). Freshness is the projection
 * row's fact (`freshQuoted`/`freshSold`), so whichever producer reaches a
 * milestone first mints it; the idempotency key only guards replays of the
 * same mint.
 */
export async function mintDealMoneyEvents(opts: {
  db: Database;
  registry: JourneyRegistry;
  hatchet: HatchetClient;
  logger: Logger;
  analytics?: AnalyticsProvider;
  applied: AppliedStageChange;
  ladder: PipelineLadder;
  /** `crm-canonical:${provider}:${dealId}` | `funnel-canonical:${funnelId}:${externalId}` */
  idempotencyPrefix: string;
  source: string;
  userId: string;
  userEmail?: string;
  contactId: string;
  /** Path-specific extras; the helper adds `canonical_stage` itself. */
  baseProperties: Record<string, unknown>;
  occurredAt: string;
  outboundPayload: CrmDealEventPayload;
}): Promise<void> {
  const { applied, ladder } = opts;
  const moneyEvents: Array<typeof DEAL_QUOTED | typeof DEAL_SOLD> = [
    ...(applied.freshQuoted ? [DEAL_QUOTED] : []),
    ...(applied.freshSold ? [DEAL_SOLD] : []),
  ];
  for (const moneyEvent of moneyEvents) {
    // The idempotency key keeps the SEMANTIC literal (stable across ladder
    // edits); the event property carries the ladder's actual stage id.
    const semantic = moneyEvent === DEAL_QUOTED ? "quoted" : "sold";
    const stage =
      (moneyEvent === DEAL_QUOTED ? ladder.quotedStage : ladder.soldStage) ??
      semantic;
    const idempotencyKey = `${opts.idempotencyPrefix}:${semantic}`;
    await ingestEvent({
      db: opts.db,
      registry: opts.registry,
      hatchet: opts.hatchet,
      logger: opts.logger,
      analytics: opts.analytics,
      event: {
        event: moneyEvent,
        userId: opts.userId,
        ...(opts.userEmail ? { userEmail: opts.userEmail } : {}),
        contactId: opts.contactId,
        eventProperties: { ...opts.baseProperties, canonical_stage: stage },
        ...(applied.value !== null
          ? {
              value: applied.value,
              ...(applied.currency ? { currency: applied.currency } : {}),
            }
          : {}),
        occurredAt: opts.occurredAt,
        idempotencyKey,
        source: opts.source,
      },
    });
    void emitOutbound({
      db: opts.db,
      hatchet: opts.hatchet,
      logger: opts.logger,
      event: moneyEvent,
      payload: opts.outboundPayload,
      dedupeKey: idempotencyKey,
    }).catch((err) =>
      opts.logger.warn("deal money outbound emit failed", { err }),
    );
  }
}
