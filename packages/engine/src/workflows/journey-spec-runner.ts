import type { JsonObject } from "@hatchet-dev/typescript-sdk/v1/types.js";
import { journeySpecSchema } from "@hogsend/core";
import type { JourneyMeta } from "@hogsend/core/types";
import {
  JOURNEY_EXECUTION_TIMEOUT,
  JOURNEY_SCHEDULE_TIMEOUT,
} from "../journeys/constants.js";
import { executeJourneyRun } from "../journeys/define-journey.js";
import { makeSpecRun } from "../journeys/spec/journey-from-spec.js";
import { hatchet } from "../lib/hatchet.js";
import { createLogger } from "../lib/logger.js";

const logger = createLogger(process.env.LOG_LEVEL);

/**
 * Dispatch input for {@link journeySpecRunnerTask}. The full spec travels in the
 * payload (a SNAPSHOT), so a Hatchet replay of an in-flight run re-reads the same
 * bytes — the run is deterministic across replay even if the stored spec was
 * edited in the meantime (in-flight version pinning for free). Specs are a few KB.
 */
export interface JourneySpecRunnerInput extends JsonObject {
  spec: JsonObject;
  /** `journey_specs.version` this snapshot came from (stamped on the state). */
  specVersion: number;
  userId: string;
  userEmail: string;
  properties: JsonObject;
}

/**
 * The ONE generic durable task that runs DB-stored journey specs (Slice 2).
 * Unlike a code journey it has NO `onEvents` — it is dispatched imperatively by
 * `ingestEvent` (`runNoWait`) for each spec whose trigger matches an event. It
 * resolves `meta`/`run` from the snapshot and hands off to the SAME
 * `executeJourneyRun` a code journey uses, so a data-defined journey gets the
 * identical guard chain, replay recovery, state lifecycle, and exactly-once
 * boundary.
 */
export const journeySpecRunnerTask = hatchet.durableTask({
  name: "journey-spec-runner",
  executionTimeout: JOURNEY_EXECUTION_TIMEOUT,
  // Same rationale as a code journey's task: a retry replays run() from the top,
  // which is only safe under the "missed > doubled" mailer/connector re-drive.
  retries: 0,
  scheduleTimeout: JOURNEY_SCHEDULE_TIMEOUT,
  fn: async (input: JourneySpecRunnerInput, hatchetCtx) => {
    // Defensive re-parse: dispatch already validated, but a snapshot authored by
    // a different engine version could drift — that must fail THIS run, never the
    // whole worker.
    const parsed = journeySpecSchema.safeParse(input.spec);
    if (!parsed.success) {
      logger.error("journey-spec-runner: invalid spec snapshot, skipping", {
        issues: parsed.error.issues.map((i) => i.message),
      });
      return { status: "skipped", reason: "invalid_spec" };
    }
    const spec = parsed.data;
    // `{ id, ...meta }` is exactly the boot meta: a spec's `where` is always a
    // plain condition array, on which `normalizeWhere` (defineJourney) is a no-op.
    const meta: JourneyMeta = { id: spec.id, ...spec.meta };
    return executeJourneyRun({
      meta,
      run: makeSpecRun(spec),
      input,
      hatchetCtx,
      specVersion: input.specVersion,
    });
  },
});
