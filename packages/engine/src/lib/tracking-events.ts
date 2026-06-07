import type { HatchetClient } from "@hatchet-dev/typescript-sdk/v1/index.js";
import type { PostHogService } from "@hogsend/core";
import type { JourneyRegistry } from "@hogsend/core/registry";
import { type Database, emailSends, journeyStates } from "@hogsend/db";
import { eq } from "drizzle-orm";
import { ingestEvent } from "./ingestion.js";
import type { Logger } from "./logger.js";

interface EmailSendContext {
  userId: string;
  userEmail: string;
  templateKey: string | null;
  resendId: string | null;
  to: string;
}

export async function resolveEmailSendContext(
  db: Database,
  emailSendId: string,
): Promise<EmailSendContext | null> {
  const rows = await db
    .select({
      toEmail: emailSends.toEmail,
      templateKey: emailSends.templateKey,
      resendId: emailSends.resendId,
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
    resendId: row.resendId,
    to: row.toEmail,
  };
}

export interface ResendEmailSendContext {
  emailSendId: string;
  userId: string;
  userEmail: string;
  templateKey: string | null;
  to: string;
}

/**
 * Mirror of {@link resolveEmailSendContext} that resolves by the provider's
 * `resendId` instead of the internal `email_sends.id`. Used by the
 * provider-webhook enrichment path (`email.delivered`/`email.bounced`) where the
 * only handle we hold is the Resend `email_id`.
 *
 * Returns the internal `emailSendId` plus the same denormalized identity
 * (`userId`/`userEmail` fall back to the recipient address, exactly like the
 * id-keyed resolver) and `to` recipient. Returns null when no send row carries
 * that `resendId` yet (e.g. a webhook arriving before the send row is committed).
 */
export async function resolveEmailSendContextByResendId(
  db: Database,
  resendId: string,
): Promise<ResendEmailSendContext | null> {
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
    .where(eq(emailSends.resendId, resendId))
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

export interface PushTrackingEventOpts {
  db: Database;
  hatchet: HatchetClient;
  registry: JourneyRegistry;
  logger: Logger;
  posthog?: PostHogService;
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
}

export async function pushTrackingEvent(
  opts: PushTrackingEventOpts,
): Promise<void> {
  const { db, hatchet, registry, logger, posthog, event, emailSendId } = opts;

  const ctx =
    opts.resolvedContext !== undefined
      ? opts.resolvedContext
      : await resolveEmailSendContext(db, emailSendId);
  if (!ctx) return;

  const properties: Record<string, unknown> = {
    emailSendId,
    templateKey: ctx.templateKey,
    ...opts.properties,
  };

  posthog?.captureEvent({
    distinctId: ctx.userId,
    event,
    properties,
  });

  await ingestEvent({
    db,
    registry,
    hatchet,
    logger,
    event: {
      event,
      userId: ctx.userId,
      userEmail: ctx.userEmail,
      eventProperties: properties,
    },
  });
}
