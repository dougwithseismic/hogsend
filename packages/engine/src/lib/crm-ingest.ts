import type { HatchetClient } from "@hatchet-dev/typescript-sdk/v1/index.js";
import type { AnalyticsProvider, CrmStageEvent } from "@hogsend/core";
import { DEFAULT_PIPELINE_LADDER } from "@hogsend/core";
import type { JourneyRegistry } from "@hogsend/core/registry";
import { contacts, type Database } from "@hogsend/db";
import { eq } from "drizzle-orm";
import { resolveOrCreateContact } from "./contacts.js";
import {
  applyCrmStageEvent,
  ensureCrmLinks,
  resolveCrmLinkedContact,
} from "./crm-deals.js";
import type { FunnelRegistry } from "./funnel-registry.js";
import { ingestEvent } from "./ingestion.js";
import type { Logger } from "./logger.js";
import { emitOutbound } from "./outbound.js";

/**
 * Land normalized {@link CrmStageEvent}s on the spine — the shared sink of
 * BOTH the webhook route and the reconciliation poll
 * (docs/revenue-attribution-plan.md §4).
 *
 * Per event: (1) resolve the contact — `crm_links` alias first (works with
 * zero PII in the payload), else the payload email (minting the links so the
 * NEXT event resolves aliased); (2) ingest `crm.stage_changed` (valued, flat
 * native ids + the stage-map's canonical resolution, idempotent across
 * webhook/poll double-detection); (3) apply the deals projection (monotonic);
 * (4) on a FRESH canonical transition, ingest the money events
 * `crm.deal_quoted` / `crm.deal_sold` (once per deal per stage, ever) with
 * the projected deal value; (5) fan the family out on the outbound spine.
 */

export const CRM_STAGE_CHANGED = "crm.stage_changed" as const;
export const CRM_DEAL_QUOTED = "crm.deal_quoted" as const;
export const CRM_DEAL_SOLD = "crm.deal_sold" as const;

