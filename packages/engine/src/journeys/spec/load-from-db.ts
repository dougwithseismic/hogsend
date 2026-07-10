import type { JourneySpec } from "@hogsend/core";
import { journeySpecSchema } from "@hogsend/core";
import { type Database, journeySpecs } from "@hogsend/db";
import { and, asc, eq } from "drizzle-orm";
import type { HogsendClient } from "../../container.js";
import type { Logger } from "../../lib/logger.js";
import type { DefinedJourney } from "../define-journey.js";
import { journeyFromSpec } from "./journey-from-spec.js";

/**
 * Load DB-stored journey specs (Slice 1). Returns the enabled rows parsed into
 * validated {@link JourneySpec}s, ready to merge into the `journeys` array
 * alongside the code journeys.
 *
 * Tolerance is the whole point: a code-array spec crashes boot when invalid
 * (it's code — fail loud). A DB row is DATA, so a single malformed/schema-drifted
 * row must NOT take the worker down and silence every other journey. Each row is
 * parsed independently; a parse failure (or a `journey_id` that disagrees with
 * the embedded `spec.id`) is logged and skipped. The admin write path validates
 * before insert, so a skip here means genuine drift, not a fresh authoring error.
 *
 * Ordered by `journey_id` for a deterministic registration order.
 */
export async function loadJourneySpecsFromDb(opts: {
  db: Database;
  logger?: Logger;
}): Promise<JourneySpec[]> {
  const { db, logger } = opts;

  const rows = await db
    .select({
      journeyId: journeySpecs.journeyId,
      version: journeySpecs.version,
      spec: journeySpecs.spec,
    })
    .from(journeySpecs)
    .where(and(eq(journeySpecs.enabled, true), eq(journeySpecs.origin, "json")))
    .orderBy(asc(journeySpecs.journeyId));

  const loaded: JourneySpec[] = [];
  for (const row of rows) {
    const parsed = journeySpecSchema.safeParse(row.spec);
    if (!parsed.success) {
      logger?.error("journey_specs: skipping unparseable row", {
        journeyId: row.journeyId,
        version: row.version,
        issues: parsed.error.issues.map((i) => i.message),
      });
      continue;
    }
    // The column and the embedded id must agree — otherwise registration keys
    // (registry id, states, logs) would disagree with the row this came from.
    if (parsed.data.id !== row.journeyId) {
      logger?.error(
        "journey_specs: skipping row whose id disagrees with spec",
        {
          journeyId: row.journeyId,
          specId: parsed.data.id,
        },
      );
      continue;
    }
    loaded.push(parsed.data);
  }

  if (loaded.length > 0) {
    logger?.info("journey_specs: loaded DB journey specs", {
      count: loaded.length,
      ids: loaded.map((s) => s.id),
    });
  }
  return loaded;
}

/**
 * Boot step shared by BOTH processes: load the DB specs, adapt each to a
 * `DefinedJourney`, register its meta into the process journey registry, and
 * return the adapted journeys (so the worker can add their Hatchet tasks; the
 * API discards them and keeps only the registry side effect for admin listing +
 * `checkExits` exitOn evaluation).
 *
 * Two guarantees:
 *  - **Code wins.** A DB spec whose id is already registered by a code journey
 *    is skipped with a warn — the repo is the source of truth on collision.
 *  - **Per-spec tolerance.** Adaptation (`journeyFromSpec`) can still throw for a
 *    DB spec that passed the shape schema but references a dead template; that
 *    is caught and skipped (logged), never crashing boot. Code-array specs keep
 *    their loud boot failure — they are code.
 *
 * DB specs are gated ONLY by their own `enabled` column (the loader query), NOT
 * by `ENABLED_JOURNEYS` — that env filter is operator config over the closed set
 * of code journeys; a DB-added journey is expected to run on its own switch.
 */
export async function loadAndRegisterDbSpecs(
  client: Pick<HogsendClient, "db" | "registry" | "templates" | "logger">,
): Promise<DefinedJourney[]> {
  const { db, registry, templates, logger } = client;
  const specs = await loadJourneySpecsFromDb({ db, logger });
  if (specs.length === 0) return [];

  const templateKeys = new Set(Object.keys(templates ?? {}));
  const adapted: DefinedJourney[] = [];
  for (const spec of specs) {
    if (registry.get(spec.id)) {
      logger.warn(
        "journey_specs: DB spec id collides with a registered journey — code wins, skipping",
        { id: spec.id },
      );
      continue;
    }
    let journey: DefinedJourney;
    try {
      journey = journeyFromSpec(spec, { templateKeys });
    } catch (err) {
      logger.error("journey_specs: skipping spec that failed adaptation", {
        id: spec.id,
        error: err instanceof Error ? err.message : String(err),
      });
      continue;
    }
    registry.register(journey.meta);
    adapted.push(journey);
  }
  return adapted;
}
