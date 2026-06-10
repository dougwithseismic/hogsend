import {
  createDatabase,
  type Database,
  emailSends,
  journeyStates,
} from "@hogsend/db";
import { and, eq, gte, sql } from "drizzle-orm";
import { checkAlertRules } from "../lib/alerting.js";
import { hatchet } from "../lib/hatchet.js";
import { createLogger, type Logger } from "../lib/logger.js";

const FAILURE_WINDOW_MINUTES = 60;

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

    await checkAlertRules({
      db,
      logger,
    });

    return { checked: true };
  },
});
