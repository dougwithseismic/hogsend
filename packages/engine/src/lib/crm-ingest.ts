import type { HatchetClient } from "@hatchet-dev/typescript-sdk/v1/index.js";
import type { AnalyticsProvider, CrmStageEvent } from "@hogsend/core";
import type { JourneyRegistry } from "@hogsend/core/registry";
import type { Database } from "@hogsend/db";
import { ingestEvent } from "./ingestion.js";
import type { Logger } from "./logger.js";

/**
 * Land normalized {@link CrmStageEvent}s on the event spine as
 * `crm.stage_changed` — the shared sink of BOTH the webhook route and the
 * reconciliation poll (docs/revenue-attribution-plan.md §4).
 *
 * The idempotency key is derived from the CRM's OWN identifiers + change
 * timestamp, so the same transition observed twice (webhook AND poll, or a
 * provider retry) inserts exactly once, while a genuinely re-entered stage
 * (different `occurredAt`) is a new event. Deal value rides first-class
 * (`value`/`currency`) — the revenue spine — and native pipeline/stage ids
 * ride as flat properties (the per-client canonical stage map consumes them
 * downstream).
 *
 * Identity: events carrying an `email` resolve top-down (same anchor the
 * sourcing path uses). Events without an email are SKIPPED with a warn until
 * the `crm_links` alias map lands (plan §4.2) — a provider should populate
 * `email` whenever its payload/hydrate can.
 */

export const CRM_STAGE_CHANGED = "crm.stage_changed" as const;

export async function ingestCrmStageEvents(opts: {
  db: Database;
  registry: JourneyRegistry;
  hatchet: HatchetClient;
  logger: Logger;
  analytics?: AnalyticsProvider;
  providerId: string;
  events: CrmStageEvent[];
}): Promise<{ ingested: number; skipped: number }> {
  const { db, registry, hatchet, logger, analytics, providerId, events } = opts;
  let ingested = 0;
  let skipped = 0;

  for (const event of events) {
    if (!event.email) {
      logger.warn("crm.stage_changed skipped: no resolvable identity", {
        provider: providerId,
        dealId: event.dealId,
        stageId: event.stageId,
      });
      skipped++;
      continue;
    }

    const idempotencyKey = [
      "crm",
      providerId,
      event.dealId,
      event.pipelineId ?? "",
      event.stageId,
      event.status ?? "",
      event.occurredAt,
    ].join(":");

    try {
      await ingestEvent({
        db,
        registry,
        hatchet,
        logger,
        analytics,
        event: {
          event: CRM_STAGE_CHANGED,
          userEmail: event.email,
          eventProperties: {
            crm: providerId,
            deal_id: event.dealId,
            ...(event.contactId ? { contact_id: event.contactId } : {}),
            ...(event.pipelineId ? { pipeline_id: event.pipelineId } : {}),
            stage_id: event.stageId,
            ...(event.stageName ? { stage_name: event.stageName } : {}),
            ...(event.status ? { status: event.status } : {}),
          },
          ...(event.value
            ? {
                value: event.value.amount,
                ...(event.value.currency
                  ? { currency: event.value.currency }
                  : {}),
              }
            : {}),
          occurredAt: event.occurredAt,
          idempotencyKey,
          source: "crm",
        },
      });
      ingested++;
    } catch (err) {
      logger.warn("crm.stage_changed ingest failed", {
        provider: providerId,
        dealId: event.dealId,
        error: err instanceof Error ? err.message : String(err),
      });
      skipped++;
    }
  }

  return { ingested, skipped };
}
