import {
  createDatabase,
  type Database,
  emailSends,
  journeyStates,
} from "@hogsend/db";
import { and, eq, gte, isNull, sql } from "drizzle-orm";
import { checkAlertRules } from "../lib/alerting.js";
import { hatchet } from "../lib/hatchet.js";
import { createLogger, type Logger } from "../lib/logger.js";

const FAILURE_WINDOW_MINUTES = 60;

// A `waiting` row only counts as STRANDED once its deadline is more than this
// grace past due. The window must absorb the two legitimate reasons a deadline
// slips while the row is still (correctly) waiting: Hatchet wake latency after
// the durable sleep fires, and the `scheduleTimeout` headroom a saturated worker
// needs to replay-resume before the engine flips the row back to `active`. Set it
// too tight and a healthy-but-slow resume false-positives; an hour clears both.
const STRANDED_GRACE_MS = 60 * 60 * 1000;

// Cap the per-row detail attached to a single alert. Stranded rows should be
// rare, but a systemic outage could strand many at once — log the total count
// plus a bounded sample rather than an unbounded array.
const STRANDED_ALERT_SAMPLE_CAP = 50;

interface StrandedFinding {
  stateId: string;
  journeyId: string;
  userId: string;
  /** Which deadline is overdue: the `wait_deadline` column or a `digest:<label>`. */
  deadlineSource: string;
  deadline: string;
  overdueMinutes: number;
}

/** The `context.__digest__` sub-bag (flat `<label>:deadline` / `<label>:result`). */
function digestBag(context: unknown): Record<string, unknown> {
  if (!context || typeof context !== "object") return {};
  const bag = (context as Record<string, unknown>).__digest__;
  return bag && typeof bag === "object" ? (bag as Record<string, unknown>) : {};
}

function finding(
  row: { id: string; journeyId: string; userId: string },
  deadlineSource: string,
  deadline: Date,
  now: number,
): StrandedFinding {
  return {
    stateId: row.id,
    journeyId: row.journeyId,
    userId: row.userId,
    deadlineSource,
    deadline: deadline.toISOString(),
    overdueMinutes: Math.round((now - deadline.getTime()) / 60000),
  };
}

// Stranded-waiting detector. A journey run can die WITHOUT the engine's
// exit/resume catch firing (a lost `runs.cancel`, Hatchet data loss, a
// saturated-redeploy `scheduleTimeout`) — the `journey_states` row then stays
// `status='waiting'` forever, and the `already_active` enrollment guard silently
// absorbs EVERY future trigger event for that (user, journey) into a black hole.
// Digest journeys park in `waiting` for days by design, so exposure is maximal.
// v1 is DETECT + ALERT only: no status flips, no auto-repair. Exported as the
// test seam (mirrors how the reconcile workflows are exercised directly).
export async function surfaceStrandedWaiting(opts: {
  db: Database;
  logger: Logger;
}): Promise<void> {
  const { db, logger } = opts;

  try {
    const rows = await db
      .select({
        id: journeyStates.id,
        journeyId: journeyStates.journeyId,
        userId: journeyStates.userId,
        waitDeadline: journeyStates.waitDeadline,
        updatedAt: journeyStates.updatedAt,
        context: journeyStates.context,
      })
      .from(journeyStates)
      .where(
        and(
          eq(journeyStates.status, "waiting"),
          isNull(journeyStates.deletedAt),
        ),
      );

    const now = Date.now();
    const cutoff = now - STRANDED_GRACE_MS;
    const stranded: StrandedFinding[] = [];

    for (const row of rows) {
      // (a) the `wait_deadline` column — a `ctx.waitForEvent({ where })` re-arm loop
      // persists an absolute deadline here; overdue past the grace = stranded.
      if (row.waitDeadline && row.waitDeadline.getTime() < cutoff) {
        stranded.push(finding(row, "wait_deadline", row.waitDeadline, now));
      }

      // (b) any digest deadline overdue past the grace WITHOUT a matching result.
      // A recorded `<label>:result` means that digest flushed cleanly (the row may
      // legitimately be parked on a LATER primitive), so only an UN-flushed overdue
      // deadline is evidence of stranding. Parse the bag in JS — waiting rows are a
      // small set, so no jsonb-path SQL is needed.
      const bag = digestBag(row.context);
      for (const [key, value] of Object.entries(bag)) {
        if (!key.endsWith(":deadline") || typeof value !== "string") continue;
        const label = key.slice(0, -":deadline".length);
        if (Object.hasOwn(bag, `${label}:result`)) continue;
        const deadline = new Date(value);
        if (Number.isNaN(deadline.getTime())) continue;
        if (deadline.getTime() < cutoff) {
          stranded.push(finding(row, `digest:${label}`, deadline, now));
        }
      }
    }

    if (stranded.length > 0) {
      logger.error("Stranded waiting journey states detected", {
        count: stranded.length,
        graceMinutes: STRANDED_GRACE_MS / 60000,
        states: stranded.slice(0, STRANDED_ALERT_SAMPLE_CAP),
        hint: "A waiting row whose deadline is long past-due means its Hatchet run died WITHOUT the engine's exit/resume catch (lost cancel, engine data loss, or a saturated-redeploy scheduleTimeout). The active-enrollment guard now absorbs every future trigger event for this user+journey into a black hole. Repair by cancelling the row via DELETE /v1/admin/journeys/:id/states/:stateId (or fail it) in the admin surface.",
      });
    }
  } catch (err) {
    logger.warn("Failed to check stranded waiting states", {
      error: err instanceof Error ? err.message : String(err),
    });
  }
}

