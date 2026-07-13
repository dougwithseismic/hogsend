import type {
  CanonicalStage,
  CrmStageEvent,
  PipelineLadder,
} from "@hogsend/core";
import { canonicalStageRank, DEFAULT_PIPELINE_LADDER } from "@hogsend/core";
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

/** The synthetic provider id for deals minted by funnel event triggers —
 * reserved (a `CrmProvider` may not register under it). */
export const EVENTS_DEAL_PROVIDER = "events";

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
  /** The deal FIRST reached the ladder's quote stage with this event. */
  freshQuoted: boolean;
  /** The deal FIRST reached the ladder's sold stage with this event. */
  freshSold: boolean;
  /** Current projected value after this event. */
  value: number | null;
  currency: string | null;
  canonicalStage: CanonicalStage | null;
}

/**
 * Apply one stage event to the projection. `canonicalStage` is the engine's
 * stage-map resolution (null = unmapped: native fields still record, the
 * canonical stage holds). `event` is the minimal projection input — the CRM
 * path passes a full {@link CrmStageEvent}; the event-trigger path builds
 * one synthetically (providerId "events").
 */
export async function applyCrmStageEvent(opts: {
  db: Database;
  logger: Logger;
  providerId: string;
  contactId: string;
  event: Pick<
    CrmStageEvent,
    "dealId" | "stageId" | "pipelineId" | "value" | "occurredAt"
  >;
  canonicalStage: CanonicalStage | null;
  /** The claiming funnel's ladder; defaults to the built-in five. */
  ladder?: PipelineLadder;
  /** The claiming funnel's id (stamped on the deal). */
  funnelId?: string | null;
  /**
   * Skip the "latest value wins" update when the deal is already terminal
   * (sold/lost). The event-trigger path sets this — a new-cycle trigger
   * colliding with a closed synthetic row must not clobber its realized
   * value. CRM paths keep the default (post-sale value revisions are real).
   */
  protectTerminalValue?: boolean;
}): Promise<AppliedStageChange> {
  const { db, logger, providerId, contactId, event, canonicalStage } = opts;
  const ladder = opts.ladder ?? DEFAULT_PIPELINE_LADDER;
  const funnelId = opts.funnelId ?? null;
  const occurredAt = new Date(event.occurredAt);
  const rank = canonicalStage
    ? canonicalStageRank(canonicalStage, ladder)
    : null;

  const insertValues = {
    provider: providerId,
    externalId: event.dealId,
    contactId,
    pipelineId: event.pipelineId ?? null,
    funnelId,
    stageId: event.stageId,
    canonicalStage: canonicalStage ?? ladder.stages[0],
    stageRank: rank !== null && rank >= 0 ? rank : 0,
    value: event.value?.amount ?? null,
    currency: event.value?.currency?.toUpperCase() ?? null,
    // quotedAt marks the deal ACTUALLY reaching the quote stage — a deal
    // first observed at sold does not retro-claim a quote event.
    quotedAt: canonicalStage === ladder.quotedStage ? occurredAt : null,
    soldAt: canonicalStage === ladder.soldStage ? occurredAt : null,
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

  // The monotonic guard is compute-then-write, so the read must be
  // serialized against the webhook/poll race (API + worker processes can
  // apply different stage events to the same deal concurrently — an
  // unguarded late `quoted` committing after `sold` would regress it).
  // SELECT ... FOR UPDATE holds the row until this event's write commits.
  return db.transaction(async (tx) => {
    const existingRows = await tx
      .select()
      .from(deals)
      .where(
        and(eq(deals.provider, providerId), eq(deals.externalId, event.dealId)),
      )
      .limit(1)
      .for("update");
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

    // A deal belongs to ONE funnel. A stage event that routes to a DIFFERENT
    // funnel (the CRM moved the deal across pipelines) must not apply another
    // ladder's ranks/designations to this row — that mints phantom money
    // events and can flip sold→lost. The stage change still lands on the
    // event spine; the projection ignores it and says so.
    if (
      funnelId &&
      existing.funnelId !== null &&
      existing.funnelId !== funnelId
    ) {
      logger.warn("cross-funnel stage event ignored by the deals projection", {
        provider: providerId,
        dealId: event.dealId,
        dealFunnel: existing.funnelId,
        eventFunnel: funnelId,
        stageId: event.stageId,
      });
      return {
        dealId: existing.id,
        freshQuoted: false,
        freshSold: false,
        value: existing.value,
        currency: existing.currency,
        canonicalStage: existing.canonicalStage,
      };
    }

    const set: Partial<typeof deals.$inferInsert> = { updatedAt: new Date() };
    // Latest value always lands (quotes get revised), independent of stage
    // direction — unless the caller protects terminal rows (see opts).
    const terminal = existing.soldAt !== null || existing.lostAt !== null;
    if (event.value && !(opts.protectTerminalValue && terminal)) {
      set.value = event.value.amount;
      set.currency = event.value.currency?.toUpperCase() ?? existing.currency;
    }

    // Adoption: a pre-funnel row (funnelId null) joins the claiming funnel —
    // but its stored rank was computed on ANOTHER ladder's scale, so re-base
    // it from the stage NAME in the new ladder before any comparison. A
    // stage the new ladder doesn't know can't be re-based: leave the row
    // untouched rather than guess.
    let existingRank = existing.stageRank;
    if (funnelId && existing.funnelId === null) {
      if (existing.canonicalStage !== "lost") {
        const rebased = canonicalStageRank(existing.canonicalStage, ladder);
        if (rebased === null) {
          logger.warn(
            "pre-funnel deal stage is foreign to the claiming funnel — projection untouched",
            {
              provider: providerId,
              dealId: event.dealId,
              dealStage: existing.canonicalStage,
              funnel: funnelId,
            },
          );
          return {
            dealId: existing.id,
            freshQuoted: false,
            freshSold: false,
            value: existing.value,
            currency: existing.currency,
            canonicalStage: existing.canonicalStage,
          };
        }
        existingRank = rebased;
        set.stageRank = rebased;
      }
      set.funnelId = funnelId;
    }

    let freshQuoted = false;
    let freshSold = false;
    const advances =
      canonicalStage !== null &&
      canonicalStage !== "lost" &&
      rank !== null &&
      rank > existingRank &&
      existing.canonicalStage !== "lost";
    const losing =
      canonicalStage === "lost" &&
      existing.canonicalStage !== (ladder.soldStage ?? "sold");

    if (advances) {
      set.canonicalStage = canonicalStage;
      set.stageRank = rank;
      set.stageId = event.stageId;
      set.pipelineId = event.pipelineId ?? existing.pipelineId;
      set.lastStageAt = occurredAt;
      if (canonicalStage === ladder.quotedStage && existing.quotedAt === null) {
        set.quotedAt = occurredAt;
        freshQuoted = true;
      }
      if (canonicalStage === ladder.soldStage && existing.soldAt === null) {
        set.soldAt = occurredAt;
        freshSold = true;
      }
    } else if (losing) {
      set.canonicalStage = "lost";
      set.stageId = event.stageId;
      set.lastStageAt = occurredAt;
      if (existing.lostAt === null) set.lostAt = occurredAt;
    }

    const updated = await tx
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
  });
}
