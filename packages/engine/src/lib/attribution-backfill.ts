import {
  attributionCredits,
  contacts,
  conversions,
  type Database,
  userEvents,
} from "@hogsend/db";
import {
  and,
  asc,
  eq,
  gt,
  gte,
  inArray,
  isNotNull,
  or,
  sql,
} from "drizzle-orm";
import { recordAttributionCredits } from "./attribution.js";
import type { ConversionRegistry } from "./conversions.js";
import { evaluateConversionsAtIngest } from "./conversions.js";
import type { Logger } from "./logger.js";

/**
 * Attribution backfill (impact plan §5.1) — replays HISTORY through the
 * same idempotent machinery ingest uses, so an existing deploy that
 * upgrades gets its whole event history credited, and a definition/window
 * change gets a deliberate, logged recompute path.
 *
 * Two stages behind one cursor (`events:<id>` → `credits:<id>`):
 *
 *  1. `events` — scan historical `user_events` matching the registry's
 *     trigger set and run conversion evaluation. The unique
 *     (definition, event) index makes replays no-ops; only genuinely new
 *     conversions are minted. Ad-platform dispatches are deliberately NOT
 *     enqueued — historical conversions must never re-fire to destinations.
 *  2. `credits` — scan conversions rows (of the scoped definitions) that
 *     have NO credit rows yet and write their ledger entries under the
 *     definition's CURRENT window config.
 *
 * `recompute: true` (requires `definitionId`) deletes the definition's
 * existing credit rows up front, then stage 2 re-credits everything — the
 * ONE sanctioned exception to the ledger's write-once philosophy, guarded
 * and logged. Conversion rows themselves are never deleted.
 *
 * Batch-shaped by design: each call processes up to `limit` rows of the
 * current stage and returns `nextCursor` (null = done). The CLI loops it;
 * an admin can curl it. Contacts are matched only — a historical event
 * whose user never became a contact is skipped, never minted.
 */
