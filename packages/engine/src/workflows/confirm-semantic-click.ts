import { getJourneyRegistrySingleton } from "../journeys/registry-singleton.js";
import { getDb } from "../lib/db.js";
import { hatchet } from "../lib/hatchet.js";
import { createLogger } from "../lib/logger.js";
import {
  type ConfirmSemanticClickInput,
  confirmSemanticClick,
} from "../lib/semantic-click.js";

/**
 * Deferred confirmation of a semantic-link answer, enqueued per candidate
 * click by the click route. The deferral (≈ the burst window, 30s) is the
 * point: an inline gate can never suppress a scanner's FIRST click because
 * the rest of the burst hasn't happened yet — this task judges the click with
 * the whole window visible on both sides.
 *
 * Retries are safe: the claim is an idempotency-keyed `user_events` insert
 * whose failed-publish path rolls back inside `ingestEvent`, the stamp is
 * `IS NULL`-guarded, and the outbound emit carries a `dedupeKey`. Self-
 * bootstraps deps from the process (cron-style; no request container).
 */
export const confirmSemanticClickTask = hatchet.task({
  name: "confirm-semantic-click",
  retries: 3,
  executionTimeout: "90s",
  fn: async (input: ConfirmSemanticClickInput) => {
    return confirmSemanticClick(
      {
        db: getDb(),
        hatchet,
        registry: getJourneyRegistrySingleton(),
        logger: createLogger(process.env.LOG_LEVEL ?? "info"),
      },
      input,
    );
  },
});
