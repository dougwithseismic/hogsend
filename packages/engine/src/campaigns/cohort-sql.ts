/**
 * Bulk condition → SQL for the campaign wave runtime. Waves after the first
 * qualify recipients FROM the anchored cohort (`campaign_recipients`) with one
 * indexed query per page — the per-user `evaluateCondition()` path is never
 * used on the wave hot path. Each supported `ConditionEval` compiles to a
 * single [NOT] EXISTS predicate correlated against the outer
 * `campaign_recipients` row; a step's condition array is AND-composed by the
 * caller (OR is deferred — core's `composite` type is the seam, so composites
 * THROW here rather than half-work).
 *
 * v1 supports exactly the cohort-builder vocabulary: `email_engagement`
 * (opened/clicked over THIS campaign's prior sends), `event` (a `user_events`
 * row since the campaign's `startedAt`), and `channel_identity` (a linked
 * connector identity). `property` has no bulk source on this path and throws.
 */
import {
  type ChannelIdentityCondition,
  type ConditionEval,
  durationToMs,
  type EmailEngagementCondition,
  type EventCondition,
} from "@hogsend/core";
import {
  campaignRecipients,
  contacts,
  emailPreferences,
  emailSends,
  userEvents,
} from "@hogsend/db";
import { type SQL, sql } from "drizzle-orm";
import type { PgColumn } from "drizzle-orm/pg-core";
import { campaignSendKeyPattern } from "../lib/campaign-send-key.js";

/**
 * The v1 linked-identity map: connector id → the `contacts` column that holds
 * the linked identity. `contact_aliases` is deliberately NOT consulted — it is
 * the stale-key merge table, not the linked-identity store. `defineCampaign`
 * already rejects unknown connectors at authoring time; the throw below is the
 * runtime backstop (a hand-written steps blob bypasses authoring validation).
 */
const CONNECTOR_IDENTITY_COLUMNS: Record<string, PgColumn | undefined> = {
  discord: contacts.discordId,
};

/**
 * Fresh suppression/unsubscribe re-check for a cohort wave — suppression is
 * never snapshotted (GDPR/CAN-SPAM): a member who unsubscribes between waves
 * is excluded from every subsequent wave automatically. Mirrors the bucket
 * resolver's correlated NOT EXISTS exactly (an EXISTS subquery, NOT a JOIN,
 * so an email with two prefs rows is not fanned out; an absent prefs row
 * matches nothing → included, subscribed-by-default). `campaign_recipients.
 * email` is normalized at write, so only the prefs side needs `lower()`. The
 * mailer's per-send category check remains the authoritative backstop.
 *
 * The second NOT EXISTS covers the erasure path the prefs check misses: an
 * admin contact delete (a GDPR erasure) sets ONLY `contacts.deletedAt` and
 * writes nothing to `email_preferences`, so an erased wave-0 recipient would
 * otherwise keep qualifying for every later wave (the mailer's per-send check
 * reads only prefs, too). Matched on the same identity binding the anchor
 * wrote (`userId = externalId ?? contactId` — see channelIdentitySql), and
 * deliberately NOT on email: merge-loser rows are also soft-deleted and share
 * their email with a live survivor, so an email leg would wrongly drop merged
 * members. Failure direction here is under-delivery, never over-delivery.
 */
export function cohortSuppressionSql(): SQL {
  return sql`not exists (
    select 1 from ${emailPreferences}
    where lower(${emailPreferences.email}) = ${campaignRecipients.email}
      and (${emailPreferences.unsubscribedAll} = true
           or ${emailPreferences.suppressed} = true)
  ) and not exists (
    select 1 from ${contacts}
    where (${contacts.externalId} = ${campaignRecipients.userId}
           or ${contacts.id}::text = ${campaignRecipients.userId})
      and ${contacts.deletedAt} is not null
  )`;
}

/**
 * Compile one wave `where` condition to its correlated [NOT] EXISTS predicate.
 * `startedAt` is the claimed row's `startedAt` — the anchor `event` conditions
 * scope to ("since the campaign started"), which is why the claim CAS must
 * never reset it.
 *
 * @throws on `composite`/`property` conditions (not supported on the wave
 * path in v1), an `event` count check, or an unknown `channel_identity`
 * connector.
 */
