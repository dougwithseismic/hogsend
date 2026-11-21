import { deliverConversionDispatch } from "../lib/conversion-dispatch.js";
import { getDb } from "../lib/db.js";
import { hatchet } from "../lib/hatchet.js";
import { createLogger } from "../lib/logger.js";

/**
 * Durable delivery of ONE conversion dispatch row (plan §5.2). Retries ride
 * Hatchet (the deterministic event_id makes platform-side dedup safe);
 * `deliverConversionDispatch` marks the row failed once attempts exhaust and
 * stops throwing, so the task run ends cleanly.
 */
export interface DispatchConversionInput {
  dispatchId: string;
  [key: string]: string;
}

export const dispatchConversionTask = hatchet.task({
  name: "dispatch-conversion",
  retries: 4,
  executionTimeout: "60s",
  fn: async (input: DispatchConversionInput) => {
    const db = getDb();
    const logger = createLogger(process.env.LOG_LEVEL ?? "info");
    return deliverConversionDispatch({
      db,
      logger,
      dispatchId: input.dispatchId,
      maxAttempts: 5,
    });
  },
});
