import { ConcurrencyLimitStrategy } from "@hatchet-dev/typescript-sdk/v1/index.js";
import { createDatabase, crmSyncCursors, type Database } from "@hogsend/db";
import { eq } from "drizzle-orm";
import { getJourneyRegistrySingleton } from "../journeys/registry-singleton.js";
import { getAnalytics } from "../lib/analytics-singleton.js";
import { ingestCrmStageEvents } from "../lib/crm-ingest.js";
import { getCrmSyncConfig } from "../lib/crm-registry-singleton.js";
import { hatchet } from "../lib/hatchet.js";
import { createLogger, type Logger } from "../lib/logger.js";

/**
 * CRM reconciliation poll — the pull
 * half of the webhook+poll hybrid. Every provider implementing `poll` is
 * walked on a cron: read the persisted cursor, pull changed deals, feed them
 * through the SAME `ingestCrmStageEvents` sink the webhook route uses (the
 * spine's idempotency dedups the overlap), persist the next cursor. A failing
 * provider records `lastError` on its cursor row and never blocks the others
 * — webhooks give latency, this poll guarantees eventual consistency.
 */

/** The sweep body — exported for direct testing; the cron task wraps it. */
export async function runCrmReconcile(deps: {
  db: Database;
  logger: Logger;
  /** Test seam — defaults to the process Hatchet client. */
  hatchet?: typeof hatchet;
}): Promise<{ polled: number; ingested: number }> {
  const { db, logger } = deps;
  const hatchetClient = deps.hatchet ?? hatchet;
  const config = getCrmSyncConfig();
  if (!config || config.registry.count() === 0) {
    return { polled: 0, ingested: 0 };
  }

  const registry = getJourneyRegistrySingleton();
  const analytics = getAnalytics();

  let polled = 0;
  let ingested = 0;

  for (const provider of config.registry.getAll()) {
    if (!provider.poll) continue;
    const providerId = provider.meta.id;

    const cursorRows = await db
      .select()
      .from(crmSyncCursors)
      .where(eq(crmSyncCursors.provider, providerId))
      .limit(1);
    const cursor = cursorRows[0]?.cursor ?? null;

    try {
      const result = await provider.poll(cursor);
      const sink = await ingestCrmStageEvents({
        db,
        registry,
        hatchet: hatchetClient,
        logger,
        analytics,
        providerId,
        events: result.events,
        funnels: config.funnels,
      });
      ingested += sink.ingested;
      polled++;

      await db
        .insert(crmSyncCursors)
        .values({
          provider: providerId,
          cursor: result.nextCursor,
          lastPolledAt: new Date(),
          lastError: null,
          updatedAt: new Date(),
        })
        .onConflictDoUpdate({
          target: crmSyncCursors.provider,
          set: {
            cursor: result.nextCursor,
            lastPolledAt: new Date(),
            lastError: null,
            updatedAt: new Date(),
          },
        });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      logger.warn("crm-reconcile provider poll failed", {
        provider: providerId,
        error: message,
      });
      await db
        .insert(crmSyncCursors)
        .values({
          provider: providerId,
          cursor,
          lastError: { message, at: new Date().toISOString() },
          updatedAt: new Date(),
        })
        .onConflictDoUpdate({
          target: crmSyncCursors.provider,
          set: {
            lastError: { message, at: new Date().toISOString() },
            updatedAt: new Date(),
          },
        });
    }
  }

  return { polled, ingested };
}

export const crmReconcileTask = hatchet.task({
  name: "crm-reconcile",
  onCrons: [process.env.CRM_RECONCILE_CRON ?? "*/10 * * * *"],
  retries: 1,
  executionTimeout: "300s",
  concurrency: {
    // Single global key → at most one sweep runs; the next QUEUES rather than
    // cancelling the in-flight run.
    expression: "'crm-reconcile'",
    maxRuns: 1,
    limitStrategy: ConcurrencyLimitStrategy.GROUP_ROUND_ROBIN,
  },
  fn: async () => {
    const { db } = createDatabase({ url: process.env.DATABASE_URL ?? "" });
    const logger = createLogger(process.env.LOG_LEVEL ?? "info");
    return runCrmReconcile({ db, logger });
  },
});