export function waveConditionSql(opts: {
  condition: ConditionEval;
  campaignId: string;
  startedAt: Date;
}): SQL {
  const { condition, campaignId, startedAt } = opts;
  switch (condition.type) {
    case "email_engagement":
      return engagementSql(condition, campaignId);
    case "event":
      return eventSql(condition, startedAt);
    case "channel_identity":
      return channelIdentitySql(condition);
    default:
      throw new Error(
        `Campaign wave \`where\` does not support "${condition.type}" conditions in v1 — only email_engagement, event, and channel_identity (the cohort-builder vocabulary).`,
      );
  }
}

/**
 * Engagement over THIS campaign's prior deliveries. The campaign-level LIKE
 * (`campaign:<escaped-id>:%`) is a correct superset of BOTH key formats
 * (legacy and step-scoped), so an absent `templateKey` — "any prior send of
 * this campaign" — and a template-filtered check both anchor on it. Negative
 * checks are NOT EXISTS of the same positive-engagement subquery, so
 * `notOpened()` reads "no opened send of this campaign", including members
 * who received nothing (e.g. suppressed on the prior wave).
 */
function engagementSql(
  condition: EmailEngagementCondition,
  campaignId: string,
): SQL {
  const engagedAt =
    condition.check === "opened" || condition.check === "not_opened"
      ? emailSends.openedAt
      : emailSends.clickedAt;
  const templateFilter =
    condition.templateKey !== undefined
      ? sql` and ${emailSends.templateKey} = ${condition.templateKey}`
      : sql.empty();
  const positive = sql`exists (
    select 1 from ${emailSends}
    where ${emailSends.idempotencyKey} like ${campaignSendKeyPattern(campaignId)}
      and ${emailSends.toEmail} = ${campaignRecipients.email}
      and ${engagedAt} is not null${templateFilter}
  )`;
  return condition.check === "not_opened" || condition.check === "not_clicked"
    ? sql`not ${positive}`
    : positive;
}

/**
 * A `user_events` row for this member since the campaign's `startedAt` (plus
 * the condition's own `within` window when set — both bounds apply, which is
 * the natural reading of "fired within N days of a campaign that started
 * later"). `campaign_recipients.user_id` may be NULL (an email-only list
 * member with no behavioral identity): SQL NULL comparison makes the EXISTS
 * false — so `firedEvent` never matches such a member and `notFiredEvent`
 * always does. That is the correct stance: with no identity there is no
 * evidence the event fired.
 */
function eventSql(condition: EventCondition, startedAt: Date): SQL {
  if (condition.check === "count") {
    throw new Error(
      'Campaign wave `where` does not support event "count" checks in v1 — only exists/not_exists (c.firedEvent / c.notFiredEvent).',
    );
  }
  // Both time bounds are passed as ISO strings + an explicit ::timestamptz
  // cast — a raw sql`` template does NOT map a JS Date param (postgres-js
  // throws ERR_INVALID_ARG_TYPE), unlike the composable gt()/lt() helpers.
  const windowFilter = condition.within
    ? sql` and ${userEvents.occurredAt} >= ${new Date(
        Date.now() - durationToMs(condition.within),
      ).toISOString()}::timestamptz`
    : sql.empty();
  const positive = sql`exists (
    select 1 from ${userEvents}
    where ${userEvents.userId} = ${campaignRecipients.userId}
      and ${userEvents.event} = ${condition.eventName}
      and ${userEvents.occurredAt} >= ${startedAt.toISOString()}::timestamptz${windowFilter}
  )`;
  return condition.check === "not_exists" ? sql`not ${positive}` : positive;
}

/**
 * The member has/lacks a linked identity for the connector (v1: `"discord"` →
 * `contacts.discordId`, live rows only). The OR-join mirrors the opt-out list
 * resolver's recipient identity fallback (`userId = externalId ?? contactId`):
 * a cohort member's `user_id` may hold either the contact's external id or,
 * for a contact without one, the contact row's own uuid — so the lookup must
 * accept both spellings. A NULL `user_id` matches nothing → `linked` false,
 * `notLinked` true (no identity, no link).
 */
function channelIdentitySql(condition: ChannelIdentityCondition): SQL {
  const column = CONNECTOR_IDENTITY_COLUMNS[condition.connector];
  if (!column) {
    throw new Error(
      `Campaign wave \`where\`: channel_identity connector "${condition.connector}" has no linked-identity source in v1 — only "discord" is supported.`,
    );
  }
  const positive = sql`exists (
    select 1 from ${contacts}
    where (${contacts.externalId} = ${campaignRecipients.userId}
           or ${contacts.id}::text = ${campaignRecipients.userId})
      and ${column} is not null
      and ${contacts.deletedAt} is null
  )`;
  return condition.check === "not_linked" ? sql`not ${positive}` : positive;
}
