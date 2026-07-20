import { canonicalStageRank } from "@hogsend/core";
import { type Database, funnelProgress } from "@hogsend/db";
import type { FunnelRegistry } from "./funnel-registry.js";
import { resolveFunnelTargets } from "./funnel-transitions.js";
import type { Logger } from "./logger.js";

/**
 * Event-funnel REPORTING projection —
 * one first-reach row per (contact, funnel, stage), the raw material for
 * progression counts ("how many reached activated") and velocity ("median
 * time signed_up → activated"). Complements the deals projection the
 * transition machinery (funnel-transitions.ts) maintains: deals hold ONE
 * current stage + money timestamps; this holds every stage's first-reach
 * instant, which is what progression rates and velocity medians read.
 *
 * Targets come from {@link resolveFunnelTargets} — the SAME gates and
 * winner selection as the deal mover, so the two projections can never
 * disagree about what counts as a stage event. `lost` is a deal outcome,
 * not progress, and is skipped; the unique (contact, funnel, stage) index
 * absorbs replays and repeats — `reachedAt` is FIRST reach by construction.
 */
export async function recordFunnelProgressAtIngest(opts: {
  db: Database;
  logger: Logger;
  funnels: FunnelRegistry | undefined;
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
}): Promise<{ reached: number }> {
  const { db, logger, funnels, event, eventRowId, contactId, userKey } = opts;
  if (!funnels) return { reached: 0 };
  const targets = resolveFunnelTargets({ funnels, event });

  let reached = 0;
  for (const { funnel, target } of targets) {
    if (target === "lost") continue;
    const rank = canonicalStageRank(target, funnel.ladder);
    if (rank === null || rank < 0) continue;
    const inserted = await db
      .insert(funnelProgress)
      .values({
        contactId,
        userKey,
        funnelId: funnel.meta.id,
        stage: target,
        stageRank: rank,
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
        funnel: funnel.meta.id,
        stage: target,
        userKey,
      });
    }
  }
  return { reached };
}
