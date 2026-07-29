import { bySubject, durationToMs, hours } from "@hogsend/core";
import type { JourneyMeta } from "@hogsend/core/types";
import { type Database, emailPreferences, journeyStates } from "@hogsend/db";
import { and, eq } from "drizzle-orm";

/**
 * The subject these guards read history for. `contactId` is REQUIRED (not
 * optional) for the same reason `ConditionContext.contactId` is: an optional
 * field silently defaults a new caller onto the mutable text key, which is
 * exactly the entry-limit miss this batch exists to close. Pass `null`
 * explicitly for a subject with no contact — a permanent, supported state (the
 * engine refuses to mint a contact on observation).
 */
export async function checkEntryLimit(opts: {
  db: Database;
  journey: JourneyMeta;
  userId: string;
  contactId: string | null;
}): Promise<{ allowed: boolean; reason?: string }> {
  const { db, journey, userId, contactId } = opts;
  if (journey.entryLimit === "unlimited") return { allowed: true };

  const subject = bySubject(journeyStates, { contactId, userKey: userId });

  if (journey.entryLimit === "once") {
    const existing = await db.query.journeyStates.findFirst({
      where: and(subject, eq(journeyStates.journeyId, journey.id)),
    });
    return existing
      ? { allowed: false, reason: "already_entered_once" }
      : { allowed: true };
  }

  if (journey.entryLimit === "once_per_period") {
    const periodMs = durationToMs(journey.entryPeriod ?? hours(24));
    const cutoff = new Date(Date.now() - periodMs);

    const existing = await db.query.journeyStates.findFirst({
      where: and(subject, eq(journeyStates.journeyId, journey.id)),
      orderBy: (states, { desc }) => [desc(states.createdAt)],
    });

    return existing && existing.createdAt > cutoff
      ? { allowed: false, reason: "period_not_elapsed" }
      : { allowed: true };
  }

  return { allowed: true };
}

/** See {@link checkEntryLimit} for why `contactId` is required. */
export async function checkEmailPreferences(opts: {
  db: Database;
  userId: string;
  contactId: string | null;
}): Promise<{ unsubscribed: boolean }> {
  const { db, userId, contactId } = opts;
  const prefs = await db.query.emailPreferences.findFirst({
    where: bySubject(emailPreferences, { contactId, userKey: userId }),
  });

  return { unsubscribed: prefs?.unsubscribedAll ?? false };
}
