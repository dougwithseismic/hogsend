import type { HatchetClient } from "@hatchet-dev/typescript-sdk/v1/index.js";
import type { JourneyRegistry } from "@hogsend/core/registry";
import {
  type Database,
  linkClicks,
  trackedLinks,
  userEvents,
} from "@hogsend/db";
import { and, countDistinct, eq, gte, isNull, lte } from "drizzle-orm";
import type { Logger } from "./logger.js";
import { emitOutbound } from "./outbound.js";
import {
  pushTrackingEvent,
  resolveEmailSendContext,
} from "./tracking-events.js";

/**
 * Scanner-burst window: SafeLinks/Proofpoint-style scanners follow EVERY link
 * in an email within seconds of delivery; humans don't. Confirmation of a
 * semantic answer is DEFERRED until the window around the candidate click has
 * fully elapsed, so the gate sees the WHOLE burst — including clicks that land
 * AFTER the candidate. An inline check could never suppress a scanner's first
 * click (the burst isn't visible yet); this one can.
 */
export const SEMANTIC_BURST_WINDOW_MS = 30_000;
export const SEMANTIC_BURST_DISTINCT_LINKS = 3;

// Type alias (NOT interface) so it picks up an implicit index signature and
// satisfies Hatchet's JsonObject task-input constraint.
export type ConfirmSemanticClickInput = {
  trackedLinkId: string;
  /** ISO instant of the candidate click. */
  clickedAt: string;
};

export type ConfirmSemanticClickResult =
  | { status: "confirmed"; event: string }
  | { status: "suppressed"; distinctLinks: number }
  /** Another link's answer claimed this send's slot first. */
  | { status: "lost" }
  | { status: "skipped"; reason: string };

export interface ConfirmSemanticClickDeps {
  db: Database;
  hatchet: HatchetClient;
  registry: JourneyRegistry;
  logger: Logger;
}

/**
 * Confirm (or suppress) one provisional semantic-link answer. Idempotent end
 * to end, so the wrapping Hatchet task can retry safely:
 *
 *  1. Sleep out the remainder of the burst window past the candidate click.
 *  2. Count DISTINCT links of the send clicked inside the window around the
 *     candidate — at/over the threshold the whole burst is scanner traffic
 *     and the answer is suppressed (the raw clicks stay recorded).
 *  3. Claim the send's answer slot via `ingestEvent` with the
 *     `sem:<emailSendId>:<event>` idempotency key (first answer wins; a
 *     failed Hatchet publish rolls the claim back inside `ingestEvent`, so a
 *     retry re-claims).
 *  4. If we claimed (or a crashed earlier attempt of THIS link did — detected
 *     by the stored row's `linkId`), stamp `semanticEmittedAt` and emit the
 *     `email.action` outbound envelope with the same key as `dedupeKey`, so
 *     re-runs are per-endpoint no-ops.
 */