export async function ingestCrmStageEvents(opts: {
  db: Database;
  registry: JourneyRegistry;
  hatchet: HatchetClient;
  logger: Logger;
  analytics?: AnalyticsProvider;
  providerId: string;
  events: CrmStageEvent[];
  /** Funnel routing (which funnel claims each (provider, pipeline)). */
  funnels?: FunnelRegistry;
}): Promise<{ ingested: number; skipped: number }> {
  const {
    db,
    registry,
    hatchet,
    logger,
    analytics,
    providerId,
    events,
    funnels,
  } = opts;
  let ingested = 0;
  let skipped = 0;

  for (const event of events) {
    try {
      // (1) Identity: alias map first, then the payload email. The resolver
      // needs a KEY (the contactId pin alone is provenance, not identity), so
      // the links path loads the contact's canonical key and round-trips it
      // as userId — the pin guarantees it folds onto that exact row.
      let contactId: string | null = null;
      let canonicalKey: string | null = null;
      const linked = await resolveCrmLinkedContact({ db, providerId, event });
      if (linked) {
        const rows = await db
          .select({
            id: contacts.id,
            externalId: contacts.externalId,
            anonymousId: contacts.anonymousId,
          })
          .from(contacts)
          .where(eq(contacts.id, linked))
          .limit(1);
        if (rows[0]) {
          contactId = rows[0].id;
          canonicalKey =
            rows[0].externalId ?? rows[0].anonymousId ?? rows[0].id;
        }
      }
      if (!contactId && event.email) {
        const resolved = await resolveOrCreateContact({
          db,
          email: event.email,
        });
        contactId = resolved.id;
        canonicalKey = resolved.resolvedKey;
      }
      if (!contactId || !canonicalKey) {
        logger.warn("crm.stage_changed skipped: no resolvable identity", {
          provider: providerId,
          dealId: event.dealId,
          stageId: event.stageId,
        });
        skipped++;
        continue;
      }
      await ensureCrmLinks({ db, providerId, contactId, event });

      // Which funnel claims this (provider, pipeline)? The matched binding
      // translates native stage ids; a miss falls through to the SAME
      // funnel's provider-`"*"` binding (a `"*"` map doubles as a per-stage
      // fallback for the funnel's own pipeline-specific bindings), then the
      // universal won/lost status hint. The container always registers a
      // "default" funnel, so the built-in fallback only covers direct
      // callers.
      const claimed = funnels?.resolve(providerId, event.pipelineId);
      const funnel = claimed?.funnel;
      const funnelId = funnel?.meta.id ?? null;
      const ladder = funnel?.ladder ?? DEFAULT_PIPELINE_LADDER;

      // Callback-form resolvers are arbitrary consumer code: a throw must
      // not swallow the event (the route 200s and the poll cursor advances
      // regardless — the transition would be lost forever), and an output
      // outside the ladder must not be stamped verbatim onto a fresh deal.
      const resolveVia = (
        binding: NonNullable<typeof claimed>["binding"],
      ): string | null => {
        if (!binding) return null;
        try {
          const out = binding.resolve(event);
          if (out === null || out === "lost" || ladder.stages.includes(out)) {
            return out;
          }
          logger.warn("funnel binding resolved to a stage outside the ladder", {
            funnel: funnelId,
            provider: providerId,
            stageId: event.stageId,
            resolved: out,
          });
        } catch (error) {
          logger.warn("funnel binding resolve threw — treating as unmapped", {
            funnel: funnelId,
            provider: providerId,
            stageId: event.stageId,
            error: error instanceof Error ? error.message : String(error),
          });
        }
        return null;
      };
      const wildcardBinding =
        claimed?.binding?.pipeline === "*"
          ? undefined
          : funnel?.meta.bindings?.find(
              (b) => b.provider === providerId && b.pipeline === "*",
            );
      const canonicalStage =
        resolveVia(claimed?.binding) ??
        resolveVia(wildcardBinding) ??
        (event.status === "won"
          ? (ladder.soldStage ?? null)
          : event.status === "lost"
            ? "lost"
            : null);
      if (!canonicalStage) {
        logger.warn("crm stage unmapped — recording native ids only", {
          provider: providerId,
          pipelineId: event.pipelineId ?? null,
          stageId: event.stageId,
        });
      }

      // (2) The raw stage-change on the spine. Idempotency spans webhook+poll:
      // both observe the same CRM change timestamp.
      const idempotencyKey = [
        "crm",
        providerId,
        event.dealId,
        event.pipelineId ?? "",
        event.stageId,
        event.status ?? "",
        event.occurredAt,
      ].join(":");

      const result = await ingestEvent({
        db,
        registry,
        hatchet,
        logger,
        analytics,
        event: {
          event: CRM_STAGE_CHANGED,
          userId: canonicalKey,
          userEmail: event.email,
          contactId,
          eventProperties: {
            crm: providerId,
            deal_id: event.dealId,
            ...(event.contactId ? { contact_id: event.contactId } : {}),
            ...(event.pipelineId ? { pipeline_id: event.pipelineId } : {}),
            stage_id: event.stageId,
            ...(event.stageName ? { stage_name: event.stageName } : {}),
            ...(event.status ? { status: event.status } : {}),
            ...(canonicalStage ? { canonical_stage: canonicalStage } : {}),
            ...(funnelId ? { funnel_id: funnelId } : {}),
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
      if (!result.stored) {
        // Duplicate observation (webhook + poll): projection already applied.
        continue;
      }
      ingested++;

      // (3) Projection (monotonic; latest value wins).
      const applied = await applyCrmStageEvent({
        db,
        logger,
        providerId,
        contactId,
        event,
        canonicalStage,
        ladder,
        funnelId,
      });

      const outboundPayload = {
        provider: providerId,
        dealId: event.dealId,
        pipelineId: event.pipelineId ?? null,
        funnelId,
        canonicalStage,
        value: applied.value,
        currency: applied.currency,
        userId: result.contactKey,
        at: event.occurredAt,
      };
      void emitOutbound({
        db,
        hatchet,
        logger,
        event: CRM_STAGE_CHANGED,
        payload: {
          ...outboundPayload,
          stageId: event.stageId,
          stageName: event.stageName ?? null,
          status: event.status ?? null,
        },
        dedupeKey: idempotencyKey,
      }).catch((err) => logger.warn("crm outbound emit failed", { err }));

      // (4) The money events — once per deal per canonical stage, ever.
      const moneyEvents: Array<typeof CRM_DEAL_QUOTED | typeof CRM_DEAL_SOLD> =
        [
          ...(applied.freshQuoted ? [CRM_DEAL_QUOTED] : []),
          ...(applied.freshSold ? [CRM_DEAL_SOLD] : []),
        ];
      for (const moneyEvent of moneyEvents) {
        // The idempotency key keeps the SEMANTIC literal (stable across
        // ladder edits); the event property carries the ladder's actual
        // stage id (what a custom funnel calls it, e.g. "won").
        const semantic = moneyEvent === CRM_DEAL_QUOTED ? "quoted" : "sold";
        const stage =
          (moneyEvent === CRM_DEAL_QUOTED
            ? ladder.quotedStage
            : ladder.soldStage) ?? semantic;
        await ingestEvent({
          db,
          registry,
          hatchet,
          logger,
          analytics,
          event: {
            event: moneyEvent,
            userId: canonicalKey,
            userEmail: event.email,
            contactId,
            eventProperties: {
              crm: providerId,
              deal_id: event.dealId,
              ...(event.pipelineId ? { pipeline_id: event.pipelineId } : {}),
              ...(funnelId ? { funnel_id: funnelId } : {}),
              canonical_stage: stage,
            },
            ...(applied.value !== null
              ? {
                  value: applied.value,
                  ...(applied.currency ? { currency: applied.currency } : {}),
                }
              : {}),
            occurredAt: event.occurredAt,
            idempotencyKey: `crm-canonical:${providerId}:${event.dealId}:${semantic}`,
            source: "crm",
          },
        });
        void emitOutbound({
          db,
          hatchet,
          logger,
          event: moneyEvent,
          payload: outboundPayload,
          dedupeKey: `crm-canonical:${providerId}:${event.dealId}:${semantic}`,
        }).catch((err) => logger.warn("crm outbound emit failed", { err }));
      }
    } catch (err) {
      logger.warn("crm stage event ingest failed", {
        provider: providerId,
        dealId: event.dealId,
        error: err instanceof Error ? err.message : String(err),
      });
      skipped++;
    }
  }

  return { ingested, skipped };
}
