import { createDatabase } from "@hogsend/db";
import { checkAlertRules } from "../lib/alerting.js";
import { hatchet } from "../lib/hatchet.js";
import { createLogger } from "../lib/logger.js";

export const checkAlertsTask = hatchet.task({
  name: "check-alerts",
  retries: 1,
  executionTimeout: "60s",
  fn: async () => {
    const { db } = createDatabase({
      url: process.env.DATABASE_URL ?? "",
    });
    const logger = createLogger(process.env.LOG_LEVEL ?? "info");

    await checkAlertRules({
      db,
      logger,
    });

    return { checked: true };
  },
});
