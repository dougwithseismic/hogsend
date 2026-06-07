import {
  deadLetterQueue,
  webhookDeliveries,
  webhookEndpoints,
} from "@hogsend/db";
import { and, eq, lt, or, sql } from "drizzle-orm";
import { getDb } from "../lib/db.js";
import { hatchet } from "../lib/hatchet.js";
import { createLogger } from "../lib/logger.js";
import { signWebhook } from "../lib/webhook-signing.js";

/**
 * Outbound webhook delivery — the durable per-(event × endpoint) POST attempt
 * plus the reaper cron that schedules retries and recovers orphaned `sending`
 * rows.
 *
 * Delivery model (Section 1.5, LOCKED decision 5/6): one `webhook_deliveries`
 * row + one `runNoWait` per endpoint (independent retry/backoff/dead-letter),
 * with a 1-minute reaper cron as the retry scheduler AND the orphan-`sending`
 * recovery — mirroring `reapStuckCampaignsTask`. Hatchet's own retry is OFF
 * (`retries: 0`); `nextRetryAt` is the single retry clock.
 *
 * The task signs from the FROZEN `payload` envelope on the row + the LIVE
 * endpoint secret read at delivery time, so a rotate-secret invalidates
 * in-flight deliveries to a compromised secret (acceptable under at-least-once).
 * The `body` that `signWebhook` produces is the EXACT bytes that are POSTed —
 * the payload is never re-serialized between sign and send (Open Risk 8).
 */

/** Statuses that are TERMINAL — a duplicate/late enqueue must not re-deliver. */
const TERMINAL_STATUSES = ["delivered", "failed", "discarded"] as const;

/** Max delivery attempts before the row is dead-lettered (env-tunable). */
const MAX_ATTEMPTS = Number(process.env.OUTBOUND_WEBHOOK_MAX_ATTEMPTS ?? 8);
/** Per-attempt POST timeout (AbortController), ms. */
const TIMEOUT_MS = Number(process.env.OUTBOUND_WEBHOOK_TIMEOUT_MS ?? 15000);
/** Exponential backoff base, ms. delay = BASE * 2^attempt + jitter(0..BASE). */
const BASE_DELAY_MS = Number(
  process.env.OUTBOUND_WEBHOOK_BASE_DELAY_MS ?? 5000,
);
/** Backoff ceiling, ms (default 6h). */
const MAX_DELAY_MS = Number(
  process.env.OUTBOUND_WEBHOOK_MAX_DELAY_MS ?? 6 * 60 * 60 * 1000,
);
/** A `sending` row older than this (no live run) is re-driven by the reaper. */
const STUCK_AFTER_MS = Number(
  process.env.OUTBOUND_WEBHOOK_STUCK_AFTER_MS ?? 5 * 60 * 1000,
);

/** Response-body snippet cap persisted for forensics (≤1KB). */
const SNIPPET_MAX = 1024;

/**
 * Exponential backoff with full jitter, capped at `MAX_DELAY_MS`:
 *   min(BASE * 2^attempt + jitter(0..BASE), MAX_DELAY).
 * `attempt` is the (already-incremented) attempt count, so the FIRST retry after
 * one failed attempt waits ~`BASE * 2` (a real backoff, not a near-zero retry).
 */
function backoffMs(attempt: number): number {
  const exp = BASE_DELAY_MS * 2 ** attempt;
  const jitter = Math.floor(Math.random() * BASE_DELAY_MS);
  return Math.min(exp + jitter, MAX_DELAY_MS);
}

/**
 * Retry classification (mirrors `plugin-resend` `isRetryableStatusCode`, with
 * the `408`/`429` carve-outs from Section 1.5 step 7). Network/timeout failures
 * (no HTTP status) are retryable and handled by the caller (status === null).
 *
 * A persistent 4xx (e.g. `410 Gone`, `400 Bad Request`) is NOT retryable — a
 * misconfigured/decommissioned endpoint should fast-fail, not burn 8 attempts.
 * `408 Request Timeout` and `429 Too Many Requests` are the retryable 4xx
 * exceptions; everything `>= 500` is retryable.
 */
function isRetryableStatus(status: number): boolean {
  if (status === 408 || status === 429) return true;
  if (status >= 500) return true;
  return false;
}

/**
 * One durable delivery attempt for a single `webhook_deliveries` row.
 *
 * `retries: 0` — the reaper (driven off `nextRetryAt`) is the retry scheduler,
 * NOT Hatchet's own backoff (which would double up on the reaper's). The CAS to
 * `sending` (step 3) prevents an overlapping reaper re-drive from double-POSTing
 * the same row.
 */
