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
}

export async function resolveEmailSendContext(
  db: Database,
  emailSendId: string,
): Promise<EmailSendContext | null> {
  const rows = await db
    .select({
      toEmail: emailSends.toEmail,
      templateKey: emailSends.templateKey,
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
}

export async function pushTrackingEvent(
  opts: PushTrackingEventOpts,
): Promise<void> {
  const { db, hatchet, registry, logger, posthog, event, emailSendId } = opts;

  const ctx = await resolveEmailSendContext(db, emailSendId);
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
