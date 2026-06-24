import type { HatchetClient } from "@hatchet-dev/typescript-sdk/v1/index.js";
import type { JourneyRegistry } from "@hogsend/core/registry";
import { type Database, emailSends, journeyStates } from "@hogsend/db";
import { eq } from "drizzle-orm";
import { type IngestResult, ingestEvent } from "./ingestion.js";
import type { Logger } from "./logger.js";
import { LINK_CLICKED } from "./tracking-event-names.js";

interface EmailSendContext {
  userId: string;
  userEmail: string;
  templateKey: string | null;
  messageId: string | null;
  to: string;
}

export async function resolveEmailSendContext(
  db: Database,
  emailSendId: string | null,
): Promise<EmailSendContext | null> {
  // A non-email tracked link (Discord/referral/ad-hoc `createTrackedLink`) has
  // a NULL `email_send_id` — there is no send row to resolve, so short-circuit
  // to null rather than issue a `WHERE id = NULL` query that matches nothing.
  if (!emailSendId) return null;
  const rows = await db
    .select({
      toEmail: emailSends.toEmail,
      templateKey: emailSends.templateKey,
      messageId: emailSends.messageId,
      userId: journeyStates.userId,
      userEmail: journeyStates.userEmail,
    })
    .from(emailSends)
    .leftJoin(journeyStates, eq(emailSends.journeyStateId, journeyStates.id))
    .where(eq(emailSends.id, emailSendId))
    .limit(1);

  const row = rows[0];
  if (!row) return null;

  return {
    userId: row.userId ?? row.toEmail,
    userEmail: row.userEmail ?? row.toEmail,
    templateKey: row.templateKey,
    messageId: row.messageId,
    to: row.toEmail,
  };
}

export interface EmailSendContextByMessageId {
  emailSendId: string;
  userId: string;
  userEmail: string;
  templateKey: string | null;
  to: string;
}

/**
 * @deprecated Renamed to {@link EmailSendContextByMessageId} as part of the
 * provider-neutral `resendId` → `messageId` rename. Kept as an alias for one
 * minor; removed the following minor.
 */
export type ResendEmailSendContext = EmailSendContextByMessageId;

/**
 * Mirror of {@link resolveEmailSendContext} that resolves by the provider's
 * `messageId` instead of the internal `email_sends.id`. Used by the
 * provider-webhook enrichment path (`email.delivered`/`email.bounced`) where the
 * only handle we hold is the provider message id.
 *
 * Returns the internal `emailSendId` plus the same denormalized identity
 * (`userId`/`userEmail` fall back to the recipient address, exactly like the
 * id-keyed resolver) and `to` recipient. Returns null when no send row carries
 * that `messageId` yet (e.g. a webhook arriving before the send row is committed).
 */
export async function resolveEmailSendContextByMessageId(
  db: Database,
  messageId: string,
): Promise<EmailSendContextByMessageId | null> {
  const rows = await db
    .select({
      emailSendId: emailSends.id,
      toEmail: emailSends.toEmail,
      templateKey: emailSends.templateKey,
      userId: journeyStates.userId,
      userEmail: journeyStates.userEmail,
      sendUserId: emailSends.userId,
      sendUserEmail: emailSends.userEmail,
    })
    .from(emailSends)
    .leftJoin(journeyStates, eq(emailSends.journeyStateId, journeyStates.id))
    .where(eq(emailSends.messageId, messageId))
    .limit(1);

  const row = rows[0];
  if (!row) return null;

  return {
    emailSendId: row.emailSendId,
    userId: row.userId ?? row.sendUserId ?? row.toEmail,
    userEmail: row.userEmail ?? row.sendUserEmail ?? row.toEmail,
    templateKey: row.templateKey,
    to: row.toEmail,
  };
}

/**
 * @deprecated Renamed to {@link resolveEmailSendContextByMessageId} as part of
 * the provider-neutral `resendId` → `messageId` rename. Kept as an alias for one
 * minor; removed the following minor.
 */
export const resolveEmailSendContextByResendId =
  resolveEmailSendContextByMessageId;

export interface PushTrackingEventOpts {
  db: Database;
  hatchet: HatchetClient;
  registry: JourneyRegistry;
  logger: Logger;
  event: string;
  emailSendId: string;
  properties?: Record<string, unknown>;
  /**
   * Pre-resolved send context. When provided (including `null`), the duplicate
   * `resolveEmailSendContext` read is skipped — the tracking routes resolve once
   * and share the result with the outbound emit on the hot path. Omit to resolve
   * lazily.
   */
  resolvedContext?: EmailSendContext | null;
  /**
   * Threaded straight into `ingestEvent` — a duplicate key returns
   * `{ stored: false }` BEFORE the Hatchet push, so journeys never see the
   * duplicate. Semantic link answers use `sem:<emailSendId>:<event>` for
   * first-answer-per-send semantics.
   */
  idempotencyKey?: string;
}