export const deliverWebhookTask = hatchet.task({
  name: "deliver-webhook",
  retries: 0,
  executionTimeout: "30s",
  fn: async (input: { deliveryId: string }) => {
    const db = getDb();
    const logger = createLogger(process.env.LOG_LEVEL ?? "info");

    // (1) Load the delivery row. Absent → nothing to do (a hard delete cascaded
    // it away between enqueue and run).
    const [row] = await db
      .select()
      .from(webhookDeliveries)
      .where(eq(webhookDeliveries.id, input.deliveryId))
      .limit(1);
    if (!row) {
      return { status: "skipped", reason: "not_found" as const };
    }
    // Already terminal — a duplicate/late enqueue (or a reaper re-drive that
    // raced a just-finished run) must not re-deliver.
    if ((TERMINAL_STATUSES as readonly string[]).includes(row.status)) {
      return { status: row.status, skipped: true };
    }

    // (2) Load the endpoint. Absent (cascade-deleted) OR disabled → `discarded`:
    // an operator action, NOT a delivery error, so it is NOT dead-lettered.
    const [endpoint] = await db
      .select()
      .from(webhookEndpoints)
      .where(eq(webhookEndpoints.id, row.endpointId))
      .limit(1);
    if (!endpoint || endpoint.disabled) {
      await db
        .update(webhookDeliveries)
        .set({
          status: "discarded",
          nextRetryAt: null,
          updatedAt: new Date(),
        })
        .where(eq(webhookDeliveries.id, row.id));
      return {
        status: "discarded" as const,
        reason: endpoint
          ? ("endpoint_disabled" as const)
          : ("endpoint_deleted" as const),
      };
    }

    // (3) CAS the row to `sending` so an overlapping reaper re-drive cannot
    // double-POST. The status guard (still non-terminal) makes a concurrent
    // claim affect zero rows; the loser of the race bails out here.
    const claimed = await db
      .update(webhookDeliveries)
      .set({
        status: "sending",
        lastAttemptAt: new Date(),
        updatedAt: new Date(),
      })
      .where(
        and(
          eq(webhookDeliveries.id, row.id),
          eq(webhookDeliveries.status, row.status),
        ),
      )
      .returning({ id: webhookDeliveries.id });
    if (claimed.length === 0) {
      return { status: "skipped", reason: "lost_cas" as const };
    }

    // (4) Sign from the FROZEN row payload + the LIVE endpoint secret. `body` is
    // the EXACT bytes signed AND sent — never re-serialize between sign and send
    // (Open Risk 8).
    const { headers, body } = signWebhook({
      id: row.webhookId,
      timestamp: Math.floor(Date.now() / 1000),
      payload: row.payload,
      secret: endpoint.secret,
    });

    // (5) POST with an AbortController timeout. A network error / timeout leaves
    // `responseStatus` null (a retryable failure, handled below).
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
    let responseStatus: number | null = null;
    let responseBodySnippet: string | null = null;
    let lastError: string | null = null;
    try {
      const res = await fetch(endpoint.url, {
        method: "POST",
        headers,
        body,
        signal: controller.signal,
      });
      responseStatus = res.status;
      const text = await res.text().catch(() => "");
      responseBodySnippet = text ? text.slice(0, SNIPPET_MAX) : null;
      if (responseStatus < 200 || responseStatus >= 300) {
        lastError = `HTTP ${responseStatus}`;
      }
    } catch (err) {
      lastError =
        err instanceof Error
          ? controller.signal.aborted
            ? `Timeout after ${TIMEOUT_MS}ms`
            : err.message
          : String(err);
    } finally {
      clearTimeout(timer);
    }

    const now = new Date();

    // (6) 2xx → delivered (TERMINAL). Also bump the endpoint's lastDeliveryAt.
    if (
      responseStatus !== null &&
      responseStatus >= 200 &&
      responseStatus < 300
    ) {
      await db
        .update(webhookDeliveries)
        .set({
          status: "delivered",
          attemptCount: row.attemptCount + 1,
          responseStatus,
          responseBodySnippet,
          deliveredAt: now,
          nextRetryAt: null,
          lastError: null,
          lastAttemptAt: now,
          updatedAt: now,
        })
        .where(eq(webhookDeliveries.id, row.id));
      await db
        .update(webhookEndpoints)
        .set({ lastDeliveryAt: now, updatedAt: now })
        .where(eq(webhookEndpoints.id, endpoint.id));
      logger.info("deliver-webhook: delivered", {
        deliveryId: row.id,
        endpointId: endpoint.id,
        eventType: row.eventType,
        responseStatus,
      });
      return { status: "delivered" as const, responseStatus };
    }

    const attemptCount = row.attemptCount + 1;

    // (7) Persistent-4xx fast-fail: a non-retryable client error (anything 4xx
    // except 408/429) is permanent after attempt >= 2 — a `410 Gone` must not
    // burn 8 attempts. The `>= 2` guard tolerates a single transient 4xx blip
    // before declaring the endpoint mis-configured.
    const httpFastFail =
      responseStatus !== null &&
      !isRetryableStatus(responseStatus) &&
      attemptCount >= 2;

    // (8) Retryable failure with attempts remaining → back to `pending` with the
    // next backoff deadline; the reaper re-drives it once `nextRetryAt` passes.
    if (!httpFastFail && attemptCount < MAX_ATTEMPTS) {
      const nextRetryAt = new Date(now.getTime() + backoffMs(attemptCount));
      await db
        .update(webhookDeliveries)
        .set({
          status: "pending",
          attemptCount,
          responseStatus,
          responseBodySnippet,
          nextRetryAt,
          lastError,
          lastAttemptAt: now,
          updatedAt: now,
        })
        .where(eq(webhookDeliveries.id, row.id));
      logger.warn("deliver-webhook: retry scheduled", {
        deliveryId: row.id,
        endpointId: endpoint.id,
        attemptCount,
        responseStatus,
        nextRetryAt: nextRetryAt.toISOString(),
        error: lastError,
      });
      return {
        status: "pending" as const,
        attemptCount,
        nextRetryAt: nextRetryAt.toISOString(),
      };
    }

    // (9) Exhausted (attempts >= MAX) OR a persistent-4xx fast-fail → `failed`
    // (TERMINAL) + a forensic `dead_letter_queue` mirror, in one transaction so
    // the terminal status and the DLQ row commit together. This is the DLQ's
    // first real producer (LOCKED decision 8).
    const exhaustError = `Exhausted ${attemptCount}: ${lastError ?? "unknown"}`;
    await db.transaction(async (tx) => {
      await tx
        .update(webhookDeliveries)
        .set({
          status: "failed",
          attemptCount,
          responseStatus,
          responseBodySnippet,
          nextRetryAt: null,
          lastError,
          lastAttemptAt: now,
          updatedAt: now,
        })
        .where(eq(webhookDeliveries.id, row.id));
      await tx.insert(deadLetterQueue).values({
        source: "webhook-delivery",
        sourceId: row.id,
        payload: {
          endpointId: endpoint.id,
          url: endpoint.url,
          eventType: row.eventType,
          webhookId: row.webhookId,
          body: row.payload,
        },
        error: exhaustError,
        retryCount: attemptCount,
        status: "pending",
      });
    });
    logger.error("deliver-webhook: failed (dead-lettered)", {
      deliveryId: row.id,
      endpointId: endpoint.id,
      eventType: row.eventType,
      attemptCount,
      responseStatus,
      fastFail: httpFastFail,
      error: lastError,
    });
    return { status: "failed" as const, attemptCount, fastFail: httpFastFail };
  },
});