export interface BackfillBatchResult {
  stage: "events" | "credits";
  processed: number;
  conversionsFired: number;
  creditsWritten: number;
  nextCursor: string | null;
}

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export async function backfillAttributionBatch(opts: {
  db: Database;
  logger: Logger;
  registry: ConversionRegistry | undefined;
  definitionId?: string;
  since?: Date;
  cursor?: string;
  limit?: number;
  recompute?: boolean;
}): Promise<BackfillBatchResult> {
  const { db, logger, registry, definitionId, since } = opts;
  const limit = Math.min(2000, Math.max(1, opts.limit ?? 500));

  const defs = (registry?.getAll() ?? []).filter(
    (def) => !definitionId || def.meta.id === definitionId,
  );
  if (defs.length === 0) {
    return {
      stage: "credits",
      processed: 0,
      conversionsFired: 0,
      creditsWritten: 0,
      nextCursor: null,
    };
  }
  const defIds = defs.map((def) => def.meta.id);
  const defById = new Map(defs.map((def) => [def.meta.id, def]));
  const namedEvents = [
    ...new Set(
      defs
        .map((def) => def.meta.trigger.event)
        .filter((event) => event !== "*"),
    ),
  ];
  const hasWildcard = defs.some((def) => def.meta.trigger.event === "*");

  const [stage, lastId] = opts.cursor
    ? (opts.cursor.split(":", 2) as ["events" | "credits", string])
    : (["events", ""] as const);

  // Recompute (guarded): first call only, one definition only.
  if (opts.recompute && !opts.cursor) {
    if (!definitionId) {
      throw new Error("recompute requires a definitionId — never blanket");
    }
    const deleted = await db
      .delete(attributionCredits)
      .where(
        inArray(
          attributionCredits.conversionId,
          db
            .select({ id: conversions.id })
            .from(conversions)
            .where(eq(conversions.definitionId, definitionId)),
        ),
      )
      .returning({ id: attributionCredits.id });
    logger.warn("attribution recompute: credit rows deleted for refill", {
      definitionId,
      deleted: deleted.length,
    });
  }

  if (stage === "events") {
    const eventMatch = or(
      namedEvents.length > 0
        ? inArray(userEvents.event, namedEvents)
        : sql`false`,
      hasWildcard ? isNotNull(userEvents.value) : sql`false`,
    );
    const rows = await db
      .select({
        id: userEvents.id,
        event: userEvents.event,
        userId: userEvents.userId,
        properties: userEvents.properties,
        value: userEvents.value,
        currency: userEvents.currency,
        source: userEvents.source,
        occurredAt: userEvents.occurredAt,
      })
      .from(userEvents)
      .where(
        and(
          eventMatch,
          ...(since ? [gte(userEvents.occurredAt, since)] : []),
          ...(lastId ? [gt(userEvents.id, lastId)] : []),
        ),
      )
      .orderBy(asc(userEvents.id))
      .limit(limit);

    // Batch contact resolution: canonical keys are externalId or the
    // contact row uuid. MATCH ONLY — backfill never mints contacts.
    const keys = [...new Set(rows.map((row) => row.userId))];
    const uuidKeys = keys.filter((key) => UUID_RE.test(key));
    const contactRows =
      keys.length > 0
        ? await db
            .select({ id: contacts.id, externalId: contacts.externalId })
            .from(contacts)
            .where(
              or(
                inArray(contacts.externalId, keys),
                uuidKeys.length > 0
                  ? inArray(contacts.id, uuidKeys)
                  : sql`false`,
              ),
            )
        : [];
    const contactByKey = new Map<string, string>();
    for (const contact of contactRows) {
      contactByKey.set(contact.id, contact.id);
      if (contact.externalId) contactByKey.set(contact.externalId, contact.id);
    }

    let conversionsFired = 0;
    let creditsWritten = 0;
    for (const row of rows) {
      const contactId = contactByKey.get(row.userId);
      if (!contactId) continue;
      const fired = await evaluateConversionsAtIngest({
        db,
        logger,
        registry,
        event: {
          name: row.event,
          source: row.source ?? null,
          properties: (row.properties ?? {}) as Record<string, unknown>,
          value: row.value,
          currency: row.currency,
          occurredAt: row.occurredAt,
        },
        eventRowId: row.id,
        contactId,
        userKey: row.userId,
      });
      for (const conversion of fired) {
        if (definitionId && conversion.definition.meta.id !== definitionId) {
          continue;
        }
        conversionsFired++;
        const { touchpoints } = await recordAttributionCredits({
          db,
          logger,
          conversionId: conversion.conversionId,
          userKey: row.userId,
          value: conversion.value,
          currency: conversion.currency,
          occurredAt: row.occurredAt,
          windowDays: conversion.definition.meta.attributionWindowDays ?? 90,
          windows: conversion.definition.meta.windows,
        });
        if (touchpoints > 0) creditsWritten++;
      }
    }

    const nextCursor =
      rows.length < limit
        ? "credits:"
        : `events:${rows[rows.length - 1]?.id ?? ""}`;
    return {
      stage: "events",
      processed: rows.length,
      conversionsFired,
      creditsWritten,
      nextCursor,
    };
  }

  // Stage 2: credit conversions that have no ledger rows yet (after a
  // recompute delete, that is all of the definition's conversions).
  const uncredited = sql`not exists (
    select 1 from ${attributionCredits}
    where ${attributionCredits.conversionId} = ${conversions.id}
  )`;
  const rows = await db
    .select({
      id: conversions.id,
      definitionId: conversions.definitionId,
      userKey: conversions.userKey,
      value: conversions.value,
      currency: conversions.currency,
      occurredAt: conversions.occurredAt,
    })
    .from(conversions)
    .where(
      and(
        inArray(conversions.definitionId, defIds),
        uncredited,
        ...(since ? [gte(conversions.occurredAt, since)] : []),
        ...(lastId ? [gt(conversions.id, lastId)] : []),
      ),
    )
    .orderBy(asc(conversions.id))
    .limit(limit);

  let creditsWritten = 0;
  for (const row of rows) {
    const def = defById.get(row.definitionId);
    if (!def) continue;
    const { touchpoints } = await recordAttributionCredits({
      db,
      logger,
      conversionId: row.id,
      userKey: row.userKey,
      value: row.value,
      currency: row.currency,
      occurredAt: row.occurredAt,
      windowDays: def.meta.attributionWindowDays ?? 90,
      windows: def.meta.windows,
    });
    if (touchpoints > 0) creditsWritten++;
  }

  return {
    stage: "credits",
    processed: rows.length,
    conversionsFired: 0,
    creditsWritten,
    nextCursor:
      rows.length < limit ? null : `credits:${rows[rows.length - 1]?.id ?? ""}`,
  };
}