// Ruleless failure surfacing. The configured alert rules already cover failed
// journeys (journey_failure_spike) and failed sends (they drag delivery_issue's
// delivery rate down) — but a fresh install has NO alert_rules rows, so a
// provider 403 fails silently while health stays green. This logs an error
// for ANY failed send / failed journey state in the window, no rule required.
async function surfaceRecentFailures(opts: {
  db: Database;
  logger: Logger;
}): Promise<void> {
  const { db, logger } = opts;
  const since = new Date(Date.now() - FAILURE_WINDOW_MINUTES * 60 * 1000);

  try {
    const [journeyRows, emailRows] = await Promise.all([
      db
        .select({ count: sql<number>`count(*)` })
        .from(journeyStates)
        .where(
          and(
            eq(journeyStates.status, "failed"),
            gte(journeyStates.updatedAt, since),
          ),
        ),
      db
        .select({ count: sql<number>`count(*)` })
        .from(emailSends)
        .where(
          and(
            eq(emailSends.status, "failed"),
            gte(emailSends.createdAt, since),
          ),
        ),
    ]);

    const failedJourneys = Number(journeyRows[0]?.count ?? 0);
    const failedEmails = Number(emailRows[0]?.count ?? 0);

    if (failedJourneys > 0 || failedEmails > 0) {
      logger.error("Recent failures detected", {
        failedJourneys,
        failedEmails,
        windowMinutes: FAILURE_WINDOW_MINUTES,
        hint: "Check journey_states.error_message and email_sends rows; /v1/health `activity` shows 24h counts",
      });
    }
  } catch (err) {
    logger.warn("Failed to check recent failures", {
      error: err instanceof Error ? err.message : String(err),
    });
  }
}

export const checkAlertsTask = hatchet.task({
  name: "check-alerts",
  retries: 1,
  executionTimeout: "60s",
  fn: async () => {
    const { db } = createDatabase({
      url: process.env.DATABASE_URL ?? "",
    });
    const logger = createLogger(process.env.LOG_LEVEL ?? "info");

    await surfaceRecentFailures({ db, logger });

    await surfaceStrandedWaiting({ db, logger });

    await checkAlertRules({
      db,
      logger,
    });

    return { checked: true };
  },
});