/** Max rows a single reaper sweep re-drives (bounds the per-tick fan-out). */
const REAPER_BATCH = 500;

/**
 * Engine-owned reaper cron for outbound webhook deliveries (Section 1.5, cloned
 * from `reapStuckCampaignsTask`). It is BOTH the retry scheduler AND the
 * orphan-`sending` recovery:
 *
 *  - A `pending` row whose `nextRetryAt` has passed (or is null — a freshly
 *    enqueued row whose `runNoWait` failed at emit time) is re-driven.
 *  - A `sending` row whose worker died mid-POST (OOM/SIGKILL/timeout, so the JS
 *    never reached a terminal write) is re-driven once it is older than
 *    `STUCK_AFTER_MS` (measured from `updatedAt`, which step 3's CAS bumped).
 *
 * Recovery is `deliverWebhookTask.run({ deliveryId })`; the delivery task's own
 * `sending` CAS guard makes an overlap with a still-live run safe (the loser
 * no-ops). Self-bootstraps `db`/`logger` from `process.env` (cron runs have no
 * request container).
 */
export const reapDueWebhookDeliveriesTask = hatchet.task({
  name: "reap-due-webhook-deliveries",
  onCrons: [process.env.OUTBOUND_WEBHOOK_REAPER_CRON ?? "*/1 * * * *"],
  retries: 1,
  executionTimeout: "120s",
  fn: async () => {
    const db = getDb();
    const logger = createLogger(process.env.LOG_LEVEL ?? "info");

    const now = new Date();
    const stuckBefore = new Date(now.getTime() - STUCK_AFTER_MS);

    // Due-pending (retry clock elapsed or never set) OR stale-sending (orphan).
    const due = await db
      .select({ id: webhookDeliveries.id })
      .from(webhookDeliveries)
      .where(
        or(
          and(
            eq(webhookDeliveries.status, "pending"),
            or(
              sql`${webhookDeliveries.nextRetryAt} is null`,
              lt(webhookDeliveries.nextRetryAt, now),
            ),
          ),
          and(
            eq(webhookDeliveries.status, "sending"),
            lt(webhookDeliveries.updatedAt, stuckBefore),
          ),
        ),
      )
      .orderBy(webhookDeliveries.nextRetryAt)
      .limit(REAPER_BATCH);

    let reDriven = 0;
    for (const row of due) {
      try {
        await deliverWebhookTask.run({ deliveryId: row.id });
        reDriven += 1;
      } catch (err) {
        logger.warn("reap-due-webhook-deliveries: re-drive failed", {
          deliveryId: row.id,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }

    if (due.length > 0) {
      logger.info("reap-due-webhook-deliveries: swept", {
        candidates: due.length,
        reDriven,
      });
    }

    return { candidates: due.length, reDriven };
  },
});
