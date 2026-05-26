import type { HatchetClient } from "@hatchet-dev/typescript-sdk/v1/index.js";
import type { JourneyRegistry } from "@hogsend/core/registry";
import { type Database, emailSends, journeyStates } from "@hogsend/db";
import type { PostHogService } from "@hogsend/plugin-posthog";
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
      journeyStateId: emailSends.journeyStateId,
    })
    .from(emailSends)
    .where(eq(emailSends.id, emailSendId))
    .limit(1);

  const send = rows[0];
  if (!send) return null;

  if (send.journeyStateId) {
    const stateRows = await db
      .select({
        userId: journeyStates.userId,
        userEmail: journeyStates.userEmail,
      })
      .from(journeyStates)
      .where(eq(journeyStates.id, send.journeyStateId))
      .limit(1);

    const state = stateRows[0];
    if (state) {
      return {
        userId: state.userId,
        userEmail: state.userEmail,
        templateKey: send.templateKey,
      };
    }
  }

  return {
    userId: send.toEmail,
    userEmail: send.toEmail,
    templateKey: send.templateKey,
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

  await ingestEvent({
    db,
    registry,
    hatchet,
    logger,
    event: {
      event,
      userId: ctx.userId,
      userEmail: ctx.userEmail,
      properties,
    },
  });

  posthog?.captureEvent({
    distinctId: ctx.userId,
    event,
    properties,
  });
}
