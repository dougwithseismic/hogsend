import type { CanonicalStage, CrmStageEvent } from "@hogsend/core";
import { canonicalStageRank } from "@hogsend/core";
import { crmLinks, type Database, deals } from "@hogsend/db";
import { and, eq } from "drizzle-orm";
import type { Logger } from "./logger.js";

/**
 * The deals projection + external-id alias map
 * (docs/revenue-attribution-plan.md §4.2). Events stay the append-only truth;
 * this module materializes current deal state with the MONOTONIC stage rule:
 * a change applies only when it advances the canonical rank (heals
 * webhook+poll double-detection and out-of-order delivery), `lost` applies
 * from any non-sold state, and a deal value update always lands (latest
 * value wins — quotes get revised).
 */

/** Resolve a CRM contact via the alias map: contact link, then deal link. */
export async function resolveCrmLinkedContact(opts: {
  db: Database;
  providerId: string;
  event: Pick<CrmStageEvent, "contactId" | "dealId">;
}): Promise<string | null> {
  const { db, providerId, event } = opts;
  const candidates: Array<{ kind: "contact" | "deal"; externalId: string }> = [
    ...(event.contactId
      ? [{ kind: "contact" as const, externalId: event.contactId }]
      : []),
    { kind: "deal" as const, externalId: event.dealId },
  ];
  for (const candidate of candidates) {
    const rows = await db
      .select({ contactId: crmLinks.contactId })
      .from(crmLinks)
      .where(
        and(
          eq(crmLinks.provider, providerId),
          eq(crmLinks.kind, candidate.kind),
          eq(crmLinks.externalId, candidate.externalId),
        ),
      )
      .limit(1);
    if (rows[0]) return rows[0].contactId;
  }
  return null;
}

/** Mint the alias rows (idempotent) so future events resolve without email. */
export async function ensureCrmLinks(opts: {
  db: Database;
  providerId: string;
  contactId: string;
  event: Pick<CrmStageEvent, "contactId" | "dealId">;
}): Promise<void> {
  const { db, providerId, contactId, event } = opts;
  const rows = [
    ...(event.contactId
      ? [
          {
            provider: providerId,
            kind: "contact" as const,
            externalId: event.contactId,
            contactId,
          },
        ]
      : []),
    {
      provider: providerId,
      kind: "deal" as const,
      externalId: event.dealId,
      contactId,
    },
  ];
  await db.insert(crmLinks).values(rows).onConflictDoNothing();
}

export interface AppliedStageChange {
  dealId: string;
  /** The deal FIRST reached canonical quoted with this event. */
  freshQuoted: boolean;
  /** The deal FIRST reached canonical sold with this event. */
  freshSold: boolean;
  /** Current projected value after this event. */
  value: number | null;
  currency: string | null;
  canonicalStage: CanonicalStage | null;
}

/**
 * Apply one stage event to the projection. `canonicalStage` is the engine's
 * stage-map resolution (null = unmapped: native fields still record, the
 * canonical stage holds).
 */
export async function applyCrmStageEvent(opts: {
  db: Database;
  logger: Logger;
  providerId: string;
  contactId: string;
  event: CrmStageEvent;
  canonicalStage: CanonicalStage | null;
}): Promise<AppliedStageChange> {
  const { db, logger, providerId, contactId, event, canonicalStage } = opts;
  const occurredAt = new Date(event.occurredAt);
  const rank = canonicalStage ? canonicalStageRank(canonicalStage) : null;

  const insertValues = {
    provider: providerId,
    externalId: event.dealId,
    contactId,
    pipelineId: event.pipelineId ?? null,
    stageId: event.stageId,
    canonicalStage: canonicalStage ?? "lead",
    stageRank: rank !== null && rank >= 0 ? rank : 0,
    value: event.value?.amount ?? null,
    currency: event.value?.currency?.toUpperCase() ?? null,
    // Quoted marks the deal ACTUALLY reaching quoted — a deal first observed
    // at sold does not retro-claim a quote event.
    quotedAt: canonicalStage === "quoted" ? occurredAt : null,
    soldAt: canonicalStage === "sold" ? occurredAt : null,
    lostAt: canonicalStage === "lost" ? occurredAt : null,
    lastStageAt: occurredAt,
  };

  // Insert-first: the common case for a new deal. A concurrent insert (the
  // webhook/poll race) falls through to the update path below.
  const inserted = await db
    .insert(deals)
    .values(insertValues)
    .onConflictDoNothing({ target: [deals.provider, deals.externalId] })
    .returning();
  if (inserted[0]) {
    return {
      dealId: inserted[0].id,
      freshQuoted: inserted[0].quotedAt !== null,
      freshSold: inserted[0].soldAt !== null,
      value: inserted[0].value,
      currency: inserted[0].currency,
      canonicalStage,
    };
  }

  const existingRows = await db
    .select()
    .from(deals)
    .where(
      and(eq(deals.provider, providerId), eq(deals.externalId, event.dealId)),
    )
    .limit(1);
  const existing = existingRows[0];
  if (!existing) {
    // Unreachable outside a delete race; surface rather than throw.
    logger.warn("crm deal projection row vanished mid-apply", {
      provider: providerId,
      dealId: event.dealId,
    });
    return {
      dealId: "",
      freshQuoted: false,
      freshSold: false,
      value: insertValues.value,
      currency: insertValues.currency,
      canonicalStage,
    };
  }

  const set: Partial<typeof deals.$inferInsert> = { updatedAt: new Date() };
  // Latest value always lands (quotes get revised), independent of stage
  // direction.
  if (event.value) {
    set.value = event.value.amount;
    set.currency = event.value.currency?.toUpperCase() ?? existing.currency;
  }

  let freshQuoted = false;
  let freshSold = false;
  const advances =
    canonicalStage !== null &&
    canonicalStage !== "lost" &&
    rank !== null &&
    rank > existing.stageRank &&
    existing.canonicalStage !== "lost";
  const losing =
    canonicalStage === "lost" && existing.canonicalStage !== "sold";

  if (advances) {
    set.canonicalStage = canonicalStage;
    set.stageRank = rank;
    set.stageId = event.stageId;
    set.pipelineId = event.pipelineId ?? existing.pipelineId;
    set.lastStageAt = occurredAt;
    if (canonicalStage === "quoted" && existing.quotedAt === null) {
      set.quotedAt = occurredAt;
      freshQuoted = true;
    }
    if (canonicalStage === "sold" && existing.soldAt === null) {
      set.soldAt = occurredAt;
      freshSold = true;
    }
  } else if (losing) {
    set.canonicalStage = "lost";
    set.stageId = event.stageId;
    set.lastStageAt = occurredAt;
    if (existing.lostAt === null) set.lostAt = occurredAt;
  }

  const updated = await db
    .update(deals)
    .set(set)
    .where(eq(deals.id, existing.id))
    .returning();
  const row = updated[0] ?? existing;

  return {
    dealId: row.id,
    freshQuoted,
    freshSold,
    value: row.value,
    currency: row.currency,
    canonicalStage,
  };
}