export async function confirmSemanticClick(
  deps: ConfirmSemanticClickDeps,
  input: ConfirmSemanticClickInput,
): Promise<ConfirmSemanticClickResult> {
  const { db, hatchet, registry, logger } = deps;

  const clickedAtMs = Date.parse(input.clickedAt);
  if (Number.isNaN(clickedAtMs)) {
    return { status: "skipped", reason: "bad_clicked_at" };
  }

  const rows = await db
    .select({
      id: trackedLinks.id,
      emailSendId: trackedLinks.emailSendId,
      originalUrl: trackedLinks.originalUrl,
      event: trackedLinks.event,
      eventProperties: trackedLinks.eventProperties,
    })
    .from(trackedLinks)
    .where(eq(trackedLinks.id, input.trackedLinkId))
    .limit(1);
  const link = rows[0];
  if (!link?.event) {
    return { status: "skipped", reason: "not_semantic" };
  }
  // The confirm path is EMAIL-semantic end to end (it claims a send's answer
  // slot keyed on `emailSendId` and emits `email.action`). The click route only
  // enqueues this task for links with a non-null `emailSendId`, but `emailSendId`
  // is nullable since the identity-stitching minor — guard defensively and
  // narrow the type for the rest of the function.
  if (!link.emailSendId) {
    return { status: "skipped", reason: "non_email_link" };
  }
  const emailSendId = link.emailSendId;
  const semanticEvent = link.event;

  // (1) Let the burst window close before judging the click.
  const remainingMs = clickedAtMs + SEMANTIC_BURST_WINDOW_MS - Date.now();
  if (remainingMs > 0) {
    await new Promise((resolve) => setTimeout(resolve, remainingMs));
  }

  // (2) Whole-burst check: distinct links of this send clicked in the window
  // AROUND the candidate (before AND after — the deferral is what makes the
  // "after" half visible).
  const windowStart = new Date(clickedAtMs - SEMANTIC_BURST_WINDOW_MS);
  const windowEnd = new Date(clickedAtMs + SEMANTIC_BURST_WINDOW_MS);
  const burst = await db
    .select({ n: countDistinct(linkClicks.trackedLinkId) })
    .from(linkClicks)
    .innerJoin(trackedLinks, eq(linkClicks.trackedLinkId, trackedLinks.id))
    .where(
      and(
        eq(trackedLinks.emailSendId, emailSendId),
        gte(linkClicks.clickedAt, windowStart),
        lte(linkClicks.clickedAt, windowEnd),
      ),
    );
  const distinctLinks = burst[0]?.n ?? 0;
  if (distinctLinks >= SEMANTIC_BURST_DISTINCT_LINKS) {
    logger.warn("Semantic answer suppressed: scanner-like click burst", {
      emailSendId,
      linkId: link.id,
      event: semanticEvent,
      distinctLinks,
    });
    return { status: "suppressed", distinctLinks };
  }

  const ctx = await resolveEmailSendContext(db, emailSendId);
  if (!ctx) {
    return { status: "skipped", reason: "no_send_context" };
  }

  // (3) Claim the answer slot. Duplicate key → stored=false BEFORE the Hatchet
  // push, so journeys/destinations see at most one answer per (send, event).
  const semKey = `sem:${emailSendId}:${semanticEvent}`;
  const result = await pushTrackingEvent({
    db,
    hatchet,
    registry,
    logger,
    event: semanticEvent,
    emailSendId,
    properties: {
      ...(link.eventProperties ?? {}),
      linkId: link.id,
    },
    resolvedContext: ctx,
    idempotencyKey: semKey,
  });

  // (4) Claimer determination. stored=false usually means another link won —
  // but if the stored row carries THIS link's id, it is a crashed earlier
  // attempt of this very confirmation, and the (idempotent) tail must re-run.
  let isClaimer = result?.stored ?? false;
  if (!isClaimer) {
    const existing = await db
      .select({ properties: userEvents.properties })
      .from(userEvents)
      .where(eq(userEvents.idempotencyKey, semKey))
      .limit(1);
    isClaimer = existing[0]?.properties?.linkId === link.id;
    if (!isClaimer) {
      return { status: "lost" };
    }
  }

  await db
    .update(trackedLinks)
    .set({ semanticEmittedAt: new Date(), updatedAt: new Date() })
    .where(
      and(eq(trackedLinks.id, link.id), isNull(trackedLinks.semanticEmittedAt)),
    );

  await emitOutbound({
    db,
    hatchet,
    logger,
    event: "email.action",
    dedupeKey: semKey,
    payload: {
      event: semanticEvent,
      properties: link.eventProperties ?? null,
      emailSendId,
      templateKey: ctx.templateKey ?? null,
      userId: ctx.userId ?? null,
      to: ctx.to ?? ctx.userEmail ?? "",
      at: new Date().toISOString(),
      linkId: link.id,
      linkUrl: link.originalUrl,
    },
  });

  return { status: "confirmed", event: semanticEvent };
}