/**
 * Re-push a first-party tracking event (open/click) back onto the INTERNAL bus
 * (`ingestEvent`) for journey routing + `userEvents` persistence.
 *
 * NOTE (Phase 2): this NO LONGER fires a fire-and-forget PostHog `captureEvent`.
 * PostHog now receives opens/clicks PER-HIT via the durable outbound spine — a
 * `kind="posthog"` destination subscribed to `email.opened`/`email.clicked` (the
 * tracking routes call `emitOutbound` alongside this). The legacy double-emit was
 * removed so PostHog gets exactly one, durable copy of each hit.
 */
export async function pushTrackingEvent(
  opts: PushTrackingEventOpts,
): Promise<IngestResult | undefined> {
  const { db, hatchet, registry, logger, event, emailSendId } = opts;

  const ctx =
    opts.resolvedContext !== undefined
      ? opts.resolvedContext
      : await resolveEmailSendContext(db, emailSendId);
  if (!ctx) return undefined;

  const properties: Record<string, unknown> = {
    emailSendId,
    templateKey: ctx.templateKey,
    ...opts.properties,
  };

  return await ingestEvent({
    db,
    registry,
    hatchet,
    logger,
    event: {
      event,
      userId: ctx.userId,
      userEmail: ctx.userEmail,
      eventProperties: properties,
      source: "tracking",
      idempotencyKey: opts.idempotencyKey,
    },
  });
}

export interface PushLinkClickEventOpts {
  db: Database;
  hatchet: HatchetClient;
  registry: JourneyRegistry;
  logger: Logger;
  /**
   * The MANAGED `links.id` — the durable, re-mint-safe key a journey filters on
   * via `trigger.where`/`ctx.waitForEvent` (`where: b.prop("linkId").eq(...)`).
   * Null when the tracked link has no managed parent row.
   */
  linkId: string | null;
  /** The `tracked_links.id` (the redirect `:id`); disambiguates a re-mint. */
  trackedLinkId: string;
  campaign: string | null;
  source: string | null;
  linkType: string | null;
  linkUrl: string;
  /**
   * The personal link's canonical contact key (`links.distinct_id`). MUST be the
   * subject's EXTERNAL canonical key (an app `external_id`, or "discord:<id>" for
   * a Discord member) — a raw snowflake or anonymous id would fork an orphan
   * contact. Null ⇒ a broadcast/public link (no person) ⇒ no re-ingest.
   */
  distinctId: string | null;
  idempotencyKey?: string;
}

/**
 * Re-push a NON-email managed-link click onto the INTERNAL bus (`ingestEvent`)
 * as the first-party `link.clicked` event so journeys can trigger / await a
 * click of a SPECIFIC managed link (filtered by `linkId`/`campaign`).
 *
 * IDENTITY GATE (crash-guard): `ingestEvent`→`resolveOrCreateContact` THROWS on
 * a zero-key event, so a broadcast/public link (`distinctId == null`) returns
 * `undefined` WITHOUT calling ingest. The click route ALSO suppresses
 * bot/prefetch hits upstream (`isBotOrPrefetch`), so an unfurl bot never reaches
 * here. All six payload keys are scalars (or null) so they survive ingest and
 * reach `trigger.where` + `waitForEvent.properties`.
 *
 * Distinct from the per-hit OUTBOUND `link.clicked` webhook: that fires for
 * EVERY hit and carries `trackedLinks.id` + the raw mint distinctId; THIS bus
 * event carries the managed `links.id` + the resolved survivor contact key.
 */
export async function pushLinkClickEvent(
  opts: PushLinkClickEventOpts,
): Promise<IngestResult | undefined> {
  const { db, hatchet, registry, logger, distinctId } = opts;
  if (!distinctId) return undefined;

  return await ingestEvent({
    db,
    registry,
    hatchet,
    logger,
    event: {
      event: LINK_CLICKED,
      userId: distinctId,
      eventProperties: {
        linkId: opts.linkId,
        trackedLinkId: opts.trackedLinkId,
        campaign: opts.campaign,
        source: opts.source,
        linkType: opts.linkType,
        linkUrl: opts.linkUrl,
      },
      source: "tracking",
      idempotencyKey: opts.idempotencyKey,
    },
  });
}
